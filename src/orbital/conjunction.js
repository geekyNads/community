/**
 * Conjunction screening: which pairs come within a threshold, when (TCA), and
 * how close (miss distance).
 *
 * Method, end to end:
 * 1. Sample every object on a fixed grid (step `stepS`), from one step before
 *    the window to one step after it so boundary events are not lost.
 * 2. Bound the candidates per sample. A pair at sample k can be part of a
 *    dip below the threshold `D` only if its separation is at most
 *    `D + 0.6 * Vrel * stepS` (Vrel = relative speed at k). For near-linear
 *    relative motion, a dip's nearest sample lies within stepS/2 of the true
 *    minimum, so the separation there is at most D + Vrel * stepS / 2; the 0.6
 *    factor is that half-step bound with 20% margin for curvature. Pairs are
 *    found through a uniform spatial hash whose cell size is the global bound
 *    `D + 1.2 * vmax * stepS`, so only neighbouring cells are compared.
 * 3. Keep only sampled local minima, since the nearest sample to a true
 *    minimum is one.
 * 4. Refine each local minimum on its bracket [t(k-1), t(k+1)] by golden-section
 *    search on the separation, with propagation at every evaluation (no
 *    interpolation). A minimum on a bracket edge is rejected, not guessed.
 *
 * Frames and units: km, km/s, TEME (see propagator.js). Times are epoch ms.
 *
 * Ceilings: the sampling cost is objects x samples propagations, and the
 * candidate scan is quadratic inside a cell. Keep the object count in the low
 * hundreds per run. A worker or a tighter grid is the upgrade path.
 */
import { propagateState } from './propagator.js';

export const SCREENING_DEFAULTS = Object.freeze({
  thresholdKm: 5,
  stepS: 60,
  // TCA tolerance. Near closest approach d(t) ≈ sqrt(m² + (v·δt)²), so a timing
  // error δt adds about (v·δt)²/(2m) to the miss: at 10.8 km/s, 0.5 s is ~2 km.
  refineToleranceS: 0.005,
  // Pairs whose relative speed is below this (5 m/s) are co-located: docked
  // vehicles or formation partners, not encounters. Excluded and counted.
  colocatedSpeedKmS: 0.005,
});

/** Classes applied after screening, by miss distance, nearest first. */
export const DEFAULT_TIERS = Object.freeze([
  Object.freeze({ id: 'close', maxKm: 1 }),
  Object.freeze({ id: 'screening', maxKm: Infinity }),
]);

const INV_PHI = (Math.sqrt(5) - 1) / 2;
const MS_PER_S = 1000;

/**
 * Golden-section minimum of `f` over [lo, hi] to within `tol` (same units).
 * Returns null when `f` is not finite inside the bracket.
 * @returns {{x: number, fx: number} | null}
 */
export function goldenSectionMin(f, lo, hi, tol) {
  let a = lo;
  let b = hi;
  let c = b - INV_PHI * (b - a);
  let d = a + INV_PHI * (b - a);
  let fc = f(c);
  let fd = f(d);
  if (!Number.isFinite(fc) || !Number.isFinite(fd)) return null;
  while (b - a > tol) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - INV_PHI * (b - a);
      fc = f(c);
      if (!Number.isFinite(fc)) return null;
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + INV_PHI * (b - a);
      fd = f(d);
      if (!Number.isFinite(fd)) return null;
    }
  }
  const x = (a + b) / 2;
  const fx = f(x);
  return Number.isFinite(fx) ? { x, fx } : null;
}

/**
 * Refine the TCA of one pair on the bracket [loMs, hiMs].
 * @returns {{tcaMs: number, missKm: number, relVelKmS: number, atEdge: boolean}
 *   | null}
 */
export function refineTca({
  a,
  b,
  loMs,
  hiMs,
  toleranceS,
  propagate = propagateState,
}) {
  const separation = (tMs) => {
    const pa = propagate(a, tMs);
    const pb = propagate(b, tMs);
    if (!pa.ok || !pb.ok) return NaN;
    return Math.hypot(
      pa.rKm.x - pb.rKm.x,
      pa.rKm.y - pb.rKm.y,
      pa.rKm.z - pb.rKm.z,
    );
  };
  const span = (hiMs - loMs) / MS_PER_S;
  const f = (sOffset) => separation(loMs + sOffset * MS_PER_S);
  const best = goldenSectionMin(f, 0, span, toleranceS);
  if (!best) return null;
  const tcaMs = loMs + best.x * MS_PER_S;
  const edgeTol = Math.max(toleranceS * 2, 1e-9);
  const atEdge = best.x <= edgeTol || span - best.x <= edgeTol;
  const pa = propagate(a, tcaMs);
  const pb = propagate(b, tcaMs);
  if (!pa.ok || !pb.ok) return null;
  const relVelKmS = Math.hypot(
    pa.vKmS.x - pb.vKmS.x,
    pa.vKmS.y - pb.vKmS.y,
    pa.vKmS.z - pb.vKmS.z,
  );
  return { tcaMs, missKm: best.fx, relVelKmS, atEdge };
}

/** Tier label for a miss distance. */
export function classifyMiss(missKm, tiers = DEFAULT_TIERS) {
  for (const tier of tiers) if (missKm <= tier.maxKm) return tier.id;
  return 'outside';
}

function pairKey(i, j) {
  return i < j ? `${i}|${j}` : `${j}|${i}`;
}

/** Yield to the event loop so a long screen does not freeze the page. */
const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Screen a set of objects for conjunctions inside a time window.
 * @param {object} options
 * @param {Array<{id: string|number, name: string, satrec: object, epochMs: number}>} options.objects
 * @param {number} options.startMs window start, epoch ms
 * @param {number} options.endMs window end, epoch ms
 * @param {number} [options.thresholdKm] screening threshold, km
 * @param {number} [options.stepS] coarse sample step, s
 * @param {number} [options.refineToleranceS] TCA tolerance, s
 * @param {Array} [options.tiers] classes by miss distance
 * @param {Function} [options.propagate] (object, epochMs) => {ok, rKm, vKmS}
 * @param {AbortSignal} [options.signal]
 * @param {(fraction: number) => void} [options.onProgress]
 * @returns {Promise<{events: object[], stats: object, explanation: object}>}
 */
export async function screenConjunctions({
  objects,
  startMs,
  endMs,
  thresholdKm = SCREENING_DEFAULTS.thresholdKm,
  stepS = SCREENING_DEFAULTS.stepS,
  refineToleranceS = SCREENING_DEFAULTS.refineToleranceS,
  colocatedSpeedKmS = SCREENING_DEFAULTS.colocatedSpeedKmS,
  tiers = DEFAULT_TIERS,
  propagate = propagateState,
  signal,
  onProgress,
}) {
  if (!Array.isArray(objects)) throw new TypeError('objects must be an array');
  if (!(endMs > startMs)) throw new RangeError('endMs must be after startMs');
  if (!(stepS > 0)) throw new RangeError('stepS must be positive');
  if (!(thresholdKm > 0)) throw new RangeError('thresholdKm must be positive');
  const clock =
    globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now;
  const t0 = clock();

  const n = objects.length;
  const dtMs = stepS * MS_PER_S;
  const sampleCount = Math.floor((endMs - startMs) / dtMs) + 3; // +1 each side
  const originMs = startMs - dtMs;
  const sampleMs = (k) => originMs + k * dtMs;

  // Flat state buffer: [sample][object][x, y, z, vx, vy, vz]; NaN when invalid.
  const states = new Float64Array(sampleCount * n * 6).fill(NaN);
  const at = (k, i) => (k * n + i) * 6;

  let propagations = 0;
  let failures = 0;
  let vmax = 0;
  for (let k = 0; k < sampleCount; k++) {
    if (k % 64 === 0) {
      signal?.throwIfAborted();
      await yieldToLoop();
      onProgress?.(k / sampleCount / 2);
    }
    for (let i = 0; i < n; i++) {
      propagations++;
      const res = propagate(objects[i], sampleMs(k));
      if (!res.ok) {
        failures++;
        continue;
      }
      const o = at(k, i);
      states[o] = res.rKm.x;
      states[o + 1] = res.rKm.y;
      states[o + 2] = res.rKm.z;
      states[o + 3] = res.vKmS.x;
      states[o + 4] = res.vKmS.y;
      states[o + 5] = res.vKmS.z;
      const speed = Math.hypot(res.vKmS.x, res.vKmS.y, res.vKmS.z);
      if (speed > vmax) vmax = speed;
    }
  }

  // Global candidate bound: a pair within D + 1.2*vmax*stepS, so the cell size
  // is at least the pairwise bound and only neighbouring cells need checking.
  const cellKm = thresholdKm + 1.2 * vmax * stepS;
  const sep = (k, i, j) => {
    const a = at(k, i);
    const b = at(k, j);
    if (Number.isNaN(states[a]) || Number.isNaN(states[b])) return NaN;
    return Math.hypot(
      states[a] - states[b],
      states[a + 1] - states[b + 1],
      states[a + 2] - states[b + 2],
    );
  };
  const relSpeed = (k, i, j) => {
    const a = at(k, i);
    const b = at(k, j);
    return Math.hypot(
      states[a + 3] - states[b + 3],
      states[a + 4] - states[b + 4],
      states[a + 5] - states[b + 5],
    );
  };

  let candidatePairs = 0;
  let localMinima = 0;
  let unbracketed = 0;
  const colocated = new Set(); // pair keys excluded as co-located
  const found = new Map(); // pairKey -> refined hits
  const dedupeWindowMs = 2 * dtMs;

  for (let k = 1; k < sampleCount - 1; k++) {
    if (k % 64 === 0) {
      signal?.throwIfAborted();
      await yieldToLoop();
      onProgress?.(0.5 + k / sampleCount / 2);
    }
    // Spatial hash of valid objects at this sample.
    const cells = new Map();
    for (let i = 0; i < n; i++) {
      const o = at(k, i);
      if (Number.isNaN(states[o])) continue;
      const key = `${Math.floor(states[o] / cellKm)},${Math.floor(states[o + 1] / cellKm)},${Math.floor(states[o + 2] / cellKm)}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(i);
      else cells.set(key, [i]);
    }
    for (const [key, bucket] of cells) {
      const [cx, cy, cz] = key.split(',').map(Number);
      for (const i of bucket) {
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dz = -1; dz <= 1; dz++) {
              const neighbour = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
              if (!neighbour) continue;
              for (const j of neighbour) {
                if (j <= i) continue;
                const d = sep(k, i, j);
                const vrel = relSpeed(k, i, j);
                if (!(d <= thresholdKm + 0.6 * vrel * stepS)) continue;
                if (vrel < colocatedSpeedKmS) {
                  // Flat separation: every sample would look like a minimum.
                  colocated.add(pairKey(i, j));
                  continue;
                }
                candidatePairs++;
                // Sampled local minimum: both neighbouring samples must exist
                // and be no closer.
                const dPrev = sep(k - 1, i, j);
                const dNext = sep(k + 1, i, j);
                if (Number.isNaN(dPrev) || Number.isNaN(dNext)) {
                  unbracketed++;
                  continue;
                }
                if (dPrev < d || dNext < d) continue;
                localMinima++;
                const refined = refineTca({
                  a: objects[i],
                  b: objects[j],
                  loMs: sampleMs(k - 1),
                  hiMs: sampleMs(k + 1),
                  toleranceS: refineToleranceS,
                  propagate,
                });
                if (!refined || refined.atEdge) continue;
                const key2 = pairKey(i, j);
                const list = found.get(key2) ?? [];
                list.push({
                  i,
                  j,
                  k,
                  ...refined,
                  sampleD: d,
                  relAtSample: relSpeed(k, i, j),
                });
                found.set(key2, list);
              }
            }
      }
    }
  }

  // Keep one hit per pair per close approach, the smallest miss.
  const events = [];
  let outsideWindow = 0;
  let aboveThreshold = 0;
  for (const [, list] of found) {
    list.sort((p, q) => p.tcaMs - q.tcaMs);
    const merged = [];
    for (const hit of list) {
      const last = merged[merged.length - 1];
      if (last && hit.tcaMs - last.tcaMs < dedupeWindowMs) {
        if (hit.missKm < last.missKm) merged[merged.length - 1] = hit;
      } else merged.push(hit);
    }
    for (const hit of merged) {
      if (hit.tcaMs < startMs || hit.tcaMs > endMs) {
        outsideWindow++;
        continue;
      }
      if (hit.missKm > thresholdKm) {
        aboveThreshold++;
        continue;
      }
      const a = objects[hit.i];
      const b = objects[hit.j];
      events.push({
        id: `${a.id}-${b.id}-${Math.round(hit.tcaMs)}`,
        a: { id: a.id, name: a.name },
        b: { id: b.id, name: b.name },
        tcaMs: hit.tcaMs,
        missKm: hit.missKm,
        relVelKmS: hit.relVelKmS,
        tier: classifyMiss(hit.missKm, tiers),
        explanation: {
          method:
            'coarse sampling, bounded spatial-hash candidates, sampled local minimum, golden-section TCA refinement',
          frame: 'TEME',
          stepS,
          thresholdKm,
          candidateBoundKm: Number(
            (thresholdKm + 0.6 * hit.relAtSample * stepS).toFixed(3),
          ),
          refineToleranceS,
          bracketMs: [sampleMs(hit.k - 1), sampleMs(hit.k + 1)],
          tleEpochMs: { a: a.epochMs ?? null, b: b.epochMs ?? null },
          limitations: [
            'Screening geometry from TLE-derived SGP4 states; not a covariance-based collision probability.',
            'Miss distance is a separation, not a probability of collision.',
            'TLE uncertainty grows with epoch age; see the source-age indicator.',
          ],
        },
      });
    }
  }
  events.sort((p, q) => p.missKm - q.missKm || p.tcaMs - q.tcaMs);

  const elapsedMs = clock() - t0;
  const stats = {
    objects: n,
    samples: sampleCount,
    stepS,
    thresholdKm,
    cellKm: Number(cellKm.toFixed(3)),
    vmaxKmS: Number(vmax.toFixed(3)),
    propagations,
    propagationFailures: failures,
    candidatePairs,
    colocatedPairs: colocated.size,
    localMinima,
    unbracketed,
    outsideWindow,
    aboveThreshold,
    events: events.length,
    elapsedMs: Number(elapsedMs.toFixed(1)),
  };
  onProgress?.(1);
  return {
    events,
    stats,
    explanation: {
      method:
        'Sampled screening with local-minimum refinement (see event explanations).',
      windowMs: [startMs, endMs],
      frame: 'TEME',
      units: { distance: 'km', speed: 'km/s', time: 'epoch ms' },
      stepS,
      thresholdKm,
      refineToleranceS,
    },
  };
}

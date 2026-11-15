import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCREENING_DEFAULTS,
  goldenSectionMin,
  refineTca,
  screenConjunctions,
  classifyMiss,
} from './conjunction.js';
import { propagateState, parseSatrec } from './propagator.js';

// Linear-motion objects make the closed-form answer exact:
// r(t) = P + V t, so TCA = -(dP·dV)/|dV|^2 and miss = |dP + dV·TCA|.
const REF_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const linear = (id, P, V) => ({ id, name: `OBJ-${id}`, P, V, epochMs: REF_MS });
const linearPropagate = (obj, ms) => {
  const t = (ms - REF_MS) / 1000;
  return {
    ok: true,
    rKm: {
      x: obj.P.x + obj.V.x * t,
      y: obj.P.y + obj.V.y * t,
      z: obj.P.z + obj.V.z * t,
    },
    vKmS: { x: obj.V.x, y: obj.V.y, z: obj.V.z },
  };
};

function analytic(a, b) {
  const dP = { x: a.P.x - b.P.x, y: a.P.y - b.P.y, z: a.P.z - b.P.z };
  const dV = { x: a.V.x - b.V.x, y: a.V.y - b.V.y, z: a.V.z - b.V.z };
  const v2 = dV.x ** 2 + dV.y ** 2 + dV.z ** 2;
  const tcaS = -(dP.x * dV.x + dP.y * dV.y + dP.z * dV.z) / v2;
  const miss = Math.hypot(
    dP.x + dV.x * tcaS,
    dP.y + dV.y * tcaS,
    dP.z + dV.z * tcaS,
  );
  return { tcaS, miss, relV: Math.sqrt(v2) };
}

test('goldenSectionMin finds a parabola minimum within tolerance', () => {
  const r = goldenSectionMin((x) => (x - 3) ** 2 + 1, 0, 10, 1e-6);
  assert.ok(Math.abs(r.x - 3) < 1e-5);
  assert.ok(Math.abs(r.fx - 1) < 1e-9);
});

test('goldenSectionMin rejects non-finite evaluations', () => {
  assert.equal(
    goldenSectionMin(() => NaN, 0, 1, 1e-3),
    null,
  );
});

test('refineTca matches the closed-form TCA, miss and relative speed', () => {
  // Closest approach ≈ 38 s in, miss ≈ 2.45 km.
  const a = linear('a', { x: 0, y: 0, z: 0 }, { x: 1, y: 0.2, z: 0 });
  const b = linear('b', { x: 40, y: 5.5, z: 0 }, { x: 0, y: 0, z: 0 });
  const exact = analytic(a, b);
  const r = refineTca({
    a,
    b,
    loMs: REF_MS,
    hiMs: REF_MS + 120_000,
    toleranceS: 0.01,
    propagate: linearPropagate,
  });
  assert.equal(r.atEdge, false);
  assert.ok(Math.abs((r.tcaMs - REF_MS) / 1000 - exact.tcaS) < 0.05);
  assert.ok(Math.abs(r.missKm - exact.miss) < 1e-4);
  assert.ok(Math.abs(r.relVelKmS - exact.relV) < 1e-9);
});

test('screenConjunctions reports an encounter below threshold with exact TCA and miss', async () => {
  const a = linear('100', { x: -300, y: 0, z: 0 }, { x: 7, y: 0.5, z: 0 });
  // Cross-track offset ≈ 0.07 km at closest approach (inside the 1 km tier).
  const b = linear('200', { x: 0, y: 21.5, z: 0 }, { x: 0, y: 0, z: 0 });
  const exact = analytic(a, b);
  const out = await screenConjunctions({
    objects: [a, b],
    startMs: REF_MS,
    endMs: REF_MS + 2 * 3600 * 1000,
    thresholdKm: 5,
    stepS: 60,
    refineToleranceS: 0.05,
    propagate: linearPropagate,
  });
  assert.equal(out.events.length, 1, JSON.stringify(out.stats));
  const [ev] = out.events;
  const tcaS = (ev.tcaMs - REF_MS) / 1000;
  assert.ok(Math.abs(tcaS - exact.tcaS) < 0.1, `TCA ${tcaS} vs ${exact.tcaS}`);
  assert.ok(Math.abs(ev.missKm - exact.miss) < 1e-3);
  assert.ok(Math.abs(ev.relVelKmS - exact.relV) < 1e-6);
  assert.equal(ev.tier, 'close');
  assert.equal(ev.explanation.frame, 'TEME');
  assert.ok(ev.explanation.limitations.length >= 2);
});

test('screenConjunctions rejects an encounter above threshold', async () => {
  const a = linear('1', { x: -300, y: 0, z: 0 }, { x: 7, y: 0, z: 0 });
  const b = linear('2', { x: 0, y: 40, z: 0 }, { x: 0, y: 0, z: 0 });
  const out = await screenConjunctions({
    objects: [a, b],
    startMs: REF_MS,
    endMs: REF_MS + 3600 * 1000,
    thresholdKm: 5,
    stepS: 60,
    propagate: linearPropagate,
  });
  assert.equal(out.events.length, 0);
  assert.equal(out.stats.aboveThreshold, 1);
});

test('screenConjunctions keeps a TCA just after the window start', async () => {
  // Closest approach 20 s after the window opens; edge samples must not drop it.
  const a = linear('1', { x: -20 * 7, y: 0, z: 0 }, { x: 7, y: 0, z: 0 });
  const b = linear('2', { x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 0 });
  const out = await screenConjunctions({
    objects: [a, b],
    startMs: REF_MS,
    endMs: REF_MS + 1800 * 1000,
    thresholdKm: 2,
    stepS: 60,
    propagate: linearPropagate,
  });
  assert.equal(out.events.length, 1);
  assert.ok(Math.abs((out.events[0].tcaMs - REF_MS) / 1000 - 20) < 0.1);
});

test('screenConjunctions ignores an encounter outside the window', async () => {
  const a = linear('1', { x: -300, y: 0, z: 0 }, { x: 7, y: 0, z: 0 });
  const b = linear('2', { x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 0 });
  // The TCA is at t ≈ 42.9 s, which lies outside a window that opens 2 h later.
  const out = await screenConjunctions({
    objects: [a, b],
    startMs: REF_MS + 2 * 3600 * 1000,
    endMs: REF_MS + 3 * 3600 * 1000,
    thresholdKm: 5,
    stepS: 60,
    propagate: linearPropagate,
  });
  assert.equal(out.events.length, 0);
});

test('screenConjunctions counts propagation failures and skips those objects', async () => {
  const good = linear('1', { x: -300, y: 0, z: 0 }, { x: 7, y: 0, z: 0 });
  const bad = { id: '2', name: 'BROKEN', epochMs: REF_MS, broken: true };
  const out = await screenConjunctions({
    objects: [good, bad],
    startMs: REF_MS,
    endMs: REF_MS + 600 * 1000,
    thresholdKm: 5,
    stepS: 60,
    propagate: (obj, ms) =>
      obj.broken
        ? { ok: false, reason: 'test failure' }
        : linearPropagate(obj, ms),
  });
  assert.equal(out.events.length, 0);
  assert.ok(out.stats.propagationFailures > 0);
});

test('screenConjunctions rejects invalid windows and steps', async () => {
  await assert.rejects(
    screenConjunctions({ objects: [], startMs: 10, endMs: 5 }),
    RangeError,
  );
  await assert.rejects(
    screenConjunctions({ objects: [], startMs: 0, endMs: 10, stepS: 0 }),
    RangeError,
  );
});

test('classifyMiss uses the first tier that contains the miss', () => {
  assert.equal(classifyMiss(0.4), 'close');
  assert.equal(classifyMiss(3), 'screening');
  assert.equal(classifyMiss(3, [{ id: 'x', maxKm: 2 }]), 'outside');
});

// --- Real SGP4 path -------------------------------------------------------

// Canonical archived ISS TLE used across this repository's tests.
const ISS1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const ISS2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

test('parseSatrec decodes the epoch and warns on checksum mismatch only', () => {
  const ok = parseSatrec(ISS1, ISS2);
  assert.equal(ok.ok, true);
  // 2008 day 264.51782528 = 2008-09-20 12:25:40 UTC.
  const expected = Date.UTC(2008, 8, 20, 12, 25, 40);
  assert.ok(
    Math.abs(ok.epochMs - expected) < 2000,
    `epoch ${new Date(ok.epochMs).toISOString()}`,
  );

  const badSum = parseSatrec(ISS1.slice(0, 68) + '0', ISS2);
  assert.equal(badSum.ok, true);
  assert.ok(badSum.warnings.some((w) => /checksum/.test(w)));
});

test('parseSatrec rejects malformed and mismatched lines', () => {
  assert.equal(parseSatrec('short', ISS2).ok, false);
  assert.equal(parseSatrec(ISS2, ISS1).ok, false);
  const otherCatalog = ISS2.replace('25544', '25545');
  assert.match(parseSatrec(ISS1, otherCatalog).reason, /catalog numbers/);
});

test('propagateState gives a low-Earth-orbit state in TEME km and km/s', () => {
  const rec = parseSatrec(ISS1, ISS2);
  const s = propagateState(rec, rec.epochMs + 600_000);
  assert.equal(s.ok, true);
  const r = Math.hypot(s.rKm.x, s.rKm.y, s.rKm.z);
  const v = Math.hypot(s.vKmS.x, s.vKmS.y, s.vKmS.z);
  assert.ok(r > 6700 && r < 6800, `radius ${r} km`);
  assert.ok(v > 7.5 && v < 7.9, `speed ${v} km/s`);
});

test('screenConjunctions runs end-to-end on real SGP4 records without failing', async () => {
  const rec = parseSatrec(ISS1, ISS2);
  const out = await screenConjunctions({
    objects: [{ id: 25544, name: 'ISS', epochMs: rec.epochMs, ...rec }],
    startMs: rec.epochMs,
    endMs: rec.epochMs + 90 * 60 * 1000,
    thresholdKm: 5,
    stepS: 60,
  });
  assert.equal(out.events.length, 0);
  assert.equal(out.stats.objects, 1);
  assert.equal(out.stats.propagationFailures, 0);
});

// Candidate detection against brute force: every pair's closed-form encounter.
test('screening matches brute-force closed-form encounters for many objects', async () => {
  let seed = 20260115;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const span = (lo, hi) => lo + (hi - lo) * rand();
  const objects = Array.from({ length: 60 }, (_, i) =>
    linear(
      String(i + 1),
      { x: span(-500, 500), y: span(-500, 500), z: span(-500, 500) },
      { x: span(-10, 10), y: span(-10, 10), z: span(-10, 10) },
    ),
  );
  const startMs = REF_MS;
  const endMs = REF_MS + 3600 * 1000;
  const thresholdKm = 50;

  const truth = [];
  for (let i = 0; i < objects.length; i++)
    for (let j = i + 1; j < objects.length; j++) {
      const e = analytic(objects[i], objects[j]);
      if (!(e.relV > 1e-6)) continue;
      if (e.tcaS * 1000 < 0 || e.tcaS * 1000 > endMs - startMs) continue;
      if (e.miss <= thresholdKm)
        truth.push({
          a: objects[i].id,
          b: objects[j].id,
          tcaS: e.tcaS,
          miss: e.miss,
        });
    }
  assert.ok(truth.length >= 1, 'fixture must contain at least one encounter');

  const out = await screenConjunctions({
    objects,
    startMs,
    endMs,
    thresholdKm,
    stepS: 30,
    refineToleranceS: 0.05,
    propagate: linearPropagate,
  });
  assert.equal(
    out.events.length,
    truth.length,
    `engine ${out.events.length} vs truth ${truth.length}`,
  );
  for (const t of truth) {
    const hit = out.events.find(
      (ev) =>
        [ev.a.id, ev.b.id].sort().join('|') === [t.a, t.b].sort().join('|') &&
        Math.abs((ev.tcaMs - startMs) / 1000 - t.tcaS) < 0.5,
    );
    assert.ok(hit, `missed pair ${t.a}/${t.b} at ${t.tcaS.toFixed(1)} s`);
    assert.ok(Math.abs(hit.missKm - t.miss) < 1e-3);
  }
  // Pruning is doing its job: far fewer refinements than pairs.
  const pairs = (objects.length * (objects.length - 1)) / 2;
  assert.ok(
    out.stats.localMinima < pairs,
    `refinements ${out.stats.localMinima} vs pairs ${pairs}`,
  );
});

test('co-located pairs (zero relative speed, e.g. docked) are excluded and counted, not refined', async () => {
  const a = linear('1', { x: 0, y: 0, z: 0 }, { x: 7, y: 0, z: 0 });
  const b = linear('2', { x: 0.01, y: 0, z: 0 }, { x: 7, y: 0, z: 0 });
  const out = await screenConjunctions({
    objects: [a, b],
    startMs: REF_MS,
    endMs: REF_MS + 3600 * 1000,
    thresholdKm: 5,
    stepS: 60,
    propagate: linearPropagate,
  });
  assert.equal(out.events.length, 0);
  assert.equal(out.stats.colocatedPairs, 1);
  assert.equal(out.stats.localMinima, 0);
});

test('TCA refinement keeps miss error below 1 m at LEO relative speed', () => {
  // Relative speed 10.8 km/s, exact miss 1.95 km at t* = 40 s.
  const a = linear('a', { x: 0, y: 0, z: 0 }, { x: 10.8, y: 0, z: 0 });
  const b = linear('b', { x: 432, y: 1.95, z: 0 }, { x: 0, y: 0, z: 0 });
  const exact = analytic(a, b);
  const r = refineTca({
    a,
    b,
    loMs: REF_MS,
    hiMs: REF_MS + 120_000,
    toleranceS: SCREENING_DEFAULTS.refineToleranceS,
    propagate: linearPropagate,
  });
  assert.ok(
    Math.abs(r.missKm - exact.miss) < 1e-3,
    `miss error ${Math.abs(r.missKm - exact.miss)} km`,
  );
  assert.ok(Math.abs((r.tcaMs - REF_MS) / 1000 - exact.tcaS) < 0.01);
});

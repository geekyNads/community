/**
 * SGP4 propagation boundary for Orbital Watch.
 *
 * Frames and units (never mixed silently):
 * - `propagate()` from satellite.js returns position in TEME, km, and
 *   velocity in TEME, km/s. TEME is the frame SGP4 is defined in.
 * - Conjunction geometry (separation, TCA, relative speed) is computed in TEME.
 *   Both objects share the frame, so the miss distance is unchanged by any
 *   common rotation. TEME is quasi-inertial over the short windows screened here.
 * - Geodetic output (latitude, longitude, altitude) goes through GMST only. This
 *   ignores polar motion and nutation (metre-level effects, far below TLE error).
 */
import { twoline2satrec, propagate as satPropagate } from 'satellite.js';

/** Operator policy for TLE age, days. Heuristic labels, not an accuracy claim. */
export const TLE_AGE_FRESH_DAYS = 3;
export const TLE_AGE_STALE_DAYS = 14;

const MS_PER_DAY = 86400000;
const JD_UNIX_EPOCH = 2440587.5;

/** TLE line checksum: digits sum, '-' counts as 1, mod 10, per column 1..68. */
export function tleChecksum(line) {
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += c.charCodeAt(0) - 48;
    else if (c === '-') sum += 1;
  }
  return sum % 10;
}

/**
 * Validate and build an SGP4 record from two TLE lines.
 * @returns {{ok: true, satrec: object, epochMs: number, warnings: string[]}
 *   | {ok: false, reason: string}}
 */
export function parseSatrec(line1, line2) {
  if (typeof line1 !== 'string' || typeof line2 !== 'string')
    return { ok: false, reason: 'TLE lines must be strings' };
  if (line1.length < 69 || line2.length < 69)
    return { ok: false, reason: 'TLE line shorter than 69 columns' };
  if (line1[0] !== '1' || line2[0] !== '2')
    return { ok: false, reason: 'TLE line numbers are not 1 and 2' };
  if (line1.slice(2, 7).trim() !== line2.slice(2, 7).trim())
    return { ok: false, reason: 'TLE catalog numbers differ between lines' };
  const warnings = [];
  if (Number(line1[68]) !== tleChecksum(line1))
    warnings.push('line 1 checksum mismatch');
  if (Number(line2[68]) !== tleChecksum(line2))
    warnings.push('line 2 checksum mismatch');
  let satrec;
  try {
    satrec = twoline2satrec(line1, line2);
  } catch (error) {
    return {
      ok: false,
      reason: `SGP4 init failed: ${error?.message ?? error}`,
    };
  }
  if (satrec.error)
    return { ok: false, reason: `SGP4 init error ${satrec.error}` };
  const epochMs = (satrec.jdsatepoch - JD_UNIX_EPOCH) * MS_PER_DAY;
  if (!Number.isFinite(epochMs))
    return { ok: false, reason: 'TLE epoch is not finite' };
  return { ok: true, satrec, epochMs, warnings };
}

/**
 * Propagate one record to a UTC instant.
 * @param {{satrec: object}} record
 * @param {number} dateMs
 * @returns {{ok: true, rKm: {x,y,z}, vKmS: {x,y,z}}
 *   | {ok: false, reason: string}}
 */
export function propagateState(record, dateMs) {
  const satrec = record?.satrec;
  if (!satrec) return { ok: false, reason: 'no SGP4 record' };
  let pv;
  try {
    pv = satPropagate(satrec, new Date(dateMs));
  } catch (error) {
    return {
      ok: false,
      reason: `propagation threw: ${error?.message ?? error}`,
    };
  }
  const p = pv?.position;
  const v = pv?.velocity;
  if (!p || !v || typeof p === 'boolean' || typeof v === 'boolean')
    return { ok: false, reason: `SGP4 error ${satrec.error ?? 'unknown'}` };
  if (![p.x, p.y, p.z, v.x, v.y, v.z].every(Number.isFinite))
    return { ok: false, reason: 'non-finite state' };
  return {
    ok: true,
    rKm: { x: p.x, y: p.y, z: p.z },
    vKmS: { x: v.x, y: v.y, z: v.z },
  };
}

/** TLE epoch age in days at `nowMs`, and its freshness label. */
export function tleFreshness(epochMs, nowMs) {
  const ageDays = (nowMs - epochMs) / MS_PER_DAY;
  const label =
    ageDays <= TLE_AGE_FRESH_DAYS
      ? 'fresh'
      : ageDays <= TLE_AGE_STALE_DAYS
        ? 'aging'
        : 'stale';
  return { ageDays, label };
}

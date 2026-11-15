/**
 * Pure helpers for encounter display: TEME to Earth-fixed samples, separation
 * series, and orbital elements from the TLE's own mean motion.
 *
 * TEME to ECEF is a rotation about z by GMST (satellite.js eciToEcf). Both objects
 * use the same GMST at the same instant, so their separation is identical in TEME
 * and ECEF. The tests check this.
 */
import {
  gstime,
  eciToEcf,
  eciToGeodetic,
  degreesLat,
  degreesLong,
} from 'satellite.js';
import { propagateState } from './propagator.js';

const MU_KM3_S2 = 398600.4418; // WGS-84 gravitational parameter
const R_EARTH_KM = 6378.137;

/** TEME position (km) to Earth-fixed ECEF (km) at `dateMs`. */
export function temeToEcef(rKm, dateMs) {
  const gmst = gstime(new Date(dateMs));
  return eciToEcf(rKm, gmst);
}

/** Geodetic subpoint and altitude of a TEME position at `dateMs`. */
export function subpoint(rKm, dateMs) {
  const gmst = gstime(new Date(dateMs));
  const g = eciToGeodetic(rKm, gmst);
  return {
    latDeg: degreesLat(g.latitude),
    lonDeg: degreesLong(g.longitude),
    altKm: g.height,
  };
}

/**
 * Sample both objects across [centerMs - halfSpanS, centerMs + halfSpanS].
 * Returns frames in TEME and ECEF with the separation. Samples where either
 * object fails to propagate are kept as null so charts show the gap.
 * @param {object} options
 * @param {object} options.a
 * @param {object} options.b
 * @param {number} options.centerMs
 * @param {number} options.halfSpanS
 * @param {number} options.stepS
 * @param {Function} [options.propagate]
 */
export function encounterSamples({
  a,
  b,
  centerMs,
  halfSpanS,
  stepS,
  propagate = propagateState,
}) {
  if (!(stepS > 0) || !(halfSpanS > 0))
    throw new RangeError('halfSpanS and stepS must be positive');
  const frames = [];
  const count = Math.floor((2 * halfSpanS) / stepS) + 1;
  for (let k = 0; k < count; k++) {
    const ms = centerMs + (-halfSpanS + k * stepS) * 1000;
    const pa = propagate(a, ms);
    const pb = propagate(b, ms);
    if (!pa.ok || !pb.ok) {
      frames.push({ ms, separationKm: null, a: null, b: null });
      continue;
    }
    const separationKm = Math.hypot(
      pa.rKm.x - pb.rKm.x,
      pa.rKm.y - pb.rKm.y,
      pa.rKm.z - pb.rKm.z,
    );
    frames.push({
      ms,
      separationKm,
      a: {
        teme: pa.rKm,
        ecef: temeToEcef(pa.rKm, ms),
        sub: subpoint(pa.rKm, ms),
      },
      b: {
        teme: pb.rKm,
        ecef: temeToEcef(pb.rKm, ms),
        sub: subpoint(pb.rKm, ms),
      },
    });
  }
  return frames;
}

/**
 * Orbital elements from TLE line 2, independent of the SGP4 internals.
 * Mean motion is columns 53-63 (revolutions per day).
 * @param {string} line2
 * @returns {{inclinationDeg: number, eccentricity: number, meanMotionRevPerDay: number,
 *   periodMin: number, semiMajorAxisKm: number, perigeeAltKm: number, apogeeAltKm: number} | null}
 */
export function orbitalElements(line2) {
  if (typeof line2 !== 'string' || line2.length < 63) return null;
  const inclinationDeg = Number(line2.slice(8, 16));
  const eccentricity = Number(`0.${line2.slice(26, 33).trim()}`);
  const revPerDay = Number(line2.slice(52, 63));
  if (![inclinationDeg, eccentricity, revPerDay].every(Number.isFinite))
    return null;
  if (revPerDay <= 0) return null;
  const nRadS = (revPerDay * 2 * Math.PI) / 86400;
  const a = Math.cbrt(MU_KM3_S2 / (nRadS * nRadS));
  return {
    inclinationDeg,
    eccentricity,
    meanMotionRevPerDay: revPerDay,
    periodMin: 1440 / revPerDay,
    semiMajorAxisKm: a,
    perigeeAltKm: a * (1 - eccentricity) - R_EARTH_KM,
    apogeeAltKm: a * (1 + eccentricity) - R_EARTH_KM,
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encounterSamples,
  orbitalElements,
  subpoint,
  temeToEcef,
} from './track.js';
import { parseSatrec, propagateState } from './propagator.js';

const ISS1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const ISS2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

test('orbitalElements reads inclination, period and altitudes from TLE line 2', () => {
  const el = orbitalElements(ISS2);
  assert.ok(Math.abs(el.inclinationDeg - 51.6416) < 1e-6);
  assert.ok(Math.abs(el.periodMin - 1440 / 15.72125391) < 1e-6);
  // 2008 TLE: ISS was near 350 km then, not today's ~415 km.
  assert.ok(
    el.perigeeAltKm > 340 && el.perigeeAltKm < 355,
    `perigee ${el.perigeeAltKm}`,
  );
  assert.ok(
    el.apogeeAltKm > 350 && el.apogeeAltKm < 365,
    `apogee ${el.apogeeAltKm}`,
  );
  assert.equal(orbitalElements('too short'), null);
});

test('subpoint of an ISS state is within its ground-track latitude band', () => {
  const rec = parseSatrec(ISS1, ISS2);
  const s = propagateState(rec, rec.epochMs);
  const sp = subpoint(s.rKm, rec.epochMs);
  assert.ok(Math.abs(sp.latDeg) <= 51.7, `lat ${sp.latDeg}`);
  assert.ok(sp.altKm > 300 && sp.altKm < 500, `alt ${sp.altKm}`);
});

test('TEME to ECEF is a rotation: vector length is preserved', () => {
  const r = { x: 4000, y: -3000, z: 2000 };
  const e = temeToEcef(r, Date.UTC(2026, 3, 1, 6, 0, 0));
  const len = (v) => Math.hypot(v.x, v.y, v.z);
  assert.ok(Math.abs(len(e) - len(r)) < 1e-9);
});

test('encounterSamples separation equals the distance of the ECEF positions', () => {
  // Linear motion keeps the expected separation exact at every sample.
  const T = Date.UTC(2026, 0, 1);
  const a = { P: { x: 7000, y: 0, z: 0 }, V: { x: 0, y: 7.5, z: 0 } };
  const b = { P: { x: 7000, y: 3, z: 0 }, V: { x: 0, y: 7.5, z: 0 } };
  const prop = (o, ms) => {
    const t = (ms - T) / 1000;
    return {
      ok: true,
      rKm: { x: o.P.x + o.V.x * t, y: o.P.y + o.V.y * t, z: o.P.z + o.V.z * t },
      vKmS: o.V,
    };
  };
  const frames = encounterSamples({
    a,
    b,
    centerMs: T,
    halfSpanS: 60,
    stepS: 30,
    propagate: prop,
  });
  assert.equal(frames.length, 5);
  for (const f of frames) {
    const d = Math.hypot(
      f.a.ecef.x - f.b.ecef.x,
      f.a.ecef.y - f.b.ecef.y,
      f.a.ecef.z - f.b.ecef.z,
    );
    assert.ok(Math.abs(d - f.separationKm) < 1e-9);
    assert.ok(Math.abs(f.separationKm - 3) < 1e-9);
  }
});

test('encounterSamples keeps gaps where propagation fails', () => {
  const frames = encounterSamples({
    a: {},
    b: {},
    centerMs: 0,
    halfSpanS: 30,
    stepS: 30,
    propagate: () => ({ ok: false, reason: 'x' }),
  });
  assert.ok(frames.every((f) => f.separationKm === null));
});

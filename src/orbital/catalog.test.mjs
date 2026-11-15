import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, parseCatalogText, isDebrisByName } from './catalog.js';
import {
  diffPredictions,
  appendRun,
  createHistoryStore,
  pairKey,
} from './history.js';
import { compareToReference } from './validation.js';

const ISS1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const ISS2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const TEXT = `ISS (ZARYA)\n${ISS1}\n${ISS2}\nBROKEN SAT\n1 99999U bad\n2 99999 nope\n`;

test('parseCatalogText keeps valid sets and reports skipped ones', () => {
  const { objects, skipped } = parseCatalogText(TEXT, { group: 'stations' });
  assert.equal(objects.length, 1);
  assert.equal(objects[0].id, 25544);
  assert.equal(objects[0].group, 'stations');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, 'BROKEN SAT');
});

test('debris is flagged by name only, and labelled as heuristic', () => {
  assert.equal(isDebrisByName('COSMOS 2251 DEB'), true);
  assert.equal(isDebrisByName('ISS (ZARYA)'), false);
});

const fakeSource = (table) => ({
  readGroup: async (group) => {
    const entry = table[group];
    if (entry instanceof Error) throw entry;
    return entry;
  },
});

test('loadCatalog merges groups by NORAD ID and reports failures', async () => {
  const source = fakeSource({
    stations: { ok: true, status: 200, text: TEXT, stale: false },
    visual: { ok: true, status: 200, text: TEXT, stale: true },
    geo: new Error('network down'),
  });
  const cat = await loadCatalog({
    source,
    groups: ['stations', 'visual', 'geo'],
    nowMs: Date.UTC(2008, 8, 21),
  });
  assert.equal(cat.objects.length, 1, 'ISS appears once across groups');
  assert.equal(cat.objects[0].freshness.label, 'fresh');
  const byGroup = Object.fromEntries(cat.groups.map((g) => [g.group, g]));
  assert.equal(byGroup.stations.status, 'ok');
  assert.equal(byGroup.visual.status, 'stale');
  assert.equal(byGroup.geo.status, 'failed');
  assert.match(byGroup.geo.reason, /network down/);
  assert.equal(cat.usable, true);
});

test('loadCatalog is unusable when every group fails', async () => {
  const source = fakeSource({ stations: { ok: false, status: 503, text: '' } });
  const cat = await loadCatalog({ source, groups: ['stations'] });
  assert.equal(cat.usable, false);
  assert.equal(cat.objects.length, 0);
});

const ev = (a, b, tcaMs, missKm) => ({
  a: { id: a },
  b: { id: b },
  tcaMs,
  missKm,
});

test('diffPredictions reports TCA and miss drift for the same pair', () => {
  const T = Date.UTC(2026, 0, 2);
  const previous = [ev('1', '2', T, 2.0), ev('3', '4', T, 1.0)];
  const current = [ev('2', '1', T + 90_000, 1.5), ev('5', '6', T, 3.0)];
  const { rows, dropped } = diffPredictions(previous, current);
  const updated = rows.find(
    (r) => r.pair === pairKey({ id: '1' }, { id: '2' }),
  );
  assert.equal(updated.status, 'updated');
  assert.equal(updated.tcaDriftS, 90);
  assert.ok(Math.abs(updated.missDriftKm - -0.5) < 1e-12);
  assert.equal(rows.find((r) => r.pair === '5|6').status, 'new');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].pair, '3|4');
});

test('diffPredictions does not match a TCA outside tolerance', () => {
  const T = Date.UTC(2026, 0, 2);
  const { rows } = diffPredictions(
    [ev('1', '2', T, 2)],
    [ev('1', '2', T + 7_200_000, 2)],
    { toleranceS: 3600 },
  );
  assert.equal(rows[0].status, 'new');
});

test('appendRun keeps the most recent 20 runs', () => {
  let h = [];
  for (let i = 0; i < 25; i++) h = appendRun(h, { i });
  assert.equal(h.length, 20);
  assert.equal(h[0].i, 5);
});

test('history store survives throwing storage', () => {
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('quota');
    },
  };
  const store = createHistoryStore(broken);
  assert.deepEqual(store.load(), []);
  assert.equal(store.save([{ i: 1 }]).length, 1);
});

test('compareToReference computes detection, false positive and false negative counts', () => {
  const T = Date.UTC(2026, 0, 2);
  const engine = [
    ev('1', '2', T + 10_000, 1.1),
    ev('7', '8', T, 0.5), // not in reference
  ];
  const reference = [
    { a: { id: '1' }, b: { id: '2' }, tcaMs: T, missKm: 1.0 },
    { a: { id: '9' }, b: { id: '10' }, tcaMs: T, missKm: 0.2 }, // missed
  ];
  const r = compareToReference(engine, reference, { tcaToleranceS: 60 });
  assert.equal(r.matched, 1);
  assert.equal(r.falseNegatives, 1);
  assert.equal(r.falsePositives, 1);
  assert.equal(r.detectionRate, 0.5);
  assert.equal(r.tcaErrorS.maxAbs, 10);
  assert.ok(Math.abs(r.missErrorKm.maxAbs - 0.1) < 1e-12);
});

test('compareToReference reports null rates when nothing is compared', () => {
  const r = compareToReference([], []);
  assert.equal(r.detectionRate, null);
  assert.equal(r.tcaErrorS, null);
});

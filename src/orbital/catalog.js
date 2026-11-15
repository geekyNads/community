/**
 * Orbital catalog: CelesTrak TLE groups turned into validated screening objects.
 *
 * Reads through the existing satellite source (the same proxy and cache the globe
 * uses), so there is one CelesTrak path. Groups that fail are reported, not
 * dropped silently, and the caller keeps its previous catalog.
 */
import { parseTleText, noradIdFromSatnum } from '../sources/tle.js';
import { parseSatrec, tleFreshness } from './propagator.js';

/** Groups the orbital view reads by default: the operator's choice, shown in the UI. */
export const DEFAULT_GROUPS = Object.freeze([
  'stations',
  'visual',
  'gps-ops',
  'galileo',
  'geo',
  'weather',
  'resource',
  'science',
  'planet',
  'sar',
]);

/** Heuristic: CelesTrak names fragment debris as "... DEB". Labelled as such in the UI. */
export function isDebrisByName(name) {
  return /\sDEB(\s|$)/i.test(String(name ?? ''));
}

/**
 * Parse one group's TLE text into objects. Invalid sets are counted, not thrown.
 * @returns {{objects: object[], skipped: Array<{name: string, reason: string}>}}
 */
export function parseCatalogText(text, { group = 'unknown' } = {}) {
  const objects = [];
  const skipped = [];
  for (const entry of parseTleText(text)) {
    const parsed = parseSatrec(entry.line1, entry.line2);
    if (!parsed.ok) {
      skipped.push({ name: entry.name, reason: parsed.reason });
      continue;
    }
    const id = noradIdFromSatnum(parsed.satrec.satnum);
    objects.push({
      id,
      name: entry.name,
      group,
      line1: entry.line1,
      line2: entry.line2,
      epochMs: parsed.epochMs,
      satrec: parsed.satrec,
      warnings: parsed.warnings,
      debrisByName: isDebrisByName(entry.name),
    });
  }
  return { objects, skipped };
}

/**
 * Load every group through `source` (a satellite source with readGroup) and merge
 * the result, keyed by NORAD ID. The first group that lists an object wins.
 * @param {object} options
 * @param {{readGroup: Function}} options.source
 * @param {string[]} [options.groups]
 * @param {number} [options.nowMs]
 */
export async function loadCatalog({
  source,
  groups = DEFAULT_GROUPS,
  nowMs = Date.now(),
}) {
  const results = await Promise.allSettled(
    groups.map((group) => source.readGroup(group)),
  );
  const byId = new Map();
  const report = [];
  groups.forEach((group, index) => {
    const result = results[index];
    if (result.status !== 'fulfilled' || !result.value?.ok) {
      const reason =
        result.status === 'rejected'
          ? String(result.reason?.message ?? result.reason)
          : `HTTP ${result.value?.status ?? 'error'}`;
      report.push({ group, status: 'failed', count: 0, reason });
      return;
    }
    const { objects, skipped } = parseCatalogText(result.value.text, { group });
    let added = 0;
    for (const object of objects) {
      if (Number.isNaN(object.id) || byId.has(object.id)) continue;
      byId.set(object.id, object);
      added++;
    }
    report.push({
      group,
      status: result.value.stale ? 'stale' : 'ok',
      count: added,
      skipped: skipped.length,
    });
  });
  const objects = [...byId.values()];
  for (const object of objects) {
    object.freshness = tleFreshness(object.epochMs, nowMs);
  }
  const usable = report.some((row) => row.status !== 'failed');
  return {
    objects,
    groups: report,
    fetchedAtMs: nowMs,
    usable,
  };
}

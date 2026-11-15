/**
 * Prediction-change intelligence: how a conjunction prediction moved between
 * two screening runs (usually across a TLE update), and a bounded run history.
 *
 * Pure functions plus a storage wrapper. Storage access is guarded: a
 * private window or blocked storage degrades to in-memory history.
 */

const MAX_RUNS = 20;
const STORAGE_KEY = 'orbital-watch.history.v1';

/** Stable key for an unordered object pair. */
export function pairKey(a, b) {
  const x = String(a.id);
  const y = String(b.id);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/**
 * Match each current event to the previous event for the same pair with the
 * nearest TCA, within `toleranceS`. Each previous event matches at most once.
 * Output rows report TCA drift (current minus previous) and miss drift.
 * @param {object[]} previous events from an earlier run
 * @param {object[]} current events from the newer run
 * @param {{toleranceS?: number}} [options]
 */
export function diffPredictions(previous, current, { toleranceS = 3600 } = {}) {
  const used = new Set();
  const rows = [];
  const toleranceMs = toleranceS * 1000;
  for (const event of [...current].sort((p, q) => p.tcaMs - q.tcaMs)) {
    const key = pairKey(event.a, event.b);
    let best = null;
    let bestIndex = -1;
    previous.forEach((old, index) => {
      if (used.has(index) || pairKey(old.a, old.b) !== key) return;
      const gap = Math.abs(old.tcaMs - event.tcaMs);
      if (
        gap <= toleranceMs &&
        (!best || gap < Math.abs(best.tcaMs - event.tcaMs))
      ) {
        best = old;
        bestIndex = index;
      }
    });
    if (best) {
      used.add(bestIndex);
      rows.push({
        pair: key,
        a: event.a,
        b: event.b,
        status: 'updated',
        prevTcaMs: best.tcaMs,
        newTcaMs: event.tcaMs,
        tcaDriftS: (event.tcaMs - best.tcaMs) / 1000,
        prevMissKm: best.missKm,
        newMissKm: event.missKm,
        missDriftKm: event.missKm - best.missKm,
      });
    } else {
      rows.push({
        pair: key,
        a: event.a,
        b: event.b,
        status: 'new',
        prevTcaMs: null,
        newTcaMs: event.tcaMs,
        tcaDriftS: null,
        prevMissKm: null,
        newMissKm: event.missKm,
        missDriftKm: null,
      });
    }
  }
  const dropped = previous
    .filter((_, index) => !used.has(index))
    .map((old) => ({
      pair: pairKey(old.a, old.b),
      a: old.a,
      b: old.b,
      status: 'dropped',
      prevTcaMs: old.tcaMs,
      prevMissKm: old.missKm,
    }));
  return { rows, dropped };
}

/** Append a run, keeping the most recent `MAX_RUNS`. Pure. */
export function appendRun(history, run) {
  return [...history, run].slice(-MAX_RUNS);
}

/**
 * Store and load run history. `storage` defaults to localStorage when present.
 * Every access is guarded; failures return empty or unchanged history.
 */
export function createHistoryStore(storage = globalThis.localStorage) {
  let memory = [];
  return {
    load() {
      try {
        const raw = storage?.getItem(STORAGE_KEY);
        if (!raw) return (memory = []);
        const parsed = JSON.parse(raw);
        memory = Array.isArray(parsed) ? parsed.slice(-MAX_RUNS) : [];
      } catch {
        memory = [];
      }
      return memory;
    },
    save(runs) {
      memory = runs.slice(-MAX_RUNS);
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify(memory));
      } catch {
        // Storage full or blocked: the in-memory copy still serves this session.
      }
      return memory;
    },
  };
}

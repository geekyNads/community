/**
 * Orbital Watch controller: catalog refresh with cache-on-failure, screening runs
 * with progress and cancellation, and run history. No DOM, no Cesium. The Vue
 * view subscribes and renders snapshots.
 */
import { loadCatalog, DEFAULT_GROUPS } from './catalog.js';
import { screenConjunctions, SCREENING_DEFAULTS } from './conjunction.js';
import { diffPredictions, appendRun, createHistoryStore } from './history.js';

/** A catalog older than this is refreshed on the next request. Ms. */
export const CATALOG_MAX_AGE_MS = 30 * 60 * 1000;

/** Screening window and object-count presets offered by the UI. */
export const WINDOW_PRESETS_H = Object.freeze([6, 24, 72]);
export const MAX_OBJECTS_DEFAULT = 300;

export function createOrbitalWatch({
  source,
  historyStore = createHistoryStore(),
  now = () => Date.now(),
  screen = screenConjunctions,
  loadCatalogFn = loadCatalog,
} = {}) {
  if (typeof source?.readGroup !== 'function')
    throw new TypeError('An orbital catalog source is required');

  const state = {
    catalog: null, // last usable catalog (kept when a refresh fails)
    catalogStatus: 'idle', // idle | loading | ready | stale | error
    catalogError: null,
    catalogFetchedAtMs: null,
    run: null, // latest run: { events, stats, explanation, diff, startedAtMs, finishedAtMs, ... }
    runStatus: 'idle', // idle | running | done | error | cancelled
    runProgress: 0,
    runError: null,
    history: historyStore.load(),
  };
  const listeners = new Set();
  let controller = null;
  let runSeq = 0;

  const snapshot = () => ({ ...state, history: [...state.history] });
  const emit = () => {
    const snap = snapshot();
    for (const fn of listeners) fn(snap);
  };

  async function refreshCatalog({
    groups = DEFAULT_GROUPS,
    force = false,
  } = {}) {
    const fresh =
      state.catalog &&
      state.catalogFetchedAtMs !== null &&
      now() - state.catalogFetchedAtMs < CATALOG_MAX_AGE_MS;
    if (fresh && !force) return state.catalog;
    state.catalogStatus = 'loading';
    emit();
    try {
      const next = await loadCatalogFn({ source, groups, nowMs: now() });
      if (!next.usable) {
        // Keep the previous catalog and say so.
        state.catalogStatus = state.catalog ? 'stale' : 'error';
        state.catalogError = 'No CelesTrak group could be read.';
      } else {
        state.catalog = next;
        state.catalogFetchedAtMs = next.fetchedAtMs;
        state.catalogStatus = next.groups.some((g) => g.status === 'failed')
          ? 'stale'
          : 'ready';
        state.catalogError = null;
      }
    } catch (error) {
      state.catalogStatus = state.catalog ? 'stale' : 'error';
      state.catalogError = String(error?.message ?? error);
    }
    emit();
    return state.catalog;
  }

  /**
   * Screen the selected groups over a window. Cancels any run in flight.
   * @param {object} options
   * @param {string[]} [options.groups]
   * @param {number} [options.windowH]
   * @param {number} [options.thresholdKm]
   * @param {number} [options.maxObjects]
   */
  async function runScreening({
    groups = DEFAULT_GROUPS,
    windowH = 24,
    thresholdKm = SCREENING_DEFAULTS.thresholdKm,
    maxObjects = MAX_OBJECTS_DEFAULT,
  } = {}) {
    if (!state.catalog) throw new Error('Load the catalog before screening');
    controller?.abort();
    controller = new AbortController();
    const seq = ++runSeq;
    const startedAtMs = now();
    const wanted = new Set(groups);
    const pool = state.catalog.objects.filter((o) => wanted.has(o.group));
    const objects = pool.slice(0, maxObjects);
    state.runStatus = 'running';
    state.runProgress = 0;
    state.runError = null;
    emit();
    try {
      const result = await screen({
        objects,
        startMs: startedAtMs,
        endMs: startedAtMs + windowH * 3600 * 1000,
        thresholdKm,
        signal: controller.signal,
        onProgress: (f) => {
          if (seq !== runSeq) return;
          state.runProgress = f;
          emit();
        },
      });
      if (seq !== runSeq) return null;
      const previous = state.history.at(-1)?.events ?? [];
      const diff = diffPredictions(previous, result.events);
      const run = {
        id: `run-${startedAtMs}`,
        startedAtMs,
        finishedAtMs: now(),
        groups: [...wanted],
        windowH,
        thresholdKm,
        objectCount: objects.length,
        truncatedFrom: pool.length > objects.length ? pool.length : null,
        events: result.events,
        stats: result.stats,
        explanation: result.explanation,
        diff,
        tleEpochsMs: Object.fromEntries(
          objects.map((o) => [String(o.id), o.epochMs]),
        ),
      };
      state.run = run;
      state.history = appendRun(state.history, run);
      historyStore.save(state.history);
      state.runStatus = 'done';
      state.runProgress = 1;
      emit();
      return run;
    } catch (error) {
      if (seq !== runSeq) return null;
      if (error?.name === 'AbortError') state.runStatus = 'cancelled';
      else {
        state.runStatus = 'error';
        state.runError = String(error?.message ?? error);
      }
      emit();
      return null;
    }
  }

  function cancelRun() {
    controller?.abort();
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      fn(snapshot());
      return () => listeners.delete(fn);
    },
    snapshot,
    refreshCatalog,
    runScreening,
    cancelRun,
  };
}

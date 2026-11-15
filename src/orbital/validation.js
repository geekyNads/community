/**
 * Validation harness: compares engine conjunctions with an independent reference
 * list. It computes metrics only. It does not claim validation: that needs a
 * reference dataset actually run through the engine, and the result must be
 * reported with its dataset and date.
 */
import { pairKey } from './history.js';

/**
 * Greedy one-to-one match: same pair, nearest TCA within `tcaToleranceS`.
 * @param {object[]} engineEvents
 * @param {object[]} referenceEvents each with a, b, tcaMs, missKm
 * @param {{tcaToleranceS?: number}} [options]
 */
export function compareToReference(
  engineEvents,
  referenceEvents,
  { tcaToleranceS = 300 } = {},
) {
  const toleranceMs = tcaToleranceS * 1000;
  const usedEngine = new Set();
  const matches = [];
  const unmatchedReference = [];

  for (const ref of referenceEvents) {
    const key = pairKey(ref.a, ref.b);
    let bestIndex = -1;
    let bestGap = Infinity;
    engineEvents.forEach((event, index) => {
      if (usedEngine.has(index) || pairKey(event.a, event.b) !== key) return;
      const gap = Math.abs(event.tcaMs - ref.tcaMs);
      if (gap <= toleranceMs && gap < bestGap) {
        bestGap = gap;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) {
      unmatchedReference.push(ref);
      continue;
    }
    usedEngine.add(bestIndex);
    const event = engineEvents[bestIndex];
    matches.push({
      pair: key,
      tcaErrorS: (event.tcaMs - ref.tcaMs) / 1000,
      missErrorKm: event.missKm - ref.missKm,
    });
  }

  const falsePositives = engineEvents.filter(
    (_, index) => !usedEngine.has(index),
  );
  const summarize = (values) => {
    if (!values.length) return null;
    const abs = values.map(Math.abs);
    return {
      n: values.length,
      meanAbs: abs.reduce((s, v) => s + v, 0) / abs.length,
      maxAbs: Math.max(...abs),
      mean: values.reduce((s, v) => s + v, 0) / values.length,
    };
  };

  return {
    referenceCount: referenceEvents.length,
    engineCount: engineEvents.length,
    matched: matches.length,
    falseNegatives: unmatchedReference.length,
    falsePositives: falsePositives.length,
    detectionRate: referenceEvents.length
      ? matches.length / referenceEvents.length
      : null,
    tcaErrorS: summarize(matches.map((m) => m.tcaErrorS)),
    missErrorKm: summarize(matches.map((m) => m.missErrorKm)),
    tcaToleranceS,
    matches,
  };
}

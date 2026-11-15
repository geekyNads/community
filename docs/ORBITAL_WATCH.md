# Orbital Watch

Orbital Watch is the space situational awareness layer built on God's Eye View.
It reads CelesTrak element sets, propagates them with SGP4, screens the catalog
for close approaches, and explains each result. The globe is the interface. The
screening engine is the product.

Code: `src/orbital/` (engine, pure JavaScript, no DOM or Cesium), the dashboard in
`src/ui/views/OrbitalWatchView.vue`, and the 3D drawing in `src/orbital/render.js`.

## What it does

- **Catalog.** TLE groups from CelesTrak, read through the proxy and cache the
  globe already uses (`src/layers/satellites/source.js`). Objects are keyed by
  NORAD ID and carry their TLE epoch and a freshness label. A failed group is
  reported. If a refresh fails, the previous catalog stays on screen, marked stale.
- **Propagation.** SGP4 via `satellite.js` 6.0.2 (`src/orbital/propagator.js`).
  TLE checksums are checked and reported. Malformed sets are skipped and counted.
- **Screening.** `screenConjunctions()` in `src/orbital/conjunction.js`.
- **Encounter inspection.** Separation against time, a closest-approach inset,
  orbital elements for both objects, and a "why flagged" list. **Show in 3D**
  draws both propagated tracks and the TCA marker on the globe.
- **Prediction change.** Each run is stored (`src/orbital/history.js`). The History
  tab compares the latest run with the previous one by pair: TCA drift, miss drift,
  and new or dropped encounters.
- **Validation harness.** `src/orbital/validation.js` compares engine output with
  an external reference list. See "Validation status".

## Frames and units

| Quantity | Frame / unit |
| --- | --- |
| SGP4 state (`propagate`) | TEME; position km, velocity km/s |
| Separation, miss distance, relative speed, TCA | computed in TEME; km, km/s |
| 3D and chart positions | ECEF, by a rotation about z by GMST |
| Geodetic subpoint | GMST only (ignores polar motion and nutation) |
| Times | UTC epoch milliseconds in code; UTC text in the UI |

Both objects in a pair share a frame and a GMST at each instant, so a separation
is the same in TEME and ECEF. `src/orbital/track.test.mjs` checks this.

## Screening method

1. **Sample.** Every object is propagated on a fixed grid, `stepS` (default 60 s),
   from one step before the window to one step after it, so boundary events are
   kept.
2. **Bound the candidates.** A pair at sample *k* is a candidate only if its
   separation is at most `D + 0.6 · Vrel · stepS`, where `D` is the threshold and
   `Vrel` the relative speed at *k*. For near-linear relative motion, a dip's
   nearest sample lies within `stepS/2` of the true minimum, so its separation is at
   most `D + Vrel · stepS/2`. The 0.6 factor is that half-step bound with a 20%
   margin for curvature. Pairs come from a uniform spatial hash whose cell size,
   `D + 1.2 · vmax · stepS`, is a global bound, so only neighbouring cells are
   compared.
3. **Co-location.** A pair whose relative speed stays below 5 m/s is co-located
   (docked vehicles, formation flying). It is excluded and counted in
   `stats.colocatedPairs`. Without this, a flat separation makes every sample look
   like a minimum.
4. **Local minimum.** Only sampled local minima are refined.
5. **Refine.** Golden-section search on the separation over `[t(k−1), t(k+1)]`,
   with SGP4 propagation at every evaluation, to a TCA tolerance of 5 ms
   (`refineToleranceS = 0.005`). A minimum on a bracket edge is rejected, not guessed.
6. **Classify.** Events with miss ≤ `D` are kept. Tiers are by miss distance: `close`
   (≤ 1 km) and `screening` (≤ `D`). Ranking is by miss distance, then TCA. There
   is no composite score.

Why the tolerance is 5 ms: near closest approach, separation is
`√(m² + (v·δt)²)`, so a timing error δt adds about `(v·δt)²/(2m)` to the miss. At
10.8 km/s, the old 0.5 s tolerance left a 0.11 km error on a 1.95 km miss. The test
`TCA refinement keeps miss error below 1 m at LEO relative speed` covers this.

## Explanations

Each event carries an `explanation`: method, frame, sampling step, candidate bound,
refinement tolerance, bracket, the TLE epoch of each object, and the limitations
below. The dashboard shows the threshold test, miss, relative velocity, time to TCA,
the source data age of each object, and the refinement settings.

## Limitations (shown in the UI)

- **Not a collision probability.** TLEs carry no covariance, so no probability is
  computed. Miss distance is a separation. The tiers are distance classes only: a
  "critical" label would be a risk claim the data cannot support.
- **TLE uncertainty grows with epoch age.** Labels: fresh ≤ 3 days, aging ≤ 14,
  stale beyond. These are operator heuristics, not an accuracy model.
- **Debris** is flagged only by name (`… DEB`). The SATCAT object type is not used,
  so "active" is not computed. The UI says so.
- **Frames.** TEME is quasi-inertial, which is adequate over the screened windows.
  Geodetic positions ignore polar motion and nutation.
- **Coverage.** Only the selected groups, capped at 300 objects per run. The UI
  reports truncation.

## Performance and ceilings

- Cost is about `objects × samples` propagations, plus a candidate scan that is
  quadratic inside a cell. One dev-browser run of the default (230 objects, 24 h,
  60 s step) took about 1.7 s on the main thread, with yields between steps. That
  is a single observation, not a benchmark.
- Refinement dominates for dense catalogs. Upgrade paths: a Web Worker for the
  screen, and a finer spatial grid per time slice.

## Validation status

- **Unit tests** (`src/orbital/*.test.mjs`, 32 tests): TLE parsing and checksums;
  SGP4 sanity (ISS radius and speed); TEME/ECEF rotation invariance; golden-section
  and TCA refinement against closed-form linear encounters; candidate detection
  against brute force (60 linear objects, every pair compared); co-location
  exclusion; catalog merge and failure reporting; prediction-change matching;
  validation metrics.
- **Not done.** No independent reference dataset has been run through the engine,
  so no detection rate, TCA error, or false-positive rate is claimed. The harness
  is ready for a dataset such as CelesTrak SOCRATES reports but has not been run
  against one.

## Installation and configuration

Orbital Watch uses the project's existing dependencies (`satellite.js`, `cesium`,
`vue`). There is nothing extra to install and no key to add.

```bash
npm install
npm run dev
```

Open the app and use the **ORBITAL WATCH** tab on the right edge. Live catalog data
comes from the same CelesTrak proxy the globe uses, so run it through `npm run dev`
or the Docker setup. Without network access, the catalog cannot load, and the panel
says so.

Screening defaults live in code, not in settings: `SCREENING_DEFAULTS` in
`src/orbital/conjunction.js` (threshold 5 km, step 60 s, TCA tolerance 5 ms,
co-location 5 m/s), `DEFAULT_GROUPS` in `src/orbital/catalog.js`, and
`MAX_OBJECTS_DEFAULT` in `src/orbital/watch.js` (300).

## Tests

```bash
node --test src/orbital/*.test.mjs
```

The full suite runs with `npm test`. Open item: the translation check (`npm run i18n`)
reports the new strings as missing from the 13 locale catalogs. They are marked for
translation with `t()`, but not yet translated. `npm run i18n -- --missing <locale>`
lists what each locale needs.

## Files

| File | Role |
| --- | --- |
| `src/orbital/propagator.js` | TLE parsing and checksums, SGP4 state, TLE age labels |
| `src/orbital/conjunction.js` | Screening, refinement, tiers, explanations |
| `src/orbital/catalog.js` | Group loading, merge by NORAD ID, failure report |
| `src/orbital/watch.js` | Controller: catalog cache, cancellable runs, history |
| `src/orbital/history.js` | Prediction-change diff and run history store |
| `src/orbital/validation.js` | Reference comparison metrics |
| `src/orbital/track.js` | Encounter samples, ECEF, subpoints, orbital elements |
| `src/orbital/render.js` | Cesium encounter drawing |
| `src/orbital/viewerRegistry.js` | Publishes the globe viewer to the dashboard |
| `src/orbital/instance.js` | The page's controller, on the globe's CelesTrak source |
| `src/ui/views/OrbitalWatchView.vue` | Dashboard |

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { msg, t } from '../../i18n/index.js';
import { orbitalWatch } from '../../orbital/instance.js';
import { DEFAULT_GROUPS } from '../../orbital/catalog.js';
import { WINDOW_PRESETS_H, MAX_OBJECTS_DEFAULT } from '../../orbital/watch.js';
import { encounterSamples, orbitalElements, subpoint } from '../../orbital/track.js';
import { propagateState, tleFreshness } from '../../orbital/propagator.js';
import { currentViewer, onViewer } from '../../orbital/viewerRegistry.js';
import { drawEncounter } from '../../orbital/render.js';

// Literal msg() keys, so npm run i18n can find each label.
const LABELS = {
  fresh: msg('fresh'),
  aging: msg('aging'),
  stale: msg('stale'),
  new: msg('new'),
  updated: msg('updated'),
};

const TABS = [
  ['conjunctions', msg('Conjunctions')],
  ['objects', msg('Objects')],
  ['encounter', msg('Encounter')],
  ['history', msg('History')],
];

const open = ref(false);
const tab = ref('conjunctions');
const snap = ref(orbitalWatch.snapshot());
const clockMs = ref(Date.now());
const viewer = ref(currentViewer());

const windowH = ref(24);
const thresholdKm = ref(5);
// Small groups by default: they fit the screening cap without silent truncation.
const groups = ref(['stations', 'visual', 'gps-ops', 'galileo']);
const selectedEventId = ref(null);
const selectedObjectId = ref(null);
const query = ref('');
const groupFilter = ref('all');

let unsubscribeWatch = () => {};
let unsubscribeViewer = () => {};
let clockTimer = null;
let removeDrawing = () => {};

const fmtUtc = (ms) =>
  ms == null || !Number.isFinite(ms)
    ? '—'
    : new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
const fmtNum = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
function fmtSpan(seconds) {
  const s = Math.round(Math.abs(seconds));
  const sign = seconds < 0 ? '−' : '+';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${sign}${h ? `${h}h ` : ''}${String(m).padStart(2, '0')}m ${String(r).padStart(2, '0')}s`;
}

const activeThresholdKm = computed(() => snap.value.run?.thresholdKm ?? thresholdKm.value);
const catalog = computed(() => snap.value.catalog);
const objects = computed(() => catalog.value?.objects ?? []);
const freshnessCounts = computed(() => {
  const c = { fresh: 0, aging: 0, stale: 0 };
  for (const o of objects.value) c[o.freshness?.label ?? 'stale'] += 1;
  return c;
});
const debrisCount = computed(() => objects.value.filter((o) => o.debrisByName).length);
const events = computed(() => snap.value.run?.events ?? []);
const closeCount = computed(() => events.value.filter((e) => e.tier === 'close').length);
const selectedEvent = computed(() => events.value.find((e) => e.id === selectedEventId.value) ?? null);
const latestRunStats = computed(() => snap.value.run?.stats ?? null);
const diffRows = computed(() => snap.value.run?.diff?.rows ?? []);
const diffDropped = computed(() => snap.value.run?.diff?.dropped ?? []);

const objectById = computed(() => {
  const map = new Map();
  for (const o of objects.value) map.set(String(o.id), o);
  return map;
});
const selectedObject = computed(() => objectById.value.get(String(selectedObjectId.value)) ?? null);

const filteredObjects = computed(() => {
  const q = query.value.trim().toLowerCase();
  return objects.value
    .filter((o) => groupFilter.value === 'all' || o.group === groupFilter.value)
    .filter((o) => !q || o.name.toLowerCase().includes(q) || String(o.id).includes(q))
    .slice(0, 200);
});

const groupCounts = computed(() => {
  const counts = {};
  for (const o of objects.value) counts[o.group] = (counts[o.group] ?? 0) + 1;
  return counts;
});

const screenedCount = computed(() => latestRunStats.value?.objects ?? 0);

const eventRows = computed(() =>
  events.value.map((e, i) => ({
    ...e,
    rank: i + 1,
    tcaS: (e.tcaMs - clockMs.value) / 1000,
  })),
);

/** Why an encounter was flagged. Every number is from the run, nothing is scored. */
const why = computed(() => {
  const e = selectedEvent.value;
  if (!e) return [];
  const run = snap.value.run;
  const ages = [e.a.id, e.b.id].map((id) => {
    const o = objectById.value.get(String(id));
    return o ? { name: o.name, ...o.freshness } : null;
  });
  return [
    {
      k: t('Threshold'),
      v: t('Miss {miss} km ≤ screening threshold {threshold} km', {
        miss: fmtNum(e.missKm, 3),
        threshold: fmtNum(activeThresholdKm.value, 1),
      }),
    },
    {
      k: t('Predicted minimum separation'),
      v: t('{miss} km at TCA (golden-section refined)', { miss: fmtNum(e.missKm, 3) }),
    },
    {
      k: t('Relative velocity at TCA'),
      v: t('{speed} km/s (TEME)', { speed: fmtNum(e.relVelKmS, 3) }),
    },
    {
      k: t('Time to TCA from now'),
      v: fmtSpan((e.tcaMs - clockMs.value) / 1000),
    },
    {
      k: t('Source data age'),
      v: ages
        .map((a) =>
          a
            ? t('{name}: {days} d ({label})', {
                name: a.name,
                days: fmtNum(a.ageDays, 1),
                label: a.label,
              })
            : t('unknown'),
        )
        .join(' · '),
    },
    {
      k: t('Refinement'),
      v: t('Sampled every {step} s; TCA tolerance {tolerance} s', {
        step: run?.stats?.stepS ?? '—',
        tolerance: run?.explanation?.refineToleranceS ?? '—',
      }),
    },
    {
      k: t('Limitations'),
      v: t(
        'Screening alert from TLE-derived states. No covariance, so no collision probability is stated. Miss distance is a separation.',
      ),
    },
  ];
});

const orbitParams = computed(() => {
  const e = selectedEvent.value;
  if (!e) return [];
  return [e.a, e.b].map((ref) => {
    const o = objectById.value.get(String(ref.id));
    return { name: ref.name, el: o ? orbitalElements(o.line2) : null };
  });
});

// Encounter chart: separation against time around the TCA, from SGP4 samples.
const chart = computed(() => {
  const e = selectedEvent.value;
  if (!e) return null;
  const oa = objectById.value.get(String(e.a.id));
  const ob = objectById.value.get(String(e.b.id));
  if (!oa || !ob) return null;
  const halfSpanS = 45 * 60;
  const frames = encounterSamples({ a: oa, b: ob, centerMs: e.tcaMs, halfSpanS, stepS: 30 });
  const pts = frames.filter((f) => f.separationKm !== null);
  if (pts.length < 2) return { frames, pts, empty: true };
  const W = 600;
  const H = 180;
  const padL = 44;
  const padB = 26;
  const t0 = e.tcaMs - halfSpanS * 1000;
  const maxKm = Math.max(...pts.map((p) => p.separationKm), activeThresholdKm.value * 1.5);
  const x = (ms) => padL + ((ms - t0) / (2 * halfSpanS * 1000)) * (W - padL - 8);
  const y = (km) => 8 + (1 - km / maxKm) * (H - padB - 8);
  return {
    frames,
    pts,
    W,
    H,
    padL,
    padB,
    line: pts.map((p) => `${x(p.ms).toFixed(1)},${y(p.separationKm).toFixed(1)}`).join(' '),
    tcaX: x(e.tcaMs),
    thresholdY: y(activeThresholdKm.value),
    yTicks: [0, maxKm / 2, maxKm].map((v) => ({ v, y: y(v) })),
    xTicks: [-45, -30, -15, 0, 15, 30, 45].map((m) => ({ m, x: x(e.tcaMs + m * 60000) })),
  };
});

// Closest-approach inset: ±60 s at 0.25 s steps on a log scale, so a 1–2 km
// minimum stays visible next to a separation of thousands of km. The grid is
// offset from the TCA, so no sample lands on it: the sampled minimum is an
// independent check, and it must not fall below the refined miss.
const zoom = computed(() => {
  const e = selectedEvent.value;
  const oa = e && objectById.value.get(String(e.a.id));
  const ob = e && objectById.value.get(String(e.b.id));
  if (!e || !oa || !ob) return null;
  const halfSpanS = 60;
  const centerMs = e.tcaMs + 125;
  const frames = encounterSamples({ a: oa, b: ob, centerMs, halfSpanS, stepS: 0.25 });
  const pts = frames.filter((f) => f.separationKm !== null);
  if (pts.length < 2) return null;
  const W = 600;
  const H = 150;
  const padL = 44;
  const padB = 22;
  const lo = 0.1;
  const hi = Math.max(...pts.map((p) => p.separationKm), activeThresholdKm.value * 2) * 1.2;
  const lg = (km) => Math.log10(Math.max(km, lo));
  const t0 = centerMs - halfSpanS * 1000;
  const x = (ms) => padL + ((ms - t0) / (2 * halfSpanS * 1000)) * (W - padL - 8);
  const y = (km) => 8 + (1 - (lg(km) - lg(lo)) / (lg(hi) - lg(lo))) * (H - padB - 8);
  return {
    W,
    H,
    padL,
    padB,
    line: pts.map((p) => `${x(p.ms).toFixed(1)},${y(p.separationKm).toFixed(1)}`).join(' '),
    tcaX: x(e.tcaMs),
    thresholdY: y(activeThresholdKm.value),
    minKm: Math.min(...pts.map((p) => p.separationKm)),
    ticks: [0.1, 1, 10, 100, 1000, 10000]
      .filter((v) => v >= lo && v <= hi)
      .map((v) => ({ v, y: y(v) })),
  };
});

const catalogClass = computed(() => `s-${snap.value.catalogStatus}`);
const runClass = computed(() => `s-${snap.value.runStatus}`);

const runStatusLabel = computed(() => {
  switch (snap.value.runStatus) {
    case 'running':
      return t('Screening {percent}%', { percent: Math.round(snap.value.runProgress * 100) });
    case 'done':
      return t('Screen complete');
    case 'cancelled':
      return t('Screen cancelled');
    case 'error':
      return t('Screen failed: {message}', { message: snap.value.runError });
    default:
      return t('Not screened yet');
  }
});

const catalogLabel = computed(() => {
  const s = snap.value.catalogStatus;
  if (s === 'loading') return t('Loading catalog…');
  if (s === 'error')
    return t('Catalog unavailable: {message}', {
      message: snap.value.catalogError ?? t('unknown error'),
    });
  if (s === 'stale')
    return t('Catalog stale: {message}', {
      message: snap.value.catalogError ?? t('a group could not be refreshed'),
    });
  if (s === 'ready') return t('Catalog {time}', { time: fmtUtc(snap.value.catalogFetchedAtMs) });
  return t('Catalog not loaded');
});

function toggleGroup(group) {
  groups.value = groups.value.includes(group)
    ? groups.value.filter((g) => g !== group)
    : [...groups.value, group];
}

function refresh() {
  return orbitalWatch.refreshCatalog({ force: true });
}

function screen() {
  return orbitalWatch.runScreening({
    groups: groups.value,
    windowH: windowH.value,
    thresholdKm: thresholdKm.value,
    maxObjects: MAX_OBJECTS_DEFAULT,
  });
}

function inspect(event) {
  selectedEventId.value = event.id;
  tab.value = 'encounter';
}

function show3d() {
  const v = viewer.value;
  const e = selectedEvent.value;
  const c = chart.value;
  if (!v || !e || !c || c.empty) return;
  removeDrawing();
  removeDrawing = drawEncounter(v, {
    frames: c.frames,
    aName: e.a.name,
    bName: e.b.name,
    tcaMs: e.tcaMs,
  });
}

function clear3d() {
  removeDrawing();
  removeDrawing = () => {};
}

const objectState = computed(() => {
  const o = selectedObject.value;
  if (!o) return null;
  const s = propagateState(o, clockMs.value);
  if (!s.ok) return { error: s.reason };
  return {
    sub: subpoint(s.rKm, clockMs.value),
    el: orbitalElements(o.line2),
  };
});

onMounted(() => {
  unsubscribeWatch = orbitalWatch.subscribe((next) => {
    snap.value = next;
    if (!selectedEventId.value && next.run?.events?.length)
      selectedEventId.value = next.run.events[0].id;
  });
  unsubscribeViewer = onViewer((v) => {
    viewer.value = v;
  });
  clockTimer = setInterval(() => (clockMs.value = Date.now()), 1000);
  orbitalWatch.refreshCatalog();
});

onUnmounted(() => {
  unsubscribeWatch();
  unsubscribeViewer();
  clearInterval(clockTimer);
  removeDrawing();
});

watch(selectedEventId, () => clear3d());
</script>

<template>
  <div class="ow-root" :class="{ open }">
    <button
      type="button"
      class="ow-tab"
      :aria-expanded="open"
      aria-controls="orbital-watch"
      @click="open = !open"
    >
      <span class="ow-tab-label">{{ t('ORBITAL WATCH') }}</span>
      <span v-if="closeCount" class="ow-tab-count" :title="t('{count} within 1 km', { count: closeCount })">{{ closeCount }}</span>
    </button>

    <aside id="orbital-watch" class="ow-panel" :aria-label="t('Orbital Watch')">
      <header class="ow-head">
        <div class="ow-title">
          <span class="ow-mark" aria-hidden="true"></span>
          <span>{{ t('ORBITAL WATCH') }}</span>
          <span class="ow-utc">{{ fmtUtc(clockMs) }}</span>
        </div>
        <div class="ow-catalog" :class="catalogClass">{{ catalogLabel }}</div>
      </header>

      <section class="ow-overview" :aria-label="t('Global overview')">
        <div class="ow-stat">
          <span class="ow-k">{{ t('Tracked objects') }}</span>
          <span class="ow-v">{{ objects.length }}</span>
        </div>
        <div class="ow-stat">
          <span class="ow-k">{{ t('Debris (by name)') }}</span>
          <span class="ow-v">{{ debrisCount }}</span>
        </div>
        <div class="ow-stat">
          <span class="ow-k">{{ t('TLE fresh / aging / stale') }}</span>
          <span class="ow-v">{{ freshnessCounts.fresh }} / {{ freshnessCounts.aging }} / {{ freshnessCounts.stale }}</span>
        </div>
        <div class="ow-stat">
          <span class="ow-k">{{ t('Encounters ≤ {threshold} km', { threshold: fmtNum(activeThresholdKm, 0) }) }}</span>
          <span class="ow-v">{{ events.length }}<span class="ow-sub"> · {{ t('{count} ≤ 1 km', { count: closeCount }) }}</span></span>
        </div>
      </section>

      <nav class="ow-tabs" role="tablist">
        <button
          v-for="[id, label] in TABS"
          :key="id"
          type="button"
          role="tab"
          :aria-selected="tab === id"
          :class="{ on: tab === id }"
          @click="tab = id"
        >{{ t(label) }}</button>
      </nav>

      <!-- CONJUNCTIONS -->
      <section v-if="tab === 'conjunctions'" class="ow-body" role="tabpanel">
        <div class="ow-controls">
          <div class="ow-seg" role="group" :aria-label="t('Window')">
            <span class="ow-label">{{ t('Window') }}</span>
            <button v-for="h in WINDOW_PRESETS_H" :key="h" type="button" :class="{ on: windowH === h }" @click="windowH = h">{{ t('{hours} h', { hours: h }) }}</button>
          </div>
          <div class="ow-seg" role="group" :aria-label="t('Threshold')">
            <span class="ow-label">{{ t('Threshold') }}</span>
            <button v-for="k in [1, 5, 10]" :key="k" type="button" :class="{ on: thresholdKm === k }" @click="thresholdKm = k">{{ t('{km} km', { km: k }) }}</button>
          </div>
          <div class="ow-groups" role="group" :aria-label="t('Groups')">
            <span class="ow-label">{{ t('Groups') }}</span>
            <button
              v-for="g in DEFAULT_GROUPS"
              :key="g"
              type="button"
              :class="{ on: groups.includes(g) }"
              :aria-pressed="groups.includes(g)"
              @click="toggleGroup(g)"
            >{{ g }} <span class="ow-dim">{{ groupCounts[g] ?? 0 }}</span></button>
          </div>
          <div class="ow-actions">
            <button type="button" class="ow-primary" :disabled="snap.runStatus === 'running' || !objects.length || !groups.length" @click="screen">{{ t('Screen') }}</button>
            <button v-if="snap.runStatus === 'running'" type="button" @click="orbitalWatch.cancelRun()">{{ t('Cancel') }}</button>
            <button type="button" :disabled="snap.catalogStatus === 'loading'" @click="refresh">{{ t('Refresh catalog') }}</button>
          </div>
        </div>

        <div class="ow-status" :class="runClass">
          <span>{{ runStatusLabel }}</span>
          <span v-if="snap.runStatus === 'running'" class="ow-bar"><span :style="{ width: Math.round(snap.runProgress * 100) + '%' }"></span></span>
        </div>

        <p v-if="snap.run" class="ow-meta">
          {{ t('{objects} objects · {samples} samples at {step} s · {propagations} propagations ({failed} failed) · {pairs} candidate pairs → {refined} refined · {ms} ms', { objects: screenedCount, samples: latestRunStats.samples, step: latestRunStats.stepS, propagations: latestRunStats.propagations.toLocaleString(), failed: latestRunStats.propagationFailures, pairs: latestRunStats.candidatePairs, refined: latestRunStats.localMinima, ms: latestRunStats.elapsedMs }) }}
          <span v-if="snap.run.truncatedFrom" class="ow-warn"> · {{ t('capped at {shown} of {total} objects', { shown: screenedCount, total: snap.run.truncatedFrom }) }}</span>
        </p>

        <div v-if="!snap.run" class="ow-empty">
          {{ t('Choose a window and threshold, then Screen. Results cover only the selected groups and are computed in this browser.') }}
        </div>
        <div v-else-if="!eventRows.length" class="ow-empty">
          {{ t('No pair of the {count} screened objects comes within {threshold} km during the next {hours} h.', { count: screenedCount, threshold: fmtNum(snap.run.thresholdKm, 1), hours: snap.run.windowH }) }}
        </div>
        <table v-else class="ow-table">
          <thead>
            <tr>
              <th>#</th><th>{{ t('Object A ↔ B') }}</th><th>{{ t('TCA (UTC)') }}</th><th>Δt</th><th class="r">{{ t('Miss km') }}</th><th class="r">{{ t('Rel v km/s') }}</th><th>{{ t('Class') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in eventRows" :key="row.id" :class="{ sel: row.id === selectedEventId }" tabindex="0" @click="inspect(row)" @keydown.enter="inspect(row)">
              <td class="dim">{{ row.rank }}</td>
              <td><span class="ow-pair">{{ row.a.name }}</span> <span class="dim">↔</span> <span class="ow-pair">{{ row.b.name }}</span></td>
              <td class="mono">{{ fmtUtc(row.tcaMs) }}</td>
              <td class="mono dim">{{ fmtSpan(row.tcaS) }}</td>
              <td class="r mono">{{ fmtNum(row.missKm, 3) }}</td>
              <td class="r mono">{{ fmtNum(row.relVelKmS, 2) }}</td>
              <td><span class="ow-chip" :data-tier="row.tier">{{ row.tier === 'close' ? t('≤ 1 km') : t('screening') }}</span></td>
            </tr>
          </tbody>
        </table>

        <p class="ow-foot">
          {{ t('Screening alerts only. Predictions use TLE-derived SGP4 states in the TEME frame. No covariance is available, so no collision probability is given, and miss distance is not a risk score.') }}
        </p>
      </section>

      <!-- OBJECTS -->
      <section v-else-if="tab === 'objects'" class="ow-body" role="tabpanel">
        <div class="ow-controls">
          <input v-model="query" type="search" :placeholder="t('Name or NORAD ID')" :aria-label="t('Search objects')" />
          <div class="ow-seg" role="group" :aria-label="t('Group')">
            <span class="ow-label">{{ t('Group') }}</span>
            <button type="button" :class="{ on: groupFilter === 'all' }" @click="groupFilter = 'all'">{{ t('all') }}</button>
            <button v-for="g in DEFAULT_GROUPS" :key="g" type="button" :class="{ on: groupFilter === g }" @click="groupFilter = g">{{ g }}</button>
          </div>
        </div>
        <div v-if="!objects.length" class="ow-empty">{{ snap.catalogStatus === 'loading' ? t('Loading catalog…') : t('No catalog loaded. Use Refresh catalog on the Conjunctions tab.') }}</div>
        <div v-else class="ow-list">
          <button
            v-for="o in filteredObjects"
            :key="o.group + o.id"
            type="button"
            :class="{ sel: String(o.id) === String(selectedObjectId) }"
            @click="selectedObjectId = o.id"
          >
            <span class="ow-pair">{{ o.name }}</span>
            <span class="mono dim">{{ o.id }}</span>
            <span class="ow-chip" :data-fresh="o.freshness.label">{{ t(LABELS[o.freshness.label]) }}</span>
          </button>
          <p v-if="filteredObjects.length === 200" class="ow-foot">{{ t('Showing the first 200 matches. Narrow the search.') }}</p>
        </div>

        <div v-if="selectedObject" class="ow-detail">
          <h3>{{ selectedObject.name }}</h3>
          <dl>
            <dt>{{ t('NORAD ID') }}</dt><dd class="mono">{{ selectedObject.id }}</dd>
            <dt>{{ t('Group') }}</dt><dd>{{ selectedObject.group }}</dd>
            <dt>{{ t('Source') }}</dt><dd>{{ t('CelesTrak GP via proxy · TLE epoch {time}', { time: fmtUtc(selectedObject.epochMs) }) }}</dd>
            <dt>{{ t('TLE age') }}</dt><dd class="mono">{{ fmtNum(selectedObject.freshness.ageDays, 2) }} d · {{ t(LABELS[selectedObject.freshness.label]) }}</dd>
            <dt>{{ t('Classification') }}</dt><dd>{{ selectedObject.debrisByName ? t('Debris by name (heuristic)') : t('Not debris by name (no SATCAT type used)') }}</dd>
            <template v-if="objectState?.el">
              <dt>{{ t('Inclination') }}</dt><dd class="mono">{{ fmtNum(objectState.el.inclinationDeg, 3) }}°</dd>
              <dt>{{ t('Eccentricity') }}</dt><dd class="mono">{{ fmtNum(objectState.el.eccentricity, 6) }}</dd>
              <dt>{{ t('Perigee / apogee') }}</dt><dd class="mono">{{ t('{perigee} / {apogee} km', { perigee: fmtNum(objectState.el.perigeeAltKm, 0), apogee: fmtNum(objectState.el.apogeeAltKm, 0) }) }}</dd>
              <dt>{{ t('Period') }}</dt><dd class="mono">{{ t('{period} min', { period: fmtNum(objectState.el.periodMin, 2) }) }}</dd>
            </template>
            <template v-if="objectState?.sub">
              <dt>{{ t('Subpoint now') }}</dt><dd class="mono">{{ t('{lat}°, {lon}° · {alt} km', { lat: fmtNum(objectState.sub.latDeg, 2), lon: fmtNum(objectState.sub.lonDeg, 2), alt: fmtNum(objectState.sub.altKm, 0) }) }}</dd>
            </template>
            <template v-if="objectState?.error"><dt>{{ t('State') }}</dt><dd class="ow-warn">{{ objectState.error }}</dd></template>
          </dl>
          <p class="ow-foot">{{ t('Positions are propagated from the TLE with SGP4 (TEME). They are not observations.') }}</p>
        </div>
      </section>

      <!-- ENCOUNTER -->
      <section v-else-if="tab === 'encounter'" class="ow-body" role="tabpanel">
        <div v-if="!selectedEvent" class="ow-empty">{{ t('Select a conjunction on the Conjunctions tab to inspect the encounter.') }}</div>
        <template v-else>
          <div class="ow-enc-head">
            <div>
              <div class="ow-enc-pair">{{ selectedEvent.a.name }} <span class="dim">↔</span> {{ selectedEvent.b.name }}</div>
              <div class="mono dim">{{ t('TCA {time} ({span})', { time: fmtUtc(selectedEvent.tcaMs), span: fmtSpan((selectedEvent.tcaMs - clockMs) / 1000) }) }}</div>
            </div>
            <div class="ow-enc-kpis">
              <div><span class="ow-k">{{ t('Miss') }}</span><span class="ow-v mono">{{ t('{km} km', { km: fmtNum(selectedEvent.missKm, 3) }) }}</span></div>
              <div><span class="ow-k">{{ t('Rel v') }}</span><span class="ow-v mono">{{ t('{speed} km/s', { speed: fmtNum(selectedEvent.relVelKmS, 2) }) }}</span></div>
            </div>
          </div>

          <div class="ow-actions">
            <button type="button" :disabled="!viewer || !chart || chart.empty" @click="show3d">{{ t('Show in 3D') }}</button>
            <button type="button" @click="clear3d">{{ t('Clear 3D') }}</button>
            <span v-if="!viewer" class="ow-dim">{{ t('Globe not ready.') }}</span>
          </div>

          <figure v-if="chart && !chart.empty" class="ow-chart">
            <figcaption class="ow-k">{{ t('Separation, ±45 min around TCA (SGP4, TEME)') }}</figcaption>
            <svg :viewBox="`0 0 ${chart.W} ${chart.H}`" role="img" :aria-label="t('Separation against time')">
              <g class="ow-grid">
                <line v-for="tk in chart.yTicks" :key="'y' + tk.v" :x1="chart.padL" :x2="chart.W - 8" :y1="tk.y" :y2="tk.y" />
              </g>
              <line class="ow-threshold" :x1="chart.padL" :x2="chart.W - 8" :y1="chart.thresholdY" :y2="chart.thresholdY" />
              <line class="ow-tca" :x1="chart.tcaX" :x2="chart.tcaX" y1="8" :y2="chart.H - chart.padB" />
              <polyline class="ow-line" :points="chart.line" />
              <text v-for="tk in chart.yTicks" :key="'yt' + tk.v" :x="chart.padL - 6" :y="tk.y + 4" text-anchor="end">{{ fmtNum(tk.v, 0) }}</text>
              <text v-for="tk in chart.xTicks" :key="'xt' + tk.m" :x="tk.x" :y="chart.H - 6" text-anchor="middle">{{ tk.m > 0 ? '+' : '' }}{{ tk.m }}m</text>
            </svg>
            <div class="ow-chart-note">
              <span class="ow-dim">{{ t('- - threshold {km} km', { km: fmtNum(activeThresholdKm, 1) }) }}</span> · <span class="ow-dim">{{ t('│ TCA') }}</span> · {{ t('{count} samples (km)', { count: chart.pts.length }) }}
            </div>
          </figure>
          <figure v-if="zoom" class="ow-chart">
            <figcaption class="ow-k">{{ t('Closest approach, ±60 s at 0.25 s steps (log scale)') }}</figcaption>
            <svg :viewBox="`0 0 ${zoom.W} ${zoom.H}`" role="img" :aria-label="t('Closest approach, log scale')">
              <g class="ow-grid">
                <line v-for="tk in zoom.ticks" :key="'zg' + tk.v" :x1="zoom.padL" :x2="zoom.W - 8" :y1="tk.y" :y2="tk.y" />
              </g>
              <line v-if="zoom.thresholdY >= 8" class="ow-threshold" :x1="zoom.padL" :x2="zoom.W - 8" :y1="zoom.thresholdY" :y2="zoom.thresholdY" />
              <line class="ow-tca" :x1="zoom.tcaX" :x2="zoom.tcaX" y1="8" :y2="zoom.H - zoom.padB" />
              <polyline class="ow-line" :points="zoom.line" />
              <text v-for="tk in zoom.ticks" :key="'zt' + tk.v" :x="zoom.padL - 6" :y="tk.y + 4" text-anchor="end">{{ tk.v }}</text>
            </svg>
            <div class="ow-chart-note">{{ t('Check: sampled minimum {sampled} km ≥ refined miss {refined} km (golden-section, TCA tolerance {tolerance} s).', { sampled: fmtNum(zoom.minKm, 3), refined: fmtNum(selectedEvent.missKm, 3), tolerance: snap.run?.explanation?.refineToleranceS }) }}</div>
          </figure>
          <p v-else-if="chart?.empty" class="ow-warn">{{ t('Propagation failed for one object in this window, so no separation series can be drawn.') }}</p>

          <h4 class="ow-h4">{{ t('Why this was flagged') }}</h4>
          <dl class="ow-why">
            <template v-for="row in why" :key="row.k">
              <dt>{{ row.k }}</dt><dd>{{ row.v }}</dd>
            </template>
          </dl>

          <h4 class="ow-h4">{{ t('Orbital parameters') }}</h4>
          <table class="ow-table">
            <thead><tr><th>{{ t('Parameter') }}</th><th class="r">{{ orbitParams[0]?.name }}</th><th class="r">{{ orbitParams[1]?.name }}</th></tr></thead>
            <tbody>
              <tr><td>{{ t('Inclination') }} °</td><td class="r mono">{{ fmtNum(orbitParams[0]?.el?.inclinationDeg, 3) }}</td><td class="r mono">{{ fmtNum(orbitParams[1]?.el?.inclinationDeg, 3) }}</td></tr>
              <tr><td>{{ t('Eccentricity') }}</td><td class="r mono">{{ fmtNum(orbitParams[0]?.el?.eccentricity, 6) }}</td><td class="r mono">{{ fmtNum(orbitParams[1]?.el?.eccentricity, 6) }}</td></tr>
              <tr><td>{{ t('Perigee km') }}</td><td class="r mono">{{ fmtNum(orbitParams[0]?.el?.perigeeAltKm, 0) }}</td><td class="r mono">{{ fmtNum(orbitParams[1]?.el?.perigeeAltKm, 0) }}</td></tr>
              <tr><td>{{ t('Apogee km') }}</td><td class="r mono">{{ fmtNum(orbitParams[0]?.el?.apogeeAltKm, 0) }}</td><td class="r mono">{{ fmtNum(orbitParams[1]?.el?.apogeeAltKm, 0) }}</td></tr>
              <tr><td>{{ t('Period min') }}</td><td class="r mono">{{ fmtNum(orbitParams[0]?.el?.periodMin, 2) }}</td><td class="r mono">{{ fmtNum(orbitParams[1]?.el?.periodMin, 2) }}</td></tr>
            </tbody>
          </table>
        </template>
      </section>

      <!-- HISTORY -->
      <section v-else class="ow-body" role="tabpanel">
        <h4 class="ow-h4">{{ t('Prediction change, latest vs previous run') }}</h4>
        <div v-if="snap.history.length < 2" class="ow-empty">{{ t('Run two screens (for example before and after a TLE update) to see how predictions move.') }}</div>
        <table v-else-if="diffRows.length || diffDropped.length" class="ow-table">
          <thead><tr><th>{{ t('Pair') }}</th><th>{{ t('Status') }}</th><th class="r">{{ t('TCA Δ s') }}</th><th class="r">{{ t('Miss km') }}</th><th class="r">{{ t('Δ miss km') }}</th></tr></thead>
          <tbody>
            <tr v-for="r in diffRows" :key="r.pair + r.newTcaMs">
              <td><span class="ow-pair">{{ r.a.name }} ↔ {{ r.b.name }}</span></td>
              <td><span class="ow-chip">{{ t(LABELS[r.status]) }}</span></td>
              <td class="r mono">{{ r.tcaDriftS == null ? '—' : fmtNum(r.tcaDriftS, 1) }}</td>
              <td class="r mono">{{ r.prevMissKm == null ? '—' : fmtNum(r.prevMissKm, 3) + ' → ' }}{{ fmtNum(r.newMissKm, 3) }}</td>
              <td class="r mono">{{ r.missDriftKm == null ? '—' : fmtNum(r.missDriftKm, 3) }}</td>
            </tr>
            <tr v-for="r in diffDropped" :key="'d' + r.pair + r.prevTcaMs">
              <td><span class="ow-pair">{{ r.a.name }} ↔ {{ r.b.name }}</span></td>
              <td><span class="ow-chip">{{ t('dropped') }}</span></td>
              <td class="r mono">—</td>
              <td class="r mono">{{ fmtNum(r.prevMissKm, 3) }}</td>
              <td class="r mono">—</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="ow-empty">{{ t('No predictions changed between the last two runs.') }}</div>

        <h4 class="ow-h4">{{ t('Runs') }}</h4>
        <ol class="ow-runs">
          <li v-for="(run, i) in [...snap.history].reverse()" :key="run.id">
            <span class="mono">{{ fmtUtc(run.startedAtMs) }}</span>
            <span class="dim">{{ t('{hours} h · ≤ {threshold} km · {objects} objects · {events} events', { hours: run.windowH, threshold: run.thresholdKm, objects: run.objectCount, events: run.events.length }) }}</span>
            <span v-if="i === 0" class="ow-chip">{{ t('latest') }}</span>
          </li>
        </ol>

        <h4 class="ow-h4">{{ t('Validation') }}</h4>
        <p class="ow-foot">
          {{ t('The comparison harness (src/orbital/validation.js) is in place. No independent reference dataset has been run through the engine yet, so no detection rate, TCA error or false-positive rate is reported.') }}
        </p>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.ow-root,
.ow-root * {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}
.ow-root {
  --ow-panel: rgba(8, 13, 17, 0.95);
  --ow-line: rgba(150, 200, 215, 0.14);
  --ow-text: #d3e4ea;
  --ow-dim: #6e8590;
  --ow-accent: #5ef2e0;
  --ow-warn: #ffb547;
  --ow-alert: #ff6b6b;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--ow-text);
  font-size: 13px;
}
.mono, .ow-v, .ow-utc, .ow-catalog, .ow-table td, .ow-meta, .ow-tab-count, dd, .ow-chart text, .ow-pair, .ow-chip, .ow-enc-pair {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.ow-tab {
  position: fixed;
  right: 0;
  top: 96px;
  z-index: 1001;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--ow-panel);
  border: 1px solid var(--ow-line);
  border-right: none;
  color: var(--ow-accent);
  padding: 10px 8px;
  letter-spacing: 0.16em;
  font-size: 11px;
  writing-mode: vertical-rl;
  cursor: pointer;
}
.ow-tab-count {
  writing-mode: horizontal-tb;
  color: var(--ow-alert);
  border: 1px solid var(--ow-alert);
  padding: 0 4px;
}
.ow-panel {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: min(480px, 100vw);
  z-index: 1000;
  background: var(--ow-panel);
  border-left: 1px solid var(--ow-line);
  transform: translateX(100%);
  transition: transform 0.22s ease;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ow-root.open .ow-panel { transform: translateX(0); }
.ow-root.open .ow-tab { right: min(480px, 100vw); }
.ow-head { padding: 14px 16px 10px; border-bottom: 1px solid var(--ow-line); }
.ow-title { display: flex; align-items: center; gap: 10px; letter-spacing: 0.18em; font-size: 12px; font-weight: 600; }
.ow-mark { width: 8px; height: 8px; border: 1px solid var(--ow-accent); }
.ow-utc { margin-left: auto; color: var(--ow-dim); letter-spacing: 0.04em; font-weight: 400; }
.ow-catalog { margin-top: 6px; color: var(--ow-dim); font-size: 11px; }
.ow-catalog.s-stale, .ow-catalog.s-error { color: var(--ow-warn); }
.ow-overview { display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid var(--ow-line); }
.ow-stat { padding: 10px 16px; border-right: 1px solid var(--ow-line); border-bottom: 1px solid var(--ow-line); display: flex; flex-direction: column; gap: 4px; }
.ow-stat:nth-child(2n) { border-right: none; }
.ow-k { color: var(--ow-dim); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
.ow-v { font-size: 18px; color: var(--ow-text); }
.ow-sub { font-size: 11px; color: var(--ow-dim); }
.ow-tabs { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid var(--ow-line); }
.ow-tabs button { background: none; border: none; color: var(--ow-dim); padding: 10px 4px; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; cursor: pointer; border-bottom: 2px solid transparent; }
.ow-tabs button.on { color: var(--ow-accent); border-bottom-color: var(--ow-accent); }
.ow-body { padding: 12px 16px 24px; overflow: auto; flex: 1; }
.ow-controls { display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px; }
.ow-controls input { background: transparent; border: 1px solid var(--ow-line); color: var(--ow-text); padding: 7px 9px; font: inherit; }
.ow-seg, .ow-groups { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ow-label { color: var(--ow-dim); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; width: 72px; }
.ow-seg button, .ow-groups button, .ow-actions button, .ow-list button, .ow-primary {
  background: transparent;
  border: 1px solid var(--ow-line);
  color: var(--ow-text);
  padding: 5px 9px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ow-seg button.on, .ow-groups button.on { border-color: var(--ow-accent); color: var(--ow-accent); }
.ow-primary { border-color: var(--ow-accent); color: var(--ow-accent); }
.ow-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
button:disabled { opacity: 0.4; cursor: default; }
.ow-dim { color: var(--ow-dim); }
.ow-warn { color: var(--ow-warn); }
.ow-status { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--ow-dim); margin: 6px 0; }
.ow-status.s-error { color: var(--ow-alert); }
.ow-bar { flex: 1; height: 2px; background: var(--ow-line); }
.ow-bar > span { display: block; height: 100%; background: var(--ow-accent); }
.ow-meta { font-size: 11px; color: var(--ow-dim); line-height: 1.6; }
.ow-empty, .ow-foot { color: var(--ow-dim); font-size: 12px; line-height: 1.5; margin: 10px 0; }
.ow-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ow-table th { text-align: left; color: var(--ow-dim); font-weight: 500; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; border-bottom: 1px solid var(--ow-line); padding: 6px 4px; }
.ow-table td { border-bottom: 1px solid var(--ow-line); padding: 7px 4px; vertical-align: middle; }
.ow-table tbody tr { cursor: pointer; }
.ow-table tbody tr:hover, .ow-table tbody tr.sel { background: rgba(94, 242, 224, 0.06); }
.ow-table .r { text-align: right; }
.ow-table .dim { color: var(--ow-dim); }
.ow-pair { color: var(--ow-text); }
.ow-chip { display: inline-block; border: 1px solid var(--ow-line); padding: 1px 6px; font-size: 10px; letter-spacing: 0.08em; color: var(--ow-dim); text-transform: uppercase; }
.ow-chip[data-tier='close'] { color: var(--ow-alert); border-color: var(--ow-alert); }
.ow-chip[data-tier='screening'] { color: var(--ow-warn); border-color: rgba(255, 181, 71, 0.5); }
.ow-chip[data-fresh='fresh'] { color: var(--ow-accent); }
.ow-chip[data-fresh='stale'] { color: var(--ow-alert); }
.ow-list { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; }
.ow-list button { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; text-align: left; }
.ow-list button.sel { border-color: var(--ow-accent); }
.ow-detail { margin-top: 14px; border-top: 1px solid var(--ow-line); padding-top: 12px; }
.ow-detail h3, .ow-h4 { margin: 0 0 8px; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ow-accent); font-weight: 600; }
.ow-h4 { margin-top: 18px; }
dl { display: grid; grid-template-columns: 150px 1fr; gap: 6px 12px; margin: 0; font-size: 12px; }
dt { color: var(--ow-dim); }
dd { margin: 0; }
.ow-enc-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
.ow-enc-pair { font-size: 15px; font-weight: 600; }
.ow-enc-kpis { display: flex; gap: 16px; }
.ow-enc-kpis > div { display: flex; flex-direction: column; gap: 2px; text-align: right; }
.ow-chart { margin: 12px 0 4px; }
.ow-chart svg { width: 100%; height: auto; display: block; }
.ow-chart text { font-size: 10px; fill: var(--ow-dim); }
.ow-grid line { stroke: var(--ow-line); stroke-width: 1; }
.ow-threshold { stroke: var(--ow-warn); stroke-dasharray: 4 4; stroke-width: 1; }
.ow-tca { stroke: var(--ow-text); stroke-width: 1; opacity: 0.6; }
.ow-line { fill: none; stroke: var(--ow-accent); stroke-width: 1.6; }
.ow-chart-note { font-size: 11px; color: var(--ow-dim); margin-top: 4px; }
.ow-why dd { color: var(--ow-text); line-height: 1.45; }
.ow-runs { padding-left: 18px; margin: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
@media (max-width: 520px) {
  .ow-label { width: 100%; }
  .ow-tab { top: 72px; }
}
/* Headings use a serif face; everything else stays monospace. */
.ow-root h1,
.ow-root h2,
.ow-root h3,
.ow-root h4,
.ow-root .ow-h4,
.ow-root .ow-title {
  font-family: 'Times New Roman', Times, serif;
}
</style>

/**
 * Cesium drawing for Orbital Watch: encounter tracks and the TCA marker, drawn from
 * SGP4 samples (see track.js). Everything goes into one CustomDataSource, which
 * is removed as a whole, so nothing leaks onto the globe.
 */
import * as Cesium from 'cesium';

const COLOR_A = '#5ef2e0';
const COLOR_B = '#ffb547';
const COLOR_TCA = '#e8f1f4';

const toCartesian = (ecefKm) =>
  Cesium.Cartesian3.fromElements(
    ecefKm.x * 1000,
    ecefKm.y * 1000,
    ecefKm.z * 1000,
  );

/**
 * Draw both encounter tracks over the sampled window and mark the TCA.
 * @param {Cesium.Viewer} viewer
 * @param {{frames: Array, aName: string, bName: string, tcaMs: number, fly?: boolean}} options
 * @returns {() => void} removes the drawing
 */
export function drawEncounter(
  viewer,
  { frames, aName, bName, tcaMs, tcaLabel = '', fly = true },
) {
  const ds = new Cesium.CustomDataSource('orbital-watch-encounter');
  const valid = frames.filter((f) => f.a && f.b);
  if (valid.length < 2) return () => {};
  const pathOf = (key) => valid.map((f) => toCartesian(f[key].ecef));
  const colorA = Cesium.Color.fromCssColorString(COLOR_A);
  const colorB = Cesium.Color.fromCssColorString(COLOR_B);
  ds.entities.add({
    name: aName,
    polyline: { positions: pathOf('a'), width: 2, material: colorA },
  });
  ds.entities.add({
    name: bName,
    polyline: { positions: pathOf('b'), width: 2, material: colorB },
  });
  // Closest sampled frame to the TCA marks the approach.
  const nearest = valid.reduce((best, f) =>
    Math.abs(f.ms - tcaMs) < Math.abs(best.ms - tcaMs) ? f : best,
  );
  // The TCA marker is a point only: world text goes through the page overlay, not Cesium labels.
  ds.entities.add({
    name: 'TCA',
    position: toCartesian(nearest.a.ecef),
    point: { pixelSize: 9, color: Cesium.Color.fromCssColorString(COLOR_TCA) },
  });
  viewer.dataSources.add(ds);
  if (fly) viewer.flyTo(ds, { duration: 1.2 }).catch?.(() => {});
  viewer.scene?.requestRender?.();
  return () => {
    if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
  };
}

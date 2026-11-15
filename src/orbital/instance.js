/**
 * The page's Orbital Watch controller, built on the globe's own CelesTrak source
 * (the same proxy and cache the satellite layer reads).
 */
import { createSatelliteSource } from '../layers/satellites/source.js';
import { createOrbitalWatch } from './watch.js';

export const orbitalWatch = createOrbitalWatch({
  source: createSatelliteSource(),
});

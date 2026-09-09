// Redirect per i models
export * from './Category.js';
export * from './Episode.js';
export * from './Genre.js';
export * from './Movie.js';
export * from './People.js';
export * from './Show.js';
export * from './ShowDetails.js';
export * from './TvShow.js';
export * from './Video.js';
export * from './Season.js';
export * from './Provider.js';
// `PlatformHandler.js` is deliberately NOT re-exported here. It imports
// `Core`, and `Core` imports every provider file (via the discovery in
// `core/providers/registry.ts`), and every provider file imports this
// barrel — so re-exporting it closes a cycle that deadlocks discovery's
// top-level await. Nothing imported it from here; its consumers take it
// from `core/models/PlatformHandler.js` directly.
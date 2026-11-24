// Keep the browser key and map ID blank on GitHub. The live website requests
// these settings from the configured Apps Script feed. Local tests can use
// a local-only copy configured with the localhost-restricted test key.
export const config = Object.freeze({
  browserKey: '',
  mapId: '',
  feedUrl: '',
});

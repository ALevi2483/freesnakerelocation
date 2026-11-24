// Keep the browser key and map ID blank on GitHub. The live website requests
// these settings from the configured Apps Script feed. Local tests can use
// a local-only copy configured with the localhost-restricted test key.
export const config = Object.freeze({
  browserKey: '',
  mapId: '',
  feedUrl: 'https://script.google.com/macros/s/AKfycbwFp08IdL6vNjHN0GCGtN5ErCTRpLOHTR_yVTxHTEVsRU9okK2myiuvJ5XB8AAF0EMH/exec',
});

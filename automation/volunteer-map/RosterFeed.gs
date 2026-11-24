const ROSTER_FEED_INDEX = 'roster-feed-index-v2';
const ROSTER_FEED_PAGE_SIZE = 250;
const ROSTER_FEED_MAX_LOCATIONS = 5000;

function refreshRosterMapFeed() {
  if (PR.getProperty('ROSTER_FEED_ENABLED') !== 'true') return;
  withWorkflowLock(() => {
    const cache = CacheService.getScriptCache();
    try {
      const {matched, totals, eligibility} = readCityCoverage_();
      if (eligibility.invalidActiveExclusions || eligibility.unknownExclusionFlags) {
        throw new Error('ROSTER_EXCLUSIONS_NEED_REVIEW');
      }
      writeRosterSnapshot_(cache, matched, totals.unmatchedListings);
      console.log(JSON.stringify(totals));
    } catch (error) {
      cache.remove(ROSTER_FEED_INDEX);
      const code = safeCode(error);
      const email = PR.getProperty('ADMIN_EMAIL');
      if (email) notifyAdmin(email, code, 'The roster map feed could not refresh. Check the private Apps Script execution.');
      throw new Error(code);
    }
  });
}

function installRosterRefreshTrigger() {
  if (PR.getProperty('ROSTER_FEED_ENABLED') !== 'true') throw new Error('ROSTER_FEED_DISABLED');
  withWorkflowLock(() => {
    const exists = ScriptApp.getProjectTriggers().some(
      trigger => trigger.getHandlerFunction() === 'refreshRosterMapFeed');
    if (!exists) ScriptApp.newTrigger('refreshRosterMapFeed').timeBased().everyMinutes(15).create();
  });
}

function writeRosterSnapshot_(cache, matched, missing) {
  if (matched.length > ROSTER_FEED_MAX_LOCATIONS) throw new Error('ROSTER_FEED_TOO_LARGE');
  const id = Utilities.getUuid();
  const keys = [];
  for (let offset = 0; offset < matched.length; offset += ROSTER_FEED_PAGE_SIZE) {
    const key = 'roster-feed:' + id + ':' + keys.length;
    const rows = matched.slice(offset, offset + ROSTER_FEED_PAGE_SIZE).map(row =>
      [row.city, row.state.toUpperCase(), row.count, row.lat, row.lng]);
    cache.put(key, JSON.stringify(rows), SNAPSHOT_SECONDS);
    keys.push(key);
  }
  // Publish the index last so readers only see one complete set of pages.
  cache.put(ROSTER_FEED_INDEX, JSON.stringify({
    keys, count: matched.length, missing, builtAt: Date.now()
  }), SNAPSHOT_SECONDS);
}

function readRosterSnapshot_(cache) {
  const snapshot = JSON.parse(cache.get(ROSTER_FEED_INDEX) || 'null');
  if (!snapshot || Date.now() - snapshot.builtAt >= SNAPSHOT_SECONDS * 1000) return null;
  const pages = snapshot.keys.length ? cache.getAll(snapshot.keys) : {};
  if (!snapshot.keys.every(key => Object.prototype.hasOwnProperty.call(pages, key))) return null;
  const locations = snapshot.keys.flatMap(key => JSON.parse(pages[key]));
  if (locations.length !== snapshot.count) return null;
  return {version: 2, locations, missing: snapshot.missing};
}

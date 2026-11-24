const ROSTER_FEED_INDEX = 'roster-feed-index-v2';
const ROSTER_FEED_PAGE_SIZE = 250;
const ROSTER_FEED_MAX_LOCATIONS = 5000;

function refreshRosterMapFeed() {
  if (PR.getProperty('ROSTER_FEED_ENABLED') !== 'true') return;
  withWorkflowLock(() => {
    const cache = CacheService.getScriptCache();
    try {
      const {matched, totals, eligibility} = readCityCoverage_(PR.getProperty('ROSTER_MAP_CONTACTS_ENABLED') === 'true');
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
  const contactKeys = [];
  for (let offset = 0; offset < matched.length; offset += ROSTER_FEED_PAGE_SIZE) {
    const key = 'roster-feed:' + id + ':' + keys.length;
    const batch = matched.slice(offset, offset + ROSTER_FEED_PAGE_SIZE);
    const rows = batch.map(row => [row.city, row.state.toUpperCase(), row.count, row.lat, row.lng]);
    cache.put(key, JSON.stringify(rows), SNAPSHOT_SECONDS);
    const contacts = batch.map(row => row.contacts || []);
    if (contacts.some(list => list.length)) {
      const contactKey = 'roster-contacts:' + id + ':' + keys.length;
      const json = JSON.stringify(contacts);
      if (Utilities.newBlob(json).getBytes().length > 95000) throw new Error('ROSTER_CONTACT_PAGE_TOO_LARGE');
      cache.put(contactKey, json, SNAPSHOT_SECONDS);
      contactKeys.push(contactKey);
    } else {
      contactKeys.push(null);
    }
    keys.push(key);
  }
  // Publish the index last so readers only see one complete set of pages.
  cache.put(ROSTER_FEED_INDEX, JSON.stringify({
    keys, contactKeys, count: matched.length, missing, builtAt: Date.now()
  }), SNAPSHOT_SECONDS);
}

function readRosterSnapshot_(cache, contactLocation) {
  const snapshot = JSON.parse(cache.get(ROSTER_FEED_INDEX) || 'null');
  if (!snapshot || Date.now() - snapshot.builtAt >= SNAPSHOT_SECONDS * 1000) return null;
  const pages = snapshot.keys.length ? cache.getAll(snapshot.keys) : {};
  if (!snapshot.keys.every(key => Object.prototype.hasOwnProperty.call(pages, key))) return null;
  const locations = snapshot.keys.flatMap(key => JSON.parse(pages[key]));
  if (locations.length !== snapshot.count) return null;
  if (contactLocation) {
    const index = locations.findIndex(row =>
      row[0] === contactLocation.city && normalize(row[1]) === contactLocation.state);
    if (index < 0) return {contacts: []};
    const page = Math.floor(index / ROSTER_FEED_PAGE_SIZE);
    const contactKey = (snapshot.contactKeys || [])[page];
    if (!contactKey) return {contacts: []};
    const contactPage = cache.get(contactKey);
    if (!contactPage) return null;
    return {contacts: JSON.parse(contactPage)[index % ROSTER_FEED_PAGE_SIZE] || []};
  }
  return {version: 2, locations, missing: snapshot.missing};
}

function approvedMapContacts_(rows) {
  const contacts = new Map();
  for (const row of rows) {
    const city = normalize(row.City);
    const state = normalize(row.State);
    const phone = phoneKey(row.Phone);
    const name = clean(row['Full Name']);
    if (!city || !state || !phone || !name || name.length > 100) continue;
    const key = JSON.stringify([city, state, phone]);
    // A conflicting name for one number is an ambiguous public contact.
    if (!contacts.has(key)) contacts.set(key, name);
    else if (contacts.get(key) !== name) contacts.set(key, null);
  }
  return contacts;
}

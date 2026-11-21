const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

const source = ['Workflow', 'Code'].map(name =>
  fs.readFileSync(`automation/volunteer-map/${name}.gs`, 'utf8')).join('\n');

function fixture() {
  const properties = new Map([
    ['GEOCODING_ENABLED', 'true'], ['PUBLIC_FEED_ENABLED', 'true'],
    ['ADMIN_EMAIL', 'admin@example.invalid'], ['RESPONSE_SHEET_ID', 'synthetic'],
    ['RESPONSE_TAB', 'Responses'],
    ['SOURCE_FIELDS', JSON.stringify({timestamp: 'Timestamp', name: 'Name', email: 'Email',
      address: 'Address', city: 'City', region: 'State', postal: 'ZIP', country: 'Country',
      preciseConsent: 'Consent', publicAlias: 'Alias'})],
  ]);
  const cache = new Map();
  const calls = [];
  const mails = [];
  const storage = [];
  const component = (type, long_name, short_name = long_name) => ({
    types: [type], long_name, short_name,
  });
  const area = [component('locality', 'Austin'), component('administrative_area_level_1', 'Texas', 'TX'),
    component('country', 'United States', 'US')];
  const areaResult = {
    types: ['locality'], address_components: area, geometry: {location: {lat: 30, lng: -97}},
  };
  const addressResult = {
    types: ['street_address'],
    address_components: [...area, component('street_number', '123'), component('postal_code', '78701')],
    geometry: {location_type: 'ROOFTOP', location: {lat: 30.12345, lng: -97.12345}},
  };
  const context = vm.createContext({
    PropertiesService: {getScriptProperties: () => ({
      getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value),
    })},
    CacheService: {getScriptCache: () => ({
      get: key => cache.get(key), put: (key, value) => cache.set(key, value), remove: key => cache.delete(key),
    })},
    Utilities: {
      DigestAlgorithm: {SHA_256: 'sha256'},
      computeDigest: (algorithm, value) => crypto.createHash(algorithm).update(value).digest(),
      base64EncodeWebSafe: value => value.toString('base64url'),
      newBlob: value => ({getBytes: () => Buffer.from(value)}),
    },
    Maps: {newGeocoder: () => ({geocode(query) {
      calls.push(query);
      if (query.startsWith('123')) return {status: 'OK', results: [addressResult]};
      if (query === 'Austin, TX, US') return {status: 'OK', results: [areaResult]};
      return {status: 'ZERO_RESULTS', results: []};
    }})},
    SpreadsheetApp: {flush() {}},
    MailApp: {sendEmail: (...args) => mails.push(args)},
    ContentService: {MimeType: {JSON: 'json'}, createTextOutput: value => ({setMimeType: () => value})},
  });
  const headers = ['Timestamp', 'Name', 'Email', 'Address', 'City', 'State', 'ZIP', 'Country', 'Consent', 'Alias'];
  const values = (changes = []) => {
    const row = ['2026-01-01 12:00', 'Private Name', 'private@example.invalid', '123 Example St',
      'Austin', 'TX', '78701', 'US', '', 'Public Alias'];
    for (const [index, value] of changes) row[index] = value;
    return row;
  };
  Object.assign(context, {
    rows: [],
    incoming: {headers, values: []},
    sheet: {getMaxRows: () => 1000, getRange: (row, column) => ({
      getDisplayValue: () => String(storage[row - 2][column - 1] ?? ''),
      setValue: cell => { storage[row - 2][column - 1] = typeof cell === 'string' ? cell.replace(/^'/, '') : cell; },
      clearContent: () => { storage[row - 2][column - 1] = ''; },
      setValues: ([cells]) => {
        storage[row - 2] = cells.map(cell => typeof cell === 'string' ? cell.replace(/^'/, '') : cell);
      },
    })},
  });
  const run = code => vm.runInContext(code, context);
  run(source);
  run('const fields = configuration().fields');
  const feed = () => JSON.parse(run('doGet()'));
  const submit = (...items) => {
    context.incoming.values.push(...items);
    run('ingest(sheet, rows, incoming, fields); validatePending(sheet, rows)');
  };
  return {run, submit, values, feed, properties, calls, storage, cache, mails};
}

test('backfill and repeated submits are idempotent, flagged, and validated once per address', () => {
  const f = fixture();
  f.submit(f.values(), f.values(), f.values([[0, 'later']]),
    f.values([[0, 'missing'], [3, '']]), f.values([[0, 'bad'], [3, '888 Example St']]));
  assert.equal(f.run('rows.length'), 4);
  assert.equal(f.run("rows[1][COL.Issue]"), 'POTENTIAL_DUPLICATE');
  assert.equal(f.run("rows[2][COL.Issue]"), 'INCOMPLETE_ADDRESS');
  assert.equal(f.run("rows[3][COL.Issue]"), 'ADDRESS_NEEDS_REVIEW');
  assert.equal(f.calls.length, 2);
  f.submit(f.values([[0, 'another']]));
  assert.equal(f.calls.length, 2);
});

test('approved approximate snapshot excludes private data and removals invalidate it', () => {
  const f = fixture();
  f.submit(f.values());
  f.run('refreshPublic(rows)');
  assert.deepEqual(f.feed().points, []);
  f.run("rows[0][COL.Action] = 'APPROVE APPROXIMATE'; applyActions(sheet, rows); refreshPublic(rows)");
  assert.deepEqual(f.feed().points, [
    {label: 'Public Alias', locality: 'Austin, TX, US', lat: 30, lng: -97, precise: false},
  ]);
  assert.doesNotMatch(JSON.stringify(f.feed()), /123|example|Private Name|78701/i);
  f.run("rows[0][COL.Action] = 'REMOVE'; applyActions(sheet, rows)");
  assert.equal(f.feed().error, 'MAP_UNAVAILABLE');
  f.run('refreshPublic(rows)');
  assert.deepEqual(f.feed().points, []);
  f.submit(f.values());
  assert.equal(f.run('rows.length'), 1);
});

test('an approved update supersedes an existing listing and requires explicit linkage', () => {
  const f = fixture();
  f.submit(f.values(), f.values([[0, 'later'], [9, 'Updated Alias']]));
  f.run("rows[0][COL.Action] = 'APPROVE APPROXIMATE'; applyActions(sheet, rows)");
  f.run("rows[1][COL.Action] = 'APPROVE APPROXIMATE'; applyActions(sheet, rows)");
  assert.equal(f.run('rows[1][COL.Issue]'), 'ACTIVE_DUPLICATE_REQUIRES_REPLACEMENT');
  f.run("rows[1][COL['Replace ID']] = rows[0][COL.ID]; applyActions(sheet, rows); refreshPublic(rows)");
  assert.equal(f.run('rows[0][COL.Status]'), 'SUPERSEDED');
  assert.equal(f.feed().points.length, 1);
  assert.equal(f.feed().points[0].label, 'Updated Alias');
});

test('precise markers require feature enablement, specific consent and administrative approval', () => {
  const f = fixture();
  f.submit(f.values(), f.values([[0, 'later'], [8, 'Yes, show my precise location']]));
  f.run("rows[0][COL.Action] = 'APPROVE PRECISE'; applyActions(sheet, rows)");
  assert.equal(f.run('rows[0][COL.Issue]'), 'PRECISE_PUBLICATION_DISABLED');
  f.properties.set('PRECISE_PUBLICATION_ENABLED', 'true');
  f.run('applyActions(sheet, rows)');
  assert.equal(f.run('rows[0][COL.Issue]'), 'PRECISE_CONSENT_REQUIRED');
  f.run("rows[1][COL.Action] = 'APPROVE PRECISE'; applyActions(sheet, rows); refreshPublic(rows)");
  assert.equal(f.feed().points[0].precise, true);
  assert.equal(f.feed().points[0].lat, 30.12345);
  f.properties.delete('PRECISE_PUBLICATION_ENABLED');
  assert.deepEqual(f.feed().points, []);
});

test('public requests never geocode; failures and quota limits keep review state pending', () => {
  const f = fixture();
  f.properties.set('DAILY_GEOCODE_LIMIT', '1');
  f.submit(f.values());
  assert.equal(f.feed().error, 'MAP_UNAVAILABLE');
  f.run("rows[0][COL.Action] = 'APPROVE APPROXIMATE'");
  assert.throws(() => f.run('applyActions(sheet, rows)'), /GEOCODE_BUDGET_REACHED/);
  assert.equal(f.run('rows[0][COL.Status]'), 'PENDING');
  assert.equal(f.calls.length, 1);
  f.properties.set('PUBLIC_FEED_ENABLED', 'false');
  assert.equal(f.feed().error, 'MAP_UNAVAILABLE');
});

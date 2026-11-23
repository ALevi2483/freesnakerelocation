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

test('default profile imports the current form and keeps the phone and agreement out of the feed', () => {
  const f = fixture();
  f.properties.delete('SOURCE_FIELDS');
  f.run(`
    const registration = configuration();
    const rawForm = [
      ['Timestamp', 'Disclaimer\\nAgreement', 'Which applies to you?',
        'Please agree to each of the following by checking the boxes next to each requirement.',
        'Full Name', REGISTRATION_FIELDS.address, 'City', 'State',
        REGISTRATION_FIELDS.phone + ' ', '', ''],
      ['2026-02-01 12:00', 'I Agree / Accept', 'First application', 'Accepted',
        'Synthetic Volunteer', '123 Example St', 'Austin', 'TX', '512-555-0100', '', ''],
      ['2026-02-02 12:00', 'I Agree / Accept', 'Update', 'Accepted',
        'Updated Volunteer', '123 Another St', 'Austin', 'TX', '+1 (512) 555-0100', '', ''],
      ['', '', '', '', '', '', '', '', '', '', 'This is outside the form inputs']
    ];
    const book = {getSheetByName: () => ({
      getLastColumn: () => rawForm[0].length,
      getDataRange: () => ({getDisplayValues: () => rawForm}),
    })};
    ingest(sheet, rows, sourceData(book, registration), registration.fields, registration.defaultCountry);
    validatePending(sheet, rows);
  `);
  assert.equal(f.run('rows.length'), 2);
  assert.equal(f.run("rows[0][COL.Country]"), 'US');
  assert.equal(f.run("rows[0][COL.Postal]"), '');
  assert.equal(f.run("rows[0][COL['Phone (private)']]"), '512-555-0100');
  assert.equal(f.run("rows[0][COL['Application type']]"), 'First application');
  assert.equal(f.run("rows[1][COL.Issue]"), 'POTENTIAL_DUPLICATE');
  assert.equal(f.run("rows[0][COL['Precise consent']]"), false);
  assert.equal(f.calls[0], '123 Example St, Austin, TX, US');

  f.run("rows[0][COL.Action] = 'APPROVE APPROXIMATE'; applyActions(sheet, rows); refreshPublic(rows)");
  assert.deepEqual(f.feed().points, [
    {label: 'Volunteer relocator', locality: 'Austin, TX, US', lat: 30, lng: -97, precise: false},
  ]);
  f.run("rows[1][COL.Action] = 'APPROVE APPROXIMATE'; applyActions(sheet, rows)");
  assert.equal(f.run('rows[1][COL.Issue]'), 'ACTIVE_DUPLICATE_REQUIRES_REPLACEMENT');

  f.run("rawForm[0][4] = 'Unexpected renamed name field'");
  assert.throws(() => f.run('sourceData(book, registration)'), /SOURCE_HEADER_MISMATCH/);
});

test('the private roster audit counts candidates without exposing source values', () => {
  const f = fixture();
  f.run(fs.readFileSync('automation/volunteer-map/RosterAudit.gs', 'utf8'));
  const report = f.run(`JSON.stringify(summarizeRoster_([
    {'Listing ID':'a', Status:'Active', City:'Example City', State:'VA', Phone:'757-555-0101'},
    {'Listing ID':'b', Status:'Active', City:' example city ', State:'va', Phone:'757-555-0102'},
    {'Listing ID':'c', Status:'Active', City:'Example City', State:'VA', Phone:'757-555-0103'},
    {'Listing ID':'d', Status:'Removed', City:'Example City', State:'VA', Phone:'757-555-0104'},
    {'Listing ID':'e', Status:'Active', City:'Example City', State:'VA', Phone:''},
    {'Listing ID':'f', Status:'Active', City:'', State:'VA', Phone:'757-555-0105'},
    {'Listing ID':'d', Status:'Active', City:'Example City', State:'VA', Phone:'757-555-0104'},
    {'Listing ID':'g', Status:'Pending', City:'Example City', State:'VA', Phone:'757-555-0106'}
  ], [
    {Phone:'+1 (757) 555-0103', Active:true},
    {Phone:'757-555-0102', Active:false},
    {Phone:'invalid', Active:true},
    {Phone:'757-555-0107', Active:'FALSE'}
  ]))`);
  assert.deepEqual(JSON.parse(report), {
    active: 6, removed: 1, otherStatus: 1, blockedByPhone: 1,
    invalidActiveExclusions: 1, unknownExclusionFlags: 1,
    activeWithMissingOrInvalidPhone: 1, activeWithMissingOrDuplicateId: 1,
    activeWithMissingCityOrState: 1, candidateListings: 2, candidateCityStatePairs: 1,
  });
  assert.doesNotMatch(report, /757|example city/i);
});

test('Census coverage counts only unique place matches for eligible listings', () => {
  const f = fixture();
  for (const name of ['RosterAudit', 'CityCoverage']) {
    f.run(fs.readFileSync(`automation/volunteer-map/${name}.gs`, 'utf8'));
  }
  const report = f.run(`JSON.stringify(summarizeCityCoverage_([
    {'Listing ID':'1', Status:'Active', City:'Example', State:'VA', Phone:'757-555-0101'},
    {'Listing ID':'2', Status:'Active', City:'Example', State:'va', Phone:'757-555-0102'},
    {'Listing ID':'3', Status:'Active', City:'Ambiguous', State:'VA', Phone:'757-555-0103'},
    {'Listing ID':'4', Status:'Active', City:'Example', State:'NC', Phone:'757-555-0104'},
    {'Listing ID':'5', Status:'Active', City:'Example', State:'VA', Phone:'757-555-0105'}
  ], [{Phone:'757-555-0105', Active:true}], censusPlaceLookup_([
    'USPS\\tNAME\\tINTPTLAT\\tINTPTLONG',
    'VA\\tExample city\\t37\\t-77',
    'VA\\tAmbiguous city\\t36\\t-77',
    'VA\\tAmbiguous CDP\\t37\\t-77'
  ].join('\\n'))))`);
  assert.deepEqual(JSON.parse(report), {
    candidateListings: 4, matchedListings: 2, unmatchedListings: 2,
    matchedCityStatePairs: 1, unmatchedCityStatePairs: 2,
  });
  assert.doesNotMatch(report, /example|ambiguous|757/i);
});

test('Census archive can be read from private Drive without a network download', () => {
  const f = fixture();
  f.run(fs.readFileSync('automation/volunteer-map/CityCoverage.gs', 'utf8'));
  f.properties.set('CENSUS_PLACES_FILE_ID', 'synthetic-file');
  f.run(`
    const DriveApp = {getFileById(id) {
      if (id !== 'synthetic-file') throw new Error('wrong file');
      return {getBlob: () => ({setContentType: mime => mime})};
    }};
    const UrlFetchApp = {fetch() { throw new Error('unexpected download'); }};
  `);
  assert.equal(f.run('censusArchive_()'), 'application/zip');
});

test('Census coverage parses pipe-delimited Gazetteer files with padded headers', () => {
  const f = fixture();
  f.run(fs.readFileSync('automation/volunteer-map/CityCoverage.gs', 'utf8'));
  const point = f.run(`JSON.stringify(censusPlaceLookup_([
    '\\uFEFFUSPS|GEOID|GEOIDFQ|NAME|INTPTLAT|INTPTLONG  ',
    'VA|1234567|1600000US1234567|Example city|37.123|-77.456  '
  ].join('\\r\\n')).get(JSON.stringify(['example', 'va'])))`);
  assert.deepEqual(JSON.parse(point), {lat: 37.123, lng: -77.456});
});

test('coverage review groups unmatched locations and excludes private fields', () => {
  const f = fixture();
  for (const name of ['RosterAudit', 'CityCoverage']) {
    f.run(fs.readFileSync(`automation/volunteer-map/${name}.gs`, 'utf8'));
  }
  const report = f.run(`JSON.stringify((() => {
    const rows = [
      {City: 'No Match', State: 'VA'},
      {City: 'Ambiguous', State: 'VA'},
      {City: 'NO MATCH', State: 'va'}
    ].map((row, index) => ({
      ...row, Status: 'Active', Phone: '757-555-0101', 'Listing ID': index + 1
    }));
    const review = [];
    summarizeCityCoverage_(rows, [], new Map([['["ambiguous","va"]', null]]),
      row => review.push(row));
    return review;
  })())`);
  assert.deepEqual(JSON.parse(report), [
    {city: 'no match', state: 'va', count: 2, issue: 'NO_EXACT_MATCH'},
    {city: 'ambiguous', state: 'va', count: 1, issue: 'AMBIGUOUS'}
  ]);
});

test('locality spelling and consolidated-city aliases preserve ambiguity and state boundaries', () => {
  const f = fixture();
  f.run(fs.readFileSync('automation/volunteer-map/CityCoverage.gs', 'utf8'));
  const result = f.run(`JSON.stringify((() => {
    const match = placeMatches_(censusPlaceLookup_([
      'USPS|NAME|INTPTLAT|INTPTLONG',
      'GA|Athens-Clarke County unified government (balance)|33|-83',
      'FL|St. Augustine city|29|-81',
      "MO|Lee's Summit city|38|-94",
      'VA|Mount Example town|37|-77',
      'VA|Mt Example CDP|36|-76'
    ].join('\\n')));
    return [match('athens','ga'), match('athens','tn'), match('st augustine','fl'),
      match('lees summit','mo'), match('mt. example','va')];
  })())`);
  assert.deepEqual(JSON.parse(result), [
    {lat:33,lng:-83}, null, {lat:29,lng:-81}, {lat:38,lng:-94}, null,
  ]);
});

test('roster preview groups listings by locality and uses only Census coordinates', () => {
  const f = fixture();
  for (const name of ['RosterAudit', 'CityCoverage']) {
    f.run(fs.readFileSync(`automation/volunteer-map/${name}.gs`, 'utf8'));
  }
  const output = f.run(`JSON.stringify((() => {
    const roster = Array.from({length: 1840}, (_, index) => ({
      'Listing ID': index + 1, Status: 'Active', City: 'City ' + (index % 1181),
      State: 'VA', Phone: '757-555-0101', Coordinates: 'private coordinates'
    }));
    const lookup = new Map(roster.map(row => [JSON.stringify([normalize(row.City), 'va']), {lat:37,lng:-77}]));
    const matched = [];
    const totals = summarizeCityCoverage_(roster, [], lookup, undefined, row => matched.push(row));
    return {totals, count: matched.length, first: matched[0]};
  })())`);
  const report = JSON.parse(output);
  assert.equal(report.totals.matchedListings, 1840);
  assert.equal(report.count, 1181);
  assert.deepEqual(report.first, {city:'city 0', state:'va', count:2, lat:37, lng:-77});
  assert.doesNotMatch(output, /757|private coordinates/i);
});

test('the roster-sized feed is gated, omits private fields, and rejects an incomplete snapshot', () => {
  const f = fixture();
  f.run(fs.readFileSync('automation/volunteer-map/RosterFeed.gs', 'utf8'));
  f.run(`
    const rosterPages = new Map();
    const rosterCache = {
      put: (key, value) => rosterPages.set(key, value),
      get: key => rosterPages.get(key),
      getAll: keys => Object.fromEntries(keys.filter(key => rosterPages.has(key))
        .map(key => [key, rosterPages.get(key)]))
    };
    CacheService.getScriptCache = () => rosterCache;
    Utilities.getUuid = () => 'test-uuid';
    writeRosterSnapshot_(rosterCache, Array.from({length: 1181}, (_, index) => ({
      city: 'Synthetic ' + index, state: 'va', lat: 37, lng: -77, count: 2,
      phone: '757-555-0101', address: 'Private street'
    })), 167);
  `);
  assert.equal(f.feed().error, 'MAP_UNAVAILABLE');
  f.properties.set('ROSTER_FEED_ENABLED', 'true');
  const feed = f.feed();
  assert.equal(feed.version, 2);
  assert.equal(feed.locations.length, 1181);
  assert.equal(feed.missing, 167);
  assert.deepEqual(feed.locations[0], ['Synthetic 0', 'VA', 2, 37, -77]);
  assert.doesNotMatch(JSON.stringify(feed), /757-555|Private street/);
  f.run("rosterPages.delete('roster-feed:test-uuid:2')");
  assert.deepEqual(f.feed(), {version: 2, error: 'MAP_UNAVAILABLE'});
});

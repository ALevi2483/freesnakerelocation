const CENSUS_PLACES_ZIP =
  'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_gaz_place_national.zip';

function auditCityCoverage() {
  console.log(JSON.stringify(readCityCoverage_().totals));
}

function createCityReviewReport() {
  const {unmatched} = readCityCoverage_();
  writeCityReport_('City Review', ['City', 'State', 'Affected listings', 'Match issue'],
    unmatched.map(row => ["'" + row.city, "'" + row.state, row.count, row.issue]));
  console.log('CITY_REVIEW_CREATED: ' + unmatched.length + ' location pairs');
}

function createRosterMapPreview() {
  const {matched, totals} = readCityCoverage_();
  writeCityReport_('Roster Map Preview', ['City', 'State', 'Listings', 'Latitude', 'Longitude'],
    matched.map(row => ["'" + row.city, "'" + row.state, row.count, row.lat, row.lng]));
  console.log(JSON.stringify(totals));
}

function writeCityReport_(name, header, rows) {
  const testId = clean(PR.getProperty('RESPONSE_SHEET_ID'));
  const rosterId = clean(PR.getProperty('ROSTER_SPREADSHEET_ID'));
  if (!testId || !rosterId || testId === rosterId) throw new Error('REVIEW_REQUIRES_SEPARATE_TEST_WORKBOOK');
  const values = [header, ...rows];
  withWorkflowLock(() => {
    const book = SpreadsheetApp.openById(testId);
    if (book.getSheetByName(name)) throw new Error('CITY_REPORT_ALREADY_EXISTS');
    const sheet = book.insertSheet(name);
    const extraRows = values.length - sheet.getMaxRows();
    if (extraRows > 0) sheet.insertRowsAfter(sheet.getMaxRows(), extraRows);
    sheet.getRange(1, 1, values.length, header.length).setValues(values);
    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
  });
}

function readCityCoverage_() {
  const id = clean(PR.getProperty('ROSTER_SPREADSHEET_ID'));
  if (!id) throw new Error('SET_ROSTER_SPREADSHEET_ID');
  const files = Utilities.unzip(censusArchive_());
  const places = files.find(file => /gaz_place_national\.txt$/i.test(file.getName()));
  if (!places) throw new Error('CENSUS_PLACE_FILE_MISSING');
  const lookup = censusPlaceLookup_(places.getDataAsString());

  const book = SpreadsheetApp.openById(id);
  const roster = rosterColumns_(book, 'Listings Master', ['Listing ID', 'Status', 'City', 'State', 'Phone']);
  const exclusions = rosterColumns_(book, 'Do Not List', ['Phone', 'Active'], 'Active');
  const unmatched = [];
  const matched = [];
  const totals = summarizeCityCoverage_(roster, exclusions, lookup,
    row => unmatched.push(row), row => matched.push(row));
  return {totals, unmatched, matched};
}

function censusArchive_() {
  const fileId = clean(PR.getProperty('CENSUS_PLACES_FILE_ID'));
  if (fileId) {
    return DriveApp.getFileById(fileId).getBlob().setContentType('application/zip');
  }
  const response = UrlFetchApp.fetch(CENSUS_PLACES_ZIP, {muteHttpExceptions: true});
  const status = response.getResponseCode();
  if (status !== 200) throw new Error('CENSUS_DOWNLOAD_FAILED_HTTP_' + status);
  return response.getBlob().setContentType('application/zip');
}

function censusPlaceLookup_(data) {
  const [first, ...lines] = data.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/);
  const required = ['USPS', 'NAME', 'INTPTLAT', 'INTPTLONG'];
  const delimiter = ['\t', '|'].find(separator => {
    const headers = first.split(separator).map(clean);
    return required.every(field => headers.includes(field));
  });
  if (!delimiter) throw new Error('CENSUS_HEADER_MISMATCH');
  const headers = first.split(delimiter).map(clean);
  const fields = required.map(field => headers.indexOf(field));
  const lookup = new Map();
  for (const line of lines) {
    const cells = line.split(delimiter);
    const [state, name, latitude, longitude] = fields.map(index => clean(cells[index]));
    if (!state || !name || !latitude || !longitude) continue;
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const place = normalize(name).replace(
      / (?:city and borough|consolidated government|metropolitan government|unified government|urban county|municipality|borough|village|city|town|cdp)(?: \(balance\))?$/, '');
    const key = JSON.stringify([place, normalize(state)]);
    if (!lookup.has(key)) lookup.set(key, {lat, lng});
    else lookup.set(key, null); // Resolve same-name locations through a private review.
  }
  if (!lookup.size) throw new Error('CENSUS_NO_PLACES');
  return lookup;
}

const CONSOLIDATED_CITY_NAMES = {
  '["athens","ga"]': 'athens-clarke county',
  '["nashville","tn"]': 'nashville-davidson',
  '["lexington","ky"]': 'lexington-fayette'
};

function placeSpelling_(name) {
  return normalize(name).replace(/['’]/g, '').replace(/[.-]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^st /, 'saint ').replace(/^mt /, 'mount ');
}

function placeMatches_(lookup) {
  const spellings = new Map();
  for (const [key, point] of lookup) {
    const [city, state] = JSON.parse(key);
    const spelling = JSON.stringify([placeSpelling_(city), state]);
    spellings.set(spelling, spellings.has(spelling) ? null : point);
  }
  return (city, state) => {
    const key = JSON.stringify([city, state]);
    if (lookup.has(key)) return lookup.get(key);
    const alias = CONSOLIDATED_CITY_NAMES[key];
    if (alias) {
      const target = JSON.stringify([alias, state]);
      if (lookup.has(target)) return lookup.get(target);
    }
    return spellings.get(JSON.stringify([placeSpelling_(city), state]));
  };
}

function summarizeCityCoverage_(roster, exclusions, lookup, onUnmatched = () => {}, onMatched = () => {}) {
  const matched = new Map();
  const unmatched = new Map();
  let matchedListings = 0;
  const match = placeMatches_(lookup);
  const totals = summarizeRoster_(roster, exclusions, (city, state) => {
    const key = JSON.stringify([city, state]);
    const point = match(city, state);
    if (point) {
      if (!matched.has(key)) matched.set(key, {city, state, count: 0, lat: point.lat, lng: point.lng});
      matched.get(key).count++;
      matchedListings++;
    } else {
      if (!unmatched.has(key)) unmatched.set(key, {
        city, state, count: 0, issue: point === null ? 'AMBIGUOUS' : 'NO_EXACT_MATCH'
      });
      unmatched.get(key).count++;
    }
  });
  for (const row of matched.values()) onMatched(row);
  [...unmatched.values()].sort((a, b) => b.count - a.count ||
    a.state.localeCompare(b.state) || a.city.localeCompare(b.city)).forEach(onUnmatched);
  return {
    candidateListings: totals.candidateListings,
    matchedListings,
    unmatchedListings: totals.candidateListings - matchedListings,
    matchedCityStatePairs: matched.size,
    unmatchedCityStatePairs: unmatched.size
  };
}

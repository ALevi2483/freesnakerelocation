const CENSUS_PLACES_ZIP =
  'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_gaz_place_national.zip';

function auditCityCoverage() {
  const id = clean(PR.getProperty('ROSTER_SPREADSHEET_ID'));
  if (!id) throw new Error('SET_ROSTER_SPREADSHEET_ID');
  const response = UrlFetchApp.fetch(CENSUS_PLACES_ZIP, {muteHttpExceptions: true});
  if (response.getResponseCode() !== 200) throw new Error('CENSUS_DOWNLOAD_FAILED');
  const files = Utilities.unzip(response.getBlob().setContentType('application/zip'));
  const places = files.find(file => /gaz_place_national\.txt$/i.test(file.getName()));
  if (!places) throw new Error('CENSUS_PLACE_FILE_MISSING');
  const lookup = censusPlaceLookup_(places.getDataAsString());

  const book = SpreadsheetApp.openById(id);
  const roster = rosterColumns_(book, 'Listings Master', ['Listing ID', 'Status', 'City', 'State', 'Phone']);
  const exclusions = rosterColumns_(book, 'Do Not List', ['Phone', 'Active'], 'Active');
  console.log(JSON.stringify(summarizeCityCoverage_(roster, exclusions, lookup)));
}

function censusPlaceLookup_(data) {
  const [first, ...lines] = data.split(/\r?\n/);
  const headers = first.replace(/^\uFEFF/, '').split('\t').map(clean);
  const fields = ['USPS', 'NAME', 'INTPTLAT', 'INTPTLONG'].map(field => headers.indexOf(field));
  if (fields.includes(-1)) throw new Error('CENSUS_HEADER_MISMATCH');
  const lookup = new Map();
  for (const line of lines) {
    const cells = line.split('\t');
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

function summarizeCityCoverage_(roster, exclusions, lookup) {
  const matched = new Set();
  const unmatched = new Set();
  let matchedListings = 0;
  const totals = summarizeRoster_(roster, exclusions, (city, state) => {
    const key = JSON.stringify([city, state]);
    if (lookup.get(key)) {
      matched.add(key);
      matchedListings++;
    } else {
      unmatched.add(key);
    }
  });
  return {
    candidateListings: totals.candidateListings,
    matchedListings,
    unmatchedListings: totals.candidateListings - matchedListings,
    matchedCityStatePairs: matched.size,
    unmatchedCityStatePairs: unmatched.size
  };
}

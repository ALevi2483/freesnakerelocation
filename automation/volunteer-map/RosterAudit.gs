// Run from the editor of the private Apps Script project.
// Only aggregate counts are written to the execution log.
function auditProductionRoster() {
  const id = clean(PR.getProperty('ROSTER_SPREADSHEET_ID'));
  if (!id) throw new Error('SET_ROSTER_SPREADSHEET_ID');
  try {
    const book = SpreadsheetApp.openById(id);
    const roster = rosterColumns_(book, 'Listings Master', ['Listing ID', 'Status', 'City', 'State', 'Phone']);
    const exclusions = rosterColumns_(book, 'Do Not List', ['Phone', 'Active'], 'Active');
    console.log(JSON.stringify(summarizeRoster_(roster, exclusions)));
  } catch (_) {
    throw new Error('ROSTER_AUDIT_FAILED_CHECK_ACCESS_AND_HEADERS');
  }
}

function rosterColumns_(book, name, fields, typedField) {
  const sheet = book.getSheetByName(name);
  if (!sheet || !sheet.getLastColumn()) throw new Error('ROSTER_SHEET_MISSING');
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(clean);
  const size = Math.max(0, sheet.getLastRow() - 1);
  const columns = fields.map(field => {
    const index = header.indexOf(field);
    if (index < 0 || index !== header.lastIndexOf(field)) throw new Error('ROSTER_HEADER_MISMATCH');
    if (!size) return [];
    const range = sheet.getRange(2, index + 1, size, 1);
    return field === typedField ? range.getValues() : range.getDisplayValues();
  });
  return Array.from({length: size}, (_, row) =>
    Object.fromEntries(fields.map((field, index) => [field, columns[index][row][0]])));
}

function summarizeRoster_(roster, exclusions, onCandidate = () => {}) {
  const counts = {
    active: 0, removed: 0, otherStatus: 0, blockedByPhone: 0,
    invalidActiveExclusions: 0, unknownExclusionFlags: 0,
    activeWithMissingOrInvalidPhone: 0, activeWithMissingOrDuplicateId: 0,
    activeWithMissingCityOrState: 0, candidateListings: 0, candidateCityStatePairs: 0
  };
  const blocked = new Set();
  for (const exclusion of exclusions) {
    const phone = phoneKey(exclusion.Phone);
    if (exclusion.Active === false || (exclusion.Active === '' && !clean(exclusion.Phone))) continue;
    if (exclusion.Active !== true) counts.unknownExclusionFlags++;
    if (exclusion.Active === true && !phone) counts.invalidActiveExclusions++;
    // For an ambiguous flag with a valid phone, err on the side of excluding it.
    if (phone) blocked.add(phone);
  }

  const ids = new Map();
  for (const listing of roster) {
    const id = clean(listing['Listing ID']);
    if (id) ids.set(id, (ids.get(id) || 0) + 1);
  }
  const cityStates = new Set();
  for (const listing of roster) {
    if (!Object.values(listing).some(value => clean(value))) continue;
    const status = normalize(listing.Status);
    if (status !== 'active') {
      counts[status === 'removed' ? 'removed' : 'otherStatus']++;
      continue;
    }
    counts.active++;
    const phone = phoneKey(listing.Phone);
    const isBlocked = blocked.has(phone);
    const uniqueId = ids.get(clean(listing['Listing ID'])) === 1;
    const city = normalize(listing.City);
    const state = normalize(listing.State);
    if (isBlocked) counts.blockedByPhone++;
    if (!phone) counts.activeWithMissingOrInvalidPhone++;
    if (!uniqueId) counts.activeWithMissingOrDuplicateId++;
    if (!city || !state) counts.activeWithMissingCityOrState++;
    if (phone && !isBlocked && uniqueId && city && state) {
      counts.candidateListings++;
      cityStates.add(JSON.stringify([city, state]));
      onCandidate(city, state);
    }
  }
  counts.candidateCityStatePairs = cityStates.size;
  return counts;
}

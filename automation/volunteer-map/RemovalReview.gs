function verifyUnmatchedRemovalReview() {
  const {summary} = removalReviewState_();
  console.log(JSON.stringify(summary));
}

function applyCheckedUnmatchedRemovals() {
  withWorkflowLock(() => {
    const {rosterId, summary, approved} = removalReviewState_();
    if (!summary.ready) throw new Error('REMOVAL_REVIEW_NOT_READY');
    requireRestrictedRosterBackup_(rosterId);

    const sheet = SpreadsheetApp.openById(rosterId).getSheetByName('Listings Master');
    const values = sheet.getDataRange().getDisplayValues();
    const targets = approvedRemovalRows_(values, approved);
    const headers = values[0].map(clean);
    const statusColumn = headers.indexOf('Status') + 1;
    const idColumn = headers.indexOf('Listing ID');
    const letter = sheet.getRange(1, statusColumn).getA1Notation().replace(/\d+$/, '');
    sheet.getRangeList(targets.map(row => letter + row)).setValue('Removed');
    SpreadsheetApp.flush();

    const finalValues = sheet.getDataRange().getDisplayValues();
    if (targets.some((row, index) => normalize(finalValues[row - 1][statusColumn - 1]) !== 'removed' ||
        clean(finalValues[row - 1][idColumn]) !== approved[index].id)) {
      throw new Error('CHECK_PRODUCTION_STATUS_AFTER_WRITE');
    }
    console.log(JSON.stringify({markedRemoved: targets.length, rebuildPublicDirectory: true}));
  });
}

function requireRestrictedRosterBackup_(rosterId) {
  const original = DriveApp.getFileById(rosterId);
  if (original.getSharingAccess() !== DriveApp.Access.PRIVATE) throw new Error('ROSTER_SHARING_NOT_RESTRICTED');
  const parents = original.getParents();
  while (parents.hasNext()) {
    const parent = parents.next();
    if (parent.getSharingAccess() !== DriveApp.Access.PRIVATE) continue;
    const copies = parent.getFilesByName('Snake Relocation Application — Before Unmatched Removals');
    while (copies.hasNext()) {
      const copy = copies.next();
      if (copy.getId() !== rosterId && copy.getMimeType() === MimeType.GOOGLE_SHEETS &&
          copy.getSharingAccess() === DriveApp.Access.PRIVATE) return;
    }
  }
  throw new Error('RESTRICTED_ROSTER_BACKUP_MISSING');
}

function approvedRemovalRows_(values, approved) {
  const header = values[0].map(clean);
  const fields = ['Listing ID', 'Status', 'City', 'State'];
  if (fields.some(field => header.indexOf(field) < 0 || header.indexOf(field) !== header.lastIndexOf(field))) {
    throw new Error('ROSTER_HEADER_MISMATCH');
  }
  const [idCol, statusCol, cityCol, stateCol] = fields.map(field => header.indexOf(field));
  const byId = new Map();
  values.slice(1).forEach((row, index) => {
    const id = clean(row[idCol]);
    if (id) byId.set(id, byId.has(id) ? null : {row, number: index + 2});
  });
  return approved.map(listing => {
    const target = byId.get(listing.id);
    if (!target || normalize(target.row[statusCol]) !== 'active' ||
        normalize(target.row[cityCol]) !== listing.city || normalize(target.row[stateCol]) !== listing.state) {
      throw new Error('ROSTER_CHANGED_RECHECK_REMOVALS');
    }
    return target.number;
  });
}

function removalReviewState_() {
  const testId = clean(PR.getProperty('RESPONSE_SHEET_ID'));
  const rosterId = clean(PR.getProperty('ROSTER_SPREADSHEET_ID'));
  if (!testId || !rosterId || testId === rosterId) {
    throw new Error('REVIEW_REQUIRES_SEPARATE_TEST_WORKBOOK');
  }
  const book = SpreadsheetApp.openById(testId);
  const review = rosterColumns_(book, 'Unmatched Removal Review',
    ['Listing ID', 'City', 'State', 'Match issue', 'Approve removal'], 'Approve removal');
  const {unmatchedListings, eligibility} = readCityCoverage_();
  const checks = compareRemovalReview_(review, unmatchedListings);
  const exclusionsNeedReview = eligibility.invalidActiveExclusions + eligibility.unknownExclusionFlags;
  const ready = checks.approved > 0 && checks.approved === checks.stillUnmatched &&
    !checks.invalidOrDuplicate && !exclusionsNeedReview;
  const approved = review.filter(row => row['Approve removal'] === true).map(row => ({
    id: clean(row['Listing ID']), city: normalize(row.City), state: normalize(row.State)
  }));
  return {rosterId, approved, summary: {...checks, exclusionsNeedReview, ready}};
}

function compareRemovalReview_(rows, unmatchedListings) {
  const current = new Map(unmatchedListings.map(row => [row.id, row]));
  const seen = new Set();
  const counts = {approved: 0, stillUnmatched: 0, changedOrMissing: 0, invalidOrDuplicate: 0};
  for (const row of rows) {
    const approval = row['Approve removal'];
    if (approval === false || approval === '') continue;
    if (approval !== true) {
      counts.invalidOrDuplicate++;
      continue;
    }
    counts.approved++;
    const id = clean(row['Listing ID']);
    if (!id || seen.has(id)) {
      counts.invalidOrDuplicate++;
      continue;
    }
    seen.add(id);
    const listing = current.get(id);
    if (listing && listing.city === normalize(row.City) && listing.state === normalize(row.State) &&
        listing.issue === clean(row['Match issue'])) {
      counts.stillUnmatched++;
    } else {
      counts.changedOrMissing++;
    }
  }
  return counts;
}

// Read-only. Run in the private test project before changing the production roster.
function verifyUnmatchedRemovalReview() {
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
  console.log(JSON.stringify({...checks, exclusionsNeedReview, ready}));
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

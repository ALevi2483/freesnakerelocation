const PR = PropertiesService.getScriptProperties();
const SNAPSHOT_SECONDS = 25 * 60;

function setupWorkflow() {
  const config = configuration();
  const book = SpreadsheetApp.openById(config.bookId);
  sourceData(book, config);
  let review = book.getSheetByName(config.review);
  if (!review) {
    // Copy only on initial installation, before changing the response workbook.
    DriveApp.getFileById(config.bookId).makeCopy('Volunteer workflow backup ' + new Date().toISOString());
    review = book.insertSheet(config.review);
    review.getRange(1, 1, 1, REVIEW_COLUMNS.length).setValues([REVIEW_COLUMNS]);
    review.setFrozenRows(1);
  }
  reviewRows(review);
  const rules = SpreadsheetApp.newDataValidation().requireValueInList([
    'APPROVE APPROXIMATE', 'APPROVE PRECISE', 'REMOVE', 'REJECT', 'RETRY'
  ]).setAllowInvalid(false).build();
  review.getRange(2, COL.Action + 1, review.getMaxRows() - 1).setDataValidation(rules);
  const handlers = new Set(ScriptApp.getProjectTriggers().map(trigger => trigger.getHandlerFunction()));
  if (!handlers.has('onVolunteerSubmit')) {
    ScriptApp.newTrigger('onVolunteerSubmit').forSpreadsheet(book).onFormSubmit().create();
  }
  if (!handlers.has('reconcileVolunteers')) {
    ScriptApp.newTrigger('reconcileVolunteers').timeBased().everyMinutes(15).create();
  }
  if (!handlers.has('checkPublicFeed')) {
    ScriptApp.newTrigger('checkPublicFeed').timeBased().everyHours(1).create();
  }
}

function configuration() {
  const fields = JSON.parse(PR.getProperty('SOURCE_FIELDS') || '{}');
  const bookId = PR.getProperty('RESPONSE_SHEET_ID');
  const source = PR.getProperty('RESPONSE_TAB');
  const review = PR.getProperty('REVIEW_TAB') || 'Map Review';
  const email = PR.getProperty('ADMIN_EMAIL');
  if (!bookId || !source || source === review || !email ||
      !['timestamp', 'name', 'address', 'city', 'region', 'country'].every(key => fields[key])) {
    throw new Error('CHECK_PRIVATE_WORKFLOW_CONFIGURATION');
  }
  return { fields, bookId, source, review, email };
}

function sourceData(book, config) {
  const sheet = book.getSheetByName(config.source);
  if (!sheet || sheet.getLastColumn() < 1) throw new Error('SOURCE_TAB_MISSING');
  const [headers, ...values] = sheet.getDataRange().getDisplayValues();
  Object.values(config.fields).filter(Boolean).forEach(field => {
    if (headers.filter(header => header === field).length !== 1) throw new Error('SOURCE_HEADER_MISMATCH');
  });
  return {headers, values};
}

function reviewRows(sheet) {
  if (!sheet) throw new Error('RUN_SETUP_WORKFLOW');
  const [headers, ...rows] = sheet.getDataRange().getValues();
  if (headers.join('|') !== REVIEW_COLUMNS.join('|')) throw new Error('REVIEW_HEADER_MISMATCH');
  return rows;
}

function digest(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, value)).replace(/=+$/, '');
}

function withWorkflowLock(work) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('WORKFLOW_BUSY');
  try { return work(); }
  finally { lock.releaseLock(); }
}

function geocode(query) {
  const cache = CacheService.getScriptCache();
  const key = 'geo:' + digest(query);
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);
  if (PR.getProperty('GEOCODING_ENABLED') !== 'true') throw new Error('GEOCODING_DISABLED');
  const limit = Number(PR.getProperty('DAILY_GEOCODE_LIMIT') || 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('GEOCODE_LIMIT_INVALID');
  // Sliding window stays below the configured limit even across midnight.
  const now = Date.now();
  const calls = JSON.parse(PR.getProperty('RECENT_GEOCODES') || '[]')
    .filter(time => time > now - 86400000);
  if (calls.length >= limit) throw new Error('GEOCODE_BUDGET_REACHED');
  calls.push(now);
  PR.setProperty('RECENT_GEOCODES', JSON.stringify(calls));
  const response = Maps.newGeocoder().geocode(query);
  if (!['OK', 'ZERO_RESULTS'].includes(response.status)) throw new Error('GEOCODER_UNAVAILABLE');
  // Keep Google results transient. The review sheet holds only a validation status.
  cache.put(key, JSON.stringify(response), CACHE_SECONDS);
  return response;
}

function onVolunteerSubmit(event) {
  // The scheduled reconciliation is also a retry path when this trigger is busy.
  if (event && event.range.getSheet().getName() === PR.getProperty('RESPONSE_TAB')) {
    reconcileVolunteers();
  }
}

function reconcileVolunteers() {
  let config;
  try {
    config = configuration();
    withWorkflowLock(() => {
      const book = SpreadsheetApp.openById(config.bookId);
      const sheet = book.getSheetByName(config.review);
      const rows = reviewRows(sheet);
      // Changes to visibility are handled first. Other stages can continue if
      // geocoding for a queued approval or a public refresh fails.
      const stages = [
        () => applyActions(sheet, rows),
        () => {
          if (PR.getProperty('PUBLIC_FEED_ENABLED') !== 'true') return;
          SpreadsheetApp.flush();
          refreshPublic(reviewRows(sheet));
        },
        () => ingest(sheet, rows, sourceData(book, config), config.fields),
        () => validatePending(sheet, rows)
      ];
      const failures = new Set();
      for (const stage of stages) {
        try { stage(); }
        catch (error) { failures.add(safeCode(error)); }
      }
      for (const code of failures) {
        notifyAdmin(config.email, code, 'Check the private Apps Script execution and review tab.');
      }
      const attention = rows.filter(row => row[COL.Issue] && row[COL.Status] === 'PENDING').length;
      const failedActions = rows.filter(row => clean(row[COL.Action]) && row[COL.Issue]).length;
      if (attention || failedActions) notifyAdmin(config.email, 'REVIEW_NEEDED',
        attention + ' pending records and ' + failedActions + ' actions need attention in the private review tab.');
      if (failures.size) throw new Error([...failures][0]);
    });
  } catch (error) {
    const code = safeCode(error);
    const email = config ? config.email : PR.getProperty('ADMIN_EMAIL');
    if (email && code !== 'WORKFLOW_BUSY') {
      notifyAdmin(email, code, 'Check the private Apps Script execution and review tab.');
    }
    throw new Error(code);
  }
}

function safeCode(error) {
  const code = clean(error && error.message);
  return /^[A-Z_]{4,50}$/.test(code) ? code : 'WORKFLOW_ERROR';
}

function notifyAdmin(email, code, summary) {
  const key = 'NOTICE_' + code;
  const now = Date.now();
  if (now - Number(PR.getProperty(key) || 0) < 86400000) return;
  MailApp.sendEmail(email, 'Volunteer map: ' + code, summary);
  PR.setProperty(key, String(now));
}

function writeRow(sheet, index, row) {
  if (index + 2 > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), 100);
    sheet.getRange(index + 2, COL.Action + 1, 100)
      .setDataValidation(sheet.getRange(2, COL.Action + 1).getDataValidation());
  }
  const range = sheet.getRange(index + 2, 1, 1, REVIEW_COLUMNS.length);
  // Prefix strings Sheets could interpret as formulas or numbers. Preserve leading zeroes.
  range.setValues([row.map(value => typeof value === 'string' && value !== '' ? "'" + value : value)]);
}

function updateReview(sheet, index, row, columns, handledAction) {
  const number = index + 2;
  if (sheet.getRange(number, COL.ID + 1).getDisplayValue() !== row[COL.ID]) {
    throw new Error('REVIEW_ROW_MOVED');
  }
  for (const column of columns) {
    const value = row[COL[column]];
    sheet.getRange(number, COL[column] + 1).setValue(
      typeof value === 'string' && value !== '' ? "'" + value : value);
  }
  if (handledAction && !row[COL.Action]) {
    const actionCell = sheet.getRange(number, COL.Action + 1);
    if (clean(actionCell.getDisplayValue()) === handledAction) actionCell.clearContent();
  }
}

function ingest(sheet, rows, source, fields) {
  const seen = new Set(rows.map(row => row[COL.ID]));
  const knownAddresses = new Map(rows.filter(row => row[COL['Address check']] === 'VALIDATED')
    .map(row => [normalize(addressQuery(rowRecord(row))), 'VALIDATED']));
  let inserted = 0;
  for (const values of source.values) {
    if (inserted >= MAX_INTAKE_PER_RUN) break;
    if (!values.some(value => clean(value))) continue;
    const record = recordFrom(values, source.headers, fields);
    const id = digest(JSON.stringify(record));
    if (seen.has(id)) continue;
    const duplicates = duplicateIds(record, rows);
    const row = [id, record.timestamp, record.name, record.email, record.address, record.city,
      record.region, record.postal, record.country, record.precise, record.alias,
      knownAddresses.get(normalize(addressQuery(record))) || '', duplicates.join(', '), 'PENDING', '', '', '', duplicates.length ? 'POTENTIAL_DUPLICATE' : '', ''];
    writeRow(sheet, rows.length, row);
    rows.push(row);
    seen.add(id);
    inserted++;
  }
}

function rowRecord(row) {
  return {
    address: clean(row[COL.Address]), city: clean(row[COL.City]), region: clean(row[COL.Region]),
    postal: clean(row[COL.Postal]), country: clean(row[COL.Country])
  };
}

function validatePending(sheet, rows) {
  if (PR.getProperty('GEOCODING_ENABLED') !== 'true') return;
  let checked = 0;
  for (const [index, row] of rows.entries()) {
    if (checked >= MAX_INTAKE_PER_RUN) break;
    if (row[COL.Status] !== 'PENDING' || row[COL['Address check']]) continue;
    const record = rowRecord(row);
    let status = 'INCOMPLETE_ADDRESS';
    if ([record.address, record.city, record.region, record.country].every(Boolean)) {
      const result = validatedResult(geocode(addressQuery(record)), record, true);
      status = result ? 'VALIDATED' : 'ADDRESS_NEEDS_REVIEW';
    }
    row[COL['Address check']] = status;
    row[COL.Issue] = status === 'VALIDATED' ?
      (row[COL['Potential duplicate IDs']] ? 'POTENTIAL_DUPLICATE' : '') : status;
    updateReview(sheet, index, row, ['Address check', 'Issue']);
    checked++;
  }
}

function applyActions(sheet, rows) {
  const cache = CacheService.getScriptCache();
  let approvals = 0;
  // Handle revocations first even if geocoding for a later approval fails.
  for (const [index, row] of rows.entries()) {
    const action = clean(row[COL.Action]);
    if (!['REMOVE', 'REJECT', 'RETRY'].includes(action)) continue;
    if (action === 'RETRY' && row[COL.Status] === 'PENDING') {
      row[COL['Address check']] = '';
    } else if (action === 'REMOVE' || (action === 'REJECT' && row[COL.Status] === 'PENDING')) {
      // Clear the snapshot before changing visibility.
      cache.remove(PUBLIC_CACHE);
      row[COL.Status] = action === 'REMOVE' ? 'REMOVED' : 'REJECTED';
    } else {
      row[COL.Issue] = 'ACTION_NOT_ALLOWED';
      updateReview(sheet, index, row, ['Issue']);
      continue;
    }
    row[COL.Action] = '';
    row[COL.Issue] = '';
    updateReview(sheet, index, row, ['Status', 'Address check', 'Issue'], action);
  }
  SpreadsheetApp.flush();

  for (const [index, row] of rows.entries()) {
    const action = clean(row[COL.Action]);
    if (!action || !action.startsWith('APPROVE ') || approvals >= MAX_INTAKE_PER_RUN) continue;
    approvals++;
    const precise = action === 'APPROVE PRECISE';
    const replacement = clean(row[COL['Replace ID']]);
    const previous = rows.findIndex(other => other[COL.ID] === replacement);
    const active = candidate => /^ACTIVE_(APPROXIMATE|PRECISE)$/.test(candidate[COL.Status]);
    const priorReplaced = previous >= 0 && rows[previous][COL.Status] === 'SUPERSEDED' &&
      rows[previous][COL['Superseded by']] === row[COL.ID];
    const record = rowRecord(row);
    const duplicates = duplicateIds({...record, name: row[COL.Name], email: row[COL.Email]},
      rows.filter(other => other !== row));
    const liveDuplicates = duplicates.filter(id => rows.some(other => other[COL.ID] === id && active(other)));
    let issue = '';
    if (!['APPROVE APPROXIMATE', 'APPROVE PRECISE'].includes(action) || row[COL.Status] !== 'PENDING') {
      issue = 'ACTION_NOT_ALLOWED';
    } else if (row[COL['Address check']] !== 'VALIDATED') {
      issue = 'ADDRESS_NOT_VALIDATED';
    } else if (precise && PR.getProperty('PRECISE_PUBLICATION_ENABLED') !== 'true') {
      issue = 'PRECISE_PUBLICATION_DISABLED';
    } else if (precise && row[COL['Precise consent']] !== true) {
      issue = 'PRECISE_CONSENT_REQUIRED';
    } else if (replacement && (previous === index || previous < 0 ||
               (!active(rows[previous]) && !priorReplaced))) {
      issue = 'REPLACEMENT_ID_INVALID';
    } else if (liveDuplicates.some(id => id !== replacement)) {
      issue = 'ACTIVE_DUPLICATE_REQUIRES_REPLACEMENT';
    } else if (rows.filter(active).length >= MAX_PUBLIC && !(previous >= 0 && active(rows[previous]))) {
      issue = 'PUBLIC_CAPACITY_REACHED';
    } else {
      const query = precise ? addressQuery(record) : [record.city, record.region, record.country].join(', ');
      const result = validatedResult(geocode(query), record, precise);
      if (!result) {
        issue = 'MAP_LOCATION_NEEDS_REVIEW';
      } else {
        cache.remove(PUBLIC_CACHE);
        if (previous >= 0 && !priorReplaced) {
          rows[previous][COL.Status] = 'SUPERSEDED';
          rows[previous][COL['Superseded by']] = row[COL.ID];
          updateReview(sheet, previous, rows[previous], ['Superseded by', 'Status']);
          SpreadsheetApp.flush();
        }
        row[COL['Public locality']] = [record.city, record.region, record.country].join(', ');
        row[COL.Status] = precise ? 'ACTIVE_PRECISE' : 'ACTIVE_APPROXIMATE';
        row[COL.Action] = '';
      }
    }
    row[COL.Issue] = issue;
    updateReview(sheet, index, row, ['Public locality', 'Status', 'Issue'], action);
  }
  SpreadsheetApp.flush();
}

function refreshPublic(rows) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(PUBLIC_CACHE);
  if (cached && Date.now() - JSON.parse(cached).builtAt < 10 * 60 * 1000) return;
  const points = [];
  let missing = 0;
  for (const row of rows) {
    const precise = row[COL.Status] === 'ACTIVE_PRECISE';
    if (!precise && row[COL.Status] !== 'ACTIVE_APPROXIMATE') continue;
    // Also check consent at serving time in case it has been withdrawn.
    if (precise && (row[COL['Precise consent']] !== true ||
      PR.getProperty('PRECISE_PUBLICATION_ENABLED') !== 'true')) continue;
    const record = rowRecord(row);
    const query = precise ? addressQuery(record) : [record.city, record.region, record.country].join(', ');
    let result;
    try { result = validatedResult(geocode(query), record, precise); }
    catch (error) {
      if (safeCode(error) !== 'GEOCODER_UNAVAILABLE') throw error;
    }
    const point = result && publicPoint(row, result);
    if (point) points.push(point);
    else missing++;
  }
  if (missing) notifyAdmin(configuration().email, 'PUBLIC_LOCATIONS_MISSING',
    missing + ' approved locations could not be mapped. Check the private review tab.');
  const json = JSON.stringify({ version: 1, points, missing, builtAt: Date.now() });
  if (Utilities.newBlob(json).getBytes().length > 95000) throw new Error('PUBLIC_PAYLOAD_TOO_LARGE');
  cache.put(PUBLIC_CACHE, json, SNAPSHOT_SECONDS);
}

function doGet() {
  let body = JSON.stringify({ version: 1, error: 'MAP_UNAVAILABLE' });
  if (PR.getProperty('PUBLIC_FEED_ENABLED') === 'true') {
    try {
      const snapshot = JSON.parse(CacheService.getScriptCache().get(PUBLIC_CACHE) || 'null');
      if (snapshot && Date.now() - snapshot.builtAt < SNAPSHOT_SECONDS * 1000) {
        const points = PR.getProperty('PRECISE_PUBLICATION_ENABLED') === 'true'
          ? snapshot.points : snapshot.points.filter(point => !point.precise);
        body = JSON.stringify({version: 1, points, missing: snapshot.missing});
      }
    } catch (_) {
      // Anonymous requests never receive diagnostics or trigger geocoding.
    }
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function checkPublicFeed() {
  if (PR.getProperty('PUBLIC_FEED_ENABLED') !== 'true') return;
  const url = PR.getProperty('PUBLIC_FEED_URL') || '';
  const config = configuration();
  try {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
      throw new Error('HEALTH_URL_MISSING');
    }
    const response = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    const body = response.getResponseCode() === 200 ? JSON.parse(response.getContentText()) : null;
    if (!body || body.version !== 1 || !Array.isArray(body.points) || body.missing) {
      throw new Error('PUBLIC_FEED_HEALTH_CHECK_FAILED');
    }
  } catch (error) {
    notifyAdmin(config.email, 'PUBLIC_FEED_HEALTH_CHECK_FAILED',
      'The anonymous map feed is unavailable, misconfigured, or missing approved locations.');
    throw new Error('PUBLIC_FEED_HEALTH_CHECK_FAILED');
  }
}

const REVIEW_COLUMNS = [
  'ID', 'Submitted', 'Name', 'Email', 'Address', 'City', 'Region', 'Postal', 'Country',
  'Precise consent', 'Public alias', 'Address check', 'Potential duplicate IDs',
  'Status', 'Action', 'Replace ID', 'Public locality', 'Issue', 'Superseded by', 'Phone (private)', 'Application type'
];
const REGISTRATION_FIELDS = Object.freeze({
  timestamp: 'Timestamp',
  name: 'Full Name',
  address: 'Street Address number (must put a full address that we can pull specific GPS coordinates.)',
  city: 'City',
  region: 'State',
  phone: 'Phone Number (Use this exact format, e.g., 555-123-4567). Do not use parentheses and make sure you use the hyphens.',
  applicationType: 'Which applies to you?'
});
const COL = Object.fromEntries(REVIEW_COLUMNS.map((name, i) => [name, i]));
const PUBLIC_CACHE = 'public-map-v1';
const CACHE_SECONDS = 21600;
const MAX_PUBLIC = 350;
const MAX_INTAKE_PER_RUN = 25;

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function normalize(value) {
  return clean(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

function recordFrom(values, headers, fields, defaultCountry = '') {
  const field = key => fields[key] ? clean(values[headers.indexOf(clean(fields[key]))]) : '';
  const record = {
    timestamp: field('timestamp'), name: field('name'), email: field('email'),
    address: field('address'), city: field('city'), region: field('region'),
    postal: field('postal'), country: field('country') || defaultCountry,
    precise: normalize(field('preciseConsent')) === 'yes, show my precise location',
    alias: safeAlias(field('publicAlias'))
  };
  if (fields.phone) record.phone = field('phone');
  if (fields.applicationType) record.applicationType = field('applicationType');
  return record;
}

function phoneKey(value) {
  const digits = clean(value).replace(/[^0-9]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length === 10 ? digits : '';
}

function addressQuery(record) {
  return [record.address, record.city, record.region, record.postal, record.country]
    .filter(Boolean).join(', ');
}

function duplicateIds(record, rows) {
  const phone = phoneKey(record.phone);
  return rows.filter(row => {
    if (['REMOVED', 'REJECTED', 'SUPERSEDED'].includes(row[COL.Status])) return false;
    const sameEmail = normalize(record.email) && normalize(record.email) === normalize(row[COL.Email]);
    const samePersonAtAddress = normalize(record.name) && normalize(record.address) &&
      ['Name', 'Address', 'City', 'Region', 'Country'].every(
        (column, i) => normalize(row[COL[column]]) === normalize(
          [record.name, record.address, record.city, record.region, record.country][i]));
    const samePhone = phone && phone === phoneKey(row[COL['Phone (private)']]);
    return sameEmail || samePhone || samePersonAtAddress;
  }).map(row => row[COL.ID]);
}

function component(result, type, key) {
  const match = (result.address_components || []).find(item => item.types.includes(type));
  return match ? clean(match[key]) : '';
}

function matchesArea(result, record) {
  const city = component(result, 'locality', 'long_name') ||
    component(result, 'postal_town', 'long_name');
  return normalize(city) === normalize(record.city) &&
    [component(result, 'administrative_area_level_1', 'short_name'),
     component(result, 'administrative_area_level_1', 'long_name')].some(
      value => normalize(value) === normalize(record.region)) &&
    [component(result, 'country', 'short_name'), component(result, 'country', 'long_name')].some(
      value => normalize(value) === normalize(record.country));
}

function validatedResult(response, record, precise) {
  const results = (response.results || []).filter(result => {
    if (result.partial_match || !matchesArea(result, record)) return false;
    if (!precise) return result.types.some(type => ['locality', 'postal_town'].includes(type));
    const submittedNumber = record.address.match(/^\s*(\d+[a-z]?)\b/i);
    return result.geometry.location_type === 'ROOFTOP' &&
      submittedNumber && normalize(submittedNumber[1]) ===
        normalize(component(result, 'street_number', 'long_name')) &&
      (!record.postal || normalize(record.postal) ===
        normalize(component(result, 'postal_code', 'long_name')));
  });
  return results.length === 1 ? results[0] : null;
}

function safeAlias(value) {
  const alias = clean(value).slice(0, 80);
  if (/@|https?:|www\.|(?:\d[().+ -]*){7}/i.test(alias)) return '';
  return alias;
}

function publicPoint(row, result) {
  const {lat, lng} = result.geometry.location;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
      Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const precise = row[COL.Status] === 'ACTIVE_PRECISE';
  return {
    label: safeAlias(row[COL['Public alias']]) || 'Volunteer relocator',
    locality: clean(row[COL['Public locality']]).slice(0, 100),
    lat, lng, precise
  };
}

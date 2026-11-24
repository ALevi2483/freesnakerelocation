import {config} from './config.js';

const mapStatus = document.querySelector('#map-status');
const searchStatus = document.querySelector('#search-status');
const form = document.querySelector('#search');
const input = document.querySelector('#location');
const searchButton = form.querySelector('button');

if (new URLSearchParams(window.location.search).get('embedded') === '1') {
  document.body.classList.add('embedded-map');
}

function validFeedUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://script.google.com' &&
      /^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const url = new URL('https://maps.googleapis.com/maps/api/js');
    url.search = new URLSearchParams({
      key, v: 'quarterly', loading: 'async', callback: 'volunteerMapReady',
      auth_referrer_policy: 'origin',
    });
    const timeout = setTimeout(() => reject(new Error('MAP_LOAD_TIMEOUT')), 12000);
    window.volunteerMapReady = () => {
      clearTimeout(timeout);
      resolve();
    };
    window.gm_authFailure = () => {
      clearTimeout(timeout);
      reject(new Error('MAP_AUTH_FAILED'));
      mapStatus.textContent = 'Google Maps authorization failed. Use the volunteer directory for contact information.';
      searchButton.disabled = true;
      input.disabled = true;
    };
    script.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('MAP_LOAD_FAILED'));
    };
    script.src = url.href;
    document.head.append(script);
  });
}

function validPoint(point) {
  return point && typeof point.label === 'string' && typeof point.locality === 'string' &&
    typeof point.precise === 'boolean' && Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
}

function rosterPoint(city, state, count, lat, lng) {
  if (typeof city !== 'string' || !city.trim() || city.length > 100 ||
      typeof state !== 'string' || !/^[a-z]{2}$/i.test(state) ||
      !Number.isSafeInteger(count) || count < 1 || count > 100000) throw new Error('INVALID_ROSTER_POINT');
  const point = {label: count + (count === 1 ? ' volunteer listing' : ' volunteer listings'),
    locality: city + ', ' + state.toUpperCase(), city, state, precise: false, lat, lng, count};
  if (!validPoint(point)) throw new Error('INVALID_ROSTER_POINT');
  return point;
}

function readRosterPreview(csv) {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  if (header !== 'City,State,Listings,Latitude,Longitude' || !lines.length || lines.length > 5000) {
    throw new Error('INVALID_ROSTER_CSV');
  }
  return lines.map(line => {
    const fields = line.match(/^("(?:[^"]|"")*"|[^",]*),("(?:[^"]|"")*"|[^",]*),([^,]+),([^,]+),([^,]+)$/);
    if (!fields) throw new Error('INVALID_ROSTER_CSV');
    const [city, state] = fields.slice(1, 3).map(value =>
      value.replace(/^"(.*)"$/, '$1').replace(/""/g, '"').trim());
    const [count, lat, lng] = fields.slice(3).map(value => Number(value.trim()));
    if (fields.slice(3).some(value => !value.trim())) throw new Error('INVALID_ROSTER_CSV');
    return rosterPoint(city, state, count, lat, lng);
  });
}

function popup(point) {
  const box = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = point.label;
  const locality = document.createElement('p');
  locality.textContent = point.locality + (point.precise ? '' : ' (approximate area)');
  box.append(title, locality);
  if (point.precise) {
    const link = document.createElement('a');
    link.href = 'https://www.google.com/maps/dir/?' + new URLSearchParams({
      api: '1', destination: point.lat + ',' + point.lng,
    });
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Get directions in Google Maps';
    box.append(link);
  }
  return box;
}

async function loadPinContacts(box, feedUrl, point) {
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Loading volunteer contacts…';
  box.append(status);
  try {
    const url = new URL(feedUrl);
    url.search = new URLSearchParams({mode: 'map-contacts', city: point.city, state: point.state});
    const response = await fetch(url, {cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error('CONTACTS_UNAVAILABLE');
    const {contacts} = await response.json();
    if (!Array.isArray(contacts)) throw new Error('CONTACTS_UNAVAILABLE');
    const list = document.createElement('ul');
    list.className = 'pin-contacts';
    for (const contact of contacts) {
      if (!Array.isArray(contact) || contact.length !== 2) continue;
      const [name, phone] = contact;
      if (typeof name !== 'string' || !name.trim() || typeof phone !== 'string' || !/^\d{10}$/.test(phone)) continue;
      const row = document.createElement('li');
      const text = document.createElement('a');
      const formatted = phone.slice(0, 3) + '-' + phone.slice(3, 6) + '-' + phone.slice(6);
      text.href = 'sms:+1' + phone;
      text.textContent = 'Text ' + formatted;
      text.setAttribute('aria-label', 'Text ' + name + ' at ' + formatted);
      row.append(document.createTextNode(name + ' '), text);
      list.append(row);
    }
    if (list.children.length) {
      status.replaceWith(list);
      return;
    }
  } catch {
    // The directory link remains available when the contact request fails.
  }
  const directory = document.createElement('a');
  directory.href = '../find.html';
  directory.target = '_top';
  directory.textContent = 'Open the volunteer directory';
  status.textContent = 'Volunteer contacts are unavailable here. ';
  status.append(directory);
}

async function start() {
  const localDemo = window.location.origin === 'http://localhost:8000' && !config.feedUrl;
  const feedUrl = localDemo ? './demo-feed.json' : config.feedUrl;
  if (!localDemo && !validFeedUrl(feedUrl)) {
    mapStatus.textContent = 'This preview is awaiting setup. Use the volunteer directory for contact information.';
    return;
  }
  let {browserKey, mapId} = config;
  if (!browserKey && !mapId && !localDemo && location.origin === 'https://www.freesnakerelocation.com') {
    const settingsUrl = new URL(feedUrl);
    settingsUrl.searchParams.set('mode', 'browser-map-config');
    const response = await fetch(settingsUrl, {
      cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error('MAP_SETTINGS_UNAVAILABLE');
    ({browserKey, mapId} = await response.json());
    if (typeof browserKey !== 'string' || !/^AIza[\w-]{35}$/.test(browserKey) ||
        typeof mapId !== 'string' || !/^[\w-]{1,128}$/.test(mapId)) {
      throw new Error('MAP_SETTINGS_INVALID');
    }
  }
  if (!browserKey || !mapId) {
    mapStatus.textContent = 'This preview is awaiting setup. Use the volunteer directory for contact information.';
    return;
  }
  await loadGoogleMaps(browserKey);
  const [{Map, InfoWindow}, {AdvancedMarkerElement}, {Geocoder}] = await Promise.all([
    google.maps.importLibrary('maps'),
    google.maps.importLibrary('marker'),
    google.maps.importLibrary('geocoding'),
  ]);
  const map = new Map(document.querySelector('#map'), {
    mapId,
    center: {lat: 39.8, lng: -98.6},
    zoom: 4,
    mapTypeControl: true,
    zoomControl: true,
  });
  const info = new InfoWindow();
  const clusterer = new window.markerClusterer.MarkerClusterer({map, markers: []});
  const geocoder = new Geocoder();
  let lastSearch = 0;
  let revision = '';

  input.disabled = false;
  searchButton.disabled = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const address = input.value.trim();
    if (!address || searchButton.disabled || Date.now() - lastSearch < 2500) return;
    lastSearch = Date.now();
    searchButton.disabled = true;
    searchStatus.textContent = 'Searching…';
    try {
      const {results} = await geocoder.geocode({address});
      const match = results[0];
      if (!match) throw new Error('NO_LOCATION');
      if (match.geometry.viewport) map.fitBounds(match.geometry.viewport);
      else {
        map.setCenter(match.geometry.location);
        map.setZoom(12);
      }
      searchStatus.textContent = 'Showing ' + match.formatted_address;
    } catch {
      searchStatus.textContent = 'Location could not be found. Try adding a city, state, or ZIP code.';
    } finally {
      searchButton.disabled = false;
    }
  });

  function renderPoints(points) {
    const nextRevision = JSON.stringify(points);
    if (revision !== nextRevision) {
      info.close();
      clusterer.clearMarkers();
      const groups = new globalThis.Map();
      for (const point of points) {
        const key = point.lat + ',' + point.lng;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(point);
      }
      const markers = [...groups.values()].map(group => {
        const [point] = group;
        const marker = new AdvancedMarkerElement({
          position: {lat: point.lat, lng: point.lng},
          title: group.length === 1 ? point.label :
            group.length + (group.every(item => item.count) ? ' locations in this area' : ' volunteers in this area'),
          gmpClickable: true,
        });
        marker.addListener('click', () => {
          const details = document.createElement('div');
          for (const item of group) {
            const box = popup(item);
            details.append(box);
            if (!localDemo && item.city) void loadPinContacts(box, feedUrl, item);
          }
          info.setContent(details);
          info.open({map, anchor: marker});
        });
        return marker;
      });
      clusterer.addMarkers(markers);
      revision = nextRevision;
    }
  }

  async function refresh() {
    try {
      const response = await fetch(feedUrl, {
        cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error('FEED_UNAVAILABLE');
      const data = await response.json();
      if (data.version === 2) {
        if (!Array.isArray(data.locations) || data.locations.length > 5000 ||
            !data.locations.every(row => Array.isArray(row) && row.length === 5)) {
          throw new Error('INVALID_ROSTER_FEED');
        }
        const points = data.locations.map(row => rosterPoint(...row));
        renderPoints(points);
        const listings = points.reduce((sum, point) => sum + point.count, 0);
        mapStatus.textContent = listings + ' listings across ' + points.length + ' city/state pairs.' +
          (data.missing ? ' Some approved locations are unavailable.' : '');
      } else {
        if (data.version !== 1 || !Array.isArray(data.points) ||
            data.points.length > 350 || !data.points.every(validPoint)) {
          throw new Error('INVALID_FEED');
        }
        renderPoints(data.points);
        mapStatus.textContent = localDemo ? 'Demo: ' + data.points.length + ' fictional locations shown.'
          : data.missing ? 'Some approved locations are temporarily unavailable.'
          : data.points.length + ' approved locations shown.';
      }
    } catch {
      info.close();
      clusterer.clearMarkers();
      revision = '';
      mapStatus.textContent = 'Volunteer locations could not be loaded. Use the volunteer directory for contact information.';
    } finally {
      if (!localDemo) setTimeout(refresh, 5 * 60 * 1000);
    }
  }

  await refresh();
  if (localDemo) {
    const label = document.createElement('label');
    label.textContent = 'Load private Roster Map Preview CSV';
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.csv,text/csv';
    label.append(picker);
    mapStatus.before(label);
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (!file) return;
      picker.disabled = true;
      try {
        if (file.size > 1024 * 1024) throw new Error('ROSTER_CSV_TOO_LARGE');
        const points = readRosterPreview(await file.text());
        renderPoints(points);
        const listings = points.reduce((sum, point) => sum + point.count, 0);
        mapStatus.textContent = 'Private preview: ' + listings + ' listings across ' +
          points.length + ' city/state pairs.';
      } catch {
        mapStatus.textContent = 'Could not load this CSV. Download the Roster Map Preview tab as CSV.';
      } finally {
        picker.value = '';
        picker.disabled = false;
      }
    });
  }
}

start().catch(() => {
  mapStatus.textContent = 'The map could not be loaded. Use the volunteer directory for contact information.';
});

import {config} from './config.js';

const mapStatus = document.querySelector('#map-status');
const searchStatus = document.querySelector('#search-status');
const form = document.querySelector('#search');
const input = document.querySelector('#location');
const searchButton = form.querySelector('button');

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
      mapStatus.textContent = 'Google Maps authorization failed. Use the current directory link above.';
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

async function start() {
  const localDemo = window.location.origin === 'http://localhost:8000' && !config.feedUrl;
  const feedUrl = localDemo ? './demo-feed.json' : config.feedUrl;
  if (!config.browserKey || !config.mapId || (!localDemo && !validFeedUrl(feedUrl))) {
    mapStatus.textContent = 'This preview is awaiting setup. Use the current directory link above.';
    return;
  }
  await loadGoogleMaps(config.browserKey);
  const [{Map, InfoWindow}, {AdvancedMarkerElement}, {Geocoder}] = await Promise.all([
    google.maps.importLibrary('maps'),
    google.maps.importLibrary('marker'),
    google.maps.importLibrary('geocoding'),
  ]);
  const map = new Map(document.querySelector('#map'), {
    mapId: config.mapId,
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

  async function refresh() {
    try {
      const response = await fetch(feedUrl, {
        cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error('FEED_UNAVAILABLE');
      const data = await response.json();
      if (data.version !== 1 || !Array.isArray(data.points) ||
          data.points.length > 350 || !data.points.every(validPoint)) {
        throw new Error('INVALID_FEED');
      }
      const nextRevision = JSON.stringify(data.points);
      if (revision !== nextRevision) {
        info.close();
        clusterer.clearMarkers();
        const groups = new globalThis.Map();
        for (const point of data.points) {
          const key = point.lat + ',' + point.lng;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(point);
        }
        const markers = [...groups.values()].map(group => {
          const [point] = group;
          const marker = new AdvancedMarkerElement({
            position: {lat: point.lat, lng: point.lng},
            title: group.length === 1 ? point.label : group.length + ' volunteers in this area',
            gmpClickable: true,
          });
          marker.addListener('click', () => {
            const details = document.createElement('div');
            details.append(...group.map(popup));
            info.setContent(details);
            info.open({map, anchor: marker});
          });
          return marker;
        });
        clusterer.addMarkers(markers);
        revision = nextRevision;
      }
      mapStatus.textContent = localDemo ? 'Demo: ' + data.points.length + ' fictional locations shown.'
        : data.missing
        ? 'Some approved locations are temporarily unavailable.'
        : data.points.length + ' approved locations shown.';
    } catch {
      info.close();
      clusterer.clearMarkers();
      revision = '';
      mapStatus.textContent = 'Volunteer locations could not be loaded. Use the current directory link above.';
    } finally {
      setTimeout(refresh, 5 * 60 * 1000);
    }
  }

  await refresh();
}

start().catch(() => {
  mapStatus.textContent = 'The map could not be loaded. Use the current directory link above.';
});

const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const base = process.env.MAP_TEST_ORIGIN || 'http://127.0.0.1:8000';
const mapStub = `
  class TestMap {
    constructor(element, options) {
      this.element = element;
      element.dataset.mapControls = String(options.mapTypeControl && options.zoomControl);
    }
    fitBounds() { this.element.dataset.searched = 'true'; }
  }
  class Marker {
    constructor({title}) { this.title = title; }
    addListener(name, handler) { this.handler = handler; }
  }
  class Info {
    close() { document.querySelector('.test-popup')?.remove(); }
    setContent(element) { this.element = element; element.className = 'test-popup'; }
    open({map}) { this.close(); map.element.append(this.element); }
  }
  class Geocoder {
    async geocode({address}) {
      return {results: [{formatted_address: address, geometry: {viewport: {}}}]};
    }
  }
  window.google = {maps: {importLibrary: async () => ({
    Map: TestMap, InfoWindow: Info, AdvancedMarkerElement: Marker, Geocoder,
  })}};
  window.volunteerMapReady();
`;

async function checkPreview(browser, viewport) {
  const page = await browser.newPage({viewport});
  try {
    page.setDefaultTimeout(7000);
    await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
    await page.goto(base + '/map-preview/');
    await page.getByText('This preview is awaiting setup.', {exact: false}).waitFor();

    await page.addInitScript(() => {
      const timer = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) =>
        timer(callback, delay === 300000 ? 250 : delay, ...args);
      window.markerClusterer = {MarkerClusterer: class {
        constructor({map}) { this.map = map; }
        clearMarkers() { this.map.element.replaceChildren(); }
        addMarkers(markers) {
          for (const marker of markers) {
            const button = document.createElement('button');
            button.textContent = marker.title;
            button.onclick = marker.handler;
            this.map.element.append(button);
          }
        }
      }};
    });

    let points = [
      {label: '<b>Volunteer One</b>', locality: 'Austin, TX', lat: 30, lng: -97, precise: false},
      {label: 'Volunteer Two', locality: 'Austin, TX', lat: 30, lng: -97, precise: false},
      {label: 'Volunteer Three', locality: 'Austin, TX', lat: 31, lng: -97, precise: true},
    ];
    let available = true;
    await page.route('**/map-preview/config.js', route => route.fulfill({
      contentType: 'text/javascript',
      body: "export const config = {browserKey:'synthetic',mapId:'synthetic',feedUrl:'https://script.google.com/macros/s/synthetic/exec'};",
    }));
    await page.route('https://script.google.com/**', route => route.fulfill({
      status: available ? 200 : 503,
      json: {version: 1, points, missing: 0},
      headers: {'Access-Control-Allow-Origin': '*'},
    }));
    await page.route('https://maps.googleapis.com/**', route =>
      route.fulfill({contentType: 'text/javascript', body: mapStub}));

    await page.reload();
    await page.getByText('3 approved locations shown.').waitFor();
    assert.equal(await page.locator('#map').getAttribute('data-map-controls'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    await page.getByRole('button', {name: '2 volunteers in this area'}).click();
    await page.getByText('<b>Volunteer One</b>', {exact: true}).waitFor();
    await page.getByText('Volunteer Two', {exact: true}).waitFor();
    assert.equal(await page.getByRole('link', {name: /directions/}).count(), 0);
    await page.getByRole('button', {name: 'Volunteer Three'}).click();
    assert.match(await page.getByRole('link', {name: /directions/}).getAttribute('href'),
      /^https:\/\/www\.google\.com\/maps\/dir\//);

    for (const query of ['78701', 'Austin', '100 Sample Street']) {
      await page.getByRole('searchbox').fill(query);
      await page.getByRole('button', {name: 'Search map'}).click();
      await page.getByText('Showing ' + query, {exact: true}).waitFor();
      assert.equal(await page.locator('#map').getAttribute('data-searched'), 'true');
      // Wait for the per-browser submission throttle before the next search.
      await page.waitForTimeout(2500);
    }
    points = points.slice(0, 2);
    await page.getByText('2 approved locations shown.').waitFor();
    assert.equal(await page.getByRole('button', {name: 'Volunteer Three'}).count(), 0);
    available = false;
    await page.getByText('Volunteer locations could not be loaded.', {exact: false}).waitFor();
    assert.equal(await page.locator('#map button').count(), 0);
    console.log(`Passed synthetic browser map checks at ${viewport.width} × ${viewport.height}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
  try {
    await Promise.all([
      checkPreview(browser, {width: 1366, height: 900}),
      checkPreview(browser, {width: 390, height: 844}),
    ]);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

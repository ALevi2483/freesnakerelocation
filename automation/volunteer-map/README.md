# Volunteer registration and map setup

## Existing site

The custom domain is set in [CNAME](../../CNAME). The repository contains static pages and no build pipeline or Apps Script source for the deployed services. The volunteer form is linked from [volunteer.html](../../volunteer.html) and [Contact.html](../../Contact.html). The shared My Maps layer is embedded in [find.html](../../find.html), [closest.html](../../closest.html), and [map.html](../../map.html).

The existing search and review pages call public Apps Script URLs. [find.html](../../find.html) and [reviews.html](../../reviews.html) use one deployment with different modes. [home.html](../../home.html), [closest.html](../../closest.html), and [relocator-by-state.html](../../relocator-by-state.html) reference other deployments. A public URL does not identify the response workbook, script source, deployment permissions or triggers. Since the new workflow does not change those deployments, any changes to phone numbers, visibility or removals in those existing directories still follow their existing process.

The code adds a standalone [map preview](../../map-preview/index.html), an Apps Script project to install, and synthetic tests. The preview has no live credentials or data source in this branch. The existing pages, content, navigation, branding and My Maps embeds are intact.

## 1. Check access and create a sandbox

1. In Google Forms, open the volunteer form as an editor. Open **Responses → View in Sheets** and note the response tab name and the column headers. Identify where approved listings and removal requests currently live. Verify whether edits to existing responses write back to this tab.
2. Keep the form responses, workbook and backups private. If you want help mapping real fields, provide the column headers with a synthetic example, or authorize access to a private sandbox via an approved Google connection. For an end-to-end launch review, access is needed to the form settings, linked response workbook schema and sharing settings, existing Apps Script deployment sources or owner-provided exports, My Maps layer configuration, and the Cloud project settings when approved. Share settings or sanitized exports through a secure channel. Keep real responses and secret values out of chat and GitHub.
3. Create a private test workbook and a copy of the form linked to that workbook. Use synthetic volunteer names, aliases, consent and contact data. If you eventually authorize real geocoder testing, use a public landmark address for a synthetic volunteer and keep precise publication disabled. For the first installation check, copy only row 1 of the real response tab into a new private spreadsheet. Keep the headings in row 1 and add only synthetic submissions. This lets you verify the exact mapping and authorization safely before connecting a copy of the form for trigger tests.

## 2. Install Apps Script privately

1. In [Apps Script](https://script.google.com/home), create a **standalone** project under the account that owns or administers the test workbook. Keep edit access limited to trusted administrators.
2. Copy [Code.gs](Code.gs) and [Workflow.gs](Workflow.gs) into script files with those names. In **Project Settings**, show the manifest and copy [appsscript.json](appsscript.json). The project uses Sheets for the review queue, Drive to make an initial backup, Apps Script triggers, Mail to notify you, and URL Fetch to check its own public endpoint.
3. In **Project Settings → Script properties**, enter these values. The spreadsheet ID is the part of its private URL between `/d/` and `/edit`. Headers must match exactly, and optional mappings can be omitted.

   | Property | Value |
   | --- | --- |
   | `RESPONSE_SHEET_ID` | Your private test spreadsheet ID |
   | `RESPONSE_TAB` | The exact Form response tab name |
   | `REVIEW_TAB` | Optional. Defaults to `Map Review` |
   | `ADMIN_EMAIL` | The address that should receive private workflow notices |
   | `SOURCE_FIELDS` | Leave unset for the existing Free Snake Relocation form. Use a JSON object only for a different form schema |
   | `GEOCODING_ENABLED` | Leave `false` until you approve sending test addresses to Google Maps |
   | `DAILY_GEOCODE_LIMIT` | Optional. Starts at 100 actual requests per rolling 24 hours, including scheduled refreshes. Valid range is 1–500 |
   | `PUBLIC_FEED_ENABLED` | Leave `false` until publication of the approved fields has been authorized |
   | `PRECISE_PUBLICATION_ENABLED` | Leave `false`. Enable only after separate owner approval of the precise-location consent policy |
   | `PUBLIC_FEED_URL` | Leave blank until you have an authorized Google Apps Script web app URL |

   With `SOURCE_FIELDS` unset, the built-in profile reads **Timestamp**, **Full Name**, the full **Street Address number** question, **City**, **State**, the full **Phone Number** question, and **Which applies to you?**. Header checks ignore leading and trailing whitespace, including the phone header’s trailing space. The disclaimer and agreement checkboxes remain in the original response sheet for private review. The application type and phone stay private. Phone matches flag possible duplicates for human review. Because this form has no country or ZIP column, the geocoding query uses the street, city, state and a U.S. default. Confirm the U.S. scope before enabling geocoding. The form has no public alias or separate location-precision opt-in. Its existing agreement about listing contact information does not serve as consent for precise markers.

   Example `SOURCE_FIELDS` for a different schema

   ```json
   {
     "timestamp": "Timestamp",
     "name": "Full Name",
     "email": "Email Address",
     "address": "Street address",
     "city": "City",
     "region": "State",
     "postal": "ZIP Code",
     "country": "Country",
     "preciseConsent": "May we publish your precise location?",
     "publicAlias": "Optional alias authorized for public display"
   }
   ```

   Map `publicAlias` only to a field that explicitly authorizes display. Otherwise the marker uses “Volunteer relocator.” Map `preciseConsent` only to a dedicated opt-in question that explains public exposure and includes the affirmative response `Yes, show my precise location`. Missing answers and legacy records default to approximate publication. Explicitly inform form respondents that Google geocodes the submitted street address for validation, even when the public display is approximate.

4. Choose `setupWorkflow` in the Apps Script editor and click **Run**. Review the Google permissions prompt and authorize it under the dedicated owner account. The script checks the source headers, copies the workbook before creating the private review tab, and installs a spreadsheet form-submit trigger, a 15-minute reconciliation trigger, and an hourly public feed check. Open **Triggers** and confirm one of each. In Drive, confirm the dated backup exists and check its sharing. Restrict editor access to the response workbook to people authorized to publish or remove listings. Keep the Form's “view results summary” setting off.
5. Run `reconcileVolunteers` once. It imports up to 25 unseen records per reconciliation. Results start in `PENDING`. Rescanning does not create copies of unchanged submissions. Changes in source values produce new review entries. Never overwrite a managed review cell or sort/delete its rows during operation. Use filter views and edit only **Action** and **Replace ID**.

## 3. Review registrations and changes

1. After approving the use of Maps for private address validation, set `GEOCODING_ENABLED` to `true`. Run a reconciliation or wait for the trigger. A fully matched address can become `VALIDATED`. An incomplete address, a partial match, an ambiguous result, a postal mismatch or a result below rooftop accuracy needs review. Some legitimate rural, non-U.S. or newly built addresses will require a correction because geocoder results and locality labels vary. Correct the source response or request a new submission, then reject the stale entry. Use **RETRY** on a pending row after a temporary problem has been resolved. Geocoder and quota errors are recorded as safe execution errors and emailed to the administrator.
2. Read the duplicate IDs and compare the private records. The script flags matching phone numbers, matching names and addresses, and matching email where an email field is configured. It cannot reliably identify all duplicates. Confirm the intended address and the public alias before approving. Clear an approval command if you need to pause it. A blocked approval remains queued and can proceed once prerequisites are met.
3. For a new listing choose **APPROVE APPROXIMATE**. The marker uses a verified Google locality centroid. A shared marker lists all volunteers at the same point. Zoom or select a cluster to see the area markers. **APPROVE PRECISE** only works when enabled globally and the response records explicit consent. The marker then shows the confirmed rooftop coordinate and can offer directions.
4. For an update, copy the current listing’s **ID** to **Replace ID** on the new pending row and approve the new row. The old row becomes **SUPERSEDED**. To honor a removal or revoked consent, choose **REMOVE** on the active row. If appropriate, approve a new approximate record after confirming consent. **REJECT** closes a pending row. The source response stays in place. Old live directories and My Maps need their existing removal process until cutover.
5. Scheduled reconciliation processes queued actions. For urgent removal, run reconciliation from the editor after entering **REMOVE**, or immediately set `PUBLIC_FEED_ENABLED` to `false` to pause the feed. Set `PRECISE_PUBLICATION_ENABLED` to `false` to filter precise points out of new responses immediately. Already-open tabs refresh up to every five minutes, and any information previously published may have been copied.

## 4. Test a deployment before approving public use or billing

1. Test registration, invalid addresses, duplicates, approval, replacement and removal with the sandbox. Before enabling real publication, check that the response sheet and backup cannot be opened from a logged-out window.
2. After authorizing publication of synthetic data, choose **Deploy → New deployment → Web app** in Apps Script. Set **Execute as** to the owner and access to **Anyone** for the synthetic endpoint. If your Workspace policy forbids anonymous web apps, use an authorized account or an owner-approved hosting alternative. Do not change the response sheet’s sharing. Copy the `/exec` URL into `PUBLIC_FEED_URL`. Enable `PUBLIC_FEED_ENABLED` and run reconciliation. A logged-out request to the endpoint must return only version, approved points, and a missing count. Each point contains only a checked alias, locality, coordinates and precision flag. Confirm that query parameters cannot access source data and that disabled or stale snapshots return a generic error. Check **Executions** and run `checkPublicFeed` to verify the anonymous route and alerting.
3. Review prices, quota and data terms using the references below, then decide whether to authorize even a test project with billing. After authorization, create a dedicated test project in the Google Cloud console, link billing and enable only **Maps JavaScript API** and **Geocoding API** for browser search. Use separate projects or keys for staging and production. Under **Google Maps Platform → Map Management**, create a JavaScript map ID. Under **APIs & Services → Credentials**, create a browser key, set **Application restrictions → Websites** to the exact allowed HTTPS origin(s), and set **API restrictions** to those two APIs. The loader uses origin-only referrer restrictions. Never reuse an unrestricted key or put a server credential in the website. If you test from a local origin, add it only to the test key and remove it afterward.
4. Before loading the map, configure **Billing → Budgets & alerts** and notify the billing owner at several thresholds (for example 50%, 80%, and 100%). A budget is an alert and may arrive after usage. In **APIs & Services → Quotas**, lower Maps loads and geocoding quotas wherever the project offers adjustable limits, leave headroom for regular visitors, and verify the limits under test. Set backend budget separately via the script property. Per-browser search throttling reduces accidental repeated submissions. It is not an abuse or billing control.
5. In a staging copy only, configure `map-preview/config.js` with the restricted browser key, map ID, and synthetic `/exec` URL. Test in a logged-out Chromium or Chrome window on small and large screens. Check roadmap/satellite, search by city, ZIP, and address, cluster drill-down, marker details, directions for consented synthetic precise locations, refresh after approval/removal, and the failure fallback. Verify the actual cross-origin response including the Apps Script redirect. Keep this staging configuration out of the shared branch until reviewed.
6. For production, review the live form consent wording, migrate only authorized volunteers, and validate the private sharing and public allowlist again. Keep the My Maps layer in service. After you approve the tested replacement, use a separate reviewed site change to point the existing map area to the configured Google Maps page and retain an explicit fallback. If a problem appears, revert that site change and disable the new feed or the Maps key.

## Cost and data handling

- Budget for **Dynamic Maps** loads and **Geocoding** requests submitted from the browser search. The March 2025 standard list-price model announced 10,000 monthly no-charge events per Essentials SKU, then initial-tier prices of US$7 per 1,000 Dynamic Maps loads and US$5 per 1,000 Geocoding requests. These are planning figures only. Current official pages were inaccessible from the development environment. Confirm the current prices, region, SKU thresholds, billing account eligibility and taxes before enabling billing. For example, under those figures, 15,000 loads and 12,000 searches would be about US$45 for those two SKUs.
- The backend uses the built-in Apps Script Maps service without a Cloud API key. Google previously documented 1,000 daily geocode calls for consumer accounts and 10,000 for Workspace accounts, subject to change and shared account quotas. Confirm current geocoding, execution, trigger runtime, email and URL Fetch limits for the installation account. The script defaults to 100 calls per rolling 24 hours and does not geocode directly in response to public traffic. Each distinct approved locality, or each precise address, may need four lookups daily if cached entries live six hours, or more with evictions. Allow for private intake too. For example, 40 distinct localities may need at least 160 daily refresh calls before intake. If the script’s capacity or quotas are insufficient for your real directory, do not cut over. The current preview and feed cap the directory at 350 approved listings. Reduce churn or plan a separately reviewed data source and scaling path based on your volume.
- Google geocoder results and map snapshots are held in Apps Script cache, with maximum configured lifetimes of six hours and 25 minutes respectively. No Google coordinates are written into the response workbook, review tab, backup or repository. Cache entries may be evicted early. A stale snapshot expires rather than remaining available indefinitely. Do not export the coordinates to My Maps, a database or a long-term cache. Confirm that the relevant Google Maps terms, including any region-specific rules and the terms governing Apps Script Maps, allow the intended lookup, transient caching and display. Use Google’s map and retain its attribution. Review public terms of use and privacy disclosures before launch.
- The public endpoint builds a fixed projection from approved rows. It omits submitted street addresses, names, email addresses, phone numbers, timestamps, internal IDs and approval notes. Review public aliases for accidental disclosure. Precise latitude and longitude are themselves sensitive. With precision disabled, coordinates are derived from the locality query alone, separately from private address validation.
- Browser pins use an integrity-pinned version of Google’s MarkerClusterer library. The page inserts labels as text and uses a fixed Google Maps directions origin. The Apps Script project should have no API executable deployment or write route. Administrative processing runs through private project triggers and spreadsheet permissions. Review those permissions and protect the response workbook, its backups and the Apps Script project.

Official references

- [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Geocoding API policies and attribution](https://developers.google.com/maps/documentation/geocoding/policies)
- [Google Maps Platform service-specific terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
- [Apps Script Maps service](https://developers.google.com/apps-script/reference/maps)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Google Cloud billing budgets](https://cloud.google.com/billing/docs/how-to/budgets)
- [Google Maps API security guidance](https://developers.google.com/maps/api-security-best-practices)

## Repository checks

From the checkout root, run `node --test tests/volunteer-workflow.test.cjs`, `node --check map-preview/map.js`, and `git diff --check`. The Node tests use synthetic rows and simulated Google services. They exercise idempotent intake, matching and invalid addresses, duplicate handling, publication filtering, approval, replacement, removal, consent and quota limits. For a local page check, run `python3 -m http.server 8000` and open `/map-preview/`. The unconfigured preview should point visitors to the current directory. With Playwright and Chromium available, run `node tests/volunteer-map-browser.cjs` while the server is running. Set `CHROMIUM_PATH` if using a system Chromium and `MAP_TEST_ORIGIN` if serving on another origin. This test simulates the Maps client, cluster adapter and feed at mobile and desktop sizes. Actual Google authorization, map tiles, terms, runtime quotas and anonymous cross-origin behavior require the owner-approved sandbox.

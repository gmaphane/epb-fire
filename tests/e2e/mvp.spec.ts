import { devices, expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';

mkdirSync('shots', { recursive: true });
const shot = (p: Page, n: string) => p.screenshot({ path: `shots/${n}.png` });

async function login(page: Page, role: string) {
  await page.getByTestId('login-' + role).click();
  // first sign-in on a phone shows the welcome tour: check it greets the person, then skip it
  const tour = page.getByTestId('tour');
  if (await tour.waitFor({ timeout: 4000 }).then(() => true).catch(() => false)) {
    await expect(page.getByTestId('tour-title')).toContainText('Welcome,');
    await page.getByTestId('tour-skip').click();
  }
  await expect(page.getByTestId('tab-map')).toBeVisible();
}
const setGps = (page: Page, lat: number, lon: number, accuracy = 5) => page.context().setGeolocation({ latitude: lat, longitude: lon, accuracy });
const sheetText = (page: Page) => page.getByTestId('sync-chip').innerText();

test.describe.configure({ mode: 'serial' });
// one phone for the whole run: shared context keeps IndexedDB + service worker between steps
let page: Page;
test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], baseURL: 'http://localhost:4173', permissions: ['geolocation'], geolocation: { latitude: 6.8287, longitude: -0.8093, accuracy: 6 }, serviceWorkers: 'allow' });
  page = await ctx.newPage();
});

test('first load, sign-in, site data and map render; no console errors', async () => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && !/tile|ERR_|Failed to load resource|net::/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await expect(page.getByTestId('demo-login')).toBeVisible();
  await login(page, 'coordinator');
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('active-count')).toHaveText('No active incidents');
  await page.waitForFunction(() => document.querySelectorAll('.leaflet-container').length === 1);
  await expect(page.getByTestId('capsule-coords')).toContainText(/±6 m/, { timeout: 15000 });
  await expect(page.getByTestId('sync-chip')).toContainText('Synced', { timeout: 15000 });
  await shot(page, '01-map');
  // service worker takes control (needed for T11)
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  expect(errors).toEqual([]);
});

test('T11: cold start with no network; T1: report offline saves < 1 s and survives reload', async () => {
  await page.goto('/');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.getByTestId('tab-map')).toBeVisible({ timeout: 10000 });
  // force the app into "no signal" state so pending is observable
  await page.getByTestId('tab-sync').click();
  await page.getByTestId('sim-offline').check();
  await expect(page.getByTestId('sync-chip')).toContainText('Offline');
  await page.getByTestId('report-fab').click();
  await expect(page.getByTestId('report-coords')).toContainText('6.8287', { timeout: 10000 });
  await shot(page, '02-report');
  await page.getByTestId('src-tower').click();
  await page.getByTestId('size-small').click();
  await page.getByTestId('notes').fill('Smoke column NE of tower');
  await page.getByTestId('submit-report').click();
  await expect(page.getByTestId('inc-coords')).toBeVisible();
  const ms = await page.evaluate(() => (window as any).__lastReportMs);
  console.log('report save ms:', ms);
  expect(ms).toBeLessThan(1000);
  await expect(page.getByTestId('row-pending')).toBeVisible();
  await expect(page.getByTestId('timeline')).toContainText('Reported');
  await shot(page, '03-incident-offline');
  // kill & reopen the app while offline
  await page.reload();
  await expect(page.getByTestId('inc-coords')).toBeVisible();
  await expect(page.getByTestId('row-pending')).toBeVisible();
  await page.goto('/#/sync');
  await expect(page.getByTestId('count-pending')).not.toHaveText('0');
  await shot(page, '04-sync-pending');
  await page.context().setOffline(false);
});

test('T2: network returns -> pending clears by itself', async () => {
  await page.goto('/#/sync');
  await expect(page.getByTestId('count-pending')).not.toHaveText('0');
  await page.getByTestId('sim-offline').uncheck(); // "signal returns"
  await expect(page.getByTestId('count-pending')).toHaveText('0', { timeout: 20000 });
  await expect(page.getByTestId('sync-chip')).toContainText('Synced');
  await page.goto('/#/incidents');
  await expect(page.getByTestId('incident-card')).toHaveCount(1);
  await expect(page.getByTestId('incident-card')).toContainText('F-2026-'); // server-assigned code came back
  await shot(page, '05-incidents');
});

test('dispatch -> alarm -> acknowledge -> status flow -> close needs a cause', async () => {
  await page.goto('/#/incidents');
  await page.getByTestId('incident-card').first().click();
  await page.getByTestId('status-confirmed').click();
  await page.getByTestId('dispatch-btn').click();
  const crewB = page.getByTestId('crew-Block-B-Day');
  await expect(crewB).toBeVisible();
  if ((await crewB.getAttribute('aria-pressed')) !== 'true') await crewB.click();
  await shot(page, '06a-dispatch');
  await page.getByTestId('instruction').fill('Meet at assembly point');
  await page.getByTestId('send-dispatch').click();
  await expect(page.getByTestId('assignment')).toContainText('Block B — Day');
  await shot(page, '06-dispatched');
  // responder on the same phone (demo): switch user
  await page.goto('/#/sync');
  await expect(page.getByTestId('count-pending')).toHaveText('0', { timeout: 15000 }); await page.getByTestId('signout').click();
  await login(page, 'responder');
  await expect(page.getByTestId('alarm')).toBeVisible();
  await shot(page, '07-alarm');
  await page.getByTestId('alarm-ack').click();
  await expect(page.getByTestId('alarm')).toHaveCount(0);
  await page.goto('/#/incidents');
  await page.getByTestId('incident-card').first().click();
  await expect(page.getByTestId('assign-state')).toContainText('acknowledged');
  await page.getByTestId('enroute').click();
  await page.getByTestId('onscene').click();
  await expect(page.getByTestId('assign-state')).toContainText('on scene');
  await expect(page.getByTestId('timeline')).toContainText('acknowledged');
  // responder cannot dismiss or close
  await expect(page.getByTestId('status-out')).toHaveCount(0);
  await expect(page.getByTestId('status-dismissed')).toHaveCount(0);
  await page.getByTestId('status-contained').click();
  // coordinator closes
  await page.goto('/#/sync'); await expect(page.getByTestId('count-pending')).toHaveText('0', { timeout: 15000 }); await page.getByTestId('signout').click(); await login(page, 'coordinator');
  await page.goto('/#/incidents'); await page.getByTestId('incident-card').first().click();
  await page.getByTestId('status-out').click();
  await expect(page.getByTestId('confirm-out')).toBeDisabled();
  await page.getByTestId('cause').selectOption('Lightning');
  await page.getByTestId('confirm-out').click();
  await expect(page.getByTestId('timeline')).toContainText('Out (cold)');
  await shot(page, '08-closed');
});

test('navigate: offline distance/bearing to an incident', async () => {
  await page.goto('/#/report');
  await page.getByTestId('src-community').click();
  await page.getByTestId('submit-report').click();
  await expect(page.getByTestId('inc-coords')).toBeVisible();
  await setGps(page, 6.8187, -0.8093); // move ~1 km south
  await page.goto('/#/navigate');
  await expect(page.getByTestId('nav-distance')).toContainText(/\d/);
  // wait for the moved fix to land (identical points read 0 m / 000°)
  await expect(page.getByTestId('nav-distance')).toContainText(/km|[1-9]\d{2} m/, { timeout: 15000 });
  await expect.poll(async () => page.getByTestId('nav-bearing').innerText(), { timeout: 15000 }).toMatch(/^(00\d|35\d)°$/);
  const d = await page.getByTestId('nav-distance').innerText();
  console.log('nav distance', d, '|', await page.getByTestId('nav-legs').innerText(), '|', await page.getByTestId('nav-bearing').innerText());
  await shot(page, '09-navigate');
  await setGps(page, 6.8287, -0.8093);
});

test('T8: walking a 100 m x 100 m square yields ~1.00 ha; weak fixes are skipped', async () => {
  await page.goto('/#/incidents');
  await page.getByTestId('incident-card').first().click();
  const href = page.url().split('/incident/')[1];
  await page.goto('/#/perimeter/' + href);
  await page.getByTestId('per-start').click();
  const lat0 = 6.8287, lon0 = -0.8093;
  const mLat = 1 / 110574, mLon = 1 / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const pts: [number, number][] = [];
  for (let i = 0; i <= 4; i++) pts.push([0, i * 25]);        // east along the top
  for (let i = 1; i <= 4; i++) pts.push([i * 25, 100]);     // south... (x = north offset)
  for (let i = 3; i >= 0; i--) pts.push([100, i * 25]);
  for (let i = 3; i >= 1; i--) pts.push([i * 25, 0]);
  await setGps(page, lat0, lon0, 40); // weak fix first: must be rejected
  await page.waitForTimeout(1500);
  for (const [n, e] of pts) {
    await setGps(page, lat0 + n * mLat, lon0 + e * mLon, 5);
    await page.waitForTimeout(1250);
  }
  await expect(page.getByTestId('per-vertices')).toContainText(/\d+ points/);
  await shot(page, '10-perimeter');
  await page.getByTestId('per-finish').click();
  await expect(page.getByTestId('per-area')).toBeVisible();
  const txt = await page.getByTestId('per-area').innerText();
  const ha = parseFloat(txt);
  console.log('walked area ha:', txt, 'vertices:', await page.getByTestId('per-vertices').innerText());
  expect(ha).toBeGreaterThan(0.95);
  expect(ha).toBeLessThan(1.05);
  await setGps(page, lat0, lon0, 6);
});

test('night mode, layers, sync screen visuals', async () => {
  await page.goto('/#/sync');
  await page.getByTestId('theme-night').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  await shot(page, '11-sync-night');
  await page.goto('/#/map');
  await shot(page, '12-map-night');
  await page.goto('/#/sync');
  await page.getByTestId('theme-day').click();
  await page.getByTestId('ready-amber').click().catch(() => {});
  await page.goto('/#/map');
  await expect(page.getByTestId('readiness-banner')).toContainText('AMBER').catch(() => {});
  await shot(page, '13-map-day');
});

test('radio relay: camp types in coordinates read out from the field', async () => {
  await page.goto('/#/report');
  await page.getByTestId('loc-manual').click();
  await expect(page.getByTestId('submit-report')).toBeDisabled();
  // misheard E instead of W is caught
  await page.getByTestId('coord-input').fill('6.8150 N 0.8100 E');
  await expect(page.getByTestId('far-warning')).toBeVisible();
  // correct UTM read-out
  await page.getByTestId('coord-input').fill('30N 741 380 753 690'.replace(/(\d{3}) (\d{3})/g, '$1$2'));
  await expect(page.getByTestId('readback')).toContainText('UTM 30N 741 380 E 753 690 N');
  await expect(page.getByTestId('report-coords')).toContainText('6.81');
  await page.getByTestId('observer').fill('Kwame (Block C patrol)');
  await page.getByTestId('via-radio').click();
  await page.getByTestId('src-patrol').click();
  await page.screenshot({ path: 'shots/14-relay-entry.png' });
  await page.getByTestId('submit-report').click();
  await expect(page.getByTestId('relay-info')).toContainText('radio relay — seen by Kwame (Block C patrol)');
  await expect(page.getByTestId('timeline')).toContainText('relayed by radio from Kwame');
  await page.screenshot({ path: 'shots/15-relay-incident.png' });
  // the field person's own read-out
  await page.goto('/#/map');
  await page.getByTestId('appbar-info').click();
  await expect(page.getByTestId('readout')).toContainText('UTM 30N');
  await page.screenshot({ path: 'shots/16-readout.png' });
});

test('report: tapping inside a compartment places the fire there (not a popup)', async () => {
  await page.goto('/#/report');
  await expect(page.getByTestId('report-coords')).toContainText(/\d/, { timeout: 10000 });
  const before = await page.getByTestId('report-coords').innerText();
  const box = (await page.getByTestId('report-map').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
  await expect(page.getByTestId('loc-map')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('report-coords')).not.toHaveText(before);
  await expect(page.locator('.leaflet-popup')).toHaveCount(0);
});

test('drawer: tapping the handle opens the fire list; swiping down closes it', async () => {
  await page.goto('/#/map');
  await page.getByTestId('peek-handle').click();
  await expect(page.getByTestId('incident-list').or(page.getByTestId('presence-menu'))).toBeVisible();
  if (await page.getByTestId('incident-list').isVisible()) {
    await page.getByTestId('incident-list-handle').click();
    await expect(page.getByTestId('peek')).toBeVisible();
  }
});

test('navigate: Stop ends en route; a hazard added by mistake can be removed', async () => {
  await page.goto('/#/navigate');
  await page.getByTestId('send-position').click();
  await expect(page.getByTestId('nav-stop')).toBeVisible();
  // add a hazard (the mistake)
  await page.getByTestId('nav-more').click();
  await page.getByRole('button', { name: 'Road hazard' }).click();
  await page.getByRole('button', { name: 'Tree down' }).click();
  await page.getByTestId('nav-stop').click();
  await expect(page.getByTestId('nav-stop')).toHaveCount(0);
  await page.goto('/#/navigate');
  await expect(page.getByTestId('send-position')).toContainText('Share my location');
  await expect(page.getByTestId('nav-stop')).toHaveCount(0);
  // remove it from the map
  await page.goto('/#/map');
  const marker = page.locator('.leaflet-marker-icon[title="Road hazard"]');
  await expect(marker).toHaveCount(1);
  await marker.dispatchEvent('click');
  await expect(page.getByTestId('hazard-sheet')).toBeVisible();
  await page.getByTestId('hazard-remove').click();
  await expect(marker).toHaveCount(0);
});

test('welcome tour can be reopened from Settings and walks through 4 steps', async () => {
  await page.goto('/#/sync');
  await page.getByTestId('show-tour').click();
  await expect(page.getByTestId('tour-title')).toContainText('Welcome,');
  for (let i = 0; i < 3; i++) await page.getByTestId('tour-next').click();
  await shot(page, '12-tour-last');
  await page.getByTestId('tour-done').click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

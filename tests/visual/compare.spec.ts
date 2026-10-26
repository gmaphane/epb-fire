import { devices, expect, test, type Page } from '@playwright/test';
// Captures screens in states comparable to the Stitch mockups (not part of the MVP test gate).
let page: Page;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], baseURL: 'http://localhost:4173', permissions: ['geolocation'], geolocation: { latitude: 6.8215, longitude: -0.8155, accuracy: 4 } });
  page = await ctx.newPage();
});
const shot = (n: string) => page.screenshot({ path: `shots/cmp-${n}.png` });
const gps = (lat: number, lon: number, accuracy = 4) => page.context().setGeolocation({ latitude: lat, longitude: lon, accuracy });

test('visual states', async () => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByTestId('login-coordinator').click();
  await page.getByTestId('sync-chip').waitFor();
  // fire 1: inside DEMO-C05 (extreme), confirmed + dispatched
  await gps(6.8165, -0.8100);
  await page.goto('/#/report');
  await expect(page.getByTestId('report-coords')).toContainText('6.816', { timeout: 10000 });
  await page.getByTestId('src-tower').click(); await page.getByTestId('size-medium').click();
  await page.getByTestId('notes').fill('Access via Block C spur — washed out, use main track then walk 300 m north.');
  await page.getByTestId('submit-report').click();
  await page.getByTestId('status-confirmed').click();
  await page.getByTestId('dispatch-btn').click();
  const cb = page.getByTestId('crew-Block-C-Day'); if ((await cb.getAttribute('aria-pressed')) !== 'true') await cb.click();
  await page.getByTestId('send-dispatch').click();
  await page.waitForTimeout(400);
  // fire 2: unverified community report
  await gps(6.8330, -0.8230);
  await page.goto('/#/report');
  await expect(page.getByTestId('report-coords')).toContainText('6.833', { timeout: 10000 });
  await page.getByTestId('src-community').click();
  await page.getByTestId('notes').fill('Light grey smoke over the ridge, no flames seen.');
  await page.getByTestId('submit-report').click();
  await page.waitForTimeout(400);
  await gps(6.8215, -0.8155);
  // incidents
  await page.goto('/#/incidents'); await page.waitForTimeout(800); await shot('incidents');
  // map with fire selected
  await page.goto('/#/map'); await page.waitForTimeout(1200);
  await page.locator('.callout-body.big').first().click({ force: true, timeout: 5000 });
  await page.waitForTimeout(500); await shot('map');
  // navigate to fire 1
  const id = await page.evaluate(() => (window as any).__lastIncident);
  await page.goto('/#/incidents');
  await page.getByTestId('incident-card').filter({ hasText: 'Priority 1' }).getByText('Navigate to Fire').click();
  await page.waitForTimeout(1500); await shot('navigate');
  // perimeter walk on fire 1
  await page.goto('/#/incidents');
  await page.getByTestId('incident-card').filter({ hasText: 'Priority 1' }).click();
  const url = page.url(); const inc = url.split('/incident/')[1];
  await page.goto('/#/perimeter/' + inc);
  await page.getByTestId('per-start').click();
  const lat0 = 6.8160, lon0 = -0.8105, mLat = 1 / 110574, mLon = 1 / 110540;
  const pts = [[0, 0], [10, 40], [40, 80], [90, 95], [140, 70], [160, 20], [130, -30], [70, -45], [25, -30]];
  for (const [n, e] of pts) { await gps(lat0 + n * mLat, lon0 + e * mLon, 3); await page.waitForTimeout(1150); }
  await page.waitForTimeout(500); await shot('perimeter');
  void id;
});

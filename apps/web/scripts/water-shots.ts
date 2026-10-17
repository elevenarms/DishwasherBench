/**
 * Screenshots of the watching page and of the cosmetic water, against a running server
 * (`pnpm --filter @spotless/web play`, port 8787 by default). Items are placed through the
 * HTTP API while a page watches `#<episode>&watch`; the water is shown with its demonstration
 * and, with `--wash`, during a real wash at the fast tier.
 *
 * `tsx scripts/water-shots.ts [--server http://localhost:8787] [--wash]`
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './driver.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = join(here, '..', 'screenshots');
mkdirSync(out, { recursive: true });
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const server = flag('--server') ?? 'http://localhost:8787';
const wash = process.argv.includes('--wash');

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

const LOAD = [
  {
    item_id: 'plate_01',
    frame: 'lower_rack',
    position_mm: [143, 368, 227],
    orientation: { preset: 'on_edge', yaw_deg: 90 },
  },
  {
    item_id: 'plate_02',
    frame: 'lower_rack',
    position_mm: [70, 368, 227],
    orientation: { preset: 'on_edge', yaw_deg: 90 },
  },
  {
    item_id: 'bowl_01',
    frame: 'lower_rack',
    position_mm: [420, 270, 200],
    orientation: { preset: 'inverted' },
  },
  {
    item_id: 'mug_01',
    frame: 'upper_rack',
    position_mm: [250, 380, 130],
    orientation: { preset: 'inverted' },
  },
];

const created = await post('/api/sessions', { level_id: 'tutorial' });
const id = String(created['session_id']);
console.log('session', id);
for (const place of LOAD.slice(0, 2)) {
  const result = await post(`/api/sessions/${id}/place`, place);
  console.log('place', place.item_id, result['accepted'], result['reason'] ?? '');
}

const browser = await launchChrome();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('page:', m.text());
  });
  await page.goto(`${server}/#${id}&watch`);
  await page.waitForFunction(() => document.querySelector('#watch-hud .hud-title') !== null, {
    timeout: 30000,
  });
  await sleep(2500);
  await page.screenshot({ path: join(out, 'watch-loading.png') });
  for (const place of LOAD.slice(2)) {
    const pending = post(`/api/sessions/${id}/place`, place);
    await sleep(900);
    await page.screenshot({ path: join(out, `watch-placing-${place.item_id}.png`) });
    const result = await pending;
    console.log('place', place.item_id, result['accepted'], result['reason'] ?? '');
    await sleep(2500);
  }
  await page.screenshot({ path: join(out, 'watch-placed.png') });
  const fps = async (): Promise<number> =>
    (await page.evaluate(
      `new Promise((resolve) => { let n = 0; const t0 = performance.now(); const step = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(step); else resolve(n); }; requestAnimationFrame(step); })`,
    )) as number;
  if (!wash) {
    for (const [name, at] of [
      ['water-wash', 0.3],
      ['water-rinse', 0.7],
      ['water-dry', 0.95],
    ] as const) {
      const status = await page.evaluate(
        (at) =>
          (
            window as unknown as { spotless: { debugWater(on: boolean, at: number): unknown } }
          ).spotless.debugWater(true, at),
        at,
      );
      await sleep(name === 'water-wash' ? 5000 : 3500);
      await page.screenshot({ path: join(out, `${name}.png`) });
      console.log(name, JSON.stringify(status), 'fps', await fps());
    }
    await page.evaluate(() =>
      (window as unknown as { spotless: { debugWater(on: boolean): unknown } }).spotless.debugWater(
        false,
      ),
    );
    // The normal page, with the demonstration.
    const normal = await browser.newPage();
    await normal.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await normal.goto(`${server}/#${id}&fxdemo`);
    await sleep(8000);
    await normal.screenshot({ path: join(out, 'water-normal-page.png') });
  } else {
    const started = await post(`/api/sessions/${id}/start_cycle?wash_tier=fast`, {});
    console.log('start_cycle', started['accepted'], started['reason'] ?? '');
    const t0 = Date.now();
    let shot = 0;
    for (;;) {
      await sleep(4000);
      const hud = await page.$eval('#watch-hud', (el) => el.textContent ?? '');
      console.log(Math.round((Date.now() - t0) / 1000), 's', hud);
      if (shot < 4) await page.screenshot({ path: join(out, `watch-wash-${++shot}.png`) });
      if (hud.includes('points')) break;
      if (Date.now() - t0 > 240_000) break;
    }
    await sleep(3000);
    await page.screenshot({ path: join(out, 'watch-report.png') });
    await sleep(6000);
    await page.screenshot({ path: join(out, 'watch-after-dry.png') });
  }
} finally {
  await browser.close();
}

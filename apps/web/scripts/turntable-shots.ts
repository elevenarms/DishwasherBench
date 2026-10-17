/**
 * Screenshots of the fixed watching view and of the turntable, against a running server:
 * `tsx scripts/turntable-shots.ts [--server http://localhost:8799] [--washed <session id>]`.
 * A turntable page is switched between items by changing its hash, as the Studio does.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './driver.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = join(here, '..', 'screenshots');
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const server = flag('--server') ?? 'http://localhost:8799';
const washed = flag('--washed');

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

const id = String((await post('/api/sessions', { level_id: 'tutorial' }))['session_id']);
for (const place of [
  {
    item_id: 'plate_01',
    frame: 'lower_rack',
    position_mm: [143, 368, 227],
    orientation: { preset: 'on_edge', yaw_deg: 90 },
  },
  {
    item_id: 'bowl_01',
    frame: 'lower_rack',
    position_mm: [420, 270, 200],
    orientation: { preset: 'inverted' },
  },
]) {
  console.log('place', place.item_id, (await post(`/api/sessions/${id}/place`, place))['accepted']);
}
const browser = await launchChrome();
try {
  const watch = await browser.newPage();
  await watch.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await watch.goto(`${server}/#${id}&watch`);
  await sleep(5000);
  await watch.screenshot({ path: join(out, 'watch-fixed.png') });
  await watch.close();

  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('page:', m.text());
  });
  await page.setViewport({ width: 320, height: 320, deviceScaleFactor: 2 });
  await page.goto(`${server}/#${id}&turntable`);
  await sleep(4000);
  await page.screenshot({ path: join(out, 'turntable-last-placed.png') });
  for (const item of ['plate_01', 'bowl_01', 'glass_01', 'fork_01', 'mug_01']) {
    await page.evaluate((hash) => {
      location.hash = hash;
    }, `${id}&turntable&item=${item}`);
    await sleep(2500);
    await page.screenshot({ path: join(out, `turntable-${item}-dirty.png`) });
  }
  if (washed !== undefined) {
    for (const item of ['plate_01', 'bowl_01', 'plate_02']) {
      const fresh = await browser.newPage();
      await fresh.setViewport({ width: 320, height: 320, deviceScaleFactor: 2 });
      await fresh.goto(`${server}/#${washed}&turntable&item=${item}`);
      await sleep(5000);
      await fresh.screenshot({ path: join(out, `turntable-${item}-washed.png`) });
      await fresh.close();
    }
  }
} finally {
  await browser.close();
}

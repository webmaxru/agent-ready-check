// E2E for the Agent-Ready League: the real app (fake scan, in-memory store) in a real browser.
import { test, expect } from '@playwright/test';
import { findChromium, collectBrowser } from '../../src/browser/collect.mjs';
import { createApp } from '../../server/app.mjs';
import { serve } from '../../server/node.mjs';
import { memoryStore } from '../../src/store/memory.mjs';
import { memoryRateLimiter } from '../../server/ratelimit.mjs';
import { fakeReport } from '../unit/server-fake-report.mjs';

test.use({ launchOptions: { executablePath: findChromium(), args: ['--no-sandbox'] } });
test.describe.configure({ mode: 'serial' });

let server; let base;
test.beforeAll(async () => {
  let n = 0;
  const app = createApp({
    scan: async (url) => {
      const asked = new URL(url).href;
      return fakeReport(url, {
        score: 40 + ((n++ * 17) % 55),
        exchanges: { home: { request: { url: asked }, response: { status: 200, finalUrl: asked }, redirects: [] } },
      });
    },
    store: memoryStore(), rateLimit: memoryRateLimiter({ limit: 100, windowSeconds: 60 }), resolve: async () => ['93.184.216.34'], browserAvailable: false,
  });
  server = await serve(app, { port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const h of ['alpha.example', 'beta.example', 'gamma.example']) {
    const r = await fetch(`${base}/api/league`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `https://${h}/` }) });
    expect(r.status).toBe(201);
  }
});
test.afterAll(async () => { server?.close(); });

test('join from a report page, land on the profile with the celebration, then see the board', async ({ page }) => {
  await page.goto(`${base}/?url=delta.example`).catch(() => {});
  const scan = await (await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://delta.example/' }) })).json();
  await page.goto(`${base}/r/${scan.id}`);
  await expect(page.locator('#league')).toContainText('would put');
  await page.getByRole('button', { name: 'Join the League' }).click();
  await expect(page).toHaveURL(/\/league\/delta\.example/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/delta\.example/i);
  await page.goto(`${base}/league`);
  await expect(page.locator('table.league tbody tr')).toHaveCount(4);
  await page.getByRole('link', { name: /grinders/i }).first().click();
  await expect(page).toHaveURL(/board=grinders/);
});

test('league pages and the report panel pass the agent axe rules with no console errors', async () => {
  const scan = await (await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://omega.example/' }) })).json();
  for (const path of ['/league', '/league?board=climbers', '/league/alpha.example', `/r/${scan.id}`]) {
    const d = await collectBrowser(`${base}${path}`, { allowPrivate: true, timeoutMs: 30000 });
    expect(d.ok, d.error).toBe(true);
    expect(d.axe.violations, `${path} axe`).toEqual([]);
    expect(d.a11y.unnamed, `${path} unnamed`).toEqual([]);
    expect(d.consoleErrors, `${path} console`).toEqual([]);
  }
});

test('screenshots of the board and a profile', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/league`);
  await page.screenshot({ path: 'test-results/league-board.png', fullPage: true });
  await page.goto(`${base}/league/alpha.example`);
  await page.screenshot({ path: 'test-results/league-profile.png', fullPage: true });
});

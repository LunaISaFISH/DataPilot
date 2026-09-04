/** Browser-level booth flow against already-running local API and web processes.
 *
 * Usage: node scripts/e2e_smoke.mjs [--web http://127.0.0.1:3000]
 * Screenshots are written to .artifacts/e2e/ and are intentionally not part of make test.
 */

import { mkdir, rm } from 'node:fs/promises';
import process from 'node:process';

import { chromium } from 'playwright-core';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const web = argument('--web', 'http://127.0.0.1:3000').replace(/\/$/, '');
const output = '.artifacts/e2e';
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.setItem('datapilot-language', 'en'));
const page = await context.newPage();
const runtimeErrors = [];
page.on('pageerror', (error) => runtimeErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') runtimeErrors.push(message.text());
});

try {
  await page.goto(`${web}/?e2e=1`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.getByText('API connected', { exact: true }).waitFor({ timeout: 15_000 });
  const samples = page.locator('#samples li');
  requireCondition((await samples.count()) === 4, `expected 4 samples, saw ${await samples.count()}`);
  const uci = samples.filter({ hasText: 'uci_online_retail' });
  await uci.getByText('real-data', { exact: true }).waitFor();
  await uci.getByText('cc-by-4.0', { exact: true }).waitFor();
  await page.screenshot({ path: `${output}/01-workbench.png`, fullPage: true });

  const ecommerce = samples.filter({ hasText: 'ecommerce_orders' });
  await ecommerce.getByRole('button', { name: 'Analyse with contract' }).click();
  await page.waitForURL(/\/runs\/[a-f0-9]+/, { timeout: 30_000 });
  await page.getByText('Review required', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('tab', { name: /Decisions/ }).click();
  await page.locator('#decisions-human').waitFor();

  const decisionRows = page.locator('#decisions-human li');
  requireCondition((await decisionRows.count()) > 0, 'no human-decision rows rendered');
  const outcomePriority = ['Approve proposal', 'Exclude', 'Quarantine', 'Flag for review', 'Reject proposal'];
  for (let index = 0; index < (await decisionRows.count()); index += 1) {
    const row = decisionRows.nth(index);
    let selected = false;
    for (const outcome of outcomePriority) {
      const candidate = row.getByRole('button', { name: new RegExp(`^${outcome}`) });
      if ((await candidate.count()) > 0 && (await candidate.first().isEnabled())) {
        await candidate.first().click();
        selected = true;
        break;
      }
    }
    requireCondition(selected, `no enabled outcome in decision row ${index + 1}`);
  }
  await page.screenshot({ path: `${output}/02-decisions.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save decisions' }).click();
  await page.getByText(/Saved · every human decision is in place/).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Generate change set' }).click();
  await page.locator('#changeset-actions').waitFor({ timeout: 20_000 });
  await page.getByText(/releasable/i).first().waitFor();
  await page.screenshot({ path: `${output}/03-change-set.png`, fullPage: true });

  await page.getByRole('button', { name: 'Apply and validate' }).click();
  await page.getByText('Conditional pass', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Open validation and release' }).click();
  await page.locator('#release-validations').waitFor({ timeout: 20_000 });
  await page.getByText('14 / 14', { exact: true }).first().waitFor();
  await page.screenshot({ path: `${output}/04-release.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/?e2e=mobile`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.getByText('API connected', { exact: true }).waitFor({ timeout: 15_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  requireCondition(overflow <= 0, `390px viewport overflows horizontally by ${overflow}px`);
  await page.getByRole('button', { name: '切换到中文' }).click();
  await page.getByRole('heading', { name: '数据发布工作台' }).waitFor();
  await page.screenshot({ path: `${output}/05-mobile-zh.png`, fullPage: true });

  requireCondition(runtimeErrors.length === 0, `browser runtime errors:\n${runtimeErrors.join('\n')}`);
  console.log(`OK browser flow; screenshots: ${output}`);
} finally {
  await browser.close();
}

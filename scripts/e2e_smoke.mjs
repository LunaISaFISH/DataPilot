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
const demoApiRequests = [];
page.on('pageerror', (error) => runtimeErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') runtimeErrors.push(message.text());
});
page.on('request', (request) => {
  const url = new URL(request.url());
  if (url.pathname === '/health' || url.pathname.startsWith('/v1/')) demoApiRequests.push(request.url());
});

try {
  await page.goto(`${web}/?e2e=home`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.getByRole('heading', { name: 'Turn a messy CSV into a decision you can defend.' }).waitFor();
  await page.getByRole('link', { name: 'Watch the 3-minute demo' }).waitFor();
  await page.screenshot({ path: `${output}/00-home.png`, fullPage: true });

  // The booth replay is an instant, build-time snapshot: no backend and no model call.
  await page.goto(`${web}/demo?e2e=booth`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.getByRole('heading', { name: 'From raw transactions to a safe handoff in 3 minutes' }).waitFor();
  await page.getByText('Demo walkthrough · verified results', { exact: true }).waitFor();
  await page.getByText('42,481', { exact: true }).first().waitFor();
  requireCondition(demoApiRequests.length === 0, `booth replay made API requests:\n${demoApiRequests.join('\n')}`);
  await page.screenshot({ path: `${output}/01-booth-facts.png`, fullPage: true });

  await page.getByRole('button', { name: 'See how AI helps' }).click();
  await page.getByText('EIRE', { exact: true }).waitFor();
  await page.getByText('Ireland', { exact: true }).waitFor();
  await page.getByText('0', { exact: true }).first().waitFor();
  await page.screenshot({ path: `${output}/02-booth-ai.png`, fullPage: true });
  await page.getByRole('button', { name: 'See the review decisions' }).click();
  await page.getByText('7/7', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'See the final result' }).click();
  await page.getByText('14/14', { exact: true }).waitFor();
  await page.getByText('Ready with exclusions', { exact: true }).first().waitFor();
  await page.screenshot({ path: `${output}/03-booth-release.png`, fullPage: true });

  // The real workbench remains available as a separate live mode.
  await page.goto(`${web}/workbench?e2e=live`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.getByText('Ready to analyse', { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText('Try a sample dataset', { exact: true }).click();
  const samples = page.locator('#samples li');
  requireCondition((await samples.count()) === 4, `expected 4 samples, saw ${await samples.count()}`);
  const uci = samples.filter({ hasText: 'uci_online_retail' });
  await uci.getByText('real-data', { exact: true }).waitFor();
  await uci.getByText('cc-by-4.0', { exact: true }).waitFor();
  await page.screenshot({ path: `${output}/04-workbench.png`, fullPage: true });

  const observationalStarted = Date.now();
  await uci.getByRole('button', { name: 'Quick scan' }).click();
  await page.waitForURL(/\/runs\/[a-f0-9]+/, { timeout: 30_000 });
  const observationalUrl = page.url();
  await page.getByText('Observational', { exact: true }).first().waitFor({ timeout: 30_000 });
  const observationalMs = Date.now() - observationalStarted;
  requireCondition(observationalMs < 30_000, 'UCI observational run exceeded 30 seconds');
  console.log(`UCI observational run ready in ${observationalMs} ms`);
  await page.screenshot({ path: `${output}/05-observational.png`, fullPage: true });

  await page.goto(`${web}/workbench?e2e=contracted`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.getByText('Ready to analyse', { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText('Try a sample dataset', { exact: true }).click();
  const ecommerce = page.locator('#samples li').filter({ hasText: 'ecommerce_orders' });
  await ecommerce.getByRole('button', { name: 'Full review' }).click();
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
  await page.screenshot({ path: `${output}/06-decisions.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save decisions' }).click();
  await page.getByText(/Saved · every human decision is in place/).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Generate change set' }).click();
  await page.locator('#changeset-actions').waitFor({ timeout: 20_000 });
  await page.getByText(/releasable/i).first().waitFor();
  await page.screenshot({ path: `${output}/07-change-set.png`, fullPage: true });

  await page.getByRole('button', { name: 'Apply and validate' }).click();
  await page.getByText('Conditional pass', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Open validation and release' }).click();
  await page.locator('#release-validations').waitFor({ timeout: 20_000 });
  await page.getByText('14 / 14', { exact: true }).first().waitFor();
  await page.screenshot({ path: `${output}/08-release.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/demo?e2e=mobile`, { waitUntil: 'networkidle', timeout: 30_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const overflowElements = await page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .map((element) => ({
        element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}.${[...element.classList].join('.')}`,
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
      }))
      .filter(({ left, right }) => left < 0 || right > window.innerWidth)
      .slice(0, 8),
  );
  requireCondition(
    overflow <= 0,
    `390px viewport overflows horizontally by ${overflow}px: ${JSON.stringify(overflowElements)}`,
  );
  await page.getByRole('button', { name: '切换到中文' }).click();
  await page.getByRole('heading', { name: '3 分钟，看一份数据如何通过交付审核' }).waitFor();
  await page.screenshot({ path: `${output}/09-mobile-zh.png`, fullPage: true });

  await page.goto(`${web}/workbench?e2e=mobile-live`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.getByText('Ready to analyse', { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: '切换到中文' }).click();
  await page.getByText('分析服务已就绪', { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByRole('heading', { name: '开始新的数据分析' }).waitFor();
  requireCondition(
    (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0,
    'mobile workbench overflows horizontally',
  );
  await page.screenshot({ path: `${output}/10-mobile-workbench-zh.png`, fullPage: true });

  await page.goto(observationalUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByText('Observational', { exact: true }).first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: '切换到中文' }).click();
  await page.getByText('仅观测', { exact: true }).first().waitFor({ timeout: 15_000 });
  requireCondition(
    (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0,
    'mobile run workspace overflows horizontally',
  );
  await page.screenshot({ path: `${output}/11-mobile-run-zh.png`, fullPage: true });

  requireCondition(runtimeErrors.length === 0, `browser runtime errors:\n${runtimeErrors.join('\n')}`);
  console.log(`OK browser flow; screenshots: ${output}`);
} finally {
  await browser.close();
}

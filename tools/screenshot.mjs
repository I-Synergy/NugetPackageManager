/**
 * Takes screenshots of each tab in the dev server UI for use in the README.
 * Run: node ./tools/screenshot.mjs
 * Requires the dev server to be running on http://localhost:3729
 */
import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'docs', 'images');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 820 });

await page.goto('http://localhost:3729', { waitUntil: 'networkidle', timeout: 30000 });

// Let initial data load settle
await page.waitForTimeout(4000);

async function waitForContent() {
  // Wait until no spinner is visible (data loaded)
  await page.waitForFunction(() => {
    const spinners = document.querySelectorAll('.spinner.large');
    return spinners.length === 0;
  }, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function clickTab(label) {
  await page.click(`[role="tab"]:has-text("${label}")`);
  await page.waitForTimeout(500);
  await waitForContent();
}

async function shot(filename) {
  await page.screenshot({ path: `${OUT_DIR}/${filename}` });
  console.log(`  ✓ ${filename}`);
}

console.log('Taking screenshots...');

// Browse (Installed) tab — shown by default
await waitForContent();
await shot('screenshot-browse.png');

// Installed tab
await clickTab('Installed');
await shot('screenshot-installed.png');
await shot('screenshot-installed-frameworks.png');

// Updates tab
await clickTab('Updates');
await shot('screenshot-updates.png');
await shot('screenshot-updates-frameworks.png');

// Consolidate tab
await clickTab('Consolidate');
await shot('screenshot-consolidate.png');

// Vulnerabilities tab
await clickTab('Vulnerabilities');
await shot('screenshot-vulnerabilities.png');

// Toolchain tab
await clickTab('Toolchain');
await waitForContent();
await shot('screenshot-toolchain.png');

// Cleanup tab (must be last)
await clickTab('Cleanup');
await shot('screenshot-cleanup.png');

await browser.close();
console.log('Done. Screenshots saved to docs/images/');

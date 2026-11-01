/**
 * Records a demo GIF of the extension UI using the dev server.
 * Run: node ./tools/record-demo.mjs
 * Requires the dev server to be running on http://localhost:3729
 */
import { chromium } from 'playwright';
import GIFEncoder from 'gif-encoder-2';
import { PNG } from 'pngjs';
import { createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '..', 'docs', 'images', 'demo.gif');
const WIDTH = 1280;
const HEIGHT = 780;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForNoSpinner(page, timeout = 45000) {
  await page.waitForFunction(
    () => document.querySelectorAll('.spinner.large').length === 0,
    { timeout }
  ).catch(() => {});
  await page.waitForTimeout(500);
}

async function captureFrame(page) {
  const buf = await page.screenshot({ type: 'png' });
  const png = PNG.sync.read(buf);
  return png.data;
}

/** Hold a still frame for the given duration (ms). */
async function hold(encoder, page, ms) {
  const frame = await captureFrame(page);
  encoder.setDelay(ms);
  encoder.addFrame(frame);
}

/** Record live motion for the given duration, capturing every ~100ms. */
async function record(encoder, page, ms) {
  const interval = 100;
  const steps = Math.max(1, Math.round(ms / interval));
  for (let i = 0; i < steps; i++) {
    const frame = await captureFrame(page); // NOSONAR: frames must be captured sequentially
    encoder.setDelay(interval);
    encoder.addFrame(frame);
    if (i < steps - 1) await page.waitForTimeout(interval); // NOSONAR: pacing must be sequential
  }
}

async function clickTab(page, label) {
  await page.click(`[role="tab"]:has-text("${label}")`);
  await page.waitForTimeout(400);
  await waitForNoSpinner(page);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: WIDTH, height: HEIGHT });
await page.goto('http://localhost:3729', { waitUntil: 'networkidle', timeout: 30000 });
await waitForNoSpinner(page);

console.log('Setting up GIF encoder...');
const encoder = new GIFEncoder(WIDTH, HEIGHT, 'neuquant', true);
encoder.setRepeat(0);
encoder.setQuality(15);
encoder.start();

const readStream = encoder.createReadStream();
const writeStream = createWriteStream(OUT_FILE);
readStream.pipe(writeStream);

console.log('Recording...');

// ── Scene 1: Installed tab — show package list ───────────────────────────────
await hold(encoder, page, 1500);

// ── Scene 2: Open project tree ───────────────────────────────────────────────
await page.click('.tab-tree-toggle');
await page.waitForTimeout(400);
await record(encoder, page, 800);

// ── Scene 3: Close project tree again ────────────────────────────────────────
await page.click('.tab-tree-toggle');
await page.waitForTimeout(300);
await record(encoder, page, 500);

// ── Scene 4: Type a search ───────────────────────────────────────────────────
await page.click('input[placeholder="Search packages..."]');
await record(encoder, page, 300);
for (const ch of 'serilog') {
  await page.keyboard.type(ch, { delay: 0 }); // NOSONAR: keystrokes must be recorded one by one
  await record(encoder, page, 120); // NOSONAR: per-character animation
}
await waitForNoSpinner(page);
await record(encoder, page, 800);

// ── Scene 5: Click first result to show details panel ────────────────────────
const firstRow = page.locator('package-row').first();
await firstRow.click();
await page.waitForTimeout(800);
await record(encoder, page, 1500);

// ── Scene 6: Clear search ────────────────────────────────────────────────────
await page.click('input[placeholder="Search packages..."]');
await page.keyboard.press('Control+a');
await page.keyboard.press('Backspace');
await record(encoder, page, 400);
await waitForNoSpinner(page);
await record(encoder, page, 400);

// ── Scene 7: Updates tab — show framework badges ─────────────────────────────
await clickTab(page, 'Updates');
await record(encoder, page, 2000);

// ── Scene 8: Use the framework filter dropdown ───────────────────────────────
const frameworkSelect = page.locator('select[slot="extra-right"]');
if (await frameworkSelect.isVisible()) {
  await frameworkSelect.selectOption({ index: 1 }); // first specific framework
  await record(encoder, page, 1200);
  await frameworkSelect.selectOption({ value: '' }); // back to "All frameworks"
  await record(encoder, page, 800);
}

// ── Scene 9: Consolidate tab — show version inconsistencies + framework badges
await clickTab(page, 'Consolidate');
await record(encoder, page, 2000);

// ── Scene 10: Vulnerabilities tab ────────────────────────────────────────────
await clickTab(page, 'Vulnerabilities');
await record(encoder, page, 2000);

// ── Scene 11: Toolchain tab — SDK selection and health ──────────────────────
console.log('  scene: Toolchain');
await clickTab(page, 'Toolchain');
await record(encoder, page, 2000);

// ── Scene 12: Cleanup tab ────────────────────────────────────────────────────
await clickTab(page, 'Cleanup');
await record(encoder, page, 2000);

// ── Scene 13: Back to Browse ─────────────────────────────────────────────────
await clickTab(page, 'Browse');
await waitForNoSpinner(page);
await hold(encoder, page, 1500);

encoder.finish();
await new Promise((resolve) => writeStream.on('finish', resolve));
await browser.close();

console.log(`Done. GIF saved to ${OUT_FILE}`);

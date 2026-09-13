import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { runAiCandidateSafety } from '../tests/e2e/ai-candidate-safety.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baseURL = 'http://127.0.0.1:4499';
const candidates = [
  process.env.PLAYWRIGHT_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const executablePath = candidates.find((candidate) => existsSync(candidate));
if (!executablePath) throw new Error('E2E_CHROME_NOT_FOUND');

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('E2E_SERVER_TIMEOUT')), 30_000);
    const done = (error) => {
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    let buffer = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      buffer = (buffer + text).slice(-1_024);
      if (buffer.includes('E2E_READY')) done();
    };
    const onExit = (code) => done(new Error(`E2E_SERVER_EXIT_${code}`));
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const server = spawn(process.execPath, ['scripts/e2e-server.js'], {
  cwd: root, stdio: ['ignore', 'inherit', 'pipe'],
});
let browser;
try {
  await waitForReady(server);
  browser = await chromium.launch({
    executablePath, headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await runAiCandidateSafety({ page, baseURL });
  console.log('✓ 候选安全、切章隔离、正文停止、离开保护、多标签冲突、备份及回收站恢复浏览器工作流');
  await context.close();
} catch (error) {
  if (browser) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (pages[0]) {
      await mkdir(join(root, 'test-results'), { recursive: true });
      await pages[0].screenshot({
        path: join(root, 'test-results', 'e2e-failure.png'), fullPage: true,
      }).catch(() => {});
    }
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await stopChild(server);
}

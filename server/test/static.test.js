import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../store.js';
import { createApp, setWebDist } from '../index.js';

beforeEach(() => { store.setDataRoot(mkdtempSync(join(tmpdir(), 'novelbox-'))); });

test('未知路径回退到 index.html，/api 不回退', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>盒子</title>');
  setWebDist(dist);
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/some/spa/route`);
  const html = await page.text();
  assert.match(html, /盒子/);
  const api404 = await fetch(`${base}/api/unknown`);
  assert.equal(api404.status, 404);
  server.close();
});

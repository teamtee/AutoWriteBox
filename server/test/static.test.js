import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as store from '../store.js';
import { createApp, setWebDist } from '../index.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

beforeEach(() => { store.setDataRoot(makeTestTempDir('novelbox-')); });
afterEach(cleanupTestTempDirs);

test('未知路径回退到 index.html，/api 不回退', async () => {
  const dist = makeTestTempDir('dist-');
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>盒子</title>');
  setWebDist(dist);
  const started = await startTestServer(createApp());
  try {
    const page = await fetch(`${started.base}/some/spa/route`);
    const html = await page.text();
    assert.match(html, /盒子/);
    const api404 = await fetch(`${started.base}/api/unknown`);
    assert.equal(api404.status, 404);
  } finally {
    await stopTestServer(started.server);
  }
});

test('非 API 路径不会触发全局 JSON 解析', async () => {
  const dist = makeTestTempDir('dist-non-api-post-');
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>盒子</title>');
  setWebDist(dist);
  const started = await startTestServer(createApp());
  try {
    const response = await fetch(`${started.base}/not-an-api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken json',
    });
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /INVALID_JSON/);
  } finally {
    await stopTestServer(started.server);
  }
});

test('内容哈希静态资源长期缓存，SPA 与普通文件始终重新验证', async () => {
  const dist = makeTestTempDir('dist-cache-');
  const assets = join(dist, 'assets');
  mkdirSync(assets);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>盒子</title>');
  writeFileSync(join(dist, 'plain.js'), 'console.log("plain")');
  writeFileSync(join(assets, 'index-Abcdef12.js'), 'console.log("hashed")');
  setWebDist(dist);
  const started = await startTestServer(createApp());
  try {
    const hashed = await fetch(`${started.base}/assets/index-Abcdef12.js`);
    assert.equal(hashed.status, 200);
    assert.equal(
      hashed.headers.get('cache-control'),
      'public, max-age=31536000, immutable',
    );

    const plain = await fetch(`${started.base}/plain.js`);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('cache-control'), 'no-cache');

    const page = await fetch(`${started.base}/some/spa/route`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
  } finally {
    await stopTestServer(started.server);
  }
});

test('静态资源和 SPA 的 Range 错误不泄露服务端路径或调用栈', async () => {
  const dist = makeTestTempDir('dist-range-');
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>盒子</title>');
  writeFileSync(join(dist, 'app.js'), 'console.log("safe")');
  setWebDist(dist);
  const started = await startTestServer(createApp());
  try {
    for (const path of ['/app.js', '/some/spa/route']) {
      const response = await fetch(`${started.base}${path}`, {
        headers: { Range: 'bytes=999999-1000000' },
      });
      const body = await response.text();
      assert.equal(response.status, 416);
      assert.match(response.headers.get('content-type'), /^text\/plain/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(body, 'RANGE_NOT_SATISFIABLE');
      assert.doesNotMatch(body, /RangeNotSatisfiableError|node_modules|dist-range|\/Users\//);
    }
  } finally {
    await stopTestServer(started.server);
  }
});

test('直接启动服务也不跟随静态目录链接读取目录外文件', {
  skip: process.platform === 'win32',
}, async () => {
  const root = makeTestTempDir('static-link-');
  const dist = join(root, 'dist');
  const secret = join(root, 'secret.json');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>盒子</title>');
  writeFileSync(secret, 'SUPER_SECRET_API_KEY');
  symlinkSync(secret, join(dist, 'leak.txt'), 'file');
  setWebDist(dist);
  const started = await startTestServer(createApp());
  try {
    const linkedAsset = await fetch(`${started.base}/leak.txt`);
    assert.equal(linkedAsset.status, 404);
    assert.equal(await linkedAsset.text(), 'NOT_FOUND');
    assert.equal(linkedAsset.headers.get('cache-control'), 'no-store');

    rmSync(join(dist, 'index.html'));
    symlinkSync(secret, join(dist, 'index.html'), 'file');
    const linkedIndex = await fetch(`${started.base}/some/spa/route`);
    const body = await linkedIndex.text();
    assert.equal(linkedIndex.status, 500);
    assert.equal(body, 'STATIC_RESOURCE_ERROR');
    assert.doesNotMatch(body, /SUPER_SECRET_API_KEY|secret\.json|\/Users\//);
  } finally {
    await stopTestServer(started.server);
  }
});

test('静态根目录本身为链接时不会把外部目录当作前端', {
  skip: process.platform === 'win32',
}, async () => {
  const root = makeTestTempDir('static-root-link-');
  const outside = join(root, 'outside');
  const linkedDist = join(root, 'dist');
  mkdirSync(outside);
  writeFileSync(join(outside, 'index.html'), 'SUPER_SECRET_STATIC_ROOT');
  symlinkSync(outside, linkedDist, 'dir');
  setWebDist(linkedDist);
  const started = await startTestServer(createApp());
  try {
    const response = await fetch(`${started.base}/`);
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.equal(body, 'STATIC_RESOURCE_ERROR');
    assert.doesNotMatch(body, /SUPER_SECRET_STATIC_ROOT|outside|\/Users\//);
  } finally {
    await stopTestServer(started.server);
  }
});

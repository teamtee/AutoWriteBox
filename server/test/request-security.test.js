import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import { createApp } from '../index.js';
import {
  CONTENT_SECURITY_POLICY,
  isAllowedBrowserFetchSite,
  isAllowedRequestHost,
  isAllowedRequestOrigin,
  mountRequestSecurity,
  normalizePublicOrigin,
} from '../request-security.js';
import {
  createPreparedBackupRegistry, mountStorageRoutes,
} from '../routes/storage.js';
import * as store from '../store.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

beforeEach(() => {
  store.setDataRoot(makeTestTempDir('novelbox-security-'));
});
afterEach(cleanupTestTempDirs);

function httpRequest(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.once('error', reject);
    req.end();
  });
}

function getWithHost(url, host) {
  return httpRequest(url, { headers: { Host: host } });
}

test('Host 校验允许回环、本机监听地址和显式白名单，但拒绝陌生域名', () => {
  assert.equal(isAllowedRequestHost('localhost:4399'), true);
  assert.equal(isAllowedRequestHost('127.1:4399'), true);
  assert.equal(isAllowedRequestHost('[::1]:4399'), true);
  assert.equal(isAllowedRequestHost('localhost.:4399'), true);
  assert.equal(isAllowedRequestHost('localhost..:4399'), false);
  assert.equal(isAllowedRequestHost('192.168.1.8:4399', { localAddress: '192.168.1.8' }), true);
  assert.equal(isAllowedRequestHost('novelbox.local:4399', { allowedHosts: 'novelbox.local' }), true);
  assert.equal(isAllowedRequestHost('attacker.example', { localAddress: '127.0.0.1' }), false);
  assert.equal(isAllowedRequestHost('attacker.example/path'), false);
});

test('API Origin 必须与请求来源完全同源', () => {
  assert.equal(isAllowedRequestOrigin(undefined, 'localhost:4399'), true);
  assert.equal(isAllowedRequestOrigin('http://localhost:4399', 'localhost:4399'), true);
  assert.equal(isAllowedRequestOrigin('https://localhost:4399', 'localhost:4399'), false);
  assert.equal(isAllowedRequestOrigin(
    'https://novel.example', 'novel.example', 'http', 'https://novel.example',
  ), true);
  assert.equal(isAllowedRequestOrigin(
    'https://novel.example', 'novel.example:8443', 'http', 'https://novel.example',
  ), false);
  assert.equal(isAllowedRequestOrigin(
    'https://attacker.example', 'novel.example', 'http', 'https://novel.example',
  ), false);
  assert.equal(isAllowedRequestOrigin('http://localhost:5173', 'localhost:4399'), false);
  assert.equal(isAllowedRequestOrigin('https://attacker.example', 'localhost:4399'), false);
  assert.equal(isAllowedRequestOrigin('null', 'localhost:4399'), false);
  assert.equal(isAllowedRequestOrigin('http://user@localhost:4399', 'localhost:4399'), false);
  assert.equal(isAllowedRequestOrigin('http://localhost:4399/path', 'localhost:4399'), false);
  assert.equal(isAllowedRequestOrigin('http://localhost:4399/?query=1', 'localhost:4399'), false);
  assert.equal(isAllowedRequestOrigin('http://localhost:4399/#fragment', 'localhost:4399'), false);
});

test('PUBLIC_ORIGIN 只接受无路径、无凭据的完整 http(s) Origin', () => {
  assert.equal(normalizePublicOrigin(' HTTPS://Novel.Example:443/ '), 'https://novel.example');
  assert.equal(normalizePublicOrigin('https://[::1]:8443'), 'https://[::1]:8443');
  assert.equal(normalizePublicOrigin(''), '');
  for (const value of [
    'novel.example',
    'ftp://novel.example',
    'https://user@novel.example',
    'https://novel.example/app',
    'https://novel.example/?token=x',
  ]) {
    assert.throws(() => normalizePublicOrigin(value), /PUBLIC_ORIGIN_INVALID/);
  }
});

test('HTTPS 反向代理必须显式配置 PUBLIC_ORIGIN 才允许同源浏览器 API', async () => {
  const headers = {
    Host: 'novel.example',
    Origin: 'https://novel.example',
    'Sec-Fetch-Site': 'same-origin',
  };
  const withoutPublicOrigin = await startTestServer(createApp({
    listenHost: '127.0.0.1',
    allowedHosts: 'novel.example',
  }));
  try {
    const blocked = await httpRequest(`${withoutPublicOrigin.base}/api/books`, { headers });
    assert.equal(blocked.status, 403);
    assert.deepEqual(JSON.parse(blocked.body), { error: 'ORIGIN_NOT_ALLOWED' });
  } finally {
    await stopTestServer(withoutPublicOrigin.server);
  }

  const withPublicOrigin = await startTestServer(createApp({
    listenHost: '127.0.0.1',
    allowedHosts: 'novel.example',
    publicOrigin: 'https://novel.example',
  }));
  try {
    const allowed = await httpRequest(`${withPublicOrigin.base}/api/books`, { headers });
    assert.equal(allowed.status, 200);
    assert.deepEqual(JSON.parse(allowed.body), []);
  } finally {
    await stopTestServer(withPublicOrigin.server);
  }
});

test('浏览器 API 请求只允许同源或用户直接导航', () => {
  assert.equal(isAllowedBrowserFetchSite(undefined), true);
  assert.equal(isAllowedBrowserFetchSite('same-origin'), true);
  assert.equal(isAllowedBrowserFetchSite('NONE'), true);
  assert.equal(isAllowedBrowserFetchSite('same-site'), false);
  assert.equal(isAllowedBrowserFetchSite('cross-site'), false);
  assert.equal(isAllowedBrowserFetchSite('unknown'), false);
});

test('陌生 Host 无法借 DNS rebinding 访问本地 API', async () => {
  const started = await startTestServer(createApp());
  try {
    const response = await getWithHost(`${started.base}/api/health`, 'attacker.example');
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body), { error: 'HOST_NOT_ALLOWED' });
  } finally {
    await stopTestServer(started.server);
  }
});

test('跨站简单表单 POST 不能在作品中悄悄新增部', async () => {
  const book = await store.createBook({ premise: 'p', title: '安全测试' });
  const started = await startTestServer(createApp());
  try {
    const response = await fetch(`${started.base}/api/books/${book.id}/sections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://attacker.example',
      },
      body: '',
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'ORIGIN_NOT_ALLOWED' });
    assert.deepEqual((await store.readBook(book.id)).sections, []);
  } finally {
    await stopTestServer(started.server);
  }
});

test('API 大小写变体不能绕过来源校验或作为隐藏路由别名', async () => {
  const book = await store.createBook({ premise: 'p', title: '大小写安全测试' });
  const started = await startTestServer(createApp());
  try {
    const blockedRead = await httpRequest(`${started.base}/API/books`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(blockedRead.status, 403);
    assert.deepEqual(JSON.parse(blockedRead.body), { error: 'ORIGIN_NOT_ALLOWED' });

    const blockedWrite = await httpRequest(`${started.base}/Api/books`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ premise: '不应创建' }),
    });
    assert.equal(blockedWrite.status, 403);
    assert.deepEqual(JSON.parse(blockedWrite.body), { error: 'ORIGIN_NOT_ALLOWED' });

    const sameOriginAlias = await httpRequest(`${started.base}/API/books`, {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(sameOriginAlias.status, 404);
    assert.deepEqual(JSON.parse(sameOriginAlias.body), { error: 'NOT_FOUND' });
    assert.equal(sameOriginAlias.headers['cache-control'], 'no-store');
    assert.deepEqual((await store.listBooks()).map((row) => row.id), [book.id]);
  } finally {
    await stopTestServer(started.server);
  }
});

test('跨站 GET/HEAD 无法读取作品或触发高成本 API', async () => {
  const started = await startTestServer(createApp());
  try {
    const blockedRequests = [
      httpRequest(`${started.base}/api/storage/diagnostics?deep=1`, {
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      }),
      httpRequest(`${started.base}/api/books`, {
        headers: { 'Sec-Fetch-Site': 'same-site' },
      }),
      httpRequest(`${started.base}/api/config`, {
        headers: { Origin: 'https://attacker.example' },
      }),
      httpRequest(`${started.base}/api/books/not-real/backup`, {
        method: 'HEAD',
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      }),
    ];
    for (const response of await Promise.all(blockedRequests)) {
      assert.equal(response.status, 403);
      if (response.body) assert.deepEqual(JSON.parse(response.body), { error: 'ORIGIN_NOT_ALLOWED' });
    }

    const sameOrigin = await httpRequest(`${started.base}/api/books`, {
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers['cache-control'], 'no-store');

    const directNavigation = await httpRequest(`${started.base}/api/books`, {
      headers: { 'Sec-Fetch-Site': 'none' },
    });
    assert.equal(directNavigation.status, 200);

    const localScript = await httpRequest(`${started.base}/api/books`);
    assert.equal(localScript.status, 200);
  } finally {
    await stopTestServer(started.server);
  }
});

test('跨站下载请求不会消耗仍可由同源页面领取的一次性备份令牌', async () => {
  const root = makeTestTempDir('novelbox-security-download-');
  const backupPath = join(root, 'backup.novelbox.json');
  await writeFile(backupPath, '{"format":"test-backup"}', { mode: 0o600 });
  const registry = createPreparedBackupRegistry();
  const token = registry.register({
    root,
    path: backupPath,
    filename: 'safe-backup.novelbox.json',
  });
  const app = express();
  mountRequestSecurity(app);
  mountStorageRoutes(app, {
    preparedBackups: registry,
    withBackupTransferSlot: async (task) => task(),
  });
  const started = await startTestServer(app);
  try {
    const blocked = await httpRequest(
      `${started.base}/api/backups/download/${token}`,
      { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    );
    assert.equal(blocked.status, 403);
    assert.deepEqual(JSON.parse(blocked.body), { error: 'ORIGIN_NOT_ALLOWED' });
    assert.ok(registry.peek(token));

    const downloaded = await httpRequest(
      `${started.base}/api/backups/download/${token}`,
      { headers: { 'Sec-Fetch-Site': 'same-origin' } },
    );
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.body, '{"format":"test-backup"}');
    assert.equal(registry.peek(token), null);
  } finally {
    await stopTestServer(started.server);
    await registry.clear();
  }
});

test('跨站请求仍可使用无敏感数据的健康检查和静态页面', async () => {
  const started = await startTestServer(createApp());
  try {
    const headers = {
      Origin: 'https://monitor.example',
      'Sec-Fetch-Site': 'cross-site',
    };
    const health = await httpRequest(`${started.base}/api/health`, { headers });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
    assert.equal(health.headers['cache-control'], 'no-store');

    const page = await httpRequest(`${started.base}/`, { headers });
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.match(page.headers['content-security-policy'], /style-src 'self'/);
    assert.match(page.headers['content-security-policy'], /object-src 'none'/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(
      page.headers['permissions-policy'],
      'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    );
    assert.notEqual(page.headers['cache-control'], 'no-store');
  } finally {
    await stopTestServer(started.server);
  }
});

test('健康检查只对跨站 GET/HEAD 开放，不豁免请求体方法', async () => {
  const started = await startTestServer(createApp());
  try {
    const headers = {
      Origin: 'https://attacker.example',
      'Sec-Fetch-Site': 'cross-site',
    };
    for (const method of ['GET', 'HEAD']) {
      const allowed = await httpRequest(`${started.base}/api/health`, { method, headers });
      assert.equal(allowed.status, 200);
    }

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const blocked = await httpRequest(`${started.base}/api/health`, { method, headers });
      assert.equal(blocked.status, 403);
      assert.deepEqual(JSON.parse(blocked.body), { error: 'ORIGIN_NOT_ALLOWED' });
    }
  } finally {
    await stopTestServer(started.server);
  }
});

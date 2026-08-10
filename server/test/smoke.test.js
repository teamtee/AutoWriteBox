import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  announceServerListening, createApp, isAllowedListenHost, resolveListenHost, resolveListenPort,
} from '../index.js';
import { startTestServer, stopTestServer } from './http-test-server.js';

const execFileAsync = promisify(execFile);

test('服务默认仅监听本机回环地址', () => {
  assert.equal(resolveListenHost(undefined), '127.0.0.1');
  assert.equal(resolveListenHost(''), '127.0.0.1');
  assert.equal(resolveListenHost(' 0.0.0.0 '), '0.0.0.0');
});

test('非回环监听必须显式确认无认证的网络暴露', () => {
  assert.equal(isAllowedListenHost(undefined), true);
  assert.equal(isAllowedListenHost('localhost'), true);
  assert.equal(isAllowedListenHost('127.8.9.10'), true);
  assert.equal(isAllowedListenHost('::1'), true);
  assert.equal(isAllowedListenHost('0.0.0.0'), false);
  assert.equal(isAllowedListenHost('::'), false);
  assert.equal(isAllowedListenHost('192.168.1.8'), false);
  assert.equal(isAllowedListenHost('0.0.0.0', '1'), true);
  assert.equal(isAllowedListenHost('192.168.1.8', '1'), true);
});

test('服务成功监听后才按启动器标记打开本机浏览器', () => {
  const opened = [];
  const logs = [];
  const logger = {
    log: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  };

  assert.equal(announceServerListening({
    host: '127.8.9.10', port: 4400, shouldOpenBrowser: true,
    browserOpener: (url) => opened.push(url), logger,
  }), 'http://127.8.9.10:4400');
  assert.deepEqual(opened, ['http://127.8.9.10:4400']);
  assert.match(logs[0], /已启动/);

  announceServerListening({
    host: '0.0.0.0', port: 4400, shouldOpenBrowser: true,
    browserOpener: (url) => opened.push(url), logger,
  });
  assert.equal(opened.length, 1);
  assert.match(logs.at(-1), /已跳过自动打开浏览器/);

  announceServerListening({
    host: '127.0.0.1', port: 4400, shouldOpenBrowser: true,
    browserOpener: () => { throw new Error('failed at /Users/private/browser'); }, logger,
  });
  assert.match(logs.at(-1), /（UNKNOWN）/);

  let reportAsyncError;
  announceServerListening({
    host: '127.0.0.1', port: 4400, shouldOpenBrowser: true,
    browserOpener: () => ({
      once(event, listener) {
        assert.equal(event, 'error');
        reportAsyncError = listener;
      },
    }),
    logger,
  });
  reportAsyncError(Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
  assert.match(logs.at(-1), /（ENOENT）/);
  assert.doesNotMatch(logs.join('\n'), /Users\/private|browser/);
});

test('非法或越界 PORT 回退到 4399', () => {
  assert.equal(resolveListenPort(undefined), 4399);
  assert.equal(resolveListenPort('-1'), 4399);
  assert.equal(resolveListenPort('70000'), 4399);
  assert.equal(resolveListenPort('5000oops'), 4399);
  assert.equal(resolveListenPort('5000'), 5000);
});

test('createApp 提供健康检查端点', async () => {
  const app = createApp();
  const started = await startTestServer(app);
  try {
    const res = await fetch(`${started.base}/api/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true });
  } finally {
    await stopTestServer(started.server);
  }
});

test('index.js 可在无 argv[1] 的动态导入场景中作为模块导入', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '-e',
    "import('./server/index.js').then(() => console.log('ok'))",
  ]);
  assert.match(stdout, /ok/);
});

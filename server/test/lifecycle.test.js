import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachServerLifecycle, configureHttpServerLimits, createApp,
  createInFlightRequestTracker, reportStructureRecovery, startStandaloneServer,
  startupFailureMessage,
} from '../index.js';
import { startTestServer, stopTestServer } from './http-test-server.js';

class FakeServer extends EventEmitter {
  listening = true;
  closeCalls = 0;
  forceCalls = 0;
  closeCallback = null;

  close(callback) {
    this.closeCalls += 1;
    this.closeCallback = callback;
  }

  closeAllConnections() {
    this.forceCalls += 1;
  }

  finish(error) {
    this.closeCallback?.(error);
  }
}

function createLogger() {
  const lines = [];
  return {
    lines,
    log: (message) => lines.push(String(message)),
    warn: (message) => lines.push(String(message)),
    error: (message) => lines.push(String(message)),
  };
}

test('HTTP 服务限制慢请求和头部资源，但不截断长响应', () => {
  const server = {};
  assert.equal(configureHttpServerLimits(server), server);
  assert.deepEqual(server, {
    requestTimeout: 300_000,
    headersTimeout: 30_000,
    timeout: 0,
    keepAliveTimeout: 5_000,
    maxHeadersCount: 100,
    maxRequestsPerSocket: 1000,
  });
});

test('SIGTERM 等待请求结束、清理预备资源并移除信号监听', async () => {
  const processRef = new EventEmitter();
  const server = new FakeServer();
  const logger = createLogger();
  let cleanupCalls = 0;
  const lifecycle = attachServerLifecycle(server, {
    processRef,
    shutdownTimeoutMs: 10_000,
    cleanup: async () => { cleanupCalls += 1; },
    logger,
  });

  processRef.emit('SIGTERM');
  assert.equal(server.closeCalls, 1);
  assert.match(logger.lines[0], /安全结束/);
  server.finish();
  await lifecycle.closed;

  assert.equal(cleanupCalls, 1);
  assert.equal(processRef.listenerCount('SIGINT'), 0);
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
  assert.equal(processRef.listenerCount('SIGHUP'), 0);
  assert.equal(server.listenerCount('error'), 0);
  lifecycle.dispose();
});

test('HTTP 连接关闭后仍等待异步路由真正收尾再执行关闭清理', async () => {
  const processRef = new EventEmitter();
  const server = new FakeServer();
  const logger = createLogger();
  let finishRequest;
  const pendingRequest = new Promise((resolve) => { finishRequest = resolve; });
  const tracker = createInFlightRequestTracker();
  const tracked = tracker.run(() => pendingRequest);
  let cleanupCalls = 0;
  const lifecycle = attachServerLifecycle(server, {
    processRef,
    shutdownTimeoutMs: 10_000,
    waitForRequests: () => tracker.waitForIdle(),
    cleanup: async () => { cleanupCalls += 1; },
    logger,
  });

  lifecycle.shutdown('SIGTERM');
  server.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 0);
  assert.equal(tracker.active, 1);

  finishRequest();
  await tracked;
  await lifecycle.closed;
  assert.equal(cleanupCalls, 1);
  assert.equal(tracker.active, 0);
});

test('真实 HTTP 响应已送达后仍以路由 Promise 为关闭边界', async () => {
  const innerTracker = createInFlightRequestTracker();
  let releaseRoute;
  const routeTail = new Promise((resolve) => { releaseRoute = resolve; });
  const requestTracker = {
    run: (task) => innerTracker.run(async () => {
      const result = task();
      await routeTail;
      return result;
    }),
    waitForIdle: () => innerTracker.waitForIdle(),
  };
  const started = await startTestServer(createApp({ requestTracker }));
  const processRef = new EventEmitter();
  let cleanupCalls = 0;
  const lifecycle = attachServerLifecycle(started.server, {
    processRef,
    shutdownTimeoutMs: 10_000,
    waitForRequests: requestTracker.waitForIdle,
    cleanup: async () => { cleanupCalls += 1; },
    logger: createLogger(),
  });

  try {
    const response = await fetch(`${started.base}/api/health`);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(innerTracker.active, 1);

    lifecycle.shutdown('TEST');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cleanupCalls, 0);

    releaseRoute();
    await lifecycle.closed;
    assert.equal(cleanupCalls, 1);
    assert.equal(innerTracker.active, 0);
  } finally {
    releaseRoute();
    if (started.server.listening) lifecycle.shutdown('TEST_CLEANUP');
    await lifecycle.closed;
    await stopTestServer(started.server);
  }
});

test('异步路由未收尾时二次信号强制完成关闭并标记 forced', async () => {
  const processRef = new EventEmitter();
  const server = new FakeServer();
  const logger = createLogger();
  let finishRequest;
  const pendingRequest = new Promise((resolve) => { finishRequest = resolve; });
  const tracker = createInFlightRequestTracker();
  const tracked = tracker.run(() => pendingRequest);
  let cleanupOptions;
  const lifecycle = attachServerLifecycle(server, {
    processRef,
    shutdownTimeoutMs: 10_000,
    waitForRequests: () => tracker.waitForIdle(),
    cleanup: async (options) => { cleanupOptions = options; },
    logger,
  });

  lifecycle.shutdown('SIGTERM');
  server.finish();
  await new Promise((resolve) => setImmediate(resolve));
  lifecycle.shutdown('SIGTERM');
  await lifecycle.closed;

  assert.equal(server.forceCalls, 1);
  assert.equal(processRef.exitCode, 1);
  assert.deepEqual(cleanupOptions, { forced: true });
  finishRequest();
  await tracked;
});

test('SIGHUP 复用安全关闭链并在完成后移除全部信号监听', async () => {
  const processRef = new EventEmitter();
  const server = new FakeServer();
  const logger = createLogger();
  let cleanupCalls = 0;
  const lifecycle = attachServerLifecycle(server, {
    processRef,
    shutdownTimeoutMs: 10_000,
    cleanup: async () => { cleanupCalls += 1; },
    logger,
  });

  processRef.emit('SIGHUP');
  assert.equal(server.closeCalls, 1);
  assert.match(logger.lines[0], /SIGHUP/);
  server.finish();
  await lifecycle.closed;

  assert.equal(cleanupCalls, 1);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    assert.equal(processRef.listenerCount(signal), 0);
  }
  lifecycle.dispose();
});

test('重复关闭信号强制断开剩余连接', async () => {
  const processRef = new EventEmitter();
  const server = new FakeServer();
  const logger = createLogger();
  let cleanupOptions;
  const lifecycle = attachServerLifecycle(server, {
    processRef,
    host: '127.0.0.1',
    port: 4399,
    shutdownTimeoutMs: 10_000,
    cleanup: async (options) => { cleanupOptions = options; },
    logger,
  });

  processRef.emit('SIGINT');
  processRef.emit('SIGINT');
  assert.equal(server.closeCalls, 1);
  assert.equal(server.forceCalls, 1);
  server.finish();
  await lifecycle.closed;
  assert.equal(processRef.exitCode, 1);
  assert.deepEqual(cleanupOptions, { forced: true });
  lifecycle.dispose();
});

test('优雅关闭超时后强制断开并把强制状态传给清理', async () => {
  const processRef = new EventEmitter();
  const server = new FakeServer();
  const logger = createLogger();
  let cleanupOptions;
  const lifecycle = attachServerLifecycle(server, {
    processRef,
    shutdownTimeoutMs: 0,
    cleanup: async (options) => { cleanupOptions = options; },
    logger,
  });

  lifecycle.shutdown('TEST');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(server.forceCalls, 1);
  assert.equal(processRef.exitCode, 1);
  server.finish();
  await lifecycle.closed;
  assert.deepEqual(cleanupOptions, { forced: true });
  lifecycle.dispose();
});

test('服务关闭自身失败时按强制状态清理，避免提前释放数据租约', async () => {
  const processRef = new EventEmitter();
  const server = new FakeServer();
  const logger = createLogger();
  let cleanupOptions;
  const lifecycle = attachServerLifecycle(server, {
    processRef,
    cleanup: async (options) => { cleanupOptions = options; },
    logger,
  });

  lifecycle.shutdown('TEST');
  server.finish(Object.assign(new Error('close failed'), { code: 'CLOSE_FAILED' }));
  await lifecycle.closed;

  assert.equal(processRef.exitCode, 1);
  assert.deepEqual(cleanupOptions, { forced: true });
  assert.match(logger.lines.join('\n'), /服务关闭失败（CLOSE_FAILED）/);
});

test('监听失败给出可操作提示并立即执行清理', async () => {
  const processRef = new EventEmitter();
  const server = new FakeServer();
  server.listening = false;
  const logger = createLogger();
  let cleanupCalls = 0;
  const lifecycle = attachServerLifecycle(server, {
    processRef,
    host: '127.0.0.1',
    port: 4399,
    cleanup: async () => { cleanupCalls += 1; },
    logger,
  });

  server.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }));
  await lifecycle.closed;
  assert.equal(processRef.exitCode, 1);
  assert.equal(cleanupCalls, 1);
  assert.ok(logger.lines.some((line) => line.includes('PORT=5001')));
  assert.equal(processRef.listenerCount('SIGINT'), 0);
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
  assert.equal(processRef.listenerCount('SIGHUP'), 0);
  lifecycle.dispose();
});

test('关闭清理异常只记录稳定错误码', async () => {
  const processRef = new EventEmitter();
  const server = new FakeServer();
  const logger = createLogger();
  const lifecycle = attachServerLifecycle(server, {
    processRef,
    cleanup: async () => { throw new Error('failed at /Users/private/cleanup'); },
    logger,
  });

  lifecycle.shutdown('TEST');
  server.finish();
  await lifecycle.closed;

  const output = logger.lines.join('\n');
  assert.equal(processRef.exitCode, 1);
  assert.match(output, /关闭清理失败（UNKNOWN）/);
  assert.doesNotMatch(output, /Users\/private|cleanup/);
  lifecycle.dispose();
});

test('独立服务先取得数据租约，关闭时最后释放', async () => {
  const events = [];
  const server = new FakeServer();
  const logger = createLogger();
  let appOptions;
  const started = await startStandaloneServer({
    host: '127.0.0.1',
    port: 4399,
    allowedHosts: 'novel.example',
    publicOrigin: 'https://novel.example',
    shouldOpenBrowser: false,
    logger,
    acquireLease: async () => {
      events.push('acquire');
      return { release: async () => { events.push('release'); return true; } };
    },
    cleanupTransfers: async () => {
      events.push('transfers');
      return { removed: 0, scannedEntries: 20_000, truncated: true };
    },
    cleanupImports: async () => { events.push('imports'); return { removed: 0 }; },
    recoverTransactions: async () => { events.push('recover'); return { recovered: 0, failures: [] }; },
    cleanupBackups: async () => { events.push('backups'); return 0; },
    appFactory: (options) => {
      appOptions = options;
      return {
        listen(_port, _host, callback) {
          events.push('listen');
          callback();
          return server;
        },
      };
    },
  });
  assert.deepEqual(events, ['acquire', 'transfers', 'imports', 'recover', 'listen']);
  const { requestTracker, ...forwardedAppOptions } = appOptions;
  assert.deepEqual(forwardedAppOptions, {
    listenHost: '127.0.0.1',
    allowedHosts: 'novel.example',
    publicOrigin: 'https://novel.example',
  });
  assert.equal(typeof requestTracker.waitForIdle, 'function');
  assert.match(
    logger.lines.join('\n'),
    /备份临时目录子项过多，本次残留清理只扫描前 20000 项/,
  );
  started.lifecycle.shutdown('TEST');
  server.finish();
  await started.lifecycle.closed;
  assert.deepEqual(events, [
    'acquire', 'transfers', 'imports', 'recover', 'listen', 'backups', 'release',
  ]);
});

test('独立服务等待 API 路由跟踪器归零后才释放数据租约', async () => {
  const events = [];
  const server = new FakeServer();
  const logger = createLogger();
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const started = await startStandaloneServer({
    host: '127.0.0.1',
    port: 4399,
    shouldOpenBrowser: false,
    logger,
    createRequestTracker: () => ({
      run: (task) => Promise.resolve().then(task),
      waitForIdle: async () => {
        events.push('wait');
        await idle;
      },
    }),
    acquireLease: async () => ({
      release: async () => { events.push('release'); return true; },
    }),
    cleanupTransfers: async () => ({ removed: 0 }),
    cleanupImports: async () => ({ removed: 0 }),
    recoverTransactions: async () => ({ recovered: 0, failures: [] }),
    cleanupBackups: async () => { events.push('backups'); return 0; },
    appFactory: () => ({
      listen(_port, _host, callback) {
        callback();
        return server;
      },
    }),
  });

  started.lifecycle.shutdown('TEST');
  server.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['wait']);

  resolveIdle();
  await started.lifecycle.closed;
  assert.deepEqual(events, ['wait', 'backups', 'release']);
});

test('独立服务强制断开时保留数据租约直到旧进程退出', async () => {
  const events = [];
  const server = new FakeServer();
  const logger = createLogger();
  const processRef = new EventEmitter();
  const started = await startStandaloneServer({
    host: '127.0.0.1',
    port: 4399,
    shouldOpenBrowser: false,
    logger,
    processRef,
    acquireLease: async () => ({
      release: async () => { events.push('release'); return true; },
    }),
    cleanupTransfers: async () => ({ removed: 0 }),
    cleanupImports: async () => ({ removed: 0 }),
    recoverTransactions: async () => ({ recovered: 0, failures: [] }),
    cleanupBackups: async () => { events.push('backups'); return 0; },
    appFactory: () => ({
      listen(_port, _host, callback) {
        callback();
        return server;
      },
    }),
  });

  started.lifecycle.shutdown('SIGTERM');
  started.lifecycle.shutdown('SIGTERM');
  server.finish();
  await started.lifecycle.closed;

  assert.deepEqual(events, ['backups']);
  assert.equal(processRef.exitCode, 1);
  assert.match(logger.lines.join('\n'), /租约将保留到进程退出/);
});

test('PUBLIC_ORIGIN 配置错误时启动失败并释放已取得的数据租约', async () => {
  const events = [];
  await assert.rejects(
    () => startStandaloneServer({
      host: '127.0.0.1',
      port: 4399,
      publicOrigin: 'https://novel.example/app',
      acquireLease: async () => {
        events.push('acquire');
        return { release: async () => { events.push('release'); return true; } };
      },
      cleanupTransfers: async () => ({ removed: 0 }),
      cleanupImports: async () => ({ removed: 0 }),
      recoverTransactions: async () => ({ recovered: 0, failures: [] }),
      appFactory: createApp,
    }),
    /PUBLIC_ORIGIN_INVALID/,
  );
  assert.deepEqual(events, ['acquire', 'release']);
});

test('启动恢复失败日志定位有限且脱敏，并明确保留数据继续启动', async () => {
  const logger = createLogger();
  reportStructureRecovery({
    recovered: 1,
    truncated: true,
    failures: [
      {
        bookId: 'book_safe', sectionId: 'section-01',
        error: 'STRUCTURE_TRANSACTION_TARGET_CONFLICT',
      },
      { bookId: 'book_2', error: 'STRUCTURE_TRANSACTION_INVALID' },
      { bookId: 'book_3', error: 'STORAGE_PATH_UNSAFE' },
      { bookId: 'book_4', error: 'BOOK_NOT_FOUND' },
      { bookId: 'book_5', error: 'STORAGE_FILE_TOO_LARGE' },
      {
        bookId: '\u001b[31m不安全位置',
        error: 'raw failure at /Users/private/secret',
      },
    ],
  }, logger);

  const output = logger.lines.join('\n');
  assert.match(output, /已恢复 1 个/);
  assert.match(output, /book_safe \/ section-01/);
  assert.match(output, /STRUCTURE_TRANSACTION_TARGET_CONFLICT/);
  assert.match(output, /其余 1 个未展开/);
  assert.match(output, /已达到安全上限并停止扫描/);
  assert.match(output, /书架运行完整性检查/);
  assert.match(output, /未自动覆盖或删除冲突数据/);
  assert.match(output, /备份 data\/ 目录/);
  assert.doesNotMatch(output, /Users\/private|不安全位置|raw failure/);

  const server = new FakeServer();
  const started = await startStandaloneServer({
    host: '127.0.0.1',
    port: 4399,
    shouldOpenBrowser: false,
    logger,
    acquireLease: async () => ({ release: async () => true }),
    cleanupTransfers: async () => ({ removed: 0 }),
    cleanupImports: async () => ({ removed: 0 }),
    recoverTransactions: async () => ({
      recovered: 0,
      failures: [{
        bookId: 'book_conflict',
        error: 'STRUCTURE_TRANSACTION_TARGET_CONFLICT',
      }],
    }),
    cleanupBackups: async () => 0,
    appFactory: () => ({
      listen(_port, _host, callback) {
        callback();
        return server;
      },
    }),
  });
  assert.ok(logger.lines.some((line) => line.includes('book_conflict')));
  assert.ok(logger.lines.some((line) => line.includes('自动小说盒子已启动')));
  started.lifecycle.shutdown('TEST');
  server.finish();
  await started.lifecycle.closed;
});

test('启动恢复整体异常不回显本地路径且服务仍可用', async () => {
  const logger = createLogger();
  const server = new FakeServer();
  const started = await startStandaloneServer({
    host: '127.0.0.1',
    port: 4399,
    shouldOpenBrowser: false,
    logger,
    acquireLease: async () => ({ release: async () => true }),
    cleanupTransfers: async () => ({ removed: 0 }),
    cleanupImports: async () => ({ removed: 0 }),
    recoverTransactions: async () => {
      throw new Error('failed at /Users/private/novel-data');
    },
    cleanupBackups: async () => 0,
    appFactory: () => ({
      listen(_port, _host, callback) {
        callback();
        return server;
      },
    }),
  });
  const output = logger.lines.join('\n');
  assert.match(output, /结构事务恢复失败，服务仍将启动：UNKNOWN/);
  assert.match(output, /自动小说盒子已启动/);
  assert.doesNotMatch(output, /Users\/private|novel-data/);
  started.lifecycle.shutdown('TEST');
  server.finish();
  await started.lifecycle.closed;
});

test('启动临时目录清理异常不回显本地路径且服务仍可用', async () => {
  const logger = createLogger();
  const server = new FakeServer();
  const started = await startStandaloneServer({
    host: '127.0.0.1',
    port: 4399,
    shouldOpenBrowser: false,
    logger,
    acquireLease: async () => ({ release: async () => true }),
    cleanupTransfers: async () => { throw new Error('failed at /Users/private/transfers'); },
    cleanupImports: async () => { throw new Error('failed at /Users/private/imports'); },
    recoverTransactions: async () => ({ recovered: 0, failures: [] }),
    cleanupBackups: async () => 0,
    appFactory: () => ({
      listen(_port, _host, callback) {
        callback();
        return server;
      },
    }),
  });
  const output = logger.lines.join('\n');
  assert.match(output, /备份传输临时目录清理失败，服务仍将启动：UNKNOWN/);
  assert.match(output, /新建\/导入暂存目录清理失败，服务仍将启动：UNKNOWN/);
  assert.match(output, /自动小说盒子已启动/);
  assert.doesNotMatch(output, /Users\/private|transfers|imports/);
  started.lifecycle.shutdown('TEST');
  server.finish();
  await started.lifecycle.closed;
});

test('第二实例与异常租约的启动提示说明数据保护原因', () => {
  const active = Object.assign(new Error('INSTANCE_ALREADY_RUNNING'), {
    owner: { pid: 123, host: '127.0.0.1', port: 5001 },
  });
  assert.match(startupFailureMessage(active), /PID 123/);
  assert.match(startupFailureMessage(active), /并发写坏/);
  assert.match(startupFailureMessage(new Error('INSTANCE_LOCK_INVALID')), /人工检查/);
  assert.match(startupFailureMessage(new Error('PUBLIC_ORIGIN_INVALID')), /PUBLIC_ORIGIN/);

  const unsafeOwner = Object.assign(new Error('INSTANCE_ALREADY_RUNNING'), {
    owner: { pid: 123, host: '127.0.0.1\nINJECTED', port: 5001 },
  });
  const unsafeNetwork = Object.assign(new Error('NETWORK_ACCESS_NOT_ALLOWED'), {
    listenHost: '0.0.0.0\nINJECTED',
  });
  const generic = startupFailureMessage(
    new Error('failed at /Users/private/data'),
    { host: '127.0.0.1\nINJECTED', port: '4399\nINJECTED' },
  );
  const output = [
    startupFailureMessage(unsafeOwner),
    startupFailureMessage(unsafeNetwork),
    generic,
  ].join('\n');
  assert.match(output, /无效地址/);
  assert.match(output, /无效端口/);
  assert.match(generic, /启动失败（UNKNOWN/);
  assert.doesNotMatch(output, /INJECTED|Users\/private|failed at/);
});

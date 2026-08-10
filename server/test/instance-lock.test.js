import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../store.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

const LOCK_FILE = '.instance-lock.json';
const FORMAT = 'auto-novel-box-instance-lock';
let root;
const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

beforeEach(() => {
  root = makeTestTempDir('novelbox-instance-lock-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

function owner({
  pid = 111,
  token = 'stale-token-1111111111',
  startedAt = '2026-08-05T00:00:00.000Z',
  processStartedAt,
} = {}) {
  return {
    format: FORMAT,
    token,
    pid,
    startedAt,
    ...(processStartedAt ? { processStartedAt } : {}),
    host: '127.0.0.1',
    port: 4399,
  };
}

async function writeOwner(value) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, LOCK_FILE), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

test('数据目录租约阻止第二个存活进程并由所有者安全释放', async () => {
  const lease = await store.acquireDataRootLease({
    pid: 111,
    createToken: () => 'active-token-111111111',
    processAlive: (pid) => pid === 111,
    settleMs: 0,
  });
  const stored = JSON.parse(await readFile(join(root, LOCK_FILE), 'utf8'));
  assert.equal(stored.pid, 111);
  assert.equal(stored.token, lease.owner.token);
  assert.equal((await stat(join(root, LOCK_FILE))).mode & 0o777, 0o600);

  await assert.rejects(
    () => store.acquireDataRootLease({
      pid: 222,
      createToken: () => 'active-token-222222222',
      processAlive: (pid) => pid === 111 || pid === 222,
      settleMs: 0,
    }),
    (error) => error?.message === 'INSTANCE_ALREADY_RUNNING'
      && error?.owner?.pid === 111,
  );
  assert.equal(await lease.release(), true);
  assert.equal(await lease.release(), false);
  assert.deepEqual(await readdir(root), []);
});

test('崩溃遗留且 PID 已失效的租约会被接管，非法租约不会自动删除', async () => {
  await writeOwner(owner());
  const lease = await store.acquireDataRootLease({
    pid: 222,
    createToken: () => 'replacement-token-22222',
    processAlive: (pid) => pid === 222,
    settleMs: 0,
  });
  assert.equal(JSON.parse(await readFile(join(root, LOCK_FILE), 'utf8')).pid, 222);
  await lease.release();

  await writeOwner({ format: FORMAT, pid: 999 });
  await assert.rejects(
    () => store.acquireDataRootLease({
      pid: 222,
      createToken: () => 'replacement-token-33333',
      processAlive: () => false,
      settleMs: 0,
    }),
    /INSTANCE_LOCK_INVALID/,
  );
  assert.deepEqual(JSON.parse(await readFile(join(root, LOCK_FILE), 'utf8')), {
    format: FORMAT, pid: 999,
  });
});

test('包含控制字符的租约主机不会被信任或自动接管', async () => {
  const unsafeOwner = owner();
  unsafeOwner.host = '127.0.0.1\nINJECTED';
  await writeOwner(unsafeOwner);

  await assert.rejects(
    () => store.acquireDataRootLease({
      pid: 222,
      createToken: () => 'replacement-token-44444',
      processAlive: () => false,
      settleMs: 0,
    }),
    /INSTANCE_LOCK_INVALID/,
  );
  assert.equal(JSON.parse(await readFile(join(root, LOCK_FILE), 'utf8')).host,
    '127.0.0.1\nINJECTED');
});

test('PID 被新进程复用时接管旧租约，但同一进程的第二实例仍被阻止', async () => {
  const oldProcessStart = Date.parse('2026-08-05T00:00:00.000Z');
  const newProcessStart = Date.parse('2026-08-05T01:00:00.000Z');
  await writeOwner(owner({
    pid: 222,
    startedAt: '2026-08-05T00:10:00.000Z',
    processStartedAt: new Date(oldProcessStart).toISOString(),
  }));

  // processAlive(222) 为 true，因为这个 PID 现在属于发起接管的新进程；必须用
  // 进程启动身份识别锁文件实际上属于已经崩溃的上一代进程。
  const lease = await store.acquireDataRootLease({
    pid: 222,
    nowMs: Date.parse('2026-08-05T01:10:00.000Z'),
    processStartedAtMs: newProcessStart,
    createToken: () => 'reused-pid-token-222222',
    processAlive: () => true,
    settleMs: 0,
  });
  const stored = JSON.parse(await readFile(join(root, LOCK_FILE), 'utf8'));
  assert.equal(stored.pid, 222);
  assert.equal(stored.processStartedAt, new Date(newProcessStart).toISOString());

  await assert.rejects(
    () => store.acquireDataRootLease({
      pid: 222,
      nowMs: Date.parse('2026-08-05T01:20:00.000Z'),
      processStartedAtMs: newProcessStart,
      createToken: () => 'same-process-token-22222',
      processAlive: () => true,
      settleMs: 0,
    }),
    /INSTANCE_ALREADY_RUNNING/,
  );
  assert.equal(await lease.release(), true);
});

test('旧租约 PID 被另一个存活进程占用时按实际启动身份安全接管', async () => {
  const oldProcessStart = Date.parse('2026-08-05T00:00:00.000Z');
  const unrelatedProcessStart = Date.parse('2026-08-05T03:00:00.000Z');
  await writeOwner(owner({
    pid: 111,
    processStartedAt: new Date(oldProcessStart).toISOString(),
  }));

  // 请求新租约的 PID 与旧 PID 不同；单靠 kill(pid, 0) 只能知道 111
  // 仍被占用，必须继续比较操作系统报告的实际进程启动时间。
  const lease = await store.acquireDataRootLease({
    pid: 222,
    processStartedAtMs: Date.parse('2026-08-05T04:00:00.000Z'),
    createToken: () => 'different-reused-pid-222',
    processAlive: () => true,
    processStartedAtForPid: async (pid) => pid === 111 ? unrelatedProcessStart : null,
    settleMs: 0,
  });
  assert.equal(JSON.parse(await readFile(join(root, LOCK_FILE), 'utf8')).pid, 222);
  assert.equal(await lease.release(), true);
});

test('进程启动身份无法读取或差异不明确时继续保守阻止接管', async () => {
  const oldProcessStart = Date.parse('2026-08-05T00:00:00.000Z');
  const acquire = (processStartedAtForPid) => store.acquireDataRootLease({
    pid: 222,
    processStartedAtMs: Date.parse('2026-08-05T04:00:00.000Z'),
    createToken: () => 'conservative-probe-222',
    processAlive: () => true,
    processStartedAtForPid,
    settleMs: 0,
  });

  await writeOwner(owner({
    pid: 111,
    processStartedAt: new Date(oldProcessStart).toISOString(),
  }));
  await assert.rejects(() => acquire(async () => null), /INSTANCE_ALREADY_RUNNING/);
  await assert.rejects(
    () => acquire(async () => { throw new Error('probe failed'); }),
    /INSTANCE_ALREADY_RUNNING/,
  );
  await assert.rejects(
    () => acquire(async () => oldProcessStart + 1_000),
    /INSTANCE_ALREADY_RUNNING/,
  );
  assert.equal(JSON.parse(await readFile(join(root, LOCK_FILE), 'utf8')).pid, 111);
});

test('操作系统探测能辨认占用旧租约 PID 的真实无关子进程', async () => {
  const unrelated = spawn(process.execPath, [
    '-e', 'setInterval(() => {}, 1000)',
  ], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    unrelated.once('spawn', resolve);
    unrelated.once('error', reject);
  });
  let lease;
  try {
    await writeOwner(owner({
      pid: unrelated.pid,
      processStartedAt: '2000-01-01T00:00:00.000Z',
    }));
    lease = await store.acquireDataRootLease({
      createToken: () => 'real-unrelated-pid-token',
      settleMs: 0,
    });
    assert.equal(JSON.parse(await readFile(join(root, LOCK_FILE), 'utf8')).pid, process.pid);
  } finally {
    await lease?.release();
    if (unrelated.exitCode === null) {
      const stopped = new Promise((resolve) => unrelated.once('exit', resolve));
      unrelated.kill();
      await stopped;
    }
  }
});

test('跨平台进程身份探测使用无 shell 参数并只接受单个时间值', async () => {
  const calls = [];
  const fakeExec = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, calls.length === 1
      ? 'Wed Aug  5 12:34:56 2026\n'
      : '2026-08-05T12:34:56.789Z\n');
  };
  const posix = await store.processStartedAtMsForPid(123, {
    platform: 'darwin', execFileImpl: fakeExec,
  });
  const windows = await store.processStartedAtMsForPid(456, {
    platform: 'win32', execFileImpl: fakeExec,
  });

  assert.equal(posix, Date.parse('Wed Aug  5 12:34:56 2026 UTC'));
  assert.equal(windows, Date.parse('2026-08-05T12:34:56.789Z'));
  assert.equal(calls[0].file, '/bin/ps');
  assert.deepEqual(calls[0].args, ['-p', '123', '-o', 'lstart=']);
  assert.equal(calls[0].options.env.LC_ALL, 'C');
  assert.equal(calls[0].options.env.TZ, 'UTC0');
  assert.match(calls[1].file, /powershell\.exe$/i);
  assert.ok(calls[1].args.includes('-NonInteractive'));
  assert.match(calls[1].args.at(-1), /Get-Process -Id 456/);
  assert.equal(Object.hasOwn(calls[0].options, 'shell'), false);
  assert.equal(Object.hasOwn(calls[1].options, 'shell'), false);

  assert.equal(await store.processStartedAtMsForPid(Number.MAX_VALUE), null);
  assert.equal(await store.processStartedAtMsForPid(123, {
    execFileImpl: (_file, _args, _options, callback) => callback(null, 'bad\nvalue'),
  }), null);
  assert.equal(await store.processStartedAtMsForPid(123, {
    execFileImpl: (_file, _args, _options, callback) => callback(new Error('failed')),
  }), null);
});

test('残留清理的进程身份探测按 PID 缓存、限制总量并保守处理异常', async () => {
  const calls = [];
  const resolveStartedAt = store.createCachedProcessStartedAtResolver(async (pid) => {
    calls.push(pid);
    if (pid === 2) throw new Error('probe failed');
    return pid * 1_000;
  }, 2);

  const first = resolveStartedAt(1);
  assert.equal(resolveStartedAt(1), first);
  assert.equal(await first, 1_000);
  assert.equal(await resolveStartedAt(2), null);
  assert.equal(await resolveStartedAt(2), null);
  assert.equal(resolveStartedAt(3), null);
  assert.deepEqual(calls, [1, 2]);

  assert.equal(store.createCachedProcessStartedAtResolver(null), null);
});

test('残留清理的进程身份探测耗尽整批时间预算后不再启动新查询', async () => {
  let nowMs = 0;
  const calls = [];
  const resolveStartedAt = store.createCachedProcessStartedAtResolver(async (pid) => {
    calls.push(pid);
    nowMs += 600;
    return pid * 1_000;
  }, 64, {
    maxElapsedMs: 1_000,
    now: () => nowMs,
  });

  assert.equal(await resolveStartedAt(1), 1_000);
  assert.equal(await resolveStartedAt(2), 2_000);
  assert.equal(resolveStartedAt(3), null);
  assert.deepEqual(calls, [1, 2]);
});

test('旧版同 PID 租约在获取时间早于当前进程启动时可安全接管', async () => {
  await writeOwner(owner({
    pid: 333,
    startedAt: '2026-08-05T00:10:00.000Z',
  }));
  const lease = await store.acquireDataRootLease({
    pid: 333,
    nowMs: Date.parse('2026-08-05T02:00:00.000Z'),
    processStartedAtMs: Date.parse('2026-08-05T01:00:00.000Z'),
    createToken: () => 'legacy-reused-token-3333',
    processAlive: () => true,
    settleMs: 0,
  });
  assert.equal(JSON.parse(await readFile(join(root, LOCK_FILE), 'utf8')).token,
    'legacy-reused-token-3333');
  assert.equal(await lease.release(), true);
});

test('两个进程同时接管同一陈旧租约时最终只有一个所有者', async () => {
  await writeOwner(owner({ pid: 999 }));
  const processAlive = (pid) => pid === 111 || pid === 222;
  const attempts = await Promise.allSettled([
    store.acquireDataRootLease({
      pid: 111,
      createToken: () => 'concurrent-token-1111111',
      processAlive,
      settleMs: 30,
    }),
    store.acquireDataRootLease({
      pid: 222,
      createToken: () => 'concurrent-token-2222222',
      processAlive,
      settleMs: 30,
    }),
  ]);
  const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
  const rejected = attempts.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason?.message || '', /INSTANCE_(?:ALREADY_RUNNING|LOCK_BUSY)/);
  const lease = fulfilled[0].value;
  const stored = JSON.parse(await readFile(join(root, LOCK_FILE), 'utf8'));
  assert.equal(stored.token, lease.owner.token);
  await lease.release();
  assert.deepEqual(await readdir(root), []);
});

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function waitForOutput(child, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => finish(new Error(`child output timeout: ${stdout}${stderr}`)), timeoutMs);
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const inspect = () => { if (pattern.test(stdout + stderr)) finish(); };
    const onStdout = (chunk) => { stdout += chunk; inspect(); };
    const onStderr = (chunk) => { stderr += chunk; inspect(); };
    const onExit = (code) => finish(new Error(`child exited ${code}: ${stdout}${stderr}`));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function collectUntilExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode, stdout: '', stderr: '' });
  }
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => finish(new Error('child exit timeout')), timeoutMs);
    const finish = (error, code, signal) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, signal, stdout, stderr });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code, signal) => finish(null, code, signal));
  });
}

test('真实双进程使用不同端口时第二实例仍在监听前退出', async () => {
  const firstPort = await unusedPort();
  let secondPort = await unusedPort();
  while (secondPort === firstPort) secondPort = await unusedPort();
  const entry = join(projectRoot, 'server', 'index.js');
  const childEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    NOVELBOX_OPEN_BROWSER: '0',
  };
  const first = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...childEnv, PORT: String(firstPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForOutput(first, /自动小说盒子已启动/);
    const second = spawn(process.execPath, [entry], {
      cwd: root,
      env: { ...childEnv, PORT: String(secondPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rejected = await collectUntilExit(second);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /另一个自动小说盒子实例/);
    assert.match(rejected.stderr, /并发写坏/);
  } finally {
    if (first.exitCode === null) first.kill('SIGTERM');
    const stopped = await collectUntilExit(first);
    assert.equal(stopped.code, 0);
  }
  await assert.rejects(() => stat(join(root, 'data', LOCK_FILE)), { code: 'ENOENT' });
});

test('真实进程收到 SIGHUP 时正常退出并释放数据租约', {
  skip: process.platform === 'win32',
}, async () => {
  const port = await unusedPort();
  const entry = join(projectRoot, 'server', 'index.js');
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      NOVELBOX_OPEN_BROWSER: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForOutput(child, /自动小说盒子已启动/);
    assert.equal(child.kill('SIGHUP'), true);
    const stopped = await collectUntilExit(child);
    assert.equal(stopped.code, 0);
    assert.equal(stopped.signal, null);
    assert.match(stopped.stdout, /SIGHUP/);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await collectUntilExit(child).catch(() => {});
    }
  }
  await assert.rejects(() => stat(join(root, 'data', LOCK_FILE)), { code: 'ENOENT' });
});

test('真实进程被强制终止后下一实例可接管陈旧租约', async () => {
  const firstPort = await unusedPort();
  let secondPort = await unusedPort();
  while (secondPort === firstPort) secondPort = await unusedPort();
  const entry = join(projectRoot, 'server', 'index.js');
  const childEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    NOVELBOX_OPEN_BROWSER: '0',
  };
  const first = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...childEnv, PORT: String(firstPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForOutput(first, /自动小说盒子已启动/);
  first.kill('SIGKILL');
  const crashed = await collectUntilExit(first);
  assert.ok(crashed.signal !== null || crashed.code !== 0);
  assert.equal(JSON.parse(await readFile(join(root, 'data', LOCK_FILE), 'utf8')).pid, first.pid);

  const replacement = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...childEnv, PORT: String(secondPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForOutput(replacement, /自动小说盒子已启动/);
  } finally {
    if (replacement.exitCode === null) replacement.kill('SIGTERM');
    const stopped = await collectUntilExit(replacement);
    assert.equal(stopped.code, 0);
  }
  await assert.rejects(() => stat(join(root, 'data', LOCK_FILE)), { code: 'ENOENT' });
});

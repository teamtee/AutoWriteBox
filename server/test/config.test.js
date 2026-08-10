import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as store from '../store.js';
import { createApp } from '../index.js';
import {
  MAX_CHAPTER_WORD_TARGET, MAX_CONFIG_API_KEY_CHARS,
  MAX_CONFIG_BASE_URL_CHARS, MAX_CONFIG_JSON_BYTES, MAX_CONFIG_MODEL_CHARS,
} from '../limits.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let base;
let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);
async function withServer(fn) {
  const started = await startTestServer(createApp());
  base = started.base;
  try { await fn(); } finally { await stopTestServer(started.server); }
}

async function getPublicConfig() {
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);
  return response.json();
}

async function postConfig(patch, expectedRevision) {
  const revision = expectedRevision ?? (await getPublicConfig()).revision;
  return fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...patch, expectedRevision: revision }),
  });
}

test('POST 保存后 GET 返回掩码 Key', async () => {
  await withServer(async () => {
    const initial = await getPublicConfig();
    assert.match(initial.revision, /^[A-Za-z0-9_-]{43}$/);
    const post = await postConfig({
      baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-secret', chapterWordTarget: 1500,
    }, initial.revision);
    const saved = await post.json();
    assert.equal(saved.apiKey, 'sk-****');
    assert.equal(saved.chapterWordTarget, 1500);
    assert.match(saved.revision, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(saved.revision, initial.revision);
    const get = await getPublicConfig();
    assert.equal(get.baseUrl, 'https://x/v1');
    assert.equal(get.apiKey, 'sk-****');
    assert.equal(get.revision, saved.revision);
  });
});

test('掩码 Key 再次保存不覆盖真实 Key', async () => {
  await withServer(async () => {
    await postConfig({ apiKey: 'sk-real' });
    await postConfig({ model: 'm2', apiKey: 'sk-****' });
    const real = await store.readConfig();
    assert.equal(real.apiKey, 'sk-real');
    assert.equal(real.model, 'm2');
  });
});

test('并发掩码保存不覆盖同时写入的新 API Key', async () => {
  await store.writeConfig({ apiKey: 'sk-old' });

  await Promise.all([
    store.writeConfig({ apiKey: 'sk-new' }),
    ...Array.from({ length: 50 }, (_, i) =>
      store.writeConfig({ model: `m${i}`, apiKey: 'sk-****' })),
  ]);

  const real = await store.readConfig();
  assert.equal(real.apiKey, 'sk-new');
});

test('保存空 API Key 会清除旧 Key', async () => {
  await withServer(async () => {
    await postConfig({ apiKey: 'sk-real' });
    const cleared = await (await postConfig({ apiKey: '' })).json();
    assert.equal(cleared.apiKey, '');

    const real = await store.readConfig();
    assert.equal(real.apiKey, '');
  });
});

test('修改 Base URL 时不允许通过掩码沿用旧 Key', async () => {
  await withServer(async () => {
    await postConfig({ baseUrl: 'https://old.example/v1', apiKey: 'sk-real' });
    const response = await postConfig({
      baseUrl: 'https://new.example/v1', apiKey: 'sk-****',
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'API_KEY_REQUIRED_FOR_BASE_URL_CHANGE');
    const real = await store.readConfig();
    assert.equal(real.baseUrl, 'https://old.example/v1');
    assert.equal(real.apiKey, 'sk-real');
  });
});

test('修改 Base URL 并显式提供新 Key 可以保存', async () => {
  await store.writeConfig({ baseUrl: 'https://old.example/v1', apiKey: 'sk-old' });
  await store.writeConfig({ baseUrl: 'https://new.example/v1', apiKey: 'sk-new' });
  const real = await store.readConfig();
  assert.equal(real.baseUrl, 'https://new.example/v1');
  assert.equal(real.apiKey, 'sk-new');
});

test('配置保存复用模型连接校验并在落盘前规范化字段', async () => {
  await withServer(async () => {
    const initial = await getPublicConfig();
    const savedResponse = await postConfig({
      baseUrl: ' HTTPS://Example.Test:443/v1/ ',
      model: ' model-name ',
      apiKey: ' sk-secret ',
    }, initial.revision);
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.baseUrl, 'https://example.test/v1');
    assert.equal(saved.model, 'model-name');
    assert.equal(saved.apiKey, 'sk-****');
    assert.deepEqual(await store.readConfig(), {
      baseUrl: 'https://example.test/v1',
      model: 'model-name',
      apiKey: 'sk-secret',
      chapterWordTarget: 2000,
      requestTimeoutMs: 300000,
    });

    for (const baseUrl of [
      'ftp://example.test/v1',
      'https://example.test/v1?token=x',
      'https://user:password@example.test/v1',
      '   ',
    ]) {
      const page = await getPublicConfig();
      const response = await postConfig({
        baseUrl,
        model: page.model,
        apiKey: 'sk-new',
        chapterWordTarget: page.chapterWordTarget,
        requestTimeoutMs: page.requestTimeoutMs,
      }, page.revision);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /LLM_BASE_URL_(?:INVALID|REQUIRED)/);
    }

    const page = await getPublicConfig();
    const insecure = await postConfig({
      baseUrl: 'http://remote.example/v1',
      model: page.model,
      apiKey: 'sk-new',
      chapterWordTarget: page.chapterWordTarget,
      requestTimeoutMs: page.requestTimeoutMs,
    }, page.revision);
    assert.equal(insecure.status, 400);
    assert.deepEqual(await insecure.json(), { error: 'LLM_INSECURE_API_KEY_TRANSPORT' });
    assert.equal((await store.readConfig()).baseUrl, 'https://example.test/v1');
  });
});

test('配置保存拒绝控制字符且不落盘密钥或不可见模型名', async () => {
  await withServer(async () => {
    await postConfig({
      baseUrl: 'https://example.test/v1', model: 'stable-model', apiKey: 'sk-stable',
    });

    for (const [patch, expectedError] of [
      [{ baseUrl: 'https://example.test/v1\n' }, 'LLM_BASE_URL_INVALID'],
      [{ model: 'model\tname' }, 'LLM_MODEL_INVALID'],
      [{ apiKey: 'sk-new\r\nX-Injected: yes' }, 'LLM_API_KEY_INVALID'],
    ]) {
      const response = await postConfig(patch);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: expectedError });
      assert.deepEqual(await store.readConfig(), {
        baseUrl: 'https://example.test/v1',
        model: 'stable-model',
        apiKey: 'sk-stable',
        chapterWordTarget: 2000,
        requestTimeoutMs: 300000,
      });
    }
  });
});

test('配置接口拒绝缺少修订号的保存', async () => {
  await withServer(async () => {
    const response = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'stale-model' }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'BAD_CONFIG_REVISION' });
    assert.equal((await store.readConfig()).model, '');
  });
});

test('旧设置页面不能覆盖另一页面已经保存的新配置', async () => {
  await withServer(async () => {
    const firstPage = await getPublicConfig();
    const stalePage = await getPublicConfig();

    const firstSave = await postConfig({
      baseUrl: firstPage.baseUrl,
      model: 'new-model',
      apiKey: firstPage.apiKey,
      chapterWordTarget: firstPage.chapterWordTarget,
      requestTimeoutMs: firstPage.requestTimeoutMs,
    }, firstPage.revision);
    assert.equal(firstSave.status, 200);

    const staleSave = await postConfig({
      baseUrl: stalePage.baseUrl,
      model: stalePage.model,
      apiKey: stalePage.apiKey,
      chapterWordTarget: 3600,
      requestTimeoutMs: stalePage.requestTimeoutMs,
    }, stalePage.revision);

    assert.equal(staleSave.status, 409);
    assert.deepEqual(await staleSave.json(), { error: 'CONFIG_CONFLICT' });
    const actual = await store.readConfig();
    assert.equal(actual.model, 'new-model');
    assert.equal(actual.chapterWordTarget, 2000);
  });
});

test('保存响应丢失后用相同旧修订号重放同一目标配置可幂等确认', async () => {
  await withServer(async () => {
    const page = await getPublicConfig();
    const target = {
      baseUrl: 'https://retry.example/v1',
      model: 'retry-model',
      apiKey: 'sk-retry-secret',
      chapterWordTarget: 2600,
      requestTimeoutMs: 180000,
    };

    const firstResponse = await postConfig(target, page.revision);
    assert.equal(firstResponse.status, 200);
    const firstSaved = await firstResponse.json();

    const replayResponse = await postConfig(target, page.revision);
    assert.equal(replayResponse.status, 200);
    assert.deepEqual(await replayResponse.json(), firstSaved);

    const differentReplay = await postConfig({ ...target, apiKey: 'sk-different' }, page.revision);
    assert.equal(differentReplay.status, 409);
    assert.deepEqual(await differentReplay.json(), { error: 'CONFIG_CONFLICT' });
    assert.deepEqual(await store.readConfig(), target);
  });
});

test('配置文件以仅当前用户可读写的权限创建', async () => {
  await store.writeConfig({ apiKey: 'sk-secret' });
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(root, 'config.json')).mode & 0o777, 0o600);
  }
});

test('读取旧配置时自动收紧可能泄露 API Key 的文件权限', {
  skip: process.platform === 'win32',
}, async () => {
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify({ apiKey: 'sk-existing' }));
  chmodSync(path, 0o644);

  assert.equal((statSync(path).mode & 0o777), 0o644);
  assert.equal((await store.readConfig()).apiKey, 'sk-existing');
  assert.equal((statSync(path).mode & 0o777), 0o600);
});

test('保存配置会收紧旧数据根目录，但不修改其父目录', {
  skip: process.platform === 'win32',
}, async () => {
  const parent = makeTestTempDir('novelbox-config-parent-');
  const dataRoot = join(parent, 'data');
  mkdirSync(dataRoot, { mode: 0o755 });
  chmodSync(parent, 0o755);
  chmodSync(dataRoot, 0o755);
  store.setDataRoot(dataRoot);

  await store.writeConfig({ apiKey: 'sk-secret' });

  assert.equal(statSync(parent).mode & 0o777, 0o755);
  assert.equal(statSync(dataRoot).mode & 0o777, 0o700);
  assert.equal(statSync(join(dataRoot, 'config.json')).mode & 0o777, 0o600);
});

test('配置文件链接不会越界读写 API Key', {
  skip: process.platform === 'win32',
}, async () => {
  const externalRoot = makeTestTempDir('novelbox-external-config-');
  const externalConfig = join(externalRoot, 'config.json');
  writeFileSync(externalConfig, JSON.stringify({ apiKey: 'sk-external' }), 'utf8');
  symlinkSync(externalConfig, join(root, 'config.json'), 'file');

  await assert.rejects(() => store.readConfig(), /STORAGE_PATH_UNSAFE/);
  await assert.rejects(() => store.writeConfig({ apiKey: 'sk-overwrite' }), /STORAGE_PATH_UNSAFE/);
  assert.equal(JSON.parse(readFileSync(externalConfig, 'utf8')).apiKey, 'sk-external');
});

test('数据根链接不会把配置读写到外部目录', {
  skip: process.platform === 'win32',
}, async () => {
  const linkParent = makeTestTempDir('novelbox-linked-root-');
  const externalRoot = makeTestTempDir('novelbox-external-root-');
  const linkedRoot = join(linkParent, 'data');
  symlinkSync(externalRoot, linkedRoot, 'dir');
  store.setDataRoot(linkedRoot);

  await assert.rejects(() => store.readConfig(), /STORAGE_PATH_UNSAFE/);
  await assert.rejects(() => store.writeConfig({ apiKey: 'sk-overwrite' }), /STORAGE_PATH_UNSAFE/);
  assert.throws(() => readFileSync(join(externalRoot, 'config.json')), { code: 'ENOENT' });
});

test('非法每章目标字数返回 JSON 错误且不覆盖旧值', async () => {
  await withServer(async () => {
    await postConfig({ chapterWordTarget: 1800 });

    const r = await postConfig({ chapterWordTarget: 0 });

    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /BAD_CHAPTER_WORD_TARGET/);
    assert.equal((await store.readConfig()).chapterWordTarget, 1800);
  });
});

test('非法 API 超时值返回 JSON 错误且不覆盖旧值', async () => {
  await store.writeConfig({ requestTimeoutMs: 120000 });
  for (const requestTimeoutMs of [0, 999, 1000.5, 3600001, 'bad']) {
    await assert.rejects(
      () => store.writeConfig({ requestTimeoutMs }),
      /BAD_REQUEST_TIMEOUT/,
    );
  }
  assert.equal((await store.readConfig()).requestTimeoutMs, 120000);
});

test('非字符串配置字段返回 JSON 错误且不覆盖旧值', async () => {
  await withServer(async () => {
    await postConfig({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-real' });

    for (const patch of [
      { baseUrl: { bad: 'object' } },
      { model: ['bad'] },
      { apiKey: 123 },
    ]) {
      const r = await postConfig(patch);

      assert.equal(r.status, 400);
      const body = await r.json();
      assert.match(body.error, /BAD_CONFIG_TEXT_FIELD/);
      const real = await store.readConfig();
      assert.equal(real.baseUrl, 'https://x/v1');
      assert.equal(real.model, 'm');
      assert.equal(real.apiKey, 'sk-real');
    }
  });
});

test('配置请求体必须是普通对象，不接受数组污染配置文件', async () => {
  await withServer(async () => {
    await postConfig({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-real' });

    const r = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['polluted']),
    });

    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /BAD_CONFIG_PATCH/);
    const real = await store.readConfig();
    assert.equal(Object.hasOwn(real, '0'), false);
    assert.equal(real.baseUrl, 'https://x/v1');
    assert.equal(real.model, 'm');
    assert.equal(real.apiKey, 'sk-real');
  });
});

test('未知配置字段返回 JSON 错误且不污染配置文件', async () => {
  await withServer(async () => {
    await postConfig({ baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-real' });

    const r = await postConfig({ extra: 'polluted' });

    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /BAD_CONFIG_FIELD/);
    const real = await store.readConfig();
    assert.equal(Object.hasOwn(real, 'extra'), false);
    assert.equal(real.baseUrl, 'https://x/v1');
    assert.equal(real.model, 'm');
    assert.equal(real.apiKey, 'sk-real');
  });
});

test('读取配置时忽略磁盘里的未知字段', async () => {
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    baseUrl: 'https://x/v1',
    model: 'm',
    apiKey: 'sk-real',
    extra: 'polluted',
  }), 'utf8');

  await withServer(async () => {
    const cfg = await (await fetch(`${base}/api/config`)).json();

    assert.equal(Object.hasOwn(cfg, 'extra'), false);
    assert.equal(cfg.baseUrl, 'https://x/v1');
    assert.equal(cfg.model, 'm');
    assert.equal(cfg.apiKey, 'sk-****');
  });
});

test('读取配置时丢弃磁盘里类型非法的已知字段', async () => {
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    baseUrl: { bad: 'object' },
    model: ['bad'],
    apiKey: 123,
    chapterWordTarget: 'bad',
  }), 'utf8');

  await withServer(async () => {
    const cfg = await (await fetch(`${base}/api/config`)).json();

    assert.equal(cfg.baseUrl, '');
    assert.equal(cfg.model, '');
    assert.equal(cfg.apiKey, '');
    assert.equal(cfg.chapterWordTarget, 2000);
  });
});

test('请求体 JSON 损坏时返回 JSON 错误，不返回默认 HTML 错误页', async () => {
  await withServer(async () => {
    const r = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"model":',
    });

    assert.equal(r.status, 400);
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    const body = await r.json();
    assert.equal(body.error, 'INVALID_JSON');
  });
});

test('配置文件损坏时返回 JSON 错误，不伪装成默认配置', async () => {
  writeFileSync(join(root, 'config.json'), '{bad json', 'utf8');

  await withServer(async () => {
    const r = await fetch(`${base}/api/config`);

    assert.equal(r.status, 500);
    const body = await r.json();
    assert.equal(body.error, 'STORAGE_JSON_INVALID');
  });
});

test('配置文件异常过大时拒绝载入并返回稳定存储错误', async () => {
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, '{}', 'utf8');
  truncateSync(configPath, MAX_CONFIG_JSON_BYTES + 1);
  if (process.platform !== 'win32') chmodSync(configPath, 0o644);

  await withServer(async () => {
    const response = await fetch(`${base}/api/config`);

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'STORAGE_FILE_TOO_LARGE' });
    if (process.platform !== 'win32') {
      assert.equal(statSync(configPath).mode & 0o777, 0o600);
    }
  });
});

test('配置保存失败返回 JSON 错误，不挂住请求', async () => {
  const rootFile = join(makeTestTempDir('novelbox-config-'), 'not-a-dir');
  writeFileSync(rootFile, 'x');
  store.setDataRoot(rootFile);
  await withServer(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', expectedRevision: 'R'.repeat(43) }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.equal(body.error, 'STORAGE_PATH_INVALID');
  });
});

test('未配置 Base URL 时生成请求返回明确错误且不改大纲', async () => {
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p', title: 't' });
    const response = await fetch(`${base}/api/books/${book.id}/version/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'outline',
        expectedRevision: store.versionRevision(book.outline),
      }),
    });
    const sse = await response.text();

    assert.match(sse, /LLM_BASE_URL_REQUIRED/);
    assert.equal(store.currentText((await store.readBook(book.id)).outline), '');
  });
});

test('配置存储层拒绝超大数值和文本且不覆盖旧值', async () => {
  await store.writeConfig({
    baseUrl: 'https://old.example/v1', model: 'old-model', apiKey: 'sk-old',
    chapterWordTarget: 1800,
  });

  await assert.rejects(
    () => store.writeConfig({ chapterWordTarget: MAX_CHAPTER_WORD_TARGET + 1 }),
    /BAD_CHAPTER_WORD_TARGET/,
  );
  for (const patch of [
    { baseUrl: 'x'.repeat(MAX_CONFIG_BASE_URL_CHARS + 1) },
    { model: 'x'.repeat(MAX_CONFIG_MODEL_CHARS + 1) },
    { apiKey: 'x'.repeat(MAX_CONFIG_API_KEY_CHARS + 1) },
  ]) {
    await assert.rejects(() => store.writeConfig(patch), /CONFIG_TEXT_TOO_LARGE/);
  }

  const saved = await store.readConfig();
  assert.equal(saved.baseUrl, 'https://old.example/v1');
  assert.equal(saved.model, 'old-model');
  assert.equal(saved.apiKey, 'sk-old');
  assert.equal(saved.chapterWordTarget, 1800);
});

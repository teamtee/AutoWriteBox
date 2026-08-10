import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as store from '../store.js';
import { createApp } from '../index.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-api-profiles-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

test('旧方案库在没有模型分工字段时安全迁移为默认路由', async () => {
  await store.atomicWriteJson(join(root, 'api-profiles.json'), {
    version: 1, activeProfileId: null, profiles: [],
  }, { mode: 0o600 });
  assert.deepEqual((await store.readApiProfiles()).taskRoutes, {
    chapter: null, outline: null, digest: null, review: null, title: null,
  });
  assert.deepEqual((await store.readApiProfiles()).bookBindings, []);
});

test('API 方案保存多个模型并可显式激活其中一个', async () => {
  await store.writeConfig({
    baseUrl: 'https://one.example/v1', model: 'model-a', apiKey: 'sk-one',
  });
  const empty = await store.readApiProfiles();
  const saved = await store.saveApiProfile({
    name: '主服务', note: '正文与大纲', useCurrentConfig: true,
    models: ['model-a', 'model-b', 'model-a'], selectedModel: 'model-a',
  }, {
    expectedRevision: empty.revision,
    expectedConfigRevision: store.configRevision(await store.readConfig()),
  });
  assert.deepEqual(saved.profile.models, ['model-a', 'model-b']);
  assert.equal(saved.profile.apiKey, 'sk-one');

  const beforeConfig = await store.readConfig();
  const activated = await store.activateApiProfile(saved.profile.id, 'model-b', {
    expectedProfilesRevision: saved.revision,
    expectedConfigRevision: store.configRevision(beforeConfig),
  });
  assert.equal(activated.config.model, 'model-b');
  assert.equal((await store.readConfig()).apiKey, 'sk-one');
  assert.equal(activated.library.activeProfileId, saved.profile.id);
  assert.equal(activated.library.profiles[0].selectedModel, 'model-b');

  const edited = await store.saveApiProfile({
    id: saved.profile.id, name: '主服务', note: '改为另一默认模型',
    baseUrl: saved.profile.baseUrl, apiKey: 'sk-****',
    models: ['model-a', 'model-b'], selectedModel: 'model-a',
  }, { expectedRevision: activated.library.revision });
  assert.equal((await store.readApiProfiles()).activeProfileId, null);
  assert.equal(edited.profile.apiKey, 'sk-one');
});

test('保存当前连接会拒绝已过期的配置快照', async () => {
  await store.writeConfig({
    baseUrl: 'https://one.example/v1', model: 'model-a', apiKey: 'sk-one',
  });
  const staleConfig = await store.readConfig();
  const staleConfigRevision = store.configRevision(staleConfig);
  await store.writeConfig({ model: 'model-new' }, { expectedRevision: staleConfigRevision });
  const library = await store.readApiProfiles();

  await assert.rejects(() => store.saveApiProfile({
    name: '陈旧快照', useCurrentConfig: true,
    models: ['model-a'], selectedModel: 'model-a', note: '',
  }, {
    expectedRevision: library.revision,
    expectedConfigRevision: staleConfigRevision,
  }), /CONFIG_CONFLICT/);
  assert.equal((await store.readApiProfiles()).profiles.length, 0);
});

test('方案库用独立修订号阻止旧页面覆盖，并安全保留掩码密钥', async () => {
  let library = await store.readApiProfiles();
  const created = await store.saveApiProfile({
    name: '服务一', baseUrl: 'https://one.example/v1', apiKey: 'sk-secret',
    models: ['m1'], selectedModel: 'm1', note: '',
  }, { expectedRevision: library.revision });
  library = await store.readApiProfiles();
  const updated = await store.saveApiProfile({
    id: created.profile.id, name: '服务一新版', baseUrl: 'https://one.example/v1',
    apiKey: 'sk-****', models: ['m1', 'm2'], selectedModel: 'm2', note: '更新',
  }, { expectedRevision: library.revision });
  assert.equal(updated.profile.apiKey, 'sk-secret');

  await assert.rejects(() => store.saveApiProfile({
    name: '陈旧新增', baseUrl: 'https://two.example/v1', apiKey: 'sk-two',
    models: ['m'], selectedModel: 'm', note: '',
  }, { expectedRevision: library.revision }), /API_PROFILES_CONFLICT/);
  const latest = await store.readApiProfiles();
  await assert.rejects(() => store.saveApiProfile({
    id: created.profile.id, name: '危险换址', baseUrl: 'https://other.example/v1',
    apiKey: 'sk-****', models: ['m1'], selectedModel: 'm1', note: '',
  }, { expectedRevision: latest.revision }), /API_KEY_REQUIRED_FOR_BASE_URL_CHANGE/);
});

test('旧页面不能激活另一页已替换的方案连接', async () => {
  let library = await store.readApiProfiles();
  const created = await store.saveApiProfile({
    name: '可更新服务', baseUrl: 'https://old.example/v1', apiKey: 'sk-old',
    models: ['same-model'], selectedModel: 'same-model', note: '',
  }, { expectedRevision: library.revision });
  const staleProfilesRevision = created.revision;
  const config = await store.readConfig();
  library = await store.readApiProfiles();
  await store.saveApiProfile({
    id: created.profile.id, name: '可更新服务',
    baseUrl: 'https://new.example/v1', apiKey: 'sk-new',
    models: ['same-model'], selectedModel: 'same-model', note: '',
  }, { expectedRevision: library.revision });

  await assert.rejects(() => store.activateApiProfile(
    created.profile.id, 'same-model', {
      expectedProfilesRevision: staleProfilesRevision,
      expectedConfigRevision: store.configRevision(config),
    },
  ), /API_PROFILES_CONFLICT/);
  assert.equal((await store.readConfig()).baseUrl, config.baseUrl);
});

test('方案接口只返回掩码密钥，激活时不会静默选择其它模型', async () => {
  const app = createApp();
  const started = await startTestServer(app);
  try {
    const configResponse = await fetch(`${started.base}/api/config`);
    const config = await configResponse.json();
    const emptyResponse = await fetch(`${started.base}/api/config/profiles`);
    const empty = await emptyResponse.json();
    const createResponse = await fetch(`${started.base}/api/config/profiles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: empty.revision,
        name: 'HTTP 服务', baseUrl: 'https://http.example/v1', apiKey: 'sk-http',
        models: ['fast', 'smart'], selectedModel: 'fast', note: '测试',
      }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();
    assert.equal(created.profile.apiKey, 'sk-****');

    const badActivation = await fetch(
      `${started.base}/api/config/profiles/${created.profile.id}/activate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'not-listed', expectedProfilesRevision: created.revision,
          expectedConfigRevision: config.revision,
        }),
      },
    );
    assert.equal(badActivation.status, 400);
    assert.deepEqual(await badActivation.json(), { error: 'BAD_API_PROFILE_MODEL' });

    const activatedResponse = await fetch(
      `${started.base}/api/config/profiles/${created.profile.id}/activate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'smart', expectedProfilesRevision: created.revision,
          expectedConfigRevision: config.revision,
        }),
      },
    );
    assert.equal(activatedResponse.status, 200);
    const activated = await activatedResponse.json();
    assert.equal(activated.config.model, 'smart');
    assert.equal(activated.config.apiKey, 'sk-****');
    assert.equal(activated.library.profiles[0].apiKey, 'sk-****');
  } finally {
    await stopTestServer(started.server);
  }
});

test('当前配置和已保存方案都可安全发现模型', async () => {
  await store.writeConfig({
    baseUrl: 'https://current.example/v1', model: 'current-model', apiKey: 'sk-current',
  });
  const empty = await store.readApiProfiles();
  const saved = await store.saveApiProfile({
    name: '可探测方案', baseUrl: 'https://profile.example/v1', apiKey: 'sk-profile',
    models: ['profile-model'], selectedModel: 'profile-model', note: '',
  }, { expectedRevision: empty.revision });
  const realFetch = globalThis.fetch;
  const seen = [];
  const started = await startTestServer(createApp());
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://current.example/v1/models') {
      seen.push([url, init?.headers?.Authorization]);
      return new Response(JSON.stringify({
        data: [{ id: 'current-model' }, { id: 'current-reasoning' }],
      }), { status: 200 });
    }
    if (url === 'https://profile.example/v1/models') {
      seen.push([url, init?.headers?.Authorization]);
      return new Response(JSON.stringify({
        data: [{ id: 'profile-model' }, { id: 'profile-fast' }],
      }), { status: 200 });
    }
    return realFetch(input, init);
  };
  try {
    const config = await realFetch(`${started.base}/api/config`).then((response) => response.json());
    const currentResponse = await realFetch(`${started.base}/api/config/models`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'current', expectedConfigRevision: config.revision,
      }),
    });
    assert.equal(currentResponse.status, 200);
    assert.deepEqual(await currentResponse.json(), {
      ok: true,
      models: ['current-model', 'current-reasoning'],
      truncated: false,
      currentModel: 'current-model',
      currentModelAvailable: true,
    });

    const profileResponse = await realFetch(`${started.base}/api/config/models`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'profile', profileId: saved.profile.id,
        expectedProfilesRevision: saved.revision,
      }),
    });
    assert.equal(profileResponse.status, 200);
    assert.deepEqual(await profileResponse.json(), {
      ok: true,
      models: ['profile-model', 'profile-fast'],
      truncated: false,
      currentModel: 'profile-model',
      currentModelAvailable: true,
    });
    assert.deepEqual(seen, [
      ['https://current.example/v1/models', 'Bearer sk-current'],
      ['https://profile.example/v1/models', 'Bearer sk-profile'],
    ]);
  } finally {
    globalThis.fetch = realFetch;
    await stopTestServer(started.server);
  }
});

test('正文、大纲、摘要、审稿和标题可显式分配模型', async () => {
  await store.writeConfig({
    baseUrl: 'https://default.example/v1', model: 'default-model', apiKey: 'sk-default',
    chapterWordTarget: 3456, requestTimeoutMs: 123456,
  });
  let library = await store.readApiProfiles();
  const saved = await store.saveApiProfile({
    name: '分工服务', baseUrl: 'https://roles.example/v1', apiKey: 'sk-roles',
    models: ['writer', 'summarizer', 'reviewer', 'namer'],
    selectedModel: 'writer', note: '',
  }, { expectedRevision: library.revision });
  library = await store.readApiProfiles();
  const routed = await store.saveApiTaskRoutes({
    chapter: { profileId: saved.profile.id, model: 'writer' },
    outline: null,
    digest: { profileId: saved.profile.id, model: 'summarizer' },
    review: { profileId: saved.profile.id, model: 'reviewer' },
    title: { profileId: saved.profile.id, model: 'namer' },
  }, { expectedRevision: library.revision });

  const fixedBook = await store.createBook({ premise: '单书固定模型' });
  const bound = await store.saveApiBookBinding(fixedBook.id, {
    profileId: saved.profile.id, model: 'reviewer',
  }, { expectedRevision: routed.revision });

  const chapterConfig = await store.readConfigForTask('chapter');
  assert.equal(chapterConfig.baseUrl, 'https://roles.example/v1');
  assert.equal(chapterConfig.apiKey, 'sk-roles');
  assert.equal(chapterConfig.model, 'writer');
  assert.equal(chapterConfig.chapterWordTarget, 3456);
  assert.equal(chapterConfig.requestTimeoutMs, 123456);
  assert.equal((await store.readConfigForTask('outline')).model, 'default-model');
  assert.equal((await store.readConfigForTask('digest')).model, 'summarizer');
  assert.equal((await store.readConfigForTask('review')).model, 'reviewer');
  assert.equal((await store.readConfigForTask('title')).model, 'namer');
  for (const task of ['chapter', 'outline', 'digest', 'review', 'title']) {
    assert.equal(
      (await store.readConfigForTask(task, { bookId: fixedBook.id })).model,
      'reviewer',
    );
  }

  await assert.rejects(() => store.saveApiTaskRoutes({
    ...routed.taskRoutes,
    title: { profileId: saved.profile.id, model: 'not-listed' },
  }, { expectedRevision: bound.revision }), /BAD_API_TASK_ROUTES/);

  const edited = await store.saveApiProfile({
    id: saved.profile.id, name: '分工服务', note: '',
    baseUrl: saved.profile.baseUrl, apiKey: 'sk-****',
    models: ['writer', 'reviewer', 'namer'], selectedModel: 'writer',
  }, { expectedRevision: bound.revision });
  const afterEdit = await store.readApiProfiles();
  assert.equal(afterEdit.taskRoutes.digest, null);
  assert.equal(edited.profile.apiKey, 'sk-roles');
  assert.equal(afterEdit.taskRoutes.chapter.model, 'writer');
  assert.equal(afterEdit.bookBindings[0].model, 'reviewer');

  await store.saveApiProfile({
    id: saved.profile.id, name: '分工服务', note: '',
    baseUrl: saved.profile.baseUrl, apiKey: 'sk-****',
    models: ['writer', 'namer'], selectedModel: 'writer',
  }, { expectedRevision: afterEdit.revision });
  const afterBoundModelRemoval = await store.readApiProfiles();
  assert.deepEqual(afterBoundModelRemoval.bookBindings, []);

  await store.deleteApiProfile(saved.profile.id, {
    expectedRevision: afterBoundModelRemoval.revision,
  });
  assert.deepEqual((await store.readApiProfiles()).taskRoutes, {
    chapter: null, outline: null, digest: null, review: null, title: null,
  });
});

test('模型分工接口只接受当前方案库中的模型', async () => {
  const empty = await store.readApiProfiles();
  const saved = await store.saveApiProfile({
    name: 'HTTP 分工', baseUrl: 'https://roles-http.example/v1', apiKey: 'sk-http-role',
    models: ['writer'], selectedModel: 'writer', note: '',
  }, { expectedRevision: empty.revision });
  const started = await startTestServer(createApp());
  try {
    const response = await fetch(`${started.base}/api/config/profiles/routing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: saved.revision,
        taskRoutes: {
          chapter: { profileId: saved.profile.id, model: 'writer' },
          outline: null, digest: null, review: null, title: null,
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.taskRoutes.chapter, {
      profileId: saved.profile.id, model: 'writer',
    });
    assert.equal(body.profiles[0].apiKey, 'sk-****');

    const book = await store.createBook({ premise: 'HTTP 单书绑定' });
    const bindingResponse = await fetch(
      `${started.base}/api/config/profiles/books/${book.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: body.revision,
          binding: { profileId: saved.profile.id, model: 'writer' },
        }),
      },
    );
    assert.equal(bindingResponse.status, 200);
    const bound = await bindingResponse.json();
    assert.deepEqual(bound.bookBindings, [{
      bookId: book.id, profileId: saved.profile.id, model: 'writer',
    }]);
    assert.equal(bound.profiles[0].apiKey, 'sk-****');

    const missingResponse = await fetch(
      `${started.base}/api/config/profiles/books/book_missing`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: bound.revision,
          binding: { profileId: saved.profile.id, model: 'writer' },
        }),
      },
    );
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), { error: 'BOOK_NOT_FOUND' });
  } finally {
    await stopTestServer(started.server);
  }
});

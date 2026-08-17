import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApiProfileStore } from '../store/api-profiles.js';
import { createConfigStore } from '../store/config.js';
import { createStoreContext } from '../store/context.js';
import { createWritingAssetStore } from '../store/writing-assets.js';

function fakeStoreContext() {
  const rootA = join(process.cwd(), 'data-a');
  const rootB = join(process.cwd(), 'data-b');
  let root = rootA;
  const files = new Map();
  const context = createStoreContext({
    getDataRoot: () => root,
    ensureDirectory: async () => {},
    readStoredJson: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return structuredClone(files.get(path));
    },
    atomicWriteJson: async (path, value) => { files.set(path, structuredClone(value)); },
    withStoreLock: async (key, task) => task(),
    throwIfAborted: (signal) => {
      if (signal?.aborted) throw signal.reason instanceof Error
        ? signal.reason : new Error('CLIENT_ABORTED');
    },
    safeId: (id) => {
      if (typeof id !== 'string' || !/^[\w-]+$/u.test(id)) throw new Error('BAD_ID');
      return id;
    },
    readBook: async (id) => {
      if (id === 'book_missing') throw new Error('BOOK_NOT_FOUND');
      return { id };
    },
  });
  return {
    context,
    files,
    rootA,
    rootB,
    setRoot(value) { root = value; },
  };
}

test('StoreContext 每次解析路径都读取最新数据根且拒绝缺失依赖', () => {
  const target = fakeStoreContext();
  assert.equal(target.context.resolvePath('config.json'), join(target.rootA, 'config.json'));
  target.setRoot(target.rootB);
  assert.equal(target.context.resolvePath('config.json'), join(target.rootB, 'config.json'));
  assert.equal(Object.isFrozen(target.context), true);
  assert.throws(() => createStoreContext({}), /STORE_CONTEXT_GETDATAROOT_REQUIRED/);
});

test('配置子模块通过 StoreContext 隔离不同数据根', async () => {
  const target = fakeStoreContext();
  const configStore = createConfigStore(target.context);
  await configStore.writeConfig({ model: 'model-a', apiKey: 'sk-a' });
  assert.equal((await configStore.readConfig()).model, 'model-a');

  target.setRoot(target.rootB);
  assert.equal((await configStore.readConfig()).model, '');
  await configStore.writeConfig({ model: 'model-b', apiKey: 'sk-b' });

  assert.equal(target.files.get(join(target.rootA, 'config.json')).model, 'model-a');
  assert.equal(target.files.get(join(target.rootB, 'config.json')).model, 'model-b');
});

test('API 方案子模块直接复用配置 StoreContext 且不缓存旧根目录', async () => {
  const target = fakeStoreContext();
  const configStore = createConfigStore(target.context);
  const profiles = createApiProfileStore(target.context, configStore);
  const empty = await profiles.readApiProfiles();
  const saved = await profiles.saveApiProfile({
    name: '方案 A', note: '', baseUrl: 'https://a.example/v1', apiKey: 'sk-a',
    models: ['model-a'], selectedModel: 'model-a',
  }, { expectedRevision: empty.revision });
  assert.equal(saved.profile.baseUrl, 'https://a.example/v1');
  assert.equal((await profiles.readApiProfiles()).profiles.length, 1);

  target.setRoot(target.rootB);
  assert.equal((await profiles.readApiProfiles()).profiles.length, 0);
  assert.ok(target.files.has(join(target.rootA, 'api-profiles.json')));
  assert.equal(target.files.has(join(target.rootB, 'api-profiles.json')), false);
});

test('创作资产子模块直接复用 StoreContext，切换数据根后不会读写旧资产库', async () => {
  const target = fakeStoreContext();
  const assets = createWritingAssetStore(target.context);
  const created = await assets.addWritingAssetReference({
    name: '参考页面', sourceName: '公开索引', sourceKind: 'link-only',
    referenceUrl: 'https://example.com/reference',
  });
  assert.match(created.revision, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await assets.readWritingAssets()).assets.length, 1);

  target.setRoot(target.rootB);
  assert.equal((await assets.readWritingAssets()).assets.length, 0);
  const second = await assets.addWritingAssetReference({
    name: '另一页面', sourceName: '第二索引', sourceKind: 'link-only',
    referenceUrl: 'https://example.com/second',
  });
  assert.notEqual(second.asset.id, created.asset.id);

  const rootAAssets = target.files.get(join(target.rootA, 'writing-assets.json'));
  const rootBAssets = target.files.get(join(target.rootB, 'writing-assets.json'));
  assert.deepEqual(rootAAssets.assets.map((asset) => asset.name), ['参考页面']);
  assert.deepEqual(rootBAssets.assets.map((asset) => asset.name), ['另一页面']);
});

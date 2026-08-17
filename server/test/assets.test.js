import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import * as store from '../store.js';
import { mountAssetRoutes } from '../routes/assets.js';
import {
  MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS, MAX_WRITING_ASSET_SOURCE_CHARS,
} from '../limits.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-assets-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

const validAnalysis = {
  style: {
    summary: '克制、紧凑的第三人称叙事',
    narrative: '有限视角，贴近主角即时感受',
    sentenceRhythm: '行动段短句，缓冲段适度拉长',
    vocabulary: '具体、少形容词',
    dialogue: '对话有即时目的和潜台词',
    description: '只保留影响行动的环境细节',
    emotion: '用动作和选择外化情绪',
    conflictAndPayoff: '先压迫再通过选择兑现',
    chapterHooks: '以未完成行动或新信息收尾',
    prompt: '采用贴近主角的第三人称有限视角，以具体动作推进剧情。',
    avoid: ['空泛总结', '密集排比'],
  },
  story: {
    summary: '主角在持续升级的外部压力下争取主动权',
    evidenceLevel: 'medium',
    premisePattern: '异常处境迫使普通人行动',
    protagonistDrive: '保护重要关系并查清真相',
    conflictEngine: '信息差与资源差持续制造选择',
    escalation: '个人危机逐步牵出更大势力',
    arcStructure: '受压、反查、局部反制',
    chapterPattern: '目标、阻碍、选择、后果',
    payoffPattern: '通过前置铺垫后的能力或信息兑现',
    hookPattern: '新线索改变下一步目标',
    reusableTechniques: ['让线索同时带来机会与风险'],
    uncertainties: ['单个片段不足以确认全书终局'],
  },
};

async function withServer(nonStreamChat, fn) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mountAssetRoutes(app, { nonStreamChat });
  const started = await startTestServer(app);
  try { await fn(started.base); } finally { await stopTestServer(started.server); }
}

function extractRequest(base, overrides = {}) {
  return fetch(`${base}/api/writing-assets/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '冷硬推进', sourceName: '自有第一章', sourceKind: 'self',
      sourceText: '主角推门而入。局势随即改变。', ...overrides,
    }),
  });
}

test('提取、读取和删除创作资产形成完整闭环', async () => {
  let sentSystem = '';
  let sentInstruction = '';
  await withServer(async ({ system, messages }) => {
    sentSystem = system;
    sentInstruction = messages[0].content;
    return JSON.stringify(validAnalysis);
  }, async (base) => {
    const empty = await (await fetch(`${base}/api/writing-assets`)).json();
    assert.deepEqual(empty.assets, []);
    assert.match(empty.revision, /^[A-Za-z0-9_-]{43}$/);

    const sourceText = `${'片段内容。'.repeat(500)}仅存在于末尾的标记`;
    const createdResponse = await extractRequest(base, { sourceText });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    assert.equal(created.asset.name, '冷硬推进');
    assert.equal(created.asset.source.length, sourceText.length);
    assert.deepEqual(created.asset.source.genres, []);
    assert.equal(created.asset.source.rightsNote, '');
    assert.ok(created.asset.source.preview.length <= 2000);
    assert.equal(created.asset.style.prompt, validAnalysis.style.prompt);
    assert.match(sentSystem, /不是续写或仿写/);
    assert.match(sentInstruction, /【创作样本】/);
    assert.match(sentInstruction, /仅存在于末尾的标记/);

    const storedPath = join(root, 'writing-assets.json');
    const stored = readFileSync(storedPath, 'utf8');
    assert.doesNotMatch(stored, /仅存在于末尾的标记/);
    assert.equal(statSync(storedPath).mode & 0o777, 0o600);

    const listed = await (await fetch(`${base}/api/writing-assets`)).json();
    assert.equal(listed.assets.length, 1);
    assert.equal(listed.assets[0].id, created.asset.id);

    const staleDelete = await fetch(`${base}/api/writing-assets/${created.asset.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: empty.revision }),
    });
    assert.equal(staleDelete.status, 409);
    assert.equal((await staleDelete.json()).error, 'ASSET_CONFLICT');

    const deleted = await fetch(`${base}/api/writing-assets/${created.asset.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: listed.revision }),
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).ok, true);
    assert.deepEqual((await (await fetch(`${base}/api/writing-assets`)).json()).assets, []);
  });
});

test('资产保存来源元数据，并在调用模型前拒绝重复样本和缺失权利说明', async () => {
  let calls = 0;
  await withServer(async () => { calls += 1; return JSON.stringify(validAnalysis); }, async (base) => {
    const sourceText = '独一无二的样本文本，用于验证内容指纹去重。';
    const first = await extractRequest(base, {
      sourceKind: 'authorized', sourceText,
      workNote: '《测试旧作》第三章', rightsNote: '已取得书面分析授权',
      genres: ['悬疑', '都市'], sceneTags: ['对话', '追逐'],
      referenceUrl: 'https://example.com/work/chapter-3',
    });
    assert.equal(first.status, 200);
    const created = await first.json();
    assert.equal(created.asset.source.workNote, '《测试旧作》第三章');
    assert.equal(created.asset.source.rightsNote, '已取得书面分析授权');
    assert.deepEqual(created.asset.source.genres, ['悬疑', '都市']);
    assert.deepEqual(created.asset.source.sceneTags, ['对话', '追逐']);
    assert.equal(created.asset.source.referenceUrl, 'https://example.com/work/chapter-3');

    const duplicate = await extractRequest(base, { sourceText });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, 'ASSET_DUPLICATE');

    const missingRights = await extractRequest(base, {
      sourceKind: 'excerpt', sourceText: '另一份外部短摘录', rightsNote: '',
    });
    assert.equal(missingRights.status, 400);
    assert.equal((await missingRights.json()).error, 'BAD_ASSET_RIGHTS_NOTE');
    assert.equal(calls, 1);
  });
});

test('仅链接记录不调用模型，可导出且按规范化链接去重', async () => {
  let calls = 0;
  await withServer(async () => { calls += 1; return JSON.stringify(validAnalysis); }, async (base) => {
    const response = await fetch(`${base}/api/writing-assets/reference`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '节奏参考页', sourceName: '公开网页索引', sourceKind: 'link-only',
        referenceUrl: 'https://example.com/reference', workNote: '只登记地址',
        genres: ['仙侠'], sceneTags: ['高潮'],
      }),
    });
    assert.equal(response.status, 200);
    const created = await response.json();
    assert.equal(created.asset.source.kind, 'link-only');
    assert.equal(created.asset.source.length, 0);
    assert.equal(created.asset.source.preview, '');
    assert.equal(created.asset.style, null);
    assert.equal(created.asset.story, null);
    assert.equal(calls, 0);

    const duplicate = await fetch(`${base}/api/writing-assets/reference`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '重复链接', sourceName: '同一网页', sourceKind: 'link-only',
        referenceUrl: 'https://example.com/reference',
      }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, 'ASSET_DUPLICATE');

    const exported = await fetch(`${base}/api/writing-assets/export`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition') ?? '', /attachment/);
    const payload = await exported.json();
    assert.equal(payload.format, 'auto-novel-box-writing-assets');
    assert.equal(payload.assets.length, 1);
    assert.equal(payload.assets[0].source.referenceUrl, 'https://example.com/reference');
  });
});

test('旧版资产文件读取时补齐新增元数据而不破坏既有分析', async () => {
  const sourceText = '旧版样本';
  const legacy = {
    version: 1,
    assets: [{
      id: `asset_${'a'.repeat(32)}`,
      name: '旧资产',
      createdAt: '2026-08-01T00:00:00.000Z',
      source: {
        kind: 'self', name: '旧来源', length: sourceText.length,
        fingerprint: 'A'.repeat(43), preview: sourceText,
      },
      ...validAnalysis,
    }],
  };
  writeFileSync(join(root, 'writing-assets.json'), JSON.stringify(legacy));
  const listed = await store.readWritingAssets();
  assert.equal(listed.assets[0].style.prompt, validAnalysis.style.prompt);
  assert.equal(listed.assets[0].source.workNote, '');
  assert.equal(listed.assets[0].source.referenceUrl, '');
  assert.deepEqual(listed.assets[0].source.sceneTags, []);
});

test('单书主辅与章节场景绑定只把抽象卡片送入上下文，删除资产会清理引用', async () => {
  const bookId = `book_${'b'.repeat(32)}`;
  await store.createBook({ premise: '资产绑定测试', requestedBookId: bookId });
  const section = await store.addSection(bookId, {});
  const chapter = await store.addChapter(bookId, section.id, {});
  const created = await store.addWritingAsset({
    name: '不可发送的资产名称', sourceName: '不可发送的作品与作者信息',
    sourceKind: 'own-previous', sourceText: '仅用于生成内容指纹的本人旧作片段。',
    workNote: '不可发送的章节备注', rightsNote: '本人拥有权利',
    genres: ['悬疑'], sceneTags: ['对话'], referenceUrl: 'https://example.com/private-source',
    analysis: validAnalysis,
  });
  const initial = await store.readWritingAssets();
  const chapterId = chapter.id;
  const saved = await store.saveWritingAssetBookBinding(bookId, {
    primaryAssetId: created.asset.id,
    auxiliaryAssetIds: [],
    sceneAssetIds: { dialogue: created.asset.id },
    chapterScenes: { [chapterId]: 'dialogue' },
  }, { expectedRevision: initial.revision });
  assert.equal(saved.binding.primaryAssetId, created.asset.id);

  const context = await store.readWritingAssetContext(bookId, chapterId);
  assert.equal(context.scene, 'dialogue');
  assert.deepEqual(context.assetIds, [created.asset.id]);
  assert.match(context.revision, /^[A-Za-z0-9_-]{43}$/);
  assert.match(context.text, /贴近主角的第三人称有限视角/);
  assert.match(context.text, /让线索同时带来机会与风险/);
  assert.doesNotMatch(context.text, /不可发送的资产名称/);
  assert.doesNotMatch(context.text, /不可发送的作品与作者信息/);
  assert.doesNotMatch(context.text, /private-source/);
  const stableContext = await store.readWritingAssetContext(bookId, chapterId);
  assert.equal(stableContext.revision, context.revision);

  const generationSnapshot = await store.readChapterGenerationContext(
    bookId, section.id, chapterId,
  );
  await assert.rejects(store.saveWritingAssetBookBinding(bookId, saved.binding, {
    expectedRevision: initial.revision,
  }), /ASSET_CONFLICT/);
  const changed = await store.saveWritingAssetBookBinding(bookId, {
    ...saved.binding, primaryAssetId: null, auxiliaryAssetIds: [created.asset.id],
  }, { expectedRevision: saved.revision });
  await assert.rejects(store.commitGeneratedChapter(
    bookId, section.id, chapterId, '不应落盘的旧文风正文', {
      expectedRevision: generationSnapshot.targetRevision,
      expectedContextRevision: generationSnapshot.contextRevision,
      expectedPreviousChapterId: generationSnapshot.previousChapterId,
      expectedPreviousChapterSectionId: generationSnapshot.previousChapterSectionId,
    },
  ), /GENERATION_CONTEXT_CONFLICT/);
  await store.deleteWritingAsset(created.asset.id, { expectedRevision: changed.revision });
  const afterDelete = await store.readWritingAssets();
  assert.equal(afterDelete.bookBindings[bookId].primaryAssetId, null);
  assert.deepEqual(afterDelete.bookBindings[bookId].sceneAssetIds, {});
  assert.equal((await store.readWritingAssetContext(bookId, chapterId)).text, '');
  assert.equal((await store.readWritingAssetContext(bookId, chapterId)).revision, '');
});

test('本书原生文风只能从已发布正文提取并以更高优先级绑定', async () => {
  const book = await store.createBook({ premise: '原生文风测试' });
  const section = await store.addSection(book.id, {});
  const chapter = await store.addChapter(book.id, section.id, { title: '落雨' });
  const path = `section:${section.id}:chapter:${chapter.id}`;
  await store.versionSet(book.id, path, '这是作者已经确认发布的本书正文。');
  const current = await store.readChapter(book.id, section.id, chapter.id);
  const currentBook = await store.readBook(book.id);
  await store.publishChapterVersion(book.id, section.id, chapter.id, {
    expectedBodyFingerprint: current.bodyFingerprint,
    expectedMemoryRevision: store.bookMemoryRevision(currentBook),
  });

  let sentInstruction = '';
  await withServer(async ({ messages }) => {
    sentInstruction = messages[0].content;
    return JSON.stringify(validAnalysis);
  }, async (base) => {
    const response = await fetch(
      `${base}/api/writing-assets/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/native`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '本书原生·落雨' }),
      },
    );
    assert.equal(response.status, 200);
    const created = await response.json();
    assert.equal(created.asset.source.kind, 'book-native');
    assert.equal(created.asset.source.bookId, book.id);
    assert.equal(created.asset.source.sectionId, section.id);
    assert.equal(created.asset.source.chapterId, chapter.id);
    assert.match(sentInstruction, /作者已经确认发布的本书正文/);

    const listed = await store.readWritingAssets();
    const bound = await store.saveWritingAssetBookBinding(book.id, {
      nativeAssetId: created.asset.id,
      primaryAssetId: null,
      auxiliaryAssetIds: [],
      sceneAssetIds: {},
      chapterScenes: {},
    }, { expectedRevision: listed.revision });
    assert.equal(bound.binding.nativeAssetId, created.asset.id);
    assert.match((await store.readWritingAssetContext(book.id, chapter.id)).text,
      /本书原生文风（最高优先级）/);

    const unpublished = await store.addChapter(book.id, section.id, {});
    const rejected = await fetch(
      `${base}/api/writing-assets/books/${book.id}/sections/${section.id}/chapters/${unpublished.id}/native`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '不应创建' }),
      },
    );
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, 'ASSET_NATIVE_SOURCE_UNPUBLISHED');
  });
});

test('超长和非法来源在调用模型前被拒绝', async () => {
  let calls = 0;
  await withServer(async () => { calls += 1; return JSON.stringify(validAnalysis); }, async (base) => {
    const oversized = await extractRequest(base, {
      sourceText: 'x'.repeat(MAX_WRITING_ASSET_SOURCE_CHARS + 1),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error, 'ASSET_SOURCE_TOO_LARGE');

    const badKind = await extractRequest(base, { sourceKind: 'scraped' });
    assert.equal(badKind.status, 400);
    assert.equal((await badKind.json()).error, 'BAD_ASSET_SOURCE_KIND');
    const forgedNative = await extractRequest(base, { sourceKind: 'book-native' });
    assert.equal(forgedNative.status, 400);
    assert.equal((await forgedNative.json()).error, 'BAD_ASSET_SOURCE_KIND');
    const longExcerpt = await extractRequest(base, {
      sourceKind: 'excerpt', rightsNote: '仅作短样本分析',
      sourceText: '摘'.repeat(MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS + 1),
    });
    assert.equal(longExcerpt.status, 413);
    assert.equal((await longExcerpt.json()).error, 'ASSET_EXCERPT_TOO_LARGE');
    assert.equal(calls, 0);
    assert.equal(existsSync(join(root, 'writing-assets.json')), false);
  });
});

test('模型返回不完整结构时不创建资产', async () => {
  await withServer(async () => '{"style":{"summary":"只有一半"}}', async (base) => {
    const response = await extractRequest(base);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, 'ASSET_EXTRACTION_FAILED');
    assert.equal(existsSync(join(root, 'writing-assets.json')), false);
  });
});

test('删除接口校验资产 ID 与修订号', async () => {
  await withServer(async () => JSON.stringify(validAnalysis), async (base) => {
    const badId = await fetch(`${base}/api/writing-assets/..%2Fescape`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 'x'.repeat(43) }),
    });
    assert.equal(badId.status, 400);
    assert.equal((await badId.json()).error, 'BAD_ASSET_ID');

    const badRevision = await fetch(`${base}/api/writing-assets/asset_${'a'.repeat(32)}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 'bad' }),
    });
    assert.equal(badRevision.status, 400);
    assert.equal((await badRevision.json()).error, 'BAD_ASSET_REVISION');
  });
});

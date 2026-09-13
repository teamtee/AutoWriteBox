import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as store from '../store.js';
import { mountAiFillRoutes } from '../routes/ai-fill.js';
import { storyEngineRevision } from '../story-engine-schema.js';
import { MAX_TOTAL_BOOK_CHAPTERS } from '../limits.js';
import {
  extractStoryEngineDraft, extractCharacterCraftDraft, extractPromiseLedgerDraft,
} from '../ai-fill-extract.js';
import {
  buildStoryEngineDraftInstruction, buildCharacterCraftDraftInstruction,
  buildPromiseLedgerDraftInstruction,
} from '../ai-fill-prompts.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';
import { startTestServer, stopTestServer } from './http-test-server.js';

const engineDraft = {
  readerExperience: '看绝境里一粒火种如何改写规则',
  protagonistAction: '在有限资源下观察、推演并选择是否干预',
  progression: '每次干预换来可见权限或认知',
  cost: '现实按同比例反噬',
  escalation: '从聚落规则升到跨城制度',
};

let root;
beforeEach(async () => {
  root = makeTestTempDir('novelbox-ai-fill-');
  store.setDataRoot(root);
  await store.writeConfig({
    baseUrl: 'https://model.test/v1', model: 'fill-model', apiKey: 'test-key',
  });
});
afterEach(cleanupTestTempDirs);

function appWithChat(nonStreamChat) {
  const app = express();
  app.use(express.json());
  mountAiFillRoutes(app, { nonStreamChat });
  return app;
}

test('提取函数要求完整字段并截断过长文本', () => {
  const parsed = extractStoryEngineDraft(`说明\n${JSON.stringify(engineDraft)}`);
  assert.deepEqual(parsed, engineDraft);
  assert.equal(extractStoryEngineDraft(JSON.stringify({
    ...engineDraft, cost: '',
  })), null);

  const craft = extractCharacterCraftDraft(JSON.stringify({
    characters: [{
      name: '沈砚', importance: 5, currentDesire: '拿回密信',
      fear: '旧罪曝光', secret: '调换证物', pressureResponse: '先冷后担险',
      speechPattern: '短句', speechAvoid: '大道理',
    }, { name: '沈砚', currentDesire: '重复' }],
    relationships: [{
      from: '沈砚', to: '沈青', importance: 4, temperature: 1,
      surfaceState: '互相讥讽', privateTension: '保护被当成不信任',
      desiredDirection: '对质后决定去留',
    }, { from: '路人', to: '沈砚', surfaceState: '路过' }],
  }), { asOfChapter: 3 });
  assert.equal(craft.characters.length, 1);
  assert.equal(craft.characters[0].asOfChapter, 3);
  assert.equal(craft.relationships.length, 0);

  const promises = extractPromiseLedgerDraft(JSON.stringify({
    entries: [{
      kind: 'mystery', importance: 5, promise: '查清灭门真相',
      expectedStartChapter: 2, expectedEndChapter: 1, notes: '不能用失忆',
    }],
  }), { startChapter: 4 });
  assert.equal(promises[0].expectedStartChapter, 4);
  assert.equal(promises[0].expectedEndChapter, 4);

  const capped = extractPromiseLedgerDraft(JSON.stringify({
    entries: [{
      kind: 'world', importance: 3, promise: '终局边界',
      expectedStartChapter: MAX_TOTAL_BOOK_CHAPTERS,
      expectedEndChapter: MAX_TOTAL_BOOK_CHAPTERS + 10,
    }],
  }), { startChapter: MAX_TOTAL_BOOK_CHAPTERS + 1 });
  assert.equal(capped[0].expectedStartChapter, MAX_TOTAL_BOOK_CHAPTERS);
  assert.equal(capped[0].expectedEndChapter, MAX_TOTAL_BOOK_CHAPTERS);
  assert.equal(extractPromiseLedgerDraft(JSON.stringify({ entries: [] })), null);
});

test('一键填充的最坏材料窗口仍可放入最小登记模型上下文', () => {
  const text = (length) => '字'.repeat(length);
  const materials = {
    premise: text(20_000), outline: text(40_000), world: text(20_000),
    style: text(20_000), existingNames: Array.from({ length: 500 }, (_, i) => `人物${i}`),
    storyEngine: Object.fromEntries([
      'readerExperience', 'protagonistAction', 'progression', 'cost', 'escalation',
    ].map((field) => [field, text(500)])),
    startChapter: 1,
  };
  for (const instruction of [
    buildStoryEngineDraftInstruction(materials),
    buildCharacterCraftDraftInstruction(materials),
    buildPromiseLedgerDraftInstruction(materials),
  ]) assert.ok(instruction.length < 16_000);
});

test('核心循环、人物和承诺草稿路由返回待确认结构且不写盘', async () => {
  const book = await store.createBook({ premise: '绝境火种', title: '笼中火种' });
  const craftBefore = await store.readCharacterCraft(book.id);
  const ledgerBefore = await store.readPromiseLedger(book.id);
  const engineRevision = storyEngineRevision(book.settings.storyEngine);
  const app = appWithChat(async ({ messages }) => {
    const content = messages[0].content;
    if (content.includes('人物导演卡')) {
      return JSON.stringify({
        characters: [{
          name: '沈砚', importance: 5, currentDesire: '保住火种',
          fear: '规则反噬', secret: '他见过上一轮文明', pressureResponse: '先算后赌',
          speechPattern: '短句', speechAvoid: '口号',
        }, {
          name: '沈青', importance: 4, currentDesire: '弄清哥哥隐瞒什么',
          fear: '被当成累赘', secret: '', pressureResponse: '追问到底',
          speechPattern: '连珠问句', speechAvoid: '求饶',
        }],
        relationships: [{
          from: '沈砚', to: '沈青', importance: 5, temperature: 2,
          surfaceState: '互相讥讽', privateTension: '保护被当成不信任',
          desiredDirection: '第一次有代价的坦白',
        }],
      });
    }
    if (content.includes('计划向读者建立的承诺')) {
      return JSON.stringify({
        entries: [{
          kind: 'main', importance: 5, promise: '读者要看到火种第一次改写规则',
          expectedStartChapter: 3, expectedEndChapter: 6, notes: '计划中',
        }],
      });
    }
    return JSON.stringify(engineDraft);
  });
  const { base, server } = await startTestServer(app);
  try {
    const engineRes = await fetch(`${base}/api/gen/story-engine-draft`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: book.id, expectedRevision: engineRevision }),
    });
    assert.equal(engineRes.status, 200);
    const engineBody = await engineRes.json();
    assert.equal(engineBody.storyEngine.cost, engineDraft.cost);
    assert.equal(engineBody.baseRevision, engineRevision);

    const craftRes = await fetch(`${base}/api/gen/character-craft-draft`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: book.id, expectedRevision: craftBefore.revision, completedChapterCount: 0,
      }),
    });
    assert.equal(craftRes.status, 200);
    const craftBody = await craftRes.json();
    assert.equal(craftBody.characters[0].name, '沈砚');
    assert.equal(craftBody.relationships[0].from, '沈砚');

    const ledgerRes = await fetch(`${base}/api/gen/promise-ledger-draft`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: book.id, expectedRevision: ledgerBefore.revision, completedChapterCount: 0,
      }),
    });
    assert.equal(ledgerRes.status, 200);
    const ledgerBody = await ledgerRes.json();
    assert.equal(ledgerBody.entries[0].promise.includes('火种'), true);

    const engineAfter = storyEngineRevision(
      (await store.readBook(book.id)).settings.storyEngine,
    );
    assert.equal(engineAfter, engineRevision);
    assert.equal((await store.readCharacterCraft(book.id)).characters.length, 0);
    assert.equal((await store.readPromiseLedger(book.id)).entries.length, 0);
  } finally {
    await stopTestServer(server);
  }
});

test('计划承诺起点由服务端作品结构计算，不信任客户端完成章数', async () => {
  const book = await store.createBook({ premise: '空书的新计划' });
  const ledger = await store.readPromiseLedger(book.id);
  let instruction = '';
  const app = appWithChat(async ({ messages }) => {
    instruction = messages[0].content;
    return JSON.stringify({ entries: [{
      kind: 'main', importance: 3, promise: '第一章建立核心困境',
      expectedStartChapter: 1, expectedEndChapter: 3, notes: '',
    }] });
  });
  const { base, server } = await startTestServer(app);
  try {
    const response = await fetch(`${base}/api/gen/promise-ledger-draft`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId: book.id, expectedRevision: ledger.revision,
        completedChapterCount: 49_999,
      }),
    });
    assert.equal(response.status, 200);
    assert.match(instruction, /expectedStartChapter 不小于 1/u);
    assert.doesNotMatch(instruction, /expectedStartChapter 不小于 50000/u);
  } finally {
    await stopTestServer(server);
  }
});

test('草稿修订冲突时拒绝迟到结果', async () => {
  const book = await store.createBook({ premise: '绝境火种' });
  const app = appWithChat(async () => JSON.stringify(engineDraft));
  const { base, server } = await startTestServer(app);
  try {
    const res = await fetch(`${base}/api/gen/story-engine-draft`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId: book.id, expectedRevision: 'N'.repeat(43) }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'STORY_ENGINE_CONFLICT' });
  } finally {
    await stopTestServer(server);
  }
});

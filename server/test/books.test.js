import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import * as store from '../store.js';
import { mountBookRoutes } from '../routes/books.js';
import { createApp } from '../index.js';
import { MAX_PREMISE_CHARS, MAX_VERSION_TEXT_CHARS } from '../limits.js';
import { WORLD_BIBLE_SECTION_LABELS } from '../world-bible.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let base;
let root;
beforeEach(() => { root = makeTestTempDir('novelbox-'); store.setDataRoot(root); });
afterEach(cleanupTestTempDirs);
async function withServer(fn) {
  const started = await startTestServer(createApp());
  base = started.base;
  try { await fn(); } finally { await stopTestServer(started.server); }
}
const j = (r) => r.json();
const rawPost = (p, b) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(b || {}),
});
const post = async (p, b) => {
  let body = b || {};
  const sectionRoute = p.match(/^\/api\/books\/([^/]+)\/sections$/);
  const chapterRoute = p.match(/^\/api\/books\/([^/]+)\/sections\/([^/]+)\/chapters$/);
  if (sectionRoute
    && !Object.prototype.hasOwnProperty.call(body, 'expectedLastSectionId')) {
    const book = await store.readBook(sectionRoute[1]);
    body = {
      ...body,
      expectedLastSectionId: book.sections.length
        ? book.sections[book.sections.length - 1]
        : null,
    };
  } else if (chapterRoute
    && !Object.prototype.hasOwnProperty.call(body, 'expectedLastChapterId')) {
    const section = await store.readSection(chapterRoute[1], chapterRoute[2]);
    body = {
      ...body,
      expectedLastChapterId: section.chapters.length
        ? section.chapters[section.chapters.length - 1]
        : null,
    };
  }
  const reviewRoute = p.match(
    /^\/api\/books\/([^/]+)\/sections\/([^/]+)\/chapters\/([^/]+)\/review$/,
  );
  if (reviewRoute && (!Object.prototype.hasOwnProperty.call(body, 'expectedBodyFingerprint')
    || !Object.prototype.hasOwnProperty.call(body, 'expectedContextRevision'))) {
    const snapshot = await store.readChapterReviewContext(
      reviewRoute[1], reviewRoute[2], reviewRoute[3],
    );
    body = {
      ...body,
      expectedBodyFingerprint: snapshot.chapter.bodyFingerprint,
      expectedContextRevision: snapshot.contextRevision,
    };
  }
  return rawPost(p, body);
};
async function currentVersionRevision(bookId, path) {
  const parsed = store.parseVersionPath(path);
  if (parsed.type === 'chapter') {
    const chapter = await store.readChapter(bookId, parsed.sectionId, parsed.chapterId);
    return store.versionRevision(chapter.body);
  }
  const book = await store.readBook(bookId);
  const versioned = parsed.type === 'outline'
    ? book.outline
    : book.settings.core[parsed.field];
  return store.versionRevision(versioned);
}
async function postVersion(bookId, operation, body, expectedRevision) {
  const revision = expectedRevision ?? await currentVersionRevision(bookId, body.path);
  return post(`/api/books/${bookId}/version/${operation}`, {
    ...body,
    expectedRevision: revision,
  });
}

test('建书→加部→加章→读全树', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: '书' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, { title: '第一部' }));
    const chapter = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, { title: '第一章' }));
    await postVersion(book.id, 'save', {
      path: `section:${s.id}:chapter:${chapter.id}`, text: '正文',
    });
    const tree = await j(await fetch(`${base}/api/books/${book.id}/tree`));
    assert.equal(tree.book.id, book.id);
    assert.equal(tree.sections.length, 1);
    assert.equal(tree.sections[0].chapters.length, 1);
    assert.equal(tree.sections[0].chapters[0].hasContent, true);
    assert.equal(tree.sections[0].chapters[0].characterCount, 2);
    assert.equal(tree.sections[0].chapters[0].publicationStatus, 'unpublished');
    assert.equal(tree.sections[0].chapters[0].body, undefined);
    assert.match(tree.book.outline.revision, /^[A-Za-z0-9_-]{43}$/);
    assert.match(tree.book.settings.core.world.revision, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(tree.book.settings.worldBibleDiagnostics, {
      valid: false, malformed: false, characters: 0, sectionCount: 0,
      missingSections: [...WORLD_BIBLE_SECTION_LABELS],
      thinSections: [], issues: ['too-short', 'missing-sections'],
    });
    assert.match(tree.book.sectionPlanContextRevision, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(tree.book.settings.serialization.dailyWordGoal, 2000);
    assert.match(tree.book.settings.serialization.revision, /^[A-Za-z0-9_-]{43}$/);

    const loadedChapter = await j(await fetch(
      `${base}/api/books/${book.id}/sections/${s.id}/chapters/${chapter.id}`,
    ));
    assert.equal(loadedChapter.body.versions[loadedChapter.body.cursor], '正文');
    assert.match(loadedChapter.body.revision, /^[A-Za-z0-9_-]{43}$/);
  });
});

test('连载设置接口保存每日目标并拒绝旧页面覆盖新版', async () => {
  await withServer(async () => {
    const book = await store.createBook({ premise: '连载目标', title: '目标测试' });
    const tree = await j(await fetch(`${base}/api/books/${book.id}/tree`));
    const initialRevision = tree.book.settings.serialization.revision;
    const savedResponse = await rawPost(`/api/books/${book.id}/serialization/settings`, {
      dailyWordGoal: 6000, expectedRevision: initialRevision,
    });
    assert.equal(savedResponse.status, 200);
    const saved = await j(savedResponse);
    assert.equal(saved.dailyWordGoal, 6000);
    assert.notEqual(saved.revision, initialRevision);

    const conflict = await rawPost(`/api/books/${book.id}/serialization/settings`, {
      dailyWordGoal: 8000, expectedRevision: initialRevision,
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await j(conflict), { error: 'SERIALIZATION_CONFLICT' });

    const invalid = await rawPost(`/api/books/${book.id}/serialization/settings`, {
      dailyWordGoal: 0, expectedRevision: saved.revision,
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await j(invalid), { error: 'BAD_DAILY_WORD_GOAL' });
  });
});

test('平台核对接口保存可追溯证据，删除带修订保护且不存在自动同步路由', async () => {
  await withServer(async () => {
    const book = await store.createBook({ premise: '平台核对', title: '核对接口' });
    const tree = await j(await fetch(`${base}/api/books/${book.id}/tree`));
    assert.deepEqual(tree.book.settings.serialization.platformConfirmations, []);
    assert.equal(tree.book.settings.serialization.syncPolicy.mode, 'manual-only');
    assert.equal(tree.book.settings.serialization.syncPolicy.automaticSyncAvailable, false);

    const saveResponse = await rawPost(`/api/books/${book.id}/platform-confirmations`, {
      platform: '起点读书',
      rulesUrl: 'https://example.test/rules',
      aiPolicyUrl: 'https://example.test/ai-policy',
      contractReference: '已核对当前合同。',
      officialApiStatus: 'not-found', apiDocsUrl: '',
      confirmRules: true, confirmAiPolicy: true, confirmContract: true,
      confirmNoBypass: true,
      expectedRevision: tree.book.settings.serialization.revision,
    });
    assert.equal(saveResponse.status, 200);
    const saved = await j(saveResponse);
    assert.equal(saved.platformConfirmations[0].platform, '起点读书');
    assert.equal(saved.platformConfirmations[0].syncGate.automaticSyncAvailable, false);

    const incomplete = await rawPost(`/api/books/${book.id}/platform-confirmations`, {
      platform: '番茄小说', expectedRevision: saved.revision,
    });
    assert.equal(incomplete.status, 400);
    assert.deepEqual(await j(incomplete), { error: 'BAD_PLATFORM_CONFIRMATION' });

    const absentSync = await rawPost(`/api/books/${book.id}/platform-sync`, {
      chapterId: 'chapter-01',
    });
    assert.equal(absentSync.status, 404);

    const deleted = await fetch(
      `${base}/api/books/${book.id}/platform-confirmations/`
        + saved.platformConfirmations[0].id,
      {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: saved.revision }),
      },
    );
    assert.equal(deleted.status, 200);
    assert.deepEqual((await j(deleted)).platformConfirmations, []);
  });
});

test('章节接口返回记忆候选，并用正文与记忆修订号确认事实', async () => {
  await withServer(async () => {
    const book = await store.createBook({ premise: '记忆接口', title: '接口测试' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});
    await store.versionSet(
      book.id, `section:${section.id}:chapter:${chapter.id}`,
      '林越明确说回溯每天只能使用两次。',
    );
    const body = await store.readChapter(book.id, section.id, chapter.id);
    await store.applyChapterDigest(book.id, section.id, chapter.id, {
      summary: '林越说明能力限制', progress: '继续调查', newCharacters: [],
      memoryCandidates: [{
        kind: 'ability', subject: '林越', predicate: '回溯上限', object: '每天两次',
        evidence: '人物明确说明', importance: 5,
      }],
    }, { expectedBodyFingerprint: body.bodyFingerprint });

    const loaded = await j(await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}`,
    ));
    assert.equal(loaded.memoryCandidates[0].status, 'pending');
    assert.match(loaded.memoryRevision, /^[A-Za-z0-9_-]{43}$/);

    const decisionPath = `/api/books/${book.id}/sections/${section.id}`
      + `/chapters/${chapter.id}/memory-candidates/${loaded.memoryCandidates[0].id}/decision`;
    const acceptedResponse = await rawPost(decisionPath, {
      action: 'accept', expectedBodyFingerprint: loaded.bodyFingerprint,
      expectedMemoryRevision: loaded.memoryRevision,
    });
    assert.equal(acceptedResponse.status, 200);
    const accepted = await j(acceptedResponse);
    assert.deepEqual(accepted.candidates.map((item) => item.status), ['accepted']);
    assert.notEqual(accepted.memoryRevision, loaded.memoryRevision);

    const libraryResponse = await fetch(`${base}/api/books/${book.id}/memory`);
    assert.equal(libraryResponse.status, 200);
    const library = await j(libraryResponse);
    assert.equal(library.facts[0].status, 'active');
    assert.match(library.plotSummary, /林越说明能力限制/);
    assert.equal(library.sectionSummaryCount, 1);
    assert.equal(library.memoryRevision, accepted.memoryRevision);

    const revokedResponse = await rawPost(
      `/api/books/${book.id}/memory-facts/${library.facts[0].id}/deactivate`,
      { expectedMemoryRevision: library.memoryRevision },
    );
    assert.equal(revokedResponse.status, 200);
    const revoked = await j(revokedResponse);
    assert.equal(revoked.fact.status, 'stale');

    const staleResponse = await rawPost(decisionPath, {
      action: 'reject', expectedBodyFingerprint: loaded.bodyFingerprint,
      expectedMemoryRevision: loaded.memoryRevision,
    });
    assert.equal(staleResponse.status, 409);
    assert.deepEqual(await j(staleResponse), { error: 'MEMORY_REVISION_CONFLICT' });
  });
});

test('手工保存正文可显式重算摘要、人物与待确认记忆候选', async () => {
  let receivedPrompt = '';
  await store.writeConfig({
    baseUrl: 'https://model.test/v1', model: 'digest-model', apiKey: 'key',
  });
  await withReviewServer(async () => {
    const book = await store.createBook({ premise: '记忆重算', title: '重算测试' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, { title: '人工章名' });
    await store.versionSet(
      book.id, `section:${section.id}:chapter:${chapter.id}`,
      '林越亲口说，回溯每天只能使用两次。',
    );
    const current = await store.readChapter(book.id, section.id, chapter.id);
    const response = await rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/memory/recompute`,
      { expectedBodyFingerprint: current.bodyFingerprint },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.bodyFingerprint, current.bodyFingerprint);
    assert.equal(result.memoryCandidates.length, 1);
    assert.equal(result.memoryCandidates[0].status, 'pending');
    assert.equal(result.memoryCandidates[0].sourceFingerprint, current.bodyFingerprint);
    assert.match(result.memoryRevision, /^[A-Za-z0-9_-]{43}$/);
    assert.match(receivedPrompt, /当前已保存正文/);
    assert.match(receivedPrompt, /回溯每天只能使用两次/);

    const reloaded = await store.readChapter(book.id, section.id, chapter.id);
    assert.equal(reloaded.summary, '林越说明回溯限制'); assert.equal(reloaded.handoff.resourceState, '回溯当日仍可使用两次');
    assert.equal(reloaded.title, '人工章名');
    assert.equal(reloaded.memoryCandidates[0].id, result.memoryCandidates[0].id);
  }, async ({ messages }) => {
    receivedPrompt = messages?.[0]?.content ?? '';
    return JSON.stringify({
      summary: '林越说明回溯限制', progress: '能力边界已明确',
      chapterTitle: '模型不应改名', sectionTitle: '模型不应改部名',
      handoff: { viewpoint: '林越', time: '当日', location: '室内', ongoingAction: '说明能力限制', immediatePressure: '', characterState: '状态稳定', resourceState: '回溯当日仍可使用两次', knowledgeBoundary: '听者已知两次上限', unresolvedCausality: '' },
      characters: [],
      memoryCandidates: [{
        kind: 'ability', subject: '林越', predicate: '回溯上限', object: '每天两次',
        evidence: '人物亲口说明', importance: 5,
      }],
    });
  });
});

test('记忆重算期间正文变化会丢弃迟到结果', async () => {
  let markStarted;
  let finishModel;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const modelResult = new Promise((resolve) => { finishModel = resolve; });
  await withReviewServer(async () => {
    const book = await store.createBook({ premise: '迟到重算' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});
    const path = `section:${section.id}:chapter:${chapter.id}`;
    await store.versionSet(book.id, path, '旧正文。');
    const current = await store.readChapter(book.id, section.id, chapter.id);
    const request = rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/memory/recompute`,
      { expectedBodyFingerprint: current.bodyFingerprint },
    );
    await started;
    await store.versionSet(book.id, path, '模型等待期间保存的新正文。');
    finishModel(JSON.stringify({ summary: '旧摘要', progress: '旧进度', characters: [], memoryCandidates: [], handoff: { location: '旧地点' } }));
    const response = await request;
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'MEMORY_SOURCE_STALE' });
    const reloaded = await store.readChapter(book.id, section.id, chapter.id);
    assert.equal(reloaded.summary, '');
    assert.deepEqual(reloaded.memoryCandidates, []);
  }, async () => {
    markStarted();
    return modelResult;
  });
});

test('阶段摘要接口用 digest 模型重算草稿，冻结后拒绝自动覆盖', async () => {
  let receivedPrompt = '';
  await store.writeConfig({
    baseUrl: 'https://model.test/v1', model: 'digest-model', apiKey: 'key',
  });
  await withReviewServer(async () => {
    const book = await store.createBook({ premise: '阶段摘要接口', title: '长篇' });
    const section = await store.addSection(book.id, { title: '启程' });
    const chapter = await store.addChapter(book.id, section.id, {});
    await store.versionSet(
      book.id, `section:${section.id}:chapter:${chapter.id}`, '林越离开故乡。',
    );
    const body = await store.readChapter(book.id, section.id, chapter.id);
    await store.applyChapterDigest(book.id, section.id, chapter.id, {
      summary: '林越离开故乡', progress: '前往北境',
      newCharacters: [], memoryCandidates: [],
    }, { expectedBodyFingerprint: body.bodyFingerprint });
    const library = await store.readBookMemory(book.id);
    const id = store.createStageSummaryId();
    const recomputed = await rawPost(`/api/books/${book.id}/stage-summaries/recompute`, {
      id, title: '启程阶段', startSectionId: section.id, endSectionId: section.id,
      expectedStageSummaryRevision: library.stageSummaryRevision,
    });
    assert.equal(recomputed.status, 200);
    const result = await recomputed.json();
    assert.equal(result.item.summary, '林越离乡后决定北上，故乡线暂告一段落。');
    assert.equal(result.item.status, 'draft');
    assert.match(receivedPrompt, /来源分部摘要/);
    assert.match(receivedPrompt, /林越离开故乡/);

    const frozen = await rawPost(`/api/books/${book.id}/stage-summaries/save`, {
      id, title: '启程阶段', startSectionId: section.id, endSectionId: section.id,
      summary: result.item.summary, status: 'frozen',
      expectedStageSummaryRevision: result.stageSummaryRevision,
    });
    assert.equal(frozen.status, 200);
    const frozenResult = await frozen.json();
    const rejected = await rawPost(`/api/books/${book.id}/stage-summaries/recompute`, {
      id, title: '启程阶段', startSectionId: section.id, endSectionId: section.id,
      expectedStageSummaryRevision: frozenResult.stageSummaryRevision,
    });
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), { error: 'STAGE_SUMMARY_FROZEN' });
  }, async ({ messages }) => {
    receivedPrompt = messages?.[0]?.content ?? '';
    return '林越离乡后决定北上，故乡线暂告一段落。';
  });
});

test('章节发布锁接口保存独立正文快照并返回当前版对照状态', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '发布锁', title: '发布测试' }));
    const section = await j(await post(`/api/books/${book.id}/sections`, { title: '第一部' }));
    const chapter = await j(await post(
      `/api/books/${book.id}/sections/${section.id}/chapters`, { title: '第一章' },
    ));
    await postVersion(book.id, 'save', {
      path: `section:${section.id}:chapter:${chapter.id}`, text: '读者已看到的正文',
    });
    let loaded = await j(await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}`,
    ));
    assert.equal(loaded.published, null);
    const locked = await rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/publish`,
      {
        expectedBodyFingerprint: loaded.bodyFingerprint,
        expectedMemoryRevision: loaded.memoryRevision,
      },
    );
    assert.equal(locked.status, 200);
    const lockedBody = await locked.json();
    assert.equal(lockedBody.published.content, '读者已看到的正文');
    assert.equal(lockedBody.published.isCurrent, true);

    await postVersion(book.id, 'save', {
      path: `section:${section.id}:chapter:${chapter.id}`, text: '本地未发布修改',
    });
    loaded = await j(await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}`,
    ));
    assert.equal(loaded.published.content, '读者已看到的正文');
    assert.equal(loaded.published.isCurrent, false);
    assert.equal(loaded.content, '本地未发布修改');

    const preflightResponse = await rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/publication/preflight`,
      { expectedBodyFingerprint: loaded.bodyFingerprint },
    );
    assert.equal(preflightResponse.status, 200);
    const preflight = await preflightResponse.json();
    assert.equal(preflight.bodyFingerprint, loaded.bodyFingerprint);
    assert.equal(preflight.reviewCurrent, false);
    assert.equal(preflight.checks.find((item) => item.id === 'duplicate').status, 'pass');
    assert.equal(preflight.checks.find((item) => item.id === 'platformRules').status, 'manual');

    const badPreflight = await rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/publication/preflight`,
      { expectedBodyFingerprint: 'bad' },
    );
    assert.equal(badPreflight.status, 400);
    assert.deepEqual(await badPreflight.json(), { error: 'BAD_PUBLICATION_ANCHOR' });
  });
});

test('损坏的百分号路由参数返回 400 JSON，不误报服务端故障', async () => {
  await withServer(async () => {
    const response = await fetch(`${base}/api/books/%E0%A4%A/tree`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'BAD_ID' });
  });
});

async function expectAbortedBookRead(path, deps) {
  let markStarted;
  let markAborted;
  const workStarted = new Promise((resolve) => { markStarted = resolve; });
  const workAborted = new Promise((resolve) => { markAborted = resolve; });
  const waitForAbort = (signal) => new Promise((resolve, reject) => {
    markStarted();
    const abort = () => {
      markAborted();
      reject(signal.reason ?? new Error('CLIENT_ABORTED'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  const app = express();
  mountBookRoutes(app, deps(waitForAbort));
  const started = await startTestServer(app);
  const controller = new AbortController();
  try {
    const request = fetch(`${started.base}${path}`, { signal: controller.signal });
    await workStarted;
    controller.abort();
    await assert.rejects(request, (error) => error?.name === 'AbortError');
    await workAborted;
  } finally {
    controller.abort();
    await stopTestServer(started.server);
  }
}

test('书架列表客户端断开会取消仍在运行的后台扫描', async () => {
  await expectAbortedBookRead('/api/books', (waitForAbort) => ({
    listBooks: ({ signal }) => waitForAbort(signal),
  }));
});

test('作品树客户端断开会取消仍在运行的后台扫描', async () => {
  await expectAbortedBookRead('/api/books/book_1/tree', (waitForAbort) => ({
    readBookStructure: (_bookId, { signal }) => waitForAbort(signal),
  }));
});

test('章节快照客户端断开会取消仍在运行的上下文读取', async () => {
  await expectAbortedBookRead(
    '/api/books/book_1/sections/section-01/chapters/chapter-01',
    (waitForAbort) => ({
      readChapterReviewContext: (_bookId, _sectionId, _chapterId, { signal }) =>
        waitForAbort(signal),
    }),
  );
});

test('结构创建接口校验末项锚点并拒绝陈旧标签页', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const firstSectionResponse = await post(`/api/books/${book.id}/sections`, {
      title: '第一部', outline: '【本部目标】找到证人', expectedLastSectionId: null,
    });
    assert.equal(firstSectionResponse.status, 200);
    const section = await j(firstSectionResponse);
    assert.equal(
      (await store.readSection(book.id, section.id)).outline.content,
      '【本部目标】找到证人',
    );

    const staleSection = await post(`/api/books/${book.id}/sections`, {
      title: '重复部', expectedLastSectionId: null,
    });
    assert.equal(staleSection.status, 409);
    assert.deepEqual(await j(staleSection), { error: 'NEXT_SECTION_CONFLICT' });

    const invalidSection = await post(`/api/books/${book.id}/sections`, {
      title: '非法锚点部', expectedLastSectionId: 42,
    });
    assert.equal(invalidSection.status, 400);
    assert.deepEqual(await j(invalidSection), { error: 'BAD_NEXT_SECTION_ANCHOR' });

    const invalidOutline = await post(`/api/books/${book.id}/sections`, {
      title: '非法大纲部', outline: { bad: true }, expectedLastSectionId: section.id,
    });
    assert.equal(invalidOutline.status, 400);
    assert.deepEqual(await j(invalidOutline), { error: 'BAD_SECTION_OUTLINE' });

    const missingSection = await rawPost(`/api/books/${book.id}/sections`, {
      title: '漏传锚点部',
    });
    assert.equal(missingSection.status, 400);
    assert.deepEqual(await j(missingSection), { error: 'BAD_NEXT_SECTION_ANCHOR' });

    const firstChapterResponse = await post(
      `/api/books/${book.id}/sections/${section.id}/chapters`,
      { title: '第一章', expectedLastChapterId: null },
    );
    assert.equal(firstChapterResponse.status, 200);

    const staleChapter = await post(
      `/api/books/${book.id}/sections/${section.id}/chapters`,
      { title: '重复章', expectedLastChapterId: null },
    );
    assert.equal(staleChapter.status, 409);
    assert.deepEqual(await j(staleChapter), { error: 'NEXT_CHAPTER_CONFLICT' });

    const invalidChapter = await post(
      `/api/books/${book.id}/sections/${section.id}/chapters`,
      { title: '非法锚点章', expectedLastChapterId: 42 },
    );
    assert.equal(invalidChapter.status, 400);
    assert.deepEqual(await j(invalidChapter), { error: 'BAD_NEXT_CHAPTER_ANCHOR' });

    const missingChapter = await rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters`,
      { title: '漏传锚点章' },
    );
    assert.equal(missingChapter.status, 400);
    assert.deepEqual(await j(missingChapter), { error: 'BAD_NEXT_CHAPTER_ANCHOR' });

    const tree = await j(await fetch(`${base}/api/books/${book.id}/tree`));
    assert.equal(tree.sections.length, 1);
    assert.equal(tree.sections[0].chapters.length, 1);
  });
});

test('新建作品使用严格的预分配 ID，冲突时不覆盖已有作品', async () => {
  await withServer(async () => {
    const requestedBookId = `book_${'a'.repeat(32)}`;
    const createdResponse = await post('/api/books', {
      premise: '精确关联', title: '原作品', requestedBookId,
    });
    assert.equal(createdResponse.status, 200);
    assert.equal((await j(createdResponse)).id, requestedBookId);

    const collision = await post('/api/books', {
      premise: '不应覆盖', title: '冲突作品', requestedBookId,
    });
    assert.equal(collision.status, 409);
    assert.deepEqual(await j(collision), { error: 'BOOK_ALREADY_EXISTS' });
    assert.equal((await store.readBook(requestedBookId)).premise, '精确关联');

    const invalid = await post('/api/books', {
      premise: '非法标识', requestedBookId: '../escape',
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await j(invalid), { error: 'BAD_BOOK_CREATION_ID' });
    assert.equal((await store.listBooks()).length, 1);
  });
});

test('单章读取拒绝未被分部索引引用的孤立文件', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const section = await j(await post(`/api/books/${book.id}/sections`, {}));
    writeFileSync(join(root, 'books', book.id, section.id, 'chapter-99.json'), JSON.stringify({
      id: 'chapter-99', index: 99, title: '', body: { versions: ['孤立正文'], cursor: 0 },
    }));

    const response = await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/chapter-99`,
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await j(response), { error: 'CHAPTER_NOT_FOUND' });
  });
});

test('单章读取拒绝所在分部已脱离作品索引的孤立数据', async () => {
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});
    book.sections = [];
    await store.writeBook(book.id, book);

    const response = await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}`,
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await j(response), { error: 'SECTION_NOT_FOUND' });
  });
});

test('建书 premise 缺失、空白或非字符串时统一返回 BAD_PREMISE', async () => {
  await withServer(async () => {
    for (const body of [{}, { premise: '   ' }, { premise: [] }]) {
      const response = await post('/api/books', body);
      assert.equal(response.status, 400);
      assert.deepEqual(await j(response), { error: 'BAD_PREMISE' });
    }
    const list = await j(await fetch(`${base}/api/books`));
    assert.deepEqual(list, []);
  });
});

test('通用 JSON 请求体和建书 premise 分别执行传输与业务上限', async () => {
  await withServer(async () => {
    const transportLimited = await post('/api/books', { premise: 'p'.repeat(2_200_000) });
    assert.equal(transportLimited.status, 413);
    assert.equal((await j(transportLimited)).error, 'REQUEST_TOO_LARGE');

    const semanticLimited = await post('/api/books', {
      premise: 'p'.repeat(MAX_PREMISE_CHARS + 1),
    });
    assert.equal(semanticLimited.status, 400);
    assert.equal((await j(semanticLimited)).error, 'PREMISE_TOO_LARGE');

    assert.deepEqual(await j(await fetch(`${base}/api/books`)), []);
  });
});

test('JSON 传输上限覆盖合法的 20 万字符最坏转义正文', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const text = '\u0000'.repeat(MAX_VERSION_TEXT_CHARS);
    const encodedBytes = Buffer.byteLength(JSON.stringify({
      path: 'outline', text, expectedRevision: store.versionRevision(book.outline),
    }));
    assert.ok(encodedBytes > 1024 * 1024);
    assert.ok(encodedBytes < 2 * 1024 * 1024);

    const saved = await postVersion(book.id, 'save', { path: 'outline', text });

    assert.equal(saved.status, 200);
    assert.equal(store.currentText((await store.readBook(book.id)).outline), text);
  });
});

test('版本正文超过存储上限时拒绝且不污染版本链', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const response = await postVersion(book.id, 'save', {
      path: 'outline', text: 'x'.repeat(MAX_VERSION_TEXT_CHARS + 1),
    });

    assert.equal(response.status, 400);
    assert.equal((await j(response)).error, 'TEXT_TOO_LARGE');
    assert.deepEqual((await store.readBook(book.id)).outline.versions, ['']);
  });
});

test('版本 save 入链，move 双向浏览', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const c = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, {}));
    const path = `section:${s.id}:chapter:${c.id}`;
    await postVersion(book.id, 'save', { path, text: '第一版' });
    let vf = await j(await postVersion(book.id, 'save', { path, text: '第二版' }));
    assert.equal(vf.versions[vf.cursor], '第二版');
    assert.match(vf.revision, /^[A-Za-z0-9_-]{43}$/);
    vf = await j(await postVersion(book.id, 'move', { path, delta: -1 }));
    assert.equal(vf.versions[vf.cursor], '第一版');       // 回退
    vf = await j(await postVersion(book.id, 'move', { path, delta: 1 }));
    assert.equal(vf.versions[vf.cursor], '第二版');       // 再前进
  });
});

test('版本保存先恢复残留删章事务，不接受随后会消失的新正文', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: '失败删章保护' }));
    const section = await j(await post(`/api/books/${book.id}/sections`, {}));
    const chapter = await j(await post(
      `/api/books/${book.id}/sections/${section.id}/chapters`, {},
    ));
    const path = `section:${section.id}:chapter:${chapter.id}`;
    const revision = await currentVersionRevision(book.id, path);
    const transactionPath = join(
      root, 'books', book.id, section.id, '.section-structure-transaction.json',
    );
    await store.atomicWriteJson(transactionPath, {
      format: 'auto-novel-box-structure-transaction', version: 1,
      type: 'delete-chapter', bookId: book.id,
      sectionId: section.id, chapterId: chapter.id,
    });

    const response = await postVersion(
      book.id, 'save', { path, text: '不能先成功再被旧事务删除' }, revision,
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await j(response), { error: 'CHAPTER_NOT_FOUND' });
    assert.equal(existsSync(transactionPath), false);
    assert.deepEqual((await store.readSection(book.id, section.id)).chapters, []);
  });
});

test('版本接口在锁内拒绝缺失或陈旧修订号，不覆盖另一页面的新版本', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const path = 'outline';
    const initialRevision = await currentVersionRevision(book.id, path);

    const first = await postVersion(
      book.id, 'save', { path, text: '页面一的新大纲' }, initialRevision,
    );
    assert.equal(first.status, 200);
    const firstBody = await j(first);
    assert.notEqual(firstBody.revision, initialRevision);

    const stale = await postVersion(
      book.id, 'save', { path, text: '页面二的陈旧草稿' }, initialRevision,
    );
    assert.equal(stale.status, 409);
    assert.deepEqual(await j(stale), { error: 'VERSION_CONFLICT' });
    assert.deepEqual((await store.readBook(book.id)).outline.versions, [
      '', '页面一的新大纲',
    ]);

    const missing = await post(`/api/books/${book.id}/version/save`, {
      path, text: '没有修订号的写入',
    });
    assert.equal(missing.status, 400);
    assert.deepEqual(await j(missing), { error: 'BAD_VERSION_REVISION' });

    const retried = await postVersion(
      book.id, 'save', { path, text: '页面二确认后的新版' }, firstBody.revision,
    );
    assert.equal(retried.status, 200);
    assert.equal((await j(retried)).versions.at(-1), '页面二确认后的新版');
  });
});

test('version/clear 清空为新版，可 move 回', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const path = 'outline';
    await postVersion(book.id, 'save', { path, text: '有内容' });
    let vf = await j(await postVersion(book.id, 'clear', { path }));
    assert.equal(vf.versions[vf.cursor], '');
    vf = await j(await postVersion(book.id, 'move', { path, delta: -1 }));
    assert.equal(vf.versions[vf.cursor], '有内容');
  });
});

test('非法 path 返回 400', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const r = await post(`/api/books/${book.id}/version/move`, {
      path: 'core:evil', delta: 1, expectedRevision: 'A'.repeat(43),
    });
    assert.equal(r.status, 400);
  });
});

test('version/move 非法 delta 返回 JSON 错误，不静默当作 0', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    for (const delta of ['abc', null, 0, 2]) {
      const r = await postVersion(book.id, 'move', { path: 'outline', delta });

      assert.equal(r.status, 400);
      const body = await j(r);
      assert.match(body.error, /BAD_DELTA/);
    }
  });
});

test('version/save 缺少或非字符串 text 返回 JSON 错误且不污染版本链', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const c = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, {}));
    const path = `section:${s.id}:chapter:${c.id}`;
    await postVersion(book.id, 'save', { path, text: '原正文' });

    for (const invalid of [{}, { text: null }, { text: { bad: 'object' } }]) {
      const r = await postVersion(book.id, 'save', { path, ...invalid });
      assert.equal(r.status, 400);
      const body = await j(r);
      assert.match(body.error, /BAD_TEXT/);
    }
    const ch = await store.readChapter(book.id, s.id, c.id);
    assert.deepEqual(ch.body.versions, ['', '原正文']);
    assert.equal(store.currentText(ch.body), '原正文');
  });
});

test('DELETE 移入回收站、可恢复 / PATCH 改名', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: 'A' }));
    const patched = await j(await fetch(`${base}/api/books/${book.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'B', expectedTitle: 'A' }),
    }));
    assert.equal(patched.title, 'B');

    const staleRename = await fetch(`${base}/api/books/${book.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'C', expectedTitle: 'A' }),
    });
    assert.equal(staleRename.status, 409);
    assert.deepEqual(await j(staleRename), { error: 'BOOK_TITLE_CONFLICT' });

    const replay = await fetch(`${base}/api/books/${book.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'B', expectedTitle: 'A' }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await j(replay)).title, 'B');

    const invalidAnchor = await fetch(`${base}/api/books/${book.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'C', expectedTitle: 42 }),
    });
    assert.equal(invalidAnchor.status, 400);
    assert.deepEqual(await j(invalidAnchor), { error: 'BAD_BOOK_TITLE_ANCHOR' });

    const missingRenameAnchor = await fetch(`${base}/api/books/${book.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'C' }),
    });
    assert.equal(missingRenameAnchor.status, 400);
    assert.deepEqual(await j(missingRenameAnchor), { error: 'BAD_BOOK_TITLE_ANCHOR' });

    const missingDeleteAnchor = await fetch(`${base}/api/books/${book.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(missingDeleteAnchor.status, 400);
    assert.deepEqual(await j(missingDeleteAnchor), { error: 'BAD_BOOK_DELETE_ANCHOR' });

    const staleDelete = await fetch(`${base}/api/books/${book.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: book.updatedAt }),
    });
    assert.equal(staleDelete.status, 409);
    assert.deepEqual(await j(staleDelete), { error: 'BOOK_DELETE_CONFLICT' });

    const del = await j(await fetch(`${base}/api/books/${book.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: patched.updatedAt }),
    }));
    assert.equal(del.ok, true);
    assert.equal(del.recoverable, true);
    const list = await j(await fetch(`${base}/api/books`));
    assert.equal(list.find((x) => x.id === book.id), undefined);

    const trash = await j(await fetch(`${base}/api/trash/books`));
    assert.equal(trash.length, 1);
    assert.equal(trash[0].bookId, book.id);
    const restored = await j(await post(`/api/trash/books/${trash[0].trashId}/restore`, {}));
    assert.equal(restored.id, book.id);
    assert.equal(restored.title, 'B');
    const restoredList = await j(await fetch(`${base}/api/books`));
    assert.ok(restoredList.some((x) => x.id === book.id));
  });
});

test('给不存在的书加部返回 JSON 错误，不退出服务', async () => {
  await withServer(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(`${base}/api/books/missing/sections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedLastSectionId: null }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    assert.equal(r.status, 404);
    const body = await j(r);
    assert.match(body.error, /BOOK_NOT_FOUND/);

    const health = await j(await fetch(`${base}/api/health`));
    assert.equal(health.ok, true);
  });
});

test('读取书树时章节损坏返回真实 JSON 错误，不误报书不存在', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: '书' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, { title: '第一部' }));
    const c = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, { title: '第一章' }));
    writeFileSync(join(root, 'books', book.id, s.id, `${c.id}.json`), '{bad json', 'utf8');

    const r = await fetch(`${base}/api/books/${book.id}/tree`);

    assert.equal(r.status, 500);
    const body = await j(r);
    assert.equal(body.error, 'STORAGE_JSON_INVALID');
  });
});

test('读取书树时章节 JSON 根节点为 null 返回稳定存储错误', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: '书' }));
    const section = await j(await post(`/api/books/${book.id}/sections`, { title: '第一部' }));
    const chapter = await j(await post(
      `/api/books/${book.id}/sections/${section.id}/chapters`, { title: '第一章' },
    ));
    writeFileSync(
      join(root, 'books', book.id, section.id, `${chapter.id}.json`), 'null', 'utf8',
    );

    const response = await fetch(`${base}/api/books/${book.id}/tree`);

    assert.equal(response.status, 500);
    assert.deepEqual(await j(response), { error: 'STORAGE_DATA_INVALID' });
  });
});

test('读取书树时章节含非法 UTF-8 返回稳定存储错误', async () => {
  await withServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: '书' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, { title: '第一部' }));
    const c = await j(await post(
      `/api/books/${book.id}/sections/${s.id}/chapters`, { title: '第一章' },
    ));
    const raw = Buffer.from(JSON.stringify({
      ...c,
      body: { versions: ['可信正文'], cursor: 0 },
      content: '可信正文',
    }));
    const textOffset = raw.indexOf(Buffer.from('可信正文'));
    assert.ok(textOffset >= 0);
    raw[textOffset] = 0xff;
    writeFileSync(join(root, 'books', book.id, s.id, `${c.id}.json`), raw);

    const response = await fetch(`${base}/api/books/${book.id}/tree`);

    assert.equal(response.status, 500);
    assert.deepEqual(await j(response), { error: 'STORAGE_JSON_INVALID' });
  });
});

test('读取书树时损坏的引用索引返回稳定的存储错误', async () => {
  await withServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    book.sections = [section.id, section.id];
    await store.writeBook(book.id, book);

    const response = await fetch(`${base}/api/books/${book.id}/tree`);

    assert.equal(response.status, 500);
    assert.deepEqual(await j(response), { error: 'STORAGE_DATA_INVALID' });
  });
});

test('书架列表读取失败返回 JSON 错误，不挂住请求', async () => {
  const fileRoot = join(makeTestTempDir('novelbox-file-'), 'not-a-directory');
  writeFileSync(fileRoot, 'not a directory', 'utf8');
  store.setDataRoot(fileRoot);

  await withServer(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(`${base}/api/books`, { signal: ctrl.signal });
    clearTimeout(timer);

    assert.equal(r.status, 500);
    const body = await j(r);
    assert.equal(body.error, 'STORAGE_PATH_INVALID');

    const health = await j(await fetch(`${base}/api/health`));
    assert.equal(health.ok, true);
  });
});

test('建书写入失败返回 JSON 错误，不挂住请求', async () => {
  const fileRoot = join(makeTestTempDir('novelbox-file-'), 'not-a-directory');
  writeFileSync(fileRoot, 'not a directory', 'utf8');
  store.setDataRoot(fileRoot);

  await withServer(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(`${base}/api/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ premise: 'p' }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    assert.equal(r.status, 500);
    const body = await j(r);
    assert.equal(body.error, 'STORAGE_PATH_INVALID');

    const health = await j(await fetch(`${base}/api/health`));
    assert.equal(health.ok, true);
  });
});

// ——— 手动审稿 ———
const fakeWebFictionChecks = [
  'goldenChapter', 'premisePromise', 'chapterGoal', 'obstacleEscalation',
  'characterChoice', 'effectiveIncrement', 'payoff', 'endingHook',
  'expressionBalance', 'repetitionRisk', 'longArcProgress',
].map((id) => ({ id, status: ['goldenChapter', 'premisePromise', 'chapterGoal', 'obstacleEscalation', 'characterChoice', 'sceneExecution', 'effectiveIncrement', 'payoff', 'tensionDynamics', 'longArcProgress'].includes(id) ? 'risk' : 'pass', detail: `${id} 有正文依据` }));

let capturedReviewPrompt = '';
let capturedReviewSystem = '';

function fakePlanComparison(prompt) {
  const matched = /目标标识：([^\n。]+)。/u.exec(prompt);
  if (!matched) {
    return { overall: 'na', summary: '本章没有已保存策划。', items: [], carryovers: [] };
  }
  const targets = matched[1].split('、').map((row) => row.split('=')[0]);
  return {
    overall: 'aligned', summary: '已保存策划均在正文中落地。',
    items: targets.map((target) => ({
      target, outcome: 'fulfilled', evidence: `${target} 在正文中有明确行动证据。`,
    })),
    carryovers: [],
  };
}

const fakeReviewNonStream = async ({ messages, system }) => {
  const prompt = messages?.[0]?.content ?? '';
  if (prompt.includes('审阅第')) {
    capturedReviewPrompt = prompt;
    capturedReviewSystem = system ?? '';
    return JSON.stringify({
      score: 78,
      verdict: '冲突成立，中段推进偏松',
      webFictionSignals: {
        chapterFunction: '冲突推进', conflictType: '人物争执', emotionTone: '紧张', payoffType: '信息揭示', dominantMode: '对话',
        rhythmFingerprint: {
          pressurePattern: 'choice-led', resolutionMethod: 'negotiation', payoffScale: 'chapter',
          hookMechanism: 'none', costType: 'none',
        },
      },
      webFictionChecks: fakeWebFictionChecks,
      planComparison: fakePlanComparison(prompt),
      issues: [
        { title: '冲突弱', detail: '缺少导火索' },
        { title: '对话偏多', detail: '中段对话偏多，压缩后更紧凑' },
      ],
      suggestions: [
        { label: '强化冲突', instruction: '把争吵的导火索写清楚' },
        { label: '精简对话', instruction: '压缩中段对话' },
      ],
    });
  }
  return '{}';
};

function appWithReview(nonStreamChatFn) {
  const app = express();
  app.use(express.json());
  mountBookRoutes(app, { nonStreamChat: nonStreamChatFn });
  return app;
}

async function withReviewServer(fn, nonStreamChatFn) {
  const started = await startTestServer(appWithReview(nonStreamChatFn));
  base = started.base;
  try { await fn(); } finally { await stopTestServer(started.server); }
}

test('手动审稿成功返回 review 并落盘', async () => {
  await withReviewServer(async () => {
    capturedReviewPrompt = '';
    capturedReviewSystem = '';
    const book = await j(await post('/api/books', { premise: 'p', title: '测试书' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, { title: '第一部' }));
    const c = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, { title: '第一章' }));
    // 写入正文
    const path = `section:${s.id}:chapter:${c.id}`;
    await postVersion(book.id, 'save', { path, text: '第一章正文内容' });
    const currentPlan = store.chapterPlanView(
      (await store.readChapter(book.id, s.id, c.id)).plan,
    );
    await store.saveChapterPlan(book.id, s.id, c.id, {
      goal: '迫使证人开口',
      scenes: [{ action: '主角当面出示证据', turn: '证人承认撒谎' }],
    }, { expectedRevision: currentPlan.revision });
    const storedBook = await store.readBook(book.id);
    await store.saveStoryEngine(book.id, {
      readerExperience: '看主角用证据撬动封闭关系网',
      protagonistAction: '调查并公开关键证据',
      progression: '获得更接近幕后人的线索',
      cost: '每次公开都会暴露一名盟友',
      escalation: '从个人秘密升级到整座城市的利益链',
    }, { expectedRevision: store.storyEngineView(storedBook.settings.storyEngine).revision });

    const r = await post(`/api/books/${book.id}/sections/${s.id}/chapters/${c.id}/review`);
    assert.equal(r.status, 200);
    const body = await j(r);
    assert.equal(body.score, 78);
    assert.equal(body.verdict, '冲突成立，中段推进偏松');
    assert.equal(body.issues.length, 2);
    assert.equal(body.suggestions.length, 2);
    assert.equal(body.webFictionChecks.length, 11);
    assert.equal(body.webFictionChecks[5].id, 'effectiveIncrement');
    assert.equal(body.webFictionSignals.conflictType, '人物争执');
    assert.equal(body.planComparison.overall, 'aligned');
    assert.deepEqual(body.planComparison.items.map((item) => item.target), [
      'goal', 'scene-1',
    ]);
    assert.ok(body.sourceCursor !== undefined);
    assert.equal(body.sourceFingerprint, (await store.readChapter(book.id, s.id, c.id)).bodyFingerprint);
    assert.match(body.sourceContextRevision, /^[A-Za-z0-9_-]{43}$/);
    assert.match(body.sourcePlanRevision, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(body.updatedAt);
    assert.match(capturedReviewPrompt, /本章目标：迫使证人开口/);
    assert.match(capturedReviewPrompt, /行动=主角当面出示证据/);
    assert.match(capturedReviewSystem, /作品核心循环/);
    assert.match(capturedReviewSystem, /看主角用证据撬动封闭关系网/);

    // 确认落盘
    const ch = await store.readChapter(book.id, s.id, c.id);
    assert.equal(ch.review.score, 78);
    assert.equal(ch.review.webFictionChecks[7].id, 'endingHook');
    assert.equal(ch.review.webFictionSignals.dominantMode, '对话');
    assert.equal(ch.review.sourceCursor, ch.body.cursor);
  }, fakeReviewNonStream);
});

test('章节加载只报告上下文元数据，手动审稿实际携带上一有效章结尾', async () => {
  await withReviewServer(async () => {
    capturedReviewPrompt = '';
    const book = await store.createBook({ premise: '跨章承接' });
    const section = await store.addSection(book.id, {});
    const previous = await store.addChapter(book.id, section.id, {});
    const target = await store.addChapter(book.id, section.id, {});
    const previousMarker = '门缝里的铜铃忽然响了三声';
    await store.versionSet(
      book.id, `section:${section.id}:chapter:${previous.id}`,
      `上一章冲突与选择。${previousMarker}`,
    );
    await store.versionSet(
      book.id, `section:${section.id}:chapter:${target.id}`, '当前待审正文',
    );

    const loadedResponse = await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${target.id}`,
    );
    assert.equal(loadedResponse.status, 200);
    const loaded = await loadedResponse.json();
    const items = loaded.contextManifest.layers.flatMap((layer) => layer.items);
    assert.equal(items.find((item) => item.id === 'previous-ending').status, 'included');
    assert.equal(items.find((item) => item.id === 'current-body').status, 'included');
    assert.equal(JSON.stringify(loaded.contextManifest).includes(previousMarker), false);

    const response = await rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters/${target.id}/review`,
      {
        expectedBodyFingerprint: loaded.bodyFingerprint,
        expectedContextRevision: loaded.reviewContextRevision,
      },
    );
    assert.equal(response.status, 200);
    assert.match(capturedReviewPrompt, new RegExp(`【上一章结尾】[^\\n]*${previousMarker}`));
  }, fakeReviewNonStream);
});

test('删除中间章后手动审稿仍按 GET 返回的逻辑序号锚点保存', async () => {
  await withReviewServer(async () => {
    const book = await store.createBook({ premise: 'p', title: '删章审稿' });
    const section = await store.addSection(book.id, {});
    await store.addChapter(book.id, section.id, {});
    const removed = await store.addChapter(book.id, section.id, {});
    const target = await store.addChapter(book.id, section.id, {});
    await store.versionSet(
      book.id, `section:${section.id}:chapter:${target.id}`, '逻辑第二章正文',
    );
    await store.deleteChapter(book.id, section.id, removed.id);

    const chapterResponse = await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${target.id}`,
    );
    const chapter = await chapterResponse.json();
    assert.equal(chapterResponse.status, 200);
    assert.equal(chapter.index, 2);

    const reviewResponse = await rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters/${target.id}/review`,
      {
        expectedBodyFingerprint: chapter.bodyFingerprint,
        expectedContextRevision: chapter.reviewContextRevision,
      },
    );

    assert.equal(reviewResponse.status, 200);
    assert.equal((await reviewResponse.json()).score, 78);
    const saved = await store.readChapter(book.id, section.id, target.id);
    assert.equal(saved.index, 2);
    assert.equal(saved.review.verdict, '冲突成立，中段推进偏松');
  }, fakeReviewNonStream);
});

test('章节响应在故事上下文后续变化时暴露新的审稿上下文修订号', async () => {
  await withReviewServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});
    await store.versionSet(
      book.id,
      `section:${section.id}:chapter:${chapter.id}`,
      '待审正文',
    );
    const reviewResponse = await post(
      `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/review`,
    );
    assert.equal(reviewResponse.status, 200);
    const review = await reviewResponse.json();

    const before = await j(await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}`,
    ));
    assert.equal(before.review.sourceContextRevision, review.sourceContextRevision);
    assert.equal(before.reviewContextRevision, review.sourceContextRevision);

    await store.versionSet(book.id, 'outline', '审稿保存后更新的大纲');
    const after = await j(await fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}`,
    ));
    assert.equal(after.review.sourceContextRevision, review.sourceContextRevision);
    assert.notEqual(after.reviewContextRevision, review.sourceContextRevision);
    assert.equal(store.currentText(after.body), '待审正文');
  }, fakeReviewNonStream);
});

test('手动审稿 LLM 解析失败按上游故障返回 REVIEW_FAILED', async () => {
  const failNonStream = async () => '抱歉，我不会审稿';
  await withReviewServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: '测试书' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, { title: '第一部' }));
    const c = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, { title: '第一章' }));
    const path = `section:${s.id}:chapter:${c.id}`;
    await postVersion(book.id, 'save', { path, text: '正文' });

    const r = await post(`/api/books/${book.id}/sections/${s.id}/chapters/${c.id}/review`);
    assert.equal(r.status, 502);
    const body = await j(r);
    assert.equal(body.error, 'REVIEW_FAILED');
  }, failNonStream);
});

test('空章节拒绝审稿且不调用 LLM', async () => {
  let calls = 0;
  const countingNonStream = async () => {
    calls += 1;
    return '{}';
  };
  await withReviewServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: '测试书' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, { title: '第一部' }));
    const c = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, { title: '第一章' }));

    const r = await post(`/api/books/${book.id}/sections/${s.id}/chapters/${c.id}/review`);
    assert.equal(r.status, 400);
    assert.equal((await j(r)).error, 'CHAPTER_EMPTY');
    assert.equal(calls, 0);
    assert.equal((await store.readChapter(book.id, s.id, c.id)).review, undefined);
  }, countingNonStream);
});

test('审稿缺少或已过期的页面锚点时不调用模型', async () => {
  let calls = 0;
  const countingNonStream = async () => {
    calls += 1;
    return '{}';
  };
  await withReviewServer(async () => {
    const book = await store.createBook({ premise: '审稿锚点' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});
    await store.versionSet(
      book.id,
      `section:${section.id}:chapter:${chapter.id}`,
      '待审正文',
    );

    const response = await rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/review`,
      {},
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'BAD_REVIEW_ANCHOR' });

    const snapshot = await store.readChapterReviewContext(
      book.id, section.id, chapter.id,
    );
    const staleBody = await rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/review`,
      {
        expectedBodyFingerprint: 'A'.repeat(43),
        expectedContextRevision: snapshot.contextRevision,
      },
    );
    assert.equal(staleBody.status, 409);
    assert.deepEqual(await staleBody.json(), { error: 'REVIEW_STALE' });

    const staleContext = await rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/review`,
      {
        expectedBodyFingerprint: snapshot.chapter.bodyFingerprint,
        expectedContextRevision: 'C'.repeat(43),
      },
    );
    assert.equal(staleContext.status, 409);
    assert.deepEqual(await staleContext.json(), { error: 'REVIEW_CONTEXT_STALE' });
    assert.equal(calls, 0);
  }, countingNonStream);
});

test('手动审稿返回前正文已变更时拒绝迟到结果', async () => {
  let reviewStartedResolve;
  let releaseReview;
  const reviewStarted = new Promise((resolve) => { reviewStartedResolve = resolve; });
  const reviewResult = new Promise((resolve) => { releaseReview = resolve; });
  const delayedReview = async () => {
    reviewStartedResolve();
    return reviewResult;
  };

  await withReviewServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: '测试书' }));
    const s = await j(await post(`/api/books/${book.id}/sections`, {}));
    const c = await j(await post(`/api/books/${book.id}/sections/${s.id}/chapters`, {}));
    const path = `section:${s.id}:chapter:${c.id}`;
    await postVersion(book.id, 'save', { path, text: '审稿基线' });

    const pending = post(`/api/books/${book.id}/sections/${s.id}/chapters/${c.id}/review`);
    await reviewStarted;
    await store.versionSet(book.id, path, '用户新正文');
    releaseReview(JSON.stringify({
      score: 78,
      verdict: '旧结果',
      issues: [{ title: '旧问题', detail: '旧详情' }],
      suggestions: [{ label: '旧建议', instruction: '旧指令' }],
    }));

    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'REVIEW_STALE');
    const chapter = await store.readChapter(book.id, s.id, c.id);
    assert.equal(store.currentText(chapter.body), '用户新正文');
    assert.equal(chapter.review, undefined);
  }, delayedReview);
});

test('手动审稿返回前故事上下文已变更时拒绝迟到结果', async () => {
  let reviewStartedResolve;
  let releaseReview;
  const reviewStarted = new Promise((resolve) => { reviewStartedResolve = resolve; });
  const delayedReview = async () => {
    reviewStartedResolve();
    return new Promise((resolve) => { releaseReview = resolve; });
  };

  await withReviewServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: '测试书' }));
    const section = await j(await post(`/api/books/${book.id}/sections`, {}));
    const chapter = await j(await post(
      `/api/books/${book.id}/sections/${section.id}/chapters`, {},
    ));
    const path = `section:${section.id}:chapter:${chapter.id}`;
    await postVersion(book.id, 'save', { path, text: '正文保持不变' });

    const pending = post(
      `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/review`,
    );
    await reviewStarted;
    await store.versionSet(book.id, 'core:constraints', '另一页面新增的禁忌约束');
    releaseReview(JSON.stringify({
      score: 78,
      verdict: '基于旧约束的结果',
      issues: [{ title: '旧问题', detail: '旧详情' }],
      suggestions: [{ label: '旧建议', instruction: '旧指令' }],
    }));

    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'REVIEW_CONTEXT_STALE');
    const saved = await store.readChapter(book.id, section.id, chapter.id);
    assert.equal(store.currentText(saved.body), '正文保持不变');
    assert.equal(saved.review, undefined);
  }, delayedReview);
});

test('审稿请求断开时取消模型调用且不保存迟到结果', async () => {
  let reviewStartedResolve;
  let modelAbortedResolve;
  const reviewStarted = new Promise((resolve) => { reviewStartedResolve = resolve; });
  const modelAborted = new Promise((resolve) => { modelAbortedResolve = resolve; });
  const cancellableReview = async ({ signal }) => new Promise((resolve, reject) => {
    reviewStartedResolve();
    const onAbort = () => {
      modelAbortedResolve();
      reject(signal.reason || new Error('CLIENT_ABORTED'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

  await withReviewServer(async () => {
    const book = await j(await post('/api/books', { premise: 'p', title: '测试书' }));
    const section = await j(await post(`/api/books/${book.id}/sections`, {}));
    const chapter = await j(await post(`/api/books/${book.id}/sections/${section.id}/chapters`, {}));
    await postVersion(book.id, 'save', {
      path: `section:${section.id}:chapter:${chapter.id}`, text: '待审正文',
    });
    const reviewSnapshot = await store.readChapterReviewContext(
      book.id, section.id, chapter.id,
    );

    const controller = new AbortController();
    const pending = fetch(
      `${base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/review`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedBodyFingerprint: reviewSnapshot.chapter.bodyFingerprint,
          expectedContextRevision: reviewSnapshot.contextRevision,
        }),
        signal: controller.signal,
      },
    );
    await reviewStarted;
    controller.abort();
    await pending.catch(() => {});
    await modelAborted;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal((await store.readChapter(book.id, section.id, chapter.id)).review, undefined);
  }, cancellableReview);
});

test('孤立分部中的章节在审稿前被拒绝，不消耗模型调用', async () => {
  let calls = 0;
  const countingReview = async () => {
    calls += 1;
    return '{}';
  };
  await withReviewServer(async () => {
    const book = await store.createBook({ premise: 'p' });
    const section = await store.addSection(book.id, {});
    const chapter = await store.addChapter(book.id, section.id, {});
    await store.versionSet(
      book.id,
      `section:${section.id}:chapter:${chapter.id}`,
      '待审正文',
    );
    book.sections = [];
    await store.writeBook(book.id, book);

    const response = await rawPost(
      `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}/review`,
      {
        expectedBodyFingerprint: (await store.readChapter(
          book.id, section.id, chapter.id,
        )).bodyFingerprint,
        expectedContextRevision: 'A'.repeat(43),
      },
    );
    assert.equal(response.status, 404);
    assert.equal((await j(response)).error, 'SECTION_NOT_FOUND');
    assert.equal(calls, 0);
  }, countingReview);
});

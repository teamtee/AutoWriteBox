import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import * as store from '../store.js';
import { createApp } from '../index.js';
import { mountStorageRoutes } from '../routes/storage.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { MAX_STORAGE_DIAGNOSTIC_ISSUES } from '../limits.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-storage-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

test('存储诊断 API 暴露损坏项目但不影响健康检查', async () => {
  const badDir = join(root, 'books', 'book_bad');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'book.json'), '{ bad json', 'utf8');

  const started = await startTestServer(createApp());
  try {
    const response = await fetch(`${started.base}/api/storage/diagnostics`);
    assert.equal(response.status, 200);
    const diagnostics = await response.json();
    assert.equal(diagnostics.ok, false);
    assert.equal(diagnostics.mode, 'quick');
    assert.equal(diagnostics.scannedBooks, 1);
    assert.equal(diagnostics.totalBooks, 1);
    assert.equal(diagnostics.truncated, false);
    assert.equal(diagnostics.issueLimit, MAX_STORAGE_DIAGNOSTIC_ISSUES);
    assert.deepEqual(diagnostics.issues, [
      { code: 'BOOK_METADATA_INVALID', bookId: 'book_bad' },
    ]);

    const health = await fetch(`${started.base}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    await stopTestServer(started.server);
  }
});

test('存储诊断 API 默认轻检，deep=1 才读取并解析章节正文', async () => {
  const book = await store.createBook({ premise: '深度诊断' });
  const section = await store.addSection(book.id, {});
  const chapter = await store.addChapter(book.id, section.id, {});
  writeFileSync(
    join(root, 'books', book.id, section.id, `${chapter.id}.json`),
    '{ invalid chapter json',
    'utf8',
  );

  const started = await startTestServer(createApp());
  try {
    const quick = await fetch(`${started.base}/api/storage/diagnostics`).then((res) => res.json());
    assert.equal(quick.mode, 'quick');
    assert.equal(quick.ok, true);

    const deep = await fetch(`${started.base}/api/storage/diagnostics?deep=1`)
      .then((res) => res.json());
    assert.equal(deep.mode, 'deep');
    assert.equal(deep.ok, false);
    assert.ok(deep.issues.some((issue) =>
      issue.code === 'CHAPTER_FILE_INVALID' && issue.chapterId === chapter.id));
  } finally {
    await stopTestServer(started.server);
  }
});

test('存储诊断仍报告没有活跃写入锁保护的崩溃残留事务', async () => {
  const book = await store.createBook({ premise: '事务诊断' });
  const pendingSection = {
    id: 'section-01', index: 1, title: '待恢复部', titleSource: 'manual',
    outline: { content: '', history: [] }, characters: [], summary: '', progress: '',
    chapters: [], chapterSummaries: {},
  };
  await store.atomicWriteJson(
    join(root, 'books', book.id, '.book-structure-transaction.json'),
    {
      format: 'auto-novel-box-structure-transaction',
      version: 1,
      type: 'add-section',
      bookId: book.id,
      sectionId: pendingSection.id,
      section: pendingSection,
    },
  );

  const diagnostics = await store.diagnoseStorage();

  assert.equal(diagnostics.ok, false);
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'BOOK_STRUCTURE_TRANSACTION_PENDING' && issue.bookId === book.id));
});

test('存储诊断区分可恢复事务与同 ID 异内容的目标冲突', async () => {
  const book = await store.createBook({ premise: '事务冲突诊断' });
  const pendingSection = {
    id: 'section-01', index: 1, title: '事务分部', titleSource: 'manual',
    outline: { content: '', history: [] }, characters: [], summary: '', progress: '',
    chapters: [], chapterSummaries: {},
  };
  const sectionRoot = join(root, 'books', book.id, pendingSection.id);
  mkdirSync(sectionRoot, { recursive: true });
  await store.atomicWriteJson(join(sectionRoot, 'section.json'), {
    ...pendingSection, title: '磁盘上的另一个分部',
  });
  await store.atomicWriteJson(
    join(root, 'books', book.id, '.book-structure-transaction.json'),
    {
      format: 'auto-novel-box-structure-transaction', version: 1, type: 'add-section',
      bookId: book.id, sectionId: pendingSection.id, section: pendingSection,
    },
  );

  let diagnostics = await store.diagnoseStorage();
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'BOOK_STRUCTURE_TRANSACTION_TARGET_CONFLICT'
      && issue.bookId === book.id));
  assert.ok(!diagnostics.issues.some((issue) =>
    issue.code === 'BOOK_STRUCTURE_TRANSACTION_PENDING'));

  // 独立作品验证章节事务冲突；分部本身必须已在作品索引中。
  const chapterBook = await store.createBook({ premise: '章节事务冲突诊断' });
  const section = await store.addSection(chapterBook.id, { title: '有效分部' });
  const pendingChapter = {
    id: 'chapter-01', index: 1, title: '事务章节', titleSource: 'manual',
    body: { versions: [''], cursor: 0 }, content: '',
    bodyFingerprint: store.contentFingerprint(''),
    characters: [], summary: '', progress: '', status: 'done',
  };
  const chapterSectionRoot = join(root, 'books', chapterBook.id, section.id);
  await store.atomicWriteJson(join(chapterSectionRoot, `${pendingChapter.id}.json`), {
    ...pendingChapter, title: '磁盘上的另一个章节',
  });
  await store.atomicWriteJson(
    join(chapterSectionRoot, '.section-structure-transaction.json'),
    {
      format: 'auto-novel-box-structure-transaction', version: 1, type: 'add-chapter',
      bookId: chapterBook.id, sectionId: section.id,
      chapterId: pendingChapter.id, chapter: pendingChapter,
    },
  );

  diagnostics = await store.diagnoseStorage({ deep: true });
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'SECTION_STRUCTURE_TRANSACTION_TARGET_CONFLICT'
      && issue.bookId === chapterBook.id && issue.sectionId === section.id));
  assert.ok(!diagnostics.issues.some((issue) =>
    issue.code === 'SECTION_STRUCTURE_TRANSACTION_PENDING'
      && issue.bookId === chapterBook.id));
});

test('存储诊断在开始前已取消时不读取数据目录', async () => {
  const controller = new AbortController();
  controller.abort(new Error('CLIENT_ABORTED'));

  await assert.rejects(
    () => store.diagnoseStorage({ deep: true, signal: controller.signal }),
    /CLIENT_ABORTED/,
  );
});

test('存储诊断校验全局创作资产库且不误报健康资产', async () => {
  await store.addWritingAsset({
    name: '测试资产', sourceName: '本人样本', sourceKind: 'self', sourceText: '一段原创正文。',
    analysis: {
      style: { summary: '紧凑', prompt: '使用具体动作推进。' },
      story: { summary: '目标受阻后作出选择', evidenceLevel: 'low' },
    },
  });
  assert.equal((await store.diagnoseStorage()).ok, true);

  writeFileSync(join(root, 'writing-assets.json'), '{"version":1,"assets":[{"bad":true}]}');
  const diagnostics = await store.diagnoseStorage();
  assert.equal(diagnostics.ok, false);
  assert.deepEqual(diagnostics.issues, [{
    code: 'WRITING_ASSETS_DATA_INVALID', bookId: 'data/writing-assets.json',
  }]);
});

test('存储诊断校验多 API 方案库且不回显密钥', async () => {
  const empty = await store.readApiProfiles();
  await store.saveApiProfile({
    name: '诊断方案', baseUrl: 'https://diagnostic.example/v1', apiKey: 'sk-private',
    models: ['model-a'], selectedModel: 'model-a', note: '',
  }, { expectedRevision: empty.revision });
  assert.equal((await store.diagnoseStorage()).ok, true);

  writeFileSync(join(root, 'api-profiles.json'), '{"version":1,"activeProfileId":null,"profiles":[{"bad":true}]}');
  const diagnostics = await store.diagnoseStorage();
  assert.equal(diagnostics.ok, false);
  assert.deepEqual(diagnostics.issues, [{
    code: 'API_PROFILES_DATA_INVALID', bookId: 'data/api-profiles.json',
  }]);
  assert.equal(JSON.stringify(diagnostics).includes('sk-private'), false);
});

test('诊断 HTTP 客户端断开会取消仍在运行的后台扫描', async () => {
  let markStarted;
  let markAborted;
  const scanStarted = new Promise((resolve) => { markStarted = resolve; });
  const scanAborted = new Promise((resolve) => { markAborted = resolve; });
  const app = express();
  mountStorageRoutes(app, {
    diagnoseStorage: ({ signal }) => new Promise((resolve, reject) => {
      markStarted();
      const abort = () => {
        markAborted();
        reject(signal.reason ?? new Error('CLIENT_ABORTED'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }),
  });

  const started = await startTestServer(app);
  const controller = new AbortController();
  try {
    const request = fetch(`${started.base}/api/storage/diagnostics?deep=1`, {
      signal: controller.signal,
    });
    await scanStarted;
    controller.abort();
    await assert.rejects(request, (error) => error?.name === 'AbortError');
    await scanAborted;
  } finally {
    controller.abort();
    await stopTestServer(started.server);
  }
});

test('回收站列表 HTTP 客户端断开会取消仍在运行的扫描', async () => {
  let markStarted;
  let markAborted;
  const scanStarted = new Promise((resolve) => { markStarted = resolve; });
  const scanAborted = new Promise((resolve) => { markAborted = resolve; });
  const app = express();
  mountStorageRoutes(app, {
    listDeletedBooks: ({ signal }) => new Promise((resolve, reject) => {
      markStarted();
      const abort = () => {
        markAborted();
        reject(signal.reason ?? new Error('CLIENT_ABORTED'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }),
  });

  const started = await startTestServer(app);
  const controller = new AbortController();
  try {
    const request = fetch(`${started.base}/api/trash/books`, { signal: controller.signal });
    await scanStarted;
    controller.abort();
    await assert.rejects(request, (error) => error?.name === 'AbortError');
    await scanAborted;
  } finally {
    controller.abort();
    await stopTestServer(started.server);
  }
});

test('恢复 HTTP 客户端断开会取消提交前的后台工作', async () => {
  let markStarted;
  let markAborted;
  const restoreStarted = new Promise((resolve) => { markStarted = resolve; });
  const restoreAborted = new Promise((resolve) => { markAborted = resolve; });
  const app = express();
  mountStorageRoutes(app, {
    restoreDeletedBook: (_trashId, { signal }) => new Promise((resolve, reject) => {
      markStarted();
      const abort = () => {
        markAborted();
        reject(signal.reason ?? new Error('CLIENT_ABORTED'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }),
  });

  const started = await startTestServer(app);
  const controller = new AbortController();
  try {
    const request = fetch(`${started.base}/api/trash/books/trash-1/restore`, {
      method: 'POST',
      signal: controller.signal,
    });
    await restoreStarted;
    controller.abort();
    await assert.rejects(request, (error) => error?.name === 'AbortError');
    await restoreAborted;
  } finally {
    controller.abort();
    await stopTestServer(started.server);
  }
});

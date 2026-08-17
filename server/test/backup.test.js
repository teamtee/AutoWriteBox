import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, readdir, rm, stat, truncate, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import * as store from '../store.js';
import {
  MAX_CHARACTER_DESC_CHARS, MAX_CHAPTER_JSON_BYTES, MAX_PREMISE_CHARS,
  MAX_REVIEW_CHECK_DETAIL_CHARS, MAX_REVIEW_INSTRUCTION_CHARS,
  MAX_REVIEW_SIGNAL_CHARS, MAX_TITLE_CHARS, MAX_VERSION_TEXT_CHARS,
} from '../limits.js';
import { createApp } from '../index.js';
import {
  cleanupAbandonedTransferDirs, createBackupTransferLimiter, createPreparedBackupRegistry,
  createTransferTempRoot, downloadFile, mountStorageRoutes, writeRequestBodyToFile,
} from '../routes/storage.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-backup-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

async function createPopulatedBook() {
  const book = await store.createBook({ premise: '备份测试', title: '可迁移小说' });
  const section = await store.addSection(book.id, { title: '第一部' });
  const chapter = await store.addChapter(book.id, section.id, { title: '第一章' });
  const path = `section:${section.id}:chapter:${chapter.id}`;
  await store.versionSet(book.id, path, '第一版正文');
  await store.versionSet(book.id, path, '第二版正文');
  const current = await store.readChapter(book.id, section.id, chapter.id);
  await store.applyChapterDigest(book.id, section.id, chapter.id, {
    summary: '主角抵达旧桥', progress: '摘要模型建议继续追查',
    handoff: {
      viewpoint: '林越', time: '当夜', location: '旧桥', ongoingAction: '正追向桥下',
      immediatePressure: '追兵逼近', characterState: '左臂受伤', resourceState: '钥匙在手',
      knowledgeBoundary: '只知道目标经过旧桥', unresolvedCausality: '桥下传来落水声',
    },
    newCharacters: [],
  }, { expectedBodyFingerprint: current.bodyFingerprint });
  await store.saveChapterReview(book.id, section.id, chapter.id, {
    score: 88,
    verdict: '可读',
    webFictionSignals: {
      chapterFunction: '阶段兑现', conflictType: '追逐', emotionTone: '紧张',
      payoffType: '脱险', dominantMode: '行动',
      rhythmFingerprint: {
        pressurePattern: 'false-relief', resolutionMethod: 'wit',
        payoffScale: 'chapter', hookMechanism: 'new-threat', costType: 'identity',
      },
    },
    webFictionChecks: [
      'goldenChapter', 'premisePromise', 'chapterGoal', 'obstacleEscalation',
      'characterChoice', 'effectiveIncrement', 'payoff', 'endingHook',
      'expressionBalance', 'repetitionRisk', 'longArcProgress',
    ].map((id) => ({ id, status: 'pass', detail: `${id} 有依据` })),
    issues: [{ title: '节奏', detail: '略慢' }],
    suggestions: [{ label: '加速', instruction: '压缩开头' }],
  }, { expectedBodyFingerprint: current.bodyFingerprint });
  return { book, section, chapter };
}

function requestWithDeclaredLength(base, length) {
  const url = new URL('/api/backups/import', base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(length),
      },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

function captureStorageHandlers(deps) {
  const handlers = new Map();
  const app = {
    post(path, handler) { handlers.set(`POST ${path}`, handler); },
    head(path, handler) { handlers.set(`HEAD ${path}`, handler); },
    get(path, handler) { handlers.set(`GET ${path}`, handler); },
  };
  mountStorageRoutes(app, deps);
  return handlers;
}

function fakeStorageResponse() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.jsonValue = value;
      this.headersSent = true;
      this.writableEnded = true;
      return this;
    },
  });
}

test('备份下载空闲超时会销毁连接并清理 timeout 监听器', async () => {
  class FakeDownloadResponse extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.timeoutMs = 0;
      this.downloadCallback = null;
    }

    setTimeout(ms, callback) {
      this.timeoutMs = ms;
      if (callback) this.on('timeout', callback);
      return this;
    }

    download(path, filename, callback) {
      this.downloadPath = path;
      this.downloadFilename = filename;
      this.downloadCallback = callback;
    }

    destroy() { this.destroyed = true; }
  }

  const stalled = new FakeDownloadResponse();
  const pending = downloadFile(stalled, '/private/backup.json', 'backup.json', {
    idleTimeoutMs: 5,
  });
  assert.equal(stalled.timeoutMs, 5);
  stalled.emit('timeout');
  await assert.rejects(pending, /RESPONSE_BACKPRESSURE_TIMEOUT/);
  assert.equal(stalled.destroyed, true);
  assert.equal(stalled.listenerCount('timeout'), 0);

  const completed = new FakeDownloadResponse();
  const delivered = downloadFile(completed, '/private/backup.json', 'backup.json');
  completed.downloadCallback();
  await delivered;
  assert.equal(completed.destroyed, false);
  assert.equal(completed.timeoutMs, 0);
  assert.equal(completed.listenerCount('timeout'), 0);
});

test('书籍备份保留版本与审稿，导入生成新副本且不包含 API Key', async () => {
  await store.writeConfig({ baseUrl: 'https://example.test/v1', model: 'm', apiKey: 'sk-top-secret' });
  const { book, section, chapter } = await createPopulatedBook();

  const backup = await store.createBookBackup(book.id);
  assert.equal(backup.format, store.BOOK_BACKUP_FORMAT);
  assert.equal(backup.version, 1);
  assert.equal(backup.sections.length, 1);
  assert.doesNotMatch(JSON.stringify(backup), /sk-top-secret/);
  const originalBackup = structuredClone(backup);

  const originalStructuredClone = globalThis.structuredClone;
  globalThis.structuredClone = () => {
    throw new Error('VALIDATED_BACKUP_CLONE_FORBIDDEN');
  };
  let imported;
  try {
    imported = await store.importBookBackup(backup);
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }
  assert.deepEqual(backup, originalBackup);
  assert.notEqual(imported.id, book.id);
  assert.equal(imported.title, '可迁移小说');
  const importedSection = await store.readSection(imported.id, section.id);
  const importedChapter = await store.readChapter(imported.id, section.id, chapter.id);
  assert.deepEqual(importedSection.chapters, [chapter.id]);
  assert.deepEqual(importedChapter.body.versions, ['', '第一版正文', '第二版正文']);
  assert.equal(store.currentText(importedChapter.body), '第二版正文');
  assert.equal(backup.sections[0].chapters[0].handoff.location, '旧桥');
  assert.equal(importedChapter.handoff.ongoingAction, '正追向桥下');
  assert.equal(importedChapter.progress, '摘要模型建议继续追查');
  assert.equal(importedChapter.review.score, 88);
  assert.equal(importedChapter.review.webFictionChecks.length, 11);
  assert.equal(importedChapter.review.webFictionChecks[7].id, 'endingHook');
  assert.equal(importedChapter.review.webFictionSignals.payoffType, '脱险');
  assert.equal(
    importedChapter.review.webFictionSignals.rhythmFingerprint.pressurePattern,
    'false-relief',
  );
  assert.match(importedChapter.review.sourceContextRevision, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    importedChapter.review.sourceContextRevision,
    backup.sections[0].chapters[0].review.sourceContextRevision,
  );
  assert.equal((await store.listBooks()).length, 2);
  assert.equal((await store.readConfig()).apiKey, 'sk-top-secret');
});

test('分块备份文件与导入格式兼容，且临时文件仅当前用户可读写', async () => {
  const { book, section, chapter } = await createPopulatedBook();
  const backupPath = join(root, 'streamed.novelbox.json');

  const result = await store.writeBookBackupFile(book.id, backupPath);
  assert.equal(result.bookId, book.id);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);

  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(backup.format, store.BOOK_BACKUP_FORMAT);
  assert.deepEqual(backup.book.sections, [section.id]);
  assert.deepEqual(backup.sections[0].section.chapters, [chapter.id]);
  assert.deepEqual(backup.sections[0].chapters[0].body.versions, ['', '第一版正文', '第二版正文']);

  const imported = await store.importBookBackupFile(backupPath, { highWaterMark: 7 });
  assert.notEqual(imported.id, book.id);
  const importedChapter = await store.readChapter(imported.id, section.id, chapter.id);
  assert.deepEqual(importedChapter.body.versions, ['', '第一版正文', '第二版正文']);
});

test('纯文本发布稿只含标题与正文，并可选择当前稿或已锁定发布稿', async () => {
  const { book, section, chapter } = await createPopulatedBook();
  const empty = await store.addChapter(book.id, section.id, { title: '空章' });
  const beforePublish = await store.readChapter(book.id, section.id, chapter.id);
  const publication = await store.publishChapterVersion(book.id, section.id, chapter.id, {
    expectedBodyFingerprint: beforePublish.bodyFingerprint,
    expectedMemoryRevision: store.bookMemoryRevision(await store.readBook(book.id)),
  });
  assert.equal(publication.published.isCurrent, true);
  await store.versionSet(
    book.id, `section:${section.id}:chapter:${chapter.id}`, '平台尚未看到的新正文',
  );

  const currentPath = join(root, 'current.txt');
  const currentResult = await store.writeBookManuscriptFile(book.id, currentPath);
  const currentText = await readFile(currentPath, 'utf8');
  assert.equal((await stat(currentPath)).mode & 0o777, 0o600);
  assert.deepEqual(currentResult, {
    bookId: book.id,
    source: 'current',
    totalChapterCount: 2,
    exportedChapterCount: 1,
    skippedChapterCount: 1,
  });
  assert.match(currentText, /^\uFEFF可迁移小说\n/);
  assert.match(currentText, /第一部\n\n第一章\n\n平台尚未看到的新正文/);
  assert.doesNotMatch(currentText, /备份测试|可读|节奏|memory|outline/);
  assert.doesNotMatch(currentText, /空章/);

  const publishedPath = join(root, 'published.txt');
  const publishedResult = await store.writeBookManuscriptFile(
    book.id, publishedPath, { source: 'published' },
  );
  const publishedText = await readFile(publishedPath, 'utf8');
  assert.equal(publishedResult.exportedChapterCount, 1);
  assert.equal(publishedResult.skippedChapterCount, 1);
  assert.match(publishedText, /第二版正文/);
  assert.doesNotMatch(publishedText, /平台尚未看到的新正文/);
  assert.equal(empty.title, '空章');
});

test('纯文本发布稿拒绝空作品和非法来源且不保留半成品', async () => {
  const book = await store.createBook({ premise: '空作品', title: '空书' });
  const section = await store.addSection(book.id, {});
  await store.addChapter(book.id, section.id, {});
  const emptyPath = join(root, 'empty.txt');
  await assert.rejects(
    () => store.writeBookManuscriptFile(book.id, emptyPath), /MANUSCRIPT_EMPTY/,
  );
  assert.equal(existsSync(emptyPath), false);
  await assert.rejects(
    () => store.writeBookManuscriptFile(book.id, emptyPath, { source: 'guess' }),
    /BAD_MANUSCRIPT_SOURCE/,
  );
});

test('内存备份按 JSON 分片计数而不再序列化完整备份树', async () => {
  const { book } = await createPopulatedBook();
  const originalStringify = JSON.stringify;
  JSON.stringify = (value, ...args) => {
    if (value && typeof value === 'object'
      && value.format === store.BOOK_BACKUP_FORMAT
      && Array.isArray(value.sections)) {
      throw new Error('WHOLE_BACKUP_STRINGIFY_FORBIDDEN');
    }
    return originalStringify(value, ...args);
  };
  let backup;
  try {
    backup = await store.createBookBackup(book.id);
  } finally {
    JSON.stringify = originalStringify;
  }

  assert.equal(backup.book.id, book.id);
  assert.equal(backup.sections[0].chapters[0].content, '第二版正文');
});

test('分块导出释放规范化前解析树且末尾只流式复核书部引用', async () => {
  const { book, section } = await createPopulatedBook();
  const storedBook = await store.readBook(book.id);
  storedBook.outline = {
    versions: ['大纲标记'.repeat(30_000)],
    cursor: 0,
  };
  await store.writeBook(book.id, storedBook);
  const storedSection = await store.readSection(book.id, section.id);
  storedSection.summary = '分部标记'.repeat(30_000);
  await store.writeSection(book.id, section.id, storedSection);

  const originalJsonParse = JSON.parse;
  const largeParses = { book: 0, section: 0 };
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.length > 64 * 1024) {
      if (text.includes('大纲标记')) largeParses.book += 1;
      if (text.includes('分部标记')) largeParses.section += 1;
    }
    return originalJsonParse(text, ...args);
  };
  const backupPath = join(root, 'projected-final-check.novelbox.json');
  try {
    await store.writeBookBackupFile(book.id, backupPath);
  } finally {
    JSON.parse = originalJsonParse;
  }

  // 恢复预检和正式导出各读取一次主数据；分部只在正式导出读取一次。
  // 末尾快照复核严格扫描完整 JSON，但不再整份 JSON.parse。
  assert.deepEqual(largeParses, { book: 2, section: 1 });
  assert.equal(JSON.parse(await readFile(backupPath, 'utf8')).book.id, book.id);
});

test('备份导出先完成残留删章事务，不导出随后必然消失的章节', async () => {
  const { book, section, chapter } = await createPopulatedBook();
  const transactionPath = join(
    root, 'books', book.id, section.id, '.section-structure-transaction.json',
  );
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-structure-transaction', version: 1,
    type: 'delete-chapter', bookId: book.id, sectionId: section.id,
    chapterId: chapter.id,
  });

  const backupPath = join(root, 'recovered-before-export.novelbox.json');
  await store.writeBookBackupFile(book.id, backupPath);
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));

  assert.deepEqual(backup.sections[0].section.chapters, []);
  assert.deepEqual(backup.sections[0].chapters, []);
  assert.equal(existsSync(transactionPath), false);
  assert.deepEqual((await store.readSection(book.id, section.id)).chapters, []);
  await assert.rejects(
    () => store.readChapter(book.id, section.id, chapter.id),
    /ENOENT/,
  );

  const secondChapter = await store.addChapter(book.id, section.id, {
    title: '内存备份前待删除章',
  });
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-structure-transaction', version: 1,
    type: 'delete-chapter', bookId: book.id, sectionId: section.id,
    chapterId: secondChapter.id,
  });
  const inMemoryBackup = await store.createBookBackup(book.id);
  assert.deepEqual(inMemoryBackup.sections[0].section.chapters, []);
  assert.deepEqual(inMemoryBackup.sections[0].chapters, []);
  assert.equal(existsSync(transactionPath), false);
});

test('分块导出持有整书快照锁，并发诊断与保存只能在备份完成后继续', async () => {
  const { book, section, chapter } = await createPopulatedBook();
  const template = await store.readChapter(book.id, section.id, chapter.id);
  const chapterIds = [];
  const oldLastText = '导出前正文'.repeat(5_000);
  for (let index = 1; index <= 200; index += 1) {
    const chapterId = `chapter-${String(index).padStart(2, '0')}`;
    const text = index === 200 ? oldLastText : `第 ${index} 章正文`.repeat(5_000);
    const stored = {
      ...structuredClone(template),
      id: chapterId,
      index,
      title: `第 ${index} 章`,
      body: { versions: ['', text], cursor: 1 },
      content: text,
      bodyFingerprint: store.contentFingerprint(text),
    };
    delete stored.review;
    writeFileSync(
      join(root, 'books', book.id, section.id, `${chapterId}.json`),
      JSON.stringify(stored),
      'utf8',
    );
    chapterIds.push(chapterId);
  }
  const storedSection = await store.readSection(book.id, section.id);
  storedSection.chapters = chapterIds;
  storedSection.chapterSummaries = {};
  await store.writeSection(book.id, section.id, storedSection, {
    preserveExistingChapters: false,
  });

  const backupPath = join(root, 'locked-snapshot.novelbox.json');
  let exportSettled = false;
  const exporting = store.writeBookBackupFile(book.id, backupPath);
  void exporting.then(
    () => { exportSettled = true; },
    () => { exportSettled = true; },
  );
  for (let attempt = 0; attempt < 1_000 && !existsSync(backupPath); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(existsSync(backupPath), true);
  assert.equal(exportSettled, false);

  // 模拟写入锁持有期间出现的合法事务文件。诊断必须等待同一把整书锁，
  // 不能把仍在进行的事务当作崩溃残留报告给用户。
  const transactionPath = join(
    root, 'books', book.id, '.book-structure-transaction.json',
  );
  const pendingSection = {
    id: 'section-02', index: 2, title: '待提交部', titleSource: 'manual',
    outline: { content: '', history: [] }, characters: [], summary: '', progress: '',
    chapters: [], chapterSummaries: {},
  };
  writeFileSync(transactionPath, JSON.stringify({
    format: 'auto-novel-box-structure-transaction',
    version: 1,
    type: 'add-section',
    bookId: book.id,
    sectionId: pendingSection.id,
    section: pendingSection,
  }), 'utf8');
  let diagnosisSettled = false;
  const diagnosing = store.diagnoseStorage()
    .finally(() => { diagnosisSettled = true; });
  for (let attempt = 0; attempt < 10 && !exportSettled; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(diagnosisSettled, false);
  await rm(transactionPath);

  let saveSettled = false;
  const lastChapterId = chapterIds.at(-1);
  const saving = store.versionSet(
    book.id,
    `section:${section.id}:chapter:${lastChapterId}`,
    '导出期间保存的新正文',
  ).finally(() => { saveSettled = true; });

  await exporting;
  assert.equal(saveSettled, false);
  const diagnostics = await diagnosing;
  assert.equal(diagnostics.ok, true);
  assert.deepEqual(diagnostics.issues, []);
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(
    store.currentText(backup.sections[0].chapters.at(-1).body),
    oldLastText,
  );

  await saving;
  const savedLastChapter = await store.readChapter(book.id, section.id, lastChapterId);
  assert.equal(store.currentText(savedLastChapter.body), '导出期间保存的新正文');
});

test('已取消的备份导出不会继续生成文件', async () => {
  const { book } = await createPopulatedBook();
  const backupPath = join(root, 'cancelled-export.novelbox.json');
  const controller = new AbortController();
  controller.abort(new Error('CLIENT_ABORTED'));

  await assert.rejects(
    () => store.writeBookBackupFile(book.id, backupPath, { signal: controller.signal }),
    /CLIENT_ABORTED/,
  );
  assert.equal(existsSync(backupPath), false);
});

test('已取消的流式导入不会提交书籍或遗留暂存目录', async () => {
  const { book } = await createPopulatedBook();
  const backupPath = join(root, 'cancelled-import.novelbox.json');
  await store.writeBookBackupFile(book.id, backupPath);
  const controller = new AbortController();
  controller.abort(new Error('CLIENT_ABORTED'));

  await assert.rejects(
    () => store.importBookBackupFile(backupPath, { signal: controller.signal }),
    /CLIENT_ABORTED/,
  );
  assert.deepEqual((await store.listBooks()).map((row) => row.id), [book.id]);
  const staged = await readdir(join(root, '.imports'))
    .catch((err) => err?.code === 'ENOENT' ? [] : Promise.reject(err));
  assert.deepEqual(staged, []);
});

test('预备导出在客户端断开后取消后台写入并清理传输目录', async () => {
  let tempRoot;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let observedSignal;
  const registry = createPreparedBackupRegistry();
  const handlers = captureStorageHandlers({
    preparedBackups: registry,
    withBackupTransferSlot: createBackupTransferLimiter(1),
    createTransferTempRoot: async (kind) => {
      tempRoot = await createTransferTempRoot(kind, { tempParent: root });
      return tempRoot;
    },
    writeBookBackupFile: async (id, path, { signal }) => {
      observedSignal = signal;
      notifyStarted();
      await new Promise((resolve, reject) => {
        const cancelled = () => reject(signal.reason);
        if (signal.aborted) cancelled();
        else signal.addEventListener('abort', cancelled, { once: true });
      });
      return { bookId: id };
    },
  });
  const req = Object.assign(new EventEmitter(), {
    aborted: false,
    params: { id: 'book-cancelled' },
  });
  const res = fakeStorageResponse();

  const pending = handlers.get('POST /api/books/:id/backup/prepare')(req, res);
  await started;
  res.destroyed = true;
  res.emit('close');
  await pending;

  assert.equal(observedSignal.aborted, true);
  assert.match(observedSignal.reason.message, /CLIENT_ABORTED/);
  assert.equal(registry.size, 0);
  assert.equal(existsSync(tempRoot), false);
});

test('直接导出断开后不再向已销毁响应发送二次错误', async () => {
  let tempRoot;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const handlers = captureStorageHandlers({
    withBackupTransferSlot: createBackupTransferLimiter(1),
    createTransferTempRoot: async (kind) => {
      tempRoot = await createTransferTempRoot(kind, { tempParent: root });
      return tempRoot;
    },
    writeBookBackupFile: async (id, path, { signal }) => {
      notifyStarted();
      await new Promise((resolve, reject) => {
        const cancelled = () => reject(signal.reason);
        if (signal.aborted) cancelled();
        else signal.addEventListener('abort', cancelled, { once: true });
      });
      return { bookId: id };
    },
  });
  const req = Object.assign(new EventEmitter(), {
    aborted: false,
    params: { id: 'book-direct-cancelled' },
  });
  const res = fakeStorageResponse();

  const pending = handlers.get('GET /api/books/:id/backup')(req, res);
  await started;
  res.destroyed = true;
  res.emit('close');
  await pending;

  assert.equal(res.jsonValue, undefined);
  assert.equal(existsSync(tempRoot), false);
});

test('上传完成后的客户端断开会取消导入并清理上传目录', async () => {
  let tempRoot;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let observedSignal;
  const handlers = captureStorageHandlers({
    withBackupTransferSlot: createBackupTransferLimiter(1),
    createTransferTempRoot: async (kind) => {
      tempRoot = await createTransferTempRoot(kind, { tempParent: root });
      return tempRoot;
    },
    importBookBackupFile: async (path, { signal }) => {
      observedSignal = signal;
      assert.equal(existsSync(path), true);
      notifyStarted();
      await new Promise((resolve, reject) => {
        const cancelled = () => reject(signal.reason);
        if (signal.aborted) cancelled();
        else signal.addEventListener('abort', cancelled, { once: true });
      });
    },
  });
  const req = Object.assign(new EventEmitter(), {
    aborted: false,
    headers: { 'content-type': 'application/octet-stream' },
    params: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); },
  });
  const res = fakeStorageResponse();

  const pending = handlers.get('POST /api/backups/import')(req, res);
  await started;
  res.destroyed = true;
  res.emit('close');
  await pending;

  assert.equal(observedSignal.aborted, true);
  assert.match(observedSignal.reason.message, /CLIENT_ABORTED/);
  assert.equal(existsSync(tempRoot), false);
});

test('非法预分配作品 ID 在读取大体积导入请求前被拒绝', async () => {
  let consumed = false;
  let createdTempRoot = false;
  const handlers = captureStorageHandlers({
    createTransferTempRoot: async () => {
      createdTempRoot = true;
      throw new Error('SHOULD_NOT_CREATE_TEMP_ROOT');
    },
  });
  const req = Object.assign(new EventEmitter(), {
    aborted: false,
    headers: {
      'content-type': 'application/octet-stream',
      'x-novelbox-book-id': '../escape',
    },
    params: {},
    async *[Symbol.asyncIterator]() {
      consumed = true;
      yield Buffer.alloc(1024);
    },
  });
  const res = fakeStorageResponse();

  await handlers.get('POST /api/backups/import')(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.jsonValue, { error: 'BAD_BOOK_CREATION_ID' });
  assert.equal(consumed, false);
  assert.equal(createdTempRoot, false);
});

test('预备导出响应未送达时撤销令牌并清理文件', async () => {
  let tempRoot;
  let notifyCleanup;
  const cleanupDone = new Promise((resolve) => { notifyCleanup = resolve; });
  const registry = createPreparedBackupRegistry({
    cleanupRoot: async (path) => {
      await rm(path, { recursive: true, force: true });
      notifyCleanup();
    },
  });
  const handlers = captureStorageHandlers({
    preparedBackups: registry,
    withBackupTransferSlot: createBackupTransferLimiter(1),
    createTransferTempRoot: async (kind) => {
      tempRoot = await createTransferTempRoot(kind, { tempParent: root });
      return tempRoot;
    },
    writeBookBackupFile: async () => ({ bookId: 'book-undelivered' }),
  });
  const req = Object.assign(new EventEmitter(), {
    aborted: false,
    params: { id: 'book-undelivered' },
  });
  const res = fakeStorageResponse();

  await handlers.get('POST /api/books/:id/backup/prepare')(req, res);
  assert.equal(registry.size, 1);
  assert.equal(existsSync(tempRoot), true);

  res.destroyed = true;
  res.emit('close');
  await cleanupDone;
  assert.equal(registry.size, 0);
  assert.equal(existsSync(tempRoot), false);
});

test('备份导出丢弃未知字段、重建派生字段并遵守可导入大小上限', async () => {
  const { book, section, chapter } = await createPopulatedBook();
  const pollutedBook = await store.readBook(book.id);
  pollutedBook.injected = { secret: 'must-not-export' };
  pollutedBook.outline.injected = 'unknown';
  await store.writeBook(book.id, pollutedBook);
  const pollutedSection = await store.readSection(book.id, section.id);
  pollutedSection.injected = { payload: 'unknown' };
  pollutedSection.index = 999;
  await store.writeSection(book.id, section.id, pollutedSection);
  const pollutedChapter = await store.readChapter(book.id, section.id, chapter.id);
  pollutedChapter.injected = { payload: 'unknown' };
  pollutedChapter.index = 999;
  pollutedChapter.content = '伪造缓存';
  pollutedChapter.bodyFingerprint = '伪造指纹';
  await store.writeChapter(book.id, section.id, chapter.id, pollutedChapter);

  const backupPath = join(root, 'canonical-export.json');
  await store.writeBookBackupFile(book.id, backupPath);
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(Object.hasOwn(backup.book, 'injected'), false);
  assert.equal(Object.hasOwn(backup.book.outline, 'injected'), false);
  assert.equal(Object.hasOwn(backup.sections[0].section, 'injected'), false);
  assert.equal(Object.hasOwn(backup.sections[0].chapters[0], 'injected'), false);
  assert.equal(backup.sections[0].section.index, 1);
  assert.equal(backup.sections[0].chapters[0].index, 1);
  assert.equal(backup.sections[0].chapters[0].content, '第二版正文');
  assert.equal(
    backup.sections[0].chapters[0].bodyFingerprint,
    store.contentFingerprint('第二版正文'),
  );
  await store.importBookBackupFile(backupPath);

  const limitedPath = join(root, 'too-small-export.json');
  await assert.rejects(
    () => store.writeBookBackupFile(book.id, limitedPath, { maxBytes: 200 }),
    /BACKUP_TOO_LARGE/,
  );
  assert.equal(existsSync(limitedPath), false);
});

test('分块备份在引用数据损坏时不留下半成品', async () => {
  const { book, section } = await createPopulatedBook();
  const broken = await store.readSection(book.id, section.id);
  broken.chapters.push('chapter-missing');
  await store.writeSection(book.id, section.id, broken, { preserveExistingChapters: false });
  const backupPath = join(root, 'broken.novelbox.json');

  await assert.rejects(
    () => store.writeBookBackupFile(book.id, backupPath),
    /BACKUP_SECTION_INVALID/,
  );
  assert.equal(existsSync(backupPath), false);
});

test('导入严格校验引用和版本结构，失败时不留下半本书', async () => {
  const { book } = await createPopulatedBook();
  const backup = await store.createBookBackup(book.id);
  backup.sections[0].section.chapters[0] = '../escape';

  await assert.rejects(() => store.importBookBackup(backup), /BACKUP_INVALID/);
  assert.deepEqual((await store.listBooks()).map((row) => row.id), [book.id]);
  assert.equal((await store.diagnoseStorage()).ok, true);
});

test('流式导入在章节落盘中途发现损坏时回滚整个暂存目录', async () => {
  const { book } = await createPopulatedBook();
  const backup = await store.createBookBackup(book.id);
  const validChapter = backup.sections[0].chapters[0];
  const brokenChapter = structuredClone(validChapter);
  brokenChapter.id = 'chapter-02';
  brokenChapter.index = 2;
  brokenChapter.body.cursor = 99;
  backup.sections[0].section.chapters.push(brokenChapter.id);
  backup.sections[0].chapters.push(brokenChapter);
  const backupPath = join(root, 'partially-broken.json');
  writeFileSync(backupPath, JSON.stringify(backup));

  await assert.rejects(() => store.importBookBackupFile(backupPath), /BACKUP_INVALID/);
  assert.deepEqual((await store.listBooks()).map((row) => row.id), [book.id]);
  const staged = await readdir(join(root, '.imports')).catch((err) => err?.code === 'ENOENT' ? [] : Promise.reject(err));
  assert.deepEqual(staged, []);
  assert.equal((await store.diagnoseStorage()).ok, true);
});

test('流式导入支持多章且不依赖备份中章节对象的排列顺序', async () => {
  const chapterIds = Array.from({ length: 40 }, (_, index) => `chapter-${String(index + 1).padStart(2, '0')}`);
  const versioned = { versions: [''], cursor: 0 };
  const backup = {
    format: store.BOOK_BACKUP_FORMAT,
    version: 1,
    exportedAt: '2026-08-05T00:00:00.000Z',
    book: {
      id: 'book-scale', title: '多章测试', titleSource: 'manual', premise: 'p',
      createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z',
      outline: versioned,
      settings: { core: {
        world: versioned, style: versioned, constraints: versioned, pacing: versioned,
      }, history: [] },
      characters: [], summary: '', progress: '', sections: ['section-01'],
    },
    sections: [{
      section: {
        id: 'section-01', index: 1, title: '一', titleSource: 'manual',
        outline: { content: '', history: [] }, characters: [], summary: '', progress: '',
        chapters: chapterIds, chapterSummaries: {},
      },
      chapters: [...chapterIds].reverse().map((id, reversedIndex) => ({
        id,
        index: chapterIds.indexOf(id) + 1,
        title: id,
        titleSource: 'manual',
        body: { versions: ['', `${id}:`.padEnd(4096, String(reversedIndex % 10))], cursor: 1 },
        content: `${id}:`.padEnd(4096, String(reversedIndex % 10)),
        characters: [], summary: '', progress: '', status: 'done',
      })),
    }],
  };
  const backupPath = join(root, 'many-chapters.json');
  writeFileSync(backupPath, JSON.stringify(backup));

  const imported = await store.importBookBackupFile(backupPath, { highWaterMark: 11 });
  const section = await store.readSection(imported.id, 'section-01');
  assert.deepEqual(section.chapters, chapterIds);
  assert.match(store.currentText((await store.readChapter(imported.id, 'section-01', 'chapter-01')).body), /^chapter-01:/);
  assert.match(store.currentText((await store.readChapter(imported.id, 'section-01', 'chapter-40')).body), /^chapter-40:/);
});

test('流式导入逐分部落暂存且不依赖分部包排列顺序', async () => {
  const book = await store.createBook({ premise: '分部重排', title: '分部重排' });
  const firstSection = await store.addSection(book.id, { title: '上部' });
  const firstChapter = await store.addChapter(book.id, firstSection.id, { title: '上章' });
  await store.versionSet(
    book.id, `section:${firstSection.id}:chapter:${firstChapter.id}`, '上部正文',
  );
  const secondSection = await store.addSection(book.id, { title: '下部' });
  const secondChapter = await store.addChapter(book.id, secondSection.id, { title: '下章' });
  await store.versionSet(
    book.id, `section:${secondSection.id}:chapter:${secondChapter.id}`, '下部正文',
  );
  const backup = await store.createBookBackup(book.id);
  backup.sections.reverse();
  const backupPath = join(root, 'reordered-sections.json');
  writeFileSync(backupPath, JSON.stringify(backup));

  const imported = await store.importBookBackupFile(backupPath, { highWaterMark: 13 });

  assert.deepEqual((await store.readBook(imported.id)).sections, [
    firstSection.id, secondSection.id,
  ]);
  assert.equal(
    store.currentText((await store.readChapter(
      imported.id, firstSection.id, firstChapter.id,
    )).body),
    '上部正文',
  );
  assert.equal(
    store.currentText((await store.readChapter(
      imported.id, secondSection.id, secondChapter.id,
    )).body),
    '下部正文',
  );
});

test('备份导入拒绝绕过日常写入上限的正文、标题和元数据', async () => {
  const { book } = await createPopulatedBook();
  const original = await store.createBookBackup(book.id);
  const mutations = [
    (backup) => { backup.book.title = '题'.repeat(MAX_TITLE_CHARS + 1); },
    (backup) => { backup.book.premise = '设'.repeat(MAX_PREMISE_CHARS + 1); },
    (backup) => { backup.book.outline.versions[0] = '纲'.repeat(MAX_VERSION_TEXT_CHARS + 1); },
    (backup) => { backup.sections[0].section.title = '部'.repeat(MAX_TITLE_CHARS + 1); },
    (backup) => { backup.sections[0].section.outline.content = '纲'.repeat(MAX_VERSION_TEXT_CHARS + 1); },
    (backup) => { backup.sections[0].chapters[0].title = '章'.repeat(MAX_TITLE_CHARS + 1); },
    (backup) => { backup.sections[0].chapters[0].body.versions[0] = '文'.repeat(MAX_VERSION_TEXT_CHARS + 1); },
    (backup) => {
      backup.sections[0].chapters[0].characters = [{
        name: '人', role: '角色', desc: '长'.repeat(MAX_CHARACTER_DESC_CHARS + 1),
      }];
    },
    (backup) => {
      backup.sections[0].chapters[0].review.suggestions[0].instruction =
        '改'.repeat(MAX_REVIEW_INSTRUCTION_CHARS + 1);
    },
    (backup) => {
      backup.sections[0].chapters[0].review.webFictionChecks[0].detail =
        '长'.repeat(MAX_REVIEW_CHECK_DETAIL_CHARS + 1);
    },
    (backup) => {
      backup.sections[0].chapters[0].review.webFictionChecks.splice(-2);
    },
    (backup) => {
      backup.sections[0].chapters[0].review.webFictionSignals.conflictType =
        '长'.repeat(MAX_REVIEW_SIGNAL_CHARS + 1);
    },
    (backup) => {
      delete backup.sections[0].chapters[0].review.webFictionSignals.dominantMode;
    },
  ];

  for (const mutate of mutations) {
    const backup = structuredClone(original);
    mutate(backup);
    await assert.rejects(() => store.importBookBackup(backup), /BACKUP_INVALID/);
  }
  assert.deepEqual((await store.listBooks()).map((row) => row.id), [book.id]);

  const streamed = structuredClone(original);
  streamed.sections[0].chapters[0].body.versions[0] =
    '文'.repeat(MAX_VERSION_TEXT_CHARS + 1);
  const backupPath = join(root, 'oversized-chapter.json');
  writeFileSync(backupPath, JSON.stringify(streamed));
  await assert.rejects(() => store.importBookBackupFile(backupPath), /BACKUP_INVALID/);
  assert.deepEqual((await store.listBooks()).map((row) => row.id), [book.id]);
  assert.deepEqual(await readdir(join(root, '.imports')).catch((err) =>
    err?.code === 'ENOENT' ? [] : Promise.reject(err)), []);
});

test('流式导入在分配前拒绝超过本地章节文件上限的对象跨度', async () => {
  const { book } = await createPopulatedBook();
  const backup = await store.createBookBackup(book.id);
  // 已知字段均合法，但未知填充使单章超过 32 MiB。
  // 若先随机读取再丢弃未知字段，会产生接近整份备份的瞬时分配。
  backup.sections[0].chapters[0].padding = 'x'.repeat(MAX_CHAPTER_JSON_BYTES);
  const backupPath = join(root, 'oversized-chapter-span.json');
  writeFileSync(backupPath, JSON.stringify(backup));

  const originalAllocUnsafe = Buffer.allocUnsafe;
  let oversizedAllocations = 0;
  Buffer.allocUnsafe = (size, ...args) => {
    if (Number(size) > 2 * 1024 * 1024) {
      oversizedAllocations += 1;
      throw new Error('OVERSIZED_RANDOM_READ_ALLOCATION');
    }
    return originalAllocUnsafe(size, ...args);
  };
  try {
    await assert.rejects(
      () => store.importBookBackupFile(backupPath),
      /BACKUP_INVALID/,
    );
  } finally {
    Buffer.allocUnsafe = originalAllocUnsafe;
  }
  assert.equal(oversizedAllocations, 0);
  assert.deepEqual((await store.listBooks()).map((row) => row.id), [book.id]);
  assert.deepEqual(await readdir(join(root, '.imports')).catch((err) =>
    err?.code === 'ENOENT' ? [] : Promise.reject(err)), []);
});

test('内存和流式备份导入只落盘已知字段并重建派生数据', async () => {
  const { book, section, chapter } = await createPopulatedBook();
  const original = await store.createBookBackup(book.id);
  original.book.injected = { apiKey: 'must-not-persist' };
  original.book.settings.injected = 'unknown';
  original.book.outline.injected = 'unknown';
  original.sections[0].section.injected = { payload: 'unknown' };
  original.sections[0].section.index = 999;
  original.sections[0].section.chapterSummaries.unreferenced = {
    index: 999, summary: '不可见摘要', injected: true,
  };
  Object.defineProperty(original.sections[0].section.chapterSummaries, '__proto__', {
    value: { summary: '原型污染' }, enumerable: true,
  });
  original.sections[0].chapters[0].injected = { payload: 'unknown' };
  original.sections[0].chapters[0].index = 999;
  original.sections[0].chapters[0].content = '伪造缓存';
  original.sections[0].chapters[0].bodyFingerprint = '伪造指纹';
  original.sections[0].chapters[0].body.injected = 'unknown';
  original.sections[0].chapters[0].review.injected = 'unknown';

  const verify = async (imported) => {
    const importedBook = await store.readBook(imported.id);
    const importedSection = await store.readSection(imported.id, section.id);
    const importedChapter = await store.readChapter(imported.id, section.id, chapter.id);
    assert.equal(Object.hasOwn(importedBook, 'injected'), false);
    assert.equal(Object.hasOwn(importedBook.settings, 'injected'), false);
    assert.equal(Object.hasOwn(importedBook.outline, 'injected'), false);
    assert.equal(Object.hasOwn(importedSection, 'injected'), false);
    assert.equal(Object.hasOwn(importedSection.chapterSummaries, 'unreferenced'), false);
    assert.equal(Object.hasOwn(importedSection.chapterSummaries, '__proto__'), false);
    assert.equal(Object.hasOwn(importedChapter, 'injected'), false);
    assert.equal(Object.hasOwn(importedChapter.body, 'injected'), false);
    assert.equal(Object.hasOwn(importedChapter.review, 'injected'), false);
    assert.equal(importedSection.index, 1);
    assert.equal(importedChapter.index, 1);
    assert.equal(importedChapter.content, '第二版正文');
    assert.equal(importedChapter.bodyFingerprint, store.contentFingerprint('第二版正文'));
  };

  await verify(await store.importBookBackup(structuredClone(original)));
  const backupPath = join(root, 'unknown-fields.json');
  writeFileSync(backupPath, JSON.stringify(original));
  await verify(await store.importBookBackupFile(backupPath, { highWaterMark: 9 }));
});

test('内存和流式备份导入拒绝会覆盖 section.json 的章节 ID', async () => {
  const { book } = await createPopulatedBook();
  const original = await store.createBookBackup(book.id);
  const conflicting = structuredClone(original);
  conflicting.sections[0].section.chapters = ['section'];
  conflicting.sections[0].chapters[0].id = 'section';

  await assert.rejects(() => store.importBookBackup(conflicting), /BACKUP_INVALID/);

  const backupPath = join(root, 'conflicting-chapter-id.json');
  writeFileSync(backupPath, JSON.stringify(conflicting));
  await assert.rejects(
    () => store.importBookBackupFile(backupPath, { highWaterMark: 9 }),
    /BACKUP_INVALID/,
  );
  assert.deepEqual((await store.listBooks()).map((row) => row.id), [book.id]);
});

test('内存和流式备份导入拒绝大小写不同但文件路径相同的 ID', async () => {
  const { book } = await createPopulatedBook();
  const original = await store.createBookBackup(book.id);
  const sectionId = original.book.sections[0];
  const chapterId = original.sections[0].section.chapters[0];

  const chapterCollision = structuredClone(original);
  chapterCollision.sections[0].section.chapters.push(chapterId.toUpperCase());
  chapterCollision.sections[0].chapters.push({
    ...structuredClone(chapterCollision.sections[0].chapters[0]),
    id: chapterId.toUpperCase(),
  });

  const sectionCollision = structuredClone(original);
  sectionCollision.book.sections.push(sectionId.toUpperCase());
  sectionCollision.sections.push({
    ...structuredClone(sectionCollision.sections[0]),
    section: {
      ...structuredClone(sectionCollision.sections[0].section),
      id: sectionId.toUpperCase(),
    },
  });

  for (const [name, conflicting] of [
    ['chapter-case-collision', chapterCollision],
    ['section-case-collision', sectionCollision],
  ]) {
    await assert.rejects(() => store.importBookBackup(conflicting), /BACKUP_INVALID/);
    const backupPath = join(root, `${name}.json`);
    writeFileSync(backupPath, JSON.stringify(conflicting));
    await assert.rejects(
      () => store.importBookBackupFile(backupPath, { highWaterMark: 9 }),
      /BACKUP_INVALID/,
    );
  }
  assert.deepEqual((await store.listBooks()).map((row) => row.id), [book.id]);
});

test('清理导入暂存目录保留超龄活跃所有者，只删除失联或可确认复用的旧目录', async () => {
  const tempParent = join(root, '.imports');
  const nowMs = Date.parse('2026-08-05T12:00:00.000Z');
  const dead = 'book_20260805000000000_deadbeefcafe_11111111111111111111111111111111';
  const live = 'book_20260805000000001_deadbeefcafe_22222222222222222222222222222222';
  const legacy = 'book_20260805000000002_deadbeefcafe_33333333333333333333333333333333';
  const reused = 'book_20260805000000003_deadbeefcafe_44444444444444444444444444444444';
  const otherLive = 'book_20260805000000004_deadbeefcafe_55555555555555555555555555555555';
  const otherReused = 'book_20260805000000005_deadbeefcafe_77777777777777777777777777777777';
  const requestedDead = `book_${'a'.repeat(32)}_${'6'.repeat(32)}`;
  const unrelated = 'user-folder';
  for (const name of [
    dead, live, legacy, reused, otherLive, otherReused, requestedDead, unrelated,
  ]) {
    mkdirSync(join(tempParent, name), { recursive: true });
  }
  writeFileSync(join(tempParent, dead, '.import-owner.json'), JSON.stringify({
    format: 'auto-novel-box-import-staging', pid: 111,
    startedAt: new Date(nowMs - 1_000).toISOString(),
  }));
  writeFileSync(join(tempParent, live, '.import-owner.json'), JSON.stringify({
    format: 'auto-novel-box-import-staging', pid: 222,
    startedAt: new Date(nowMs - 20_000).toISOString(),
    processStartedAt: new Date(nowMs - 30_000).toISOString(),
  }));
  writeFileSync(join(tempParent, reused, '.import-owner.json'), JSON.stringify({
    format: 'auto-novel-box-import-staging', pid: 222,
    startedAt: new Date(nowMs - 20_000).toISOString(),
    processStartedAt: new Date(nowMs - 40_000).toISOString(),
  }));
  writeFileSync(join(tempParent, otherLive, '.import-owner.json'), JSON.stringify({
    format: 'auto-novel-box-import-staging', pid: 444,
    startedAt: new Date(nowMs - 20_000).toISOString(),
    processStartedAt: new Date(nowMs - 30_000).toISOString(),
  }));
  writeFileSync(join(tempParent, otherReused, '.import-owner.json'), JSON.stringify({
    format: 'auto-novel-box-import-staging', pid: 555,
    startedAt: new Date(nowMs - 20_000).toISOString(),
    processStartedAt: new Date(nowMs - 40_000).toISOString(),
  }));
  writeFileSync(join(tempParent, requestedDead, '.import-owner.json'), JSON.stringify({
    format: 'auto-novel-box-import-staging', pid: 111,
    startedAt: new Date(nowMs - 20_000).toISOString(),
  }));
  await utimes(join(tempParent, legacy), new Date(nowMs - 20_000), new Date(nowMs - 20_000));

  const cleanup = await store.cleanupAbandonedImports({
    nowMs,
    maxAgeMs: 10_000,
    processAlive: (pid) => [222, 444, 555].includes(pid),
    processStartedAtForPid: async (pid) => ({
      222: nowMs - 30_000,
      444: nowMs - 30_000,
      555: nowMs - 5_000,
    })[pid] ?? null,
    currentPid: 222,
    currentProcessStartedAtMs: nowMs - 30_000,
  });

  assert.equal(cleanup.removed, 5);
  assert.deepEqual((await readdir(tempParent)).sort(), [live, otherLive, unrelated].sort());
});

test('备份上传按流落盘并在超限或空请求时删除半成品', async () => {
  const savedPath = join(root, 'upload-ok.json');
  const request = Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]);
  request.headers = {};
  assert.equal(await writeRequestBodyToFile(request, savedPath, { maxBytes: 20 }), 7);
  assert.equal(await readFile(savedPath, 'utf8'), '{"a":1}');
  assert.equal((await stat(savedPath)).mode & 0o777, 0o600);

  const oversizedPath = join(root, 'upload-large.json');
  const oversized = Readable.from([Buffer.from('123'), Buffer.from('456')]);
  oversized.headers = {};
  await assert.rejects(
    () => writeRequestBodyToFile(oversized, oversizedPath, { maxBytes: 5 }),
    /BACKUP_TOO_LARGE/,
  );
  assert.equal(existsSync(oversizedPath), false);

  const emptyPath = join(root, 'upload-empty.json');
  const empty = Readable.from([]);
  empty.headers = {};
  await assert.rejects(() => writeRequestBodyToFile(empty, emptyPath), /BACKUP_INVALID/);
  assert.equal(existsSync(emptyPath), false);

  const interruptedPath = join(root, 'upload-interrupted.json');
  const interrupted = Readable.from((async function* interruptedUpload() {
    yield Buffer.from('{"partial":');
    throw new Error('UPLOAD_ABORTED');
  }()));
  interrupted.headers = {};
  await assert.rejects(() => writeRequestBodyToFile(interrupted, interruptedPath), /UPLOAD_ABORTED/);
  assert.equal(existsSync(interruptedPath), false);

  const sparsePath = join(root, 'oversized-sparse.json');
  writeFileSync(sparsePath, '');
  await truncate(sparsePath, store.BOOK_BACKUP_MAX_BYTES + 1);
  await assert.rejects(() => store.importBookBackupFile(sparsePath), /BACKUP_TOO_LARGE/);
  await rm(sparsePath);
});

test('备份传输临时目录保留活跃所有者，只清理失联、旧进程或无主过期目录', async () => {
  const tempParent = join(root, 'system-temp');
  mkdirSync(tempParent);
  const nowMs = Date.parse('2026-08-05T12:00:00.000Z');
  const currentProcessStartedAt = '2026-08-05T11:00:00.000Z';
  const priorProcessStartedAt = '2026-08-04T11:00:00.000Z';
  const live = await createTransferTempRoot('upload', {
    tempParent, pid: 222, nowMs, processStartedAt: currentProcessStartedAt,
  });
  const dead = await createTransferTempRoot('export', {
    tempParent, pid: 111, nowMs, processStartedAt: currentProcessStartedAt,
  });
  const activeExpired = await createTransferTempRoot('export', {
    tempParent,
    pid: 333,
    nowMs: nowMs - 2 * 24 * 60 * 60 * 1000,
    processStartedAt: priorProcessStartedAt,
  });
  const reusedCurrentPid = await createTransferTempRoot('upload', {
    tempParent, pid: 444, nowMs, processStartedAt: priorProcessStartedAt,
  });
  const reusedOtherPid = await createTransferTempRoot('export', {
    tempParent, pid: 555, nowMs, processStartedAt: priorProcessStartedAt,
  });
  const probeUnavailable = await createTransferTempRoot('upload', {
    tempParent,
    pid: 666,
    nowMs: nowMs - 2 * 24 * 60 * 60 * 1000,
    processStartedAt: priorProcessStartedAt,
  });
  const staleLegacy = join(tempParent, 'novelbox-export-Ab12Cd');
  const freshLegacy = join(tempParent, 'novelbox-upload-Ef34Gh');
  const unrelated = join(tempParent, 'user-folder');
  for (const path of [staleLegacy, freshLegacy, unrelated]) mkdirSync(path);
  const staleTime = new Date(nowMs - 2 * 24 * 60 * 60 * 1000);
  await utimes(staleLegacy, staleTime, staleTime);
  const freshTime = new Date(nowMs - 60 * 1000);
  await utimes(freshLegacy, freshTime, freshTime);

  const ownerPath = join(live, '.transfer-owner.json');
  assert.equal((await stat(live)).mode & 0o777, 0o700);
  assert.equal((await stat(ownerPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(ownerPath, 'utf8')), {
    format: 'auto-novel-box-transfer',
    kind: 'upload',
    pid: 222,
    createdAt: nowMs,
    processStartedAt: currentProcessStartedAt,
  });

  const cleanup = await cleanupAbandonedTransferDirs({
    tempParent,
    nowMs,
    maxAgeMs: 24 * 60 * 60 * 1000,
    processAlive: (pid) => [222, 333, 444, 555, 666].includes(pid),
    processStartedAtForPid: async (pid) => ({
      222: Date.parse(currentProcessStartedAt),
      333: Date.parse(priorProcessStartedAt),
      555: Date.parse(currentProcessStartedAt),
    })[pid] ?? null,
    currentPid: 444,
    currentProcessStartedAt,
  });

  assert.equal(cleanup.removed, 4);
  assert.equal(cleanup.truncated, false);
  assert.deepEqual((await readdir(tempParent)).sort(), [
    basename(live), basename(activeExpired), basename(probeUnavailable),
    basename(freshLegacy), basename(unrelated),
  ].sort());
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(reusedCurrentPid), false);
  assert.equal(existsSync(reusedOtherPid), false);
  assert.equal(existsSync(staleLegacy), false);
});

test('默认备份传输只使用当前数据根下的私有专用目录', async () => {
  const transferRoot = await createTransferTempRoot('upload');
  const transferParent = join(root, '.transfers');
  assert.equal(dirname(transferRoot), transferParent);
  assert.equal((await stat(transferParent)).mode & 0o777, 0o700);
  assert.equal((await stat(transferRoot)).mode & 0o777, 0o700);

  const cleanup = await cleanupAbandonedTransferDirs({
    processAlive: () => false,
    currentPid: process.pid + 1,
  });
  assert.deepEqual(cleanup, { removed: 1, scannedEntries: 1, truncated: false });
  assert.deepEqual(await readdir(transferParent), []);
});

test('默认备份残留清理不跟随 data/.transfers 符号链接', async () => {
  const outside = makeTestTempDir('novelbox-transfer-outside-');
  const stale = join(outside, 'novelbox-export-Aa11Bb');
  mkdirSync(stale);
  symlinkSync(outside, join(root, '.transfers'), 'dir');

  await assert.rejects(
    () => cleanupAbandonedTransferDirs(),
    /STORAGE_PATH_UNSAFE/,
  );
  assert.equal(existsSync(stale), true);
});

test('备份传输残留清理对专用临时目录执行有界扫描', async () => {
  const tempParent = join(root, 'bounded-system-temp');
  mkdirSync(tempParent);
  const stale = [
    join(tempParent, 'novelbox-export-Aa11Bb'),
    join(tempParent, 'novelbox-upload-Cc22Dd'),
  ];
  for (const path of stale) mkdirSync(path);
  const nowMs = Date.parse('2026-08-05T12:00:00.000Z');
  const staleTime = new Date(nowMs - 2 * 24 * 60 * 60 * 1000);
  for (const path of stale) await utimes(path, staleTime, staleTime);

  const cleanup = await cleanupAbandonedTransferDirs({
    tempParent,
    nowMs,
    maxEntries: 1,
  });

  assert.deepEqual(cleanup, { removed: 1, scannedEntries: 1, truncated: true });
  assert.equal((await readdir(tempParent)).length, 1);
});

test('预备备份令牌有容量上限、只可领取一次并在过期时清理文件', async () => {
  const firstRoot = join(root, 'prepared-first');
  const secondRoot = join(root, 'prepared-second');
  mkdirSync(firstRoot);
  mkdirSync(secondRoot);
  const registry = createPreparedBackupRegistry({
    ttlMs: 60_000,
    maxEntries: 1,
    createToken: () => 'token-1',
  });
  const record = { root: firstRoot, path: join(firstRoot, 'backup.json'), filename: 'a.json' };
  const token = registry.register(record);

  assert.equal(token, 'token-1');
  assert.equal(registry.size, 1);
  assert.equal(registry.peek(token), record);
  assert.throws(
    () => registry.register({ root: secondRoot, path: 'b', filename: 'b.json' }),
    /BACKUP_EXPORT_BUSY/,
  );
  assert.equal(registry.take(token), record);
  assert.equal(registry.take(token), null);
  assert.equal(registry.size, 0);

  const expiringToken = registry.register({
    root: secondRoot, path: join(secondRoot, 'backup.json'), filename: 'b.json',
  });
  assert.equal(await registry.expire(expiringToken), true);
  assert.equal(await registry.expire(expiringToken), false);
  assert.equal(existsSync(secondRoot), false);

  const thirdRoot = makeTestTempDir('novelbox-prepared-third-');
  registry.register({ root: thirdRoot, path: 'c', filename: 'c.json' });
  assert.equal(await registry.clear(), 1);
  assert.equal(registry.size, 0);
  assert.equal(existsSync(thirdRoot), false);
});

test('预备备份注册表清空会等待已移除条目的在途目录清理', async () => {
  let releaseCleanup;
  const cleanupPending = new Promise((resolve) => { releaseCleanup = resolve; });
  const registry = createPreparedBackupRegistry({
    ttlMs: 60_000,
    maxEntries: 1,
    cleanupRoot: async () => { await cleanupPending; },
  });
  const token = registry.register({ root: '/private/pending', path: 'backup', filename: 'a.json' });
  const expiring = registry.expire(token);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.size, 0);
  assert.equal(registry.canRegister(), false);
  assert.throws(
    () => registry.register({ root: '/private/other', path: 'backup', filename: 'b.json' }),
    /BACKUP_EXPORT_BUSY/,
  );

  let cleared = false;
  const clearing = registry.clear().then((count) => {
    cleared = true;
    return count;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleared, false);

  releaseCleanup();
  assert.equal(await expiring, true);
  assert.equal(await clearing, 0);
  assert.equal(cleared, true);
  assert.equal(registry.canRegister(), true);
});

test('备份传输限制器拒绝超额并在成功或失败后释放名额', async () => {
  const run = createBackupTransferLimiter(1);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const first = run(async () => {
    await pending;
    return 'done';
  });

  await assert.rejects(() => run(async () => 'overflow'), /BACKUP_EXPORT_BUSY/);
  release();
  assert.equal(await first, 'done');
  await assert.rejects(() => run(async () => { throw new Error('FAILED'); }), /FAILED/);
  assert.equal(await run(async () => 'reused'), 'reused');
});

test('慢速上传只占上传槽，不阻塞已就绪的备份导出', async () => {
  let releaseUpload;
  const uploadPaused = new Promise((resolve) => { releaseUpload = resolve; });
  let notifyChunk;
  const firstChunkRead = new Promise((resolve) => { notifyChunk = resolve; });
  const registry = createPreparedBackupRegistry();
  const handlers = captureStorageHandlers({
    preparedBackups: registry,
    withBackupTransferSlot: createBackupTransferLimiter(1),
    withBackupUploadSlot: createBackupTransferLimiter(1),
    createTransferTempRoot: (kind) => createTransferTempRoot(kind, { tempParent: root }),
    writeBookBackupFile: async () => ({ bookId: 'book-ready' }),
    importBookBackupFile: async () => ({ id: 'book-imported' }),
  });
  const importReq = Object.assign(new EventEmitter(), {
    aborted: false,
    headers: { 'content-type': 'application/octet-stream' },
    params: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{');
      notifyChunk();
      await uploadPaused;
      yield Buffer.from('}');
    },
  });
  const importRes = fakeStorageResponse();
  const importing = handlers.get('POST /api/backups/import')(importReq, importRes);
  await firstChunkRead;
  await new Promise((resolve) => setImmediate(resolve));

  const exportReq = Object.assign(new EventEmitter(), {
    aborted: false,
    params: { id: 'book-ready' },
  });
  const exportRes = fakeStorageResponse();
  try {
    await handlers.get('POST /api/books/:id/backup/prepare')(exportReq, exportRes);
  } finally {
    releaseUpload();
    await importing;
  }
  assert.match(exportRes.jsonValue?.downloadUrl || '', /^\/api\/backups\/download\//);
  assert.equal(importRes.jsonValue?.id, 'book-imported');
  await registry.clear();
});

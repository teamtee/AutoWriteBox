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

test('备份 HTTP 导出可下载，导入后新增副本且错误始终返回 JSON', async () => {
  await store.writeConfig({ apiKey: 'sk-never-export' });
  const { book } = await createPopulatedBook();
  const started = await startTestServer(createApp());
  try {
    const exported = await fetch(`${started.base}/api/books/${book.id}/backup`);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type') || '', /application\/json/);
    assert.equal(
      exported.headers.get('content-disposition'),
      `attachment; filename="${book.id}.novelbox.json"`,
    );
    const bytes = await exported.text();
    assert.doesNotMatch(bytes, /sk-never-export/);

    const preparedResponse = await fetch(
      `${started.base}/api/books/${book.id}/backup/prepare`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    assert.equal(preparedResponse.status, 200);
    const prepared = await preparedResponse.json();
    assert.match(prepared.downloadUrl, /^\/api\/backups\/download\/[0-9a-f-]{36}$/i);
    const preparedHead = await fetch(started.base + prepared.downloadUrl, { method: 'HEAD' });
    assert.equal(preparedHead.status, 200);
    assert.ok(Number(preparedHead.headers.get('content-length')) > 0);
    assert.equal(
      preparedHead.headers.get('content-disposition'),
      `attachment; filename="${book.id}.novelbox.json"`,
    );
    const preparedDownload = await fetch(started.base + prepared.downloadUrl);
    assert.equal(preparedDownload.status, 200);
    const preparedBytes = await preparedDownload.text();
    assert.doesNotMatch(preparedBytes, /sk-never-export/);
    const preparedBackup = JSON.parse(preparedBytes);
    assert.equal(preparedBackup.format, store.BOOK_BACKUP_FORMAT);
    assert.equal(preparedBackup.book.id, book.id);
    const repeatedDownload = await fetch(started.base + prepared.downloadUrl);
    assert.equal(repeatedDownload.status, 404);
    assert.deepEqual(await repeatedDownload.json(), { error: 'BACKUP_DOWNLOAD_NOT_FOUND' });

    const manuscriptPrepared = await fetch(
      `${started.base}/api/books/${book.id}/manuscript/prepare`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'current' }),
      },
    );
    assert.equal(manuscriptPrepared.status, 200);
    const manuscriptInfo = await manuscriptPrepared.json();
    assert.equal(manuscriptInfo.source, 'current');
    assert.equal(manuscriptInfo.totalChapterCount, 1);
    assert.equal(manuscriptInfo.exportedChapterCount, 1);
    assert.equal(manuscriptInfo.skippedChapterCount, 0);
    const manuscriptHead = await fetch(
      started.base + manuscriptInfo.downloadUrl, { method: 'HEAD' },
    );
    assert.match(manuscriptHead.headers.get('content-type') || '', /text\/plain/);
    assert.equal(
      manuscriptHead.headers.get('content-disposition'),
      `attachment; filename="${book.id}.current.txt"`,
    );
    const manuscriptDownload = await fetch(started.base + manuscriptInfo.downloadUrl);
    assert.equal(manuscriptDownload.status, 200);
    assert.match(manuscriptDownload.headers.get('content-type') || '', /text\/plain/);
    const manuscriptText = await manuscriptDownload.text();
    assert.match(manuscriptText, /可迁移小说/);
    assert.match(manuscriptText, /第一章\n\n第二版正文/);
    assert.doesNotMatch(manuscriptText, /备份测试|sk-never-export|webFictionChecks/);

    const badManuscript = await fetch(
      `${started.base}/api/books/${book.id}/manuscript/prepare`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'unknown' }),
      },
    );
    assert.equal(badManuscript.status, 400);
    assert.deepEqual(await badManuscript.json(), { error: 'BAD_MANUSCRIPT_SOURCE' });

    const tooLarge = await requestWithDeclaredLength(started.base, store.BOOK_BACKUP_MAX_BYTES + 1);
    assert.equal(tooLarge.status, 413);
    assert.equal(JSON.parse(tooLarge.body).error, 'BACKUP_TOO_LARGE');

    const requestedBookId = `book_${'b'.repeat(32)}`;
    const imported = await fetch(`${started.base}/api/backups/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Novelbox-Book-Id': requestedBookId,
      },
      body: bytes,
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).id, requestedBookId);
    assert.equal((await store.listBooks()).length, 2);

    const collision = await fetch(`${started.base}/api/backups/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Novelbox-Book-Id': requestedBookId,
      },
      body: bytes,
    });
    assert.equal(collision.status, 409);
    assert.deepEqual(await collision.json(), { error: 'BOOK_ALREADY_EXISTS' });
    assert.equal((await store.listBooks()).length, 2);

    const invalidRequestedId = await fetch(`${started.base}/api/backups/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Novelbox-Book-Id': '../escape',
      },
      body: bytes,
    });
    assert.equal(invalidRequestedId.status, 400);
    assert.deepEqual(await invalidRequestedId.json(), { error: 'BAD_BOOK_CREATION_ID' });
    assert.equal((await store.listBooks()).length, 2);

    const malformed = await fetch(`${started.base}/api/backups/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: '{bad json',
    });
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers.get('content-type') || '', /application\/json/);
    assert.equal((await malformed.json()).error, 'BACKUP_INVALID_JSON');
    assert.equal((await store.listBooks()).length, 2);

    const invalidBackup = JSON.parse(bytes);
    invalidBackup.sections[0].section.chapters[0] = '../escape';
    const invalid = await fetch(`${started.base}/api/backups/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: JSON.stringify(invalidBackup),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'BACKUP_INVALID');
    assert.equal((await store.listBooks()).length, 2);
    assert.equal((await store.diagnoseStorage()).ok, true);
  } finally {
    await stopTestServer(started.server);
  }
});

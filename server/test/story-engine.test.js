import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.js';
import { createApp } from '../index.js';
import {
  emptyStoryEngine, normalizeStoryEngine, storyEngineRevision, storyEngineView,
} from '../story-engine-schema.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';
import { startTestServer, stopTestServer } from './http-test-server.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-story-engine-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

const engineInput = {
  readerExperience: '看文明在绝境中意外进化',
  protagonistAction: '观察、推演并选择是否干预',
  progression: '获得能量和更精细的干预权限',
  cost: '每次干预都会在现实制造新的道德债务',
  escalation: '从单一聚落升级到多文明与现实战争互相影响',
};

test('作品核心循环规范化、修订号和字段边界稳定', () => {
  const normalized = normalizeStoryEngine({
    ...engineInput, readerExperience: `  ${engineInput.readerExperience}  `,
  });
  assert.deepEqual(normalized, engineInput);
  assert.match(storyEngineRevision(normalized), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(storyEngineView(normalized).isEmpty, false);
  assert.equal(storyEngineView(emptyStoryEngine()).isEmpty, true);
  assert.throws(
    () => normalizeStoryEngine({ readerExperience: '长'.repeat(501) }),
    /STORY_ENGINE_TOO_LARGE/,
  );
  assert.throws(
    () => normalizeStoryEngine({ protagonistAction: 42 }),
    /BAD_STORY_ENGINE/,
  );
});

test('核心循环保存使用独立修订号并使章节生成与审稿旧上下文失效', async () => {
  const book = await store.createBook({ premise: '文明沙盘' });
  const section = await store.addSection(book.id, {});
  const chapter = await store.addChapter(book.id, section.id, {});
  const beforeGeneration = await store.readChapterGenerationContext(
    book.id, section.id, chapter.id,
  );
  const beforeReview = await store.readChapterReviewContext(book.id, section.id, chapter.id);
  const initial = storyEngineView((await store.readBook(book.id)).settings.storyEngine);
  const saved = await store.saveStoryEngine(book.id, engineInput, {
    expectedRevision: initial.revision,
  });
  assert.equal(saved.progression, engineInput.progression);
  assert.notEqual(saved.revision, initial.revision);
  const afterGeneration = await store.readChapterGenerationContext(
    book.id, section.id, chapter.id,
  );
  const afterReview = await store.readChapterReviewContext(book.id, section.id, chapter.id);
  assert.notEqual(afterGeneration.contextRevision, beforeGeneration.contextRevision);
  assert.notEqual(afterReview.contextRevision, beforeReview.contextRevision);
  await assert.rejects(
    () => store.saveStoryEngine(book.id, { ...engineInput, cost: '旧页面覆盖' }, {
      expectedRevision: initial.revision,
    }),
    /STORY_ENGINE_CONFLICT/,
  );
});

test('核心循环 HTTP 返回修订视图并拒绝陈旧页面覆盖', async () => {
  const started = await startTestServer(createApp());
  try {
    const book = await store.createBook({ premise: '循环接口测试' });
    const treePath = `/api/books/${book.id}/tree`;
    const loaded = await (await fetch(started.base + treePath)).json();
    assert.equal(loaded.book.settings.storyEngine.isEmpty, true);
    const save = (storyEngine, expectedRevision) => fetch(
      `${started.base}/api/books/${book.id}/story-engine`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storyEngine, expectedRevision }),
      },
    );
    const savedResponse = await save(engineInput, loaded.book.settings.storyEngine.revision);
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.readerExperience, engineInput.readerExperience);
    const stale = await save(
      { ...engineInput, escalation: '旧页面版本' },
      loaded.book.settings.storyEngine.revision,
    );
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: 'STORY_ENGINE_CONFLICT' });
  } finally {
    await stopTestServer(started.server);
  }
});

test('作品备份完整保留核心循环', async () => {
  const book = await store.createBook({ premise: '循环备份' });
  const initial = storyEngineView((await store.readBook(book.id)).settings.storyEngine);
  await store.saveStoryEngine(book.id, engineInput, { expectedRevision: initial.revision });
  const backup = await store.createBookBackup(book.id);
  assert.deepEqual(backup.book.settings.storyEngine, engineInput);
  const importedBook = await store.importBookBackup(backup);
  const imported = await store.readBook(importedBook.id);
  assert.deepEqual(imported.settings.storyEngine, engineInput);
});

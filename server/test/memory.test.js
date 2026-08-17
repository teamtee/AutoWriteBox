import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as store from '../store.js';
import { buildContext } from '../prompts.js';
import {
  generationChapterMemorySelection, generationMemoryRows, generationMemorySelection,
} from '../generation-context.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-memory-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

async function createChapterWithText(text = '林越发动回溯，但明确说今天只能再用一次。') {
  const book = await store.createBook({ premise: '长期记忆测试', title: '记忆之书' });
  const section = await store.addSection(book.id, {});
  const chapter = await store.addChapter(book.id, section.id, {});
  await store.versionSet(book.id, `section:${section.id}:chapter:${chapter.id}`, text);
  return { bookId: book.id, sectionId: section.id, chapterId: chapter.id };
}

const abilityCandidate = (object = '每天最多使用两次') => ({
  kind: 'ability', subject: '林越', predicate: '回溯使用上限', object,
  evidence: '人物明确说明当日剩余次数', importance: 5,
  details: {
    eventType: 'used', limitation: object, time: '当日', location: '北港钟楼',
  },
});

function activeMemoryFact(index, overrides = {}) {
  return {
    id: `fact-${index}`, kind: 'item', subject: `普通物品${index}`,
    predicate: '当前状态', object: `完好且由守卫保管${index}`,
    evidence: '历史正文证据', importance: 5, status: 'active',
    source: { chapterIndex: index + 1 },
    updatedAt: new Date(Date.UTC(2026, 0, Math.min(28, index + 1))).toISOString(),
    ...overrides,
  };
}

async function extractCandidates(target, candidates) {
  const chapter = await store.readChapter(
    target.bookId, target.sectionId, target.chapterId,
  );
  return store.applyChapterDigest(
    target.bookId, target.sectionId, target.chapterId,
    {
      summary: '林越使用回溯', progress: '继续调查', newCharacters: [],
      memoryCandidates: candidates,
    },
    { expectedBodyFingerprint: chapter.bodyFingerprint },
  );
}

test('digest 只创建带正文指纹的待确认记忆候选', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [abilityCandidate(), abilityCandidate()]);
  const chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  const book = await store.readBook(target.bookId);

  assert.equal(chapter.memoryCandidates.length, 1);
  assert.match(chapter.memoryCandidates[0].id, /^memory_[0-9a-f]{32}$/);
  assert.equal(chapter.memoryCandidates[0].sourceFingerprint, chapter.bodyFingerprint);
  assert.equal(store.chapterMemoryCandidatesView(book, chapter)[0].status, 'pending');
  assert.deepEqual(book.memory.facts, []);
  assert.doesNotMatch(buildContext({ book, section: {}, prevChapter: null }), /回溯使用上限/);
});

test('正文可精确定位的最高重要度候选自动进入事实库，并允许作者事后否决', async () => {
  const target = await createChapterWithText('林越把青铜钥匙交给沈青，众人都看见了。');
  await extractCandidates(target, [{
    kind: 'item', subject: '青铜钥匙', predicate: '当前持有人', object: '沈青',
    evidence: '交接发生在众人面前', importance: 5, aliases: ['旧城钥匙'],
  }]);
  let chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  let book = await store.readBook(target.bookId);
  assert.equal(book.memory.facts.length, 1);
  assert.equal(book.memory.facts[0].autoAccepted, true);
  assert.equal(book.memory.facts[0].object, '沈青');
  assert.deepEqual(book.memory.facts[0].aliases, ['旧城钥匙']);
  assert.equal(store.chapterMemoryCandidatesView(book, chapter)[0].status, 'accepted');

  const rejected = await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, chapter.memoryCandidates[0].id,
    {
      action: 'reject', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  assert.equal(rejected.candidate.status, 'rejected');
  book = await store.readBook(target.bookId);
  chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  assert.equal(book.memory.facts.length, 0);
  assert.equal(store.chapterMemoryCandidatesView(book, chapter)[0].status, 'rejected');
});

test('低重要度或正文无法精确定位的候选继续等待人工确认', async () => {
  const target = await createChapterWithText('林越看了一眼青铜钥匙。');
  await extractCandidates(target, [{
    kind: 'item', subject: '青铜钥匙', predicate: '当前持有人', object: '沈青',
    evidence: '模型推断', importance: 4,
  }, {
    kind: 'item', subject: '青铜钥匙', predicate: '来源', object: '旧王陵深处',
    evidence: '正文没有明确说明', importance: 5,
  }]);
  const chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  const book = await store.readBook(target.bookId);
  assert.equal(book.memory.facts.length, 0);
  assert.deepEqual(
    store.chapterMemoryCandidatesView(book, chapter).map((item) => item.status),
    ['pending', 'pending'],
  );
});

test('人工确认后事实进入上下文并随单书备份保存', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [{ ...abilityCandidate(), aliases: ['阿越', '回溯者'] }]);
  let chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  let book = await store.readBook(target.bookId);
  const candidate = chapter.memoryCandidates[0];
  const accepted = await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, candidate.id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  assert.equal(accepted.candidate.status, 'accepted');
  assert.deepEqual(accepted.candidates.map((item) => item.status), ['accepted']);

  book = await store.readBook(target.bookId);
  chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  assert.equal(book.memory.facts.length, 1);
  assert.equal(book.memory.facts[0].source.chapterId, target.chapterId);
  assert.equal(book.memory.facts[0].source.bodyFingerprint, chapter.bodyFingerprint);
  assert.deepEqual(book.memory.facts[0].details, {
    eventType: 'used', limitation: '每天最多使用两次', time: '当日', location: '北港钟楼',
  });
  assert.deepEqual(book.memory.facts[0].aliases, ['阿越', '回溯者']);
  assert.match(buildContext({ book, section: {}, prevChapter: null }), /回溯使用上限/);
  assert.match(buildContext({ book, section: {}, prevChapter: null }), /限制=每天最多使用两次/);
  assert.match(buildContext({ book, section: {}, prevChapter: null }), /地点=北港钟楼/);
  assert.equal(store.chapterMemoryCandidatesView(book, chapter)[0].status, 'accepted');

  const backup = await store.createBookBackup(target.bookId);
  assert.equal(backup.book.memory.facts[0].id, candidate.id);
  assert.equal(backup.book.memory.facts[0].details.limitation, '每天最多使用两次');
  assert.deepEqual(backup.book.memory.facts[0].aliases, ['阿越', '回溯者']);
  assert.deepEqual(
    backup.sections[0].chapters[0].memoryCandidates[0].aliases, ['阿越', '回溯者'],
  );
  assert.equal(backup.sections[0].chapters[0].memoryCandidates[0].id, candidate.id);

  const imported = await store.importBookBackup(backup);
  const importedBook = await store.readBook(imported.id);
  const importedChapter = await store.readChapter(
    imported.id, target.sectionId, target.chapterId,
  );
  assert.equal(importedBook.memory.facts[0].status, 'active');
  assert.equal(importedBook.memory.facts[0].details.location, '北港钟楼');
  assert.deepEqual(importedBook.memory.facts[0].aliases, ['阿越', '回溯者']);
  assert.equal(
    store.chapterMemoryCandidatesView(importedBook, importedChapter)[0].status,
    'accepted',
  );

  const backupPath = join(root, 'memory-backup.json');
  await writeFile(backupPath, JSON.stringify(backup));
  const streamed = await store.importBookBackupFile(backupPath, { highWaterMark: 11 });
  assert.equal((await store.readBook(streamed.id)).memory.facts[0].id, candidate.id);
  assert.equal((await store.readBook(streamed.id)).memory.facts[0].details.eventType, 'used');
});

test('同一主体属性出现不同值时必须显式替换，不能自动覆盖', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [abilityCandidate('每天最多使用两次')]);
  let chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  let book = await store.readBook(target.bookId);
  await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, chapter.memoryCandidates[0].id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );

  await extractCandidates(target, [abilityCandidate('每天最多使用三次')]);
  chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  book = await store.readBook(target.bookId);
  const replacement = chapter.memoryCandidates[0];
  await assert.rejects(() => store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, replacement.id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  ), /MEMORY_CONFLICT/);
  assert.equal((await store.readBook(target.bookId)).memory.facts[0].status, 'active');

  const replaced = await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, replacement.id,
    {
      action: 'replace', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  assert.equal(replaced.fact.object, '每天最多使用三次');
  assert.deepEqual(
    (await store.readBook(target.bookId)).memory.facts.map((fact) => fact.status),
    ['superseded', 'active'],
  );
});

test('正文改写会清空候选并把来源于旧正文的已确认事实标记失效', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [abilityCandidate()]);
  let chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  let book = await store.readBook(target.bookId);
  await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, chapter.memoryCandidates[0].id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );

  await store.versionSet(
    target.bookId, `section:${target.sectionId}:chapter:${target.chapterId}`,
    '改写后不再具有回溯能力。',
  );
  chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  book = await store.readBook(target.bookId);
  assert.deepEqual(chapter.memoryCandidates, []);
  assert.equal(book.memory.facts[0].status, 'stale');
  assert.doesNotMatch(buildContext({ book, section: {}, prevChapter: null }), /回溯使用上限/);
});

test('已发布正文独立锁定，本地改写不会让读者已看到的事实失效', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [abilityCandidate()]);
  let chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  let book = await store.readBook(target.bookId);
  await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, chapter.memoryCandidates[0].id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  book = await store.readBook(target.bookId);
  const published = await store.publishChapterVersion(
    target.bookId, target.sectionId, target.chapterId,
    {
      expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  assert.equal(published.published.isCurrent, true);
  assert.equal(published.published.content, '林越发动回溯，但明确说今天只能再用一次。');

  await store.versionSet(
    target.bookId, `section:${target.sectionId}:chapter:${target.chapterId}`,
    '未发布草稿：林越失去了回溯能力。',
  );
  chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  book = await store.readBook(target.bookId);
  assert.equal(store.chapterPublicationView(chapter).isCurrent, false);
  assert.match(store.chapterPublicationView(chapter).content, /今天只能再用一次/);
  assert.equal(book.memory.facts[0].status, 'active');
  assert.match(buildContext({ book, section: {}, prevChapter: null }), /回溯使用上限/);

  const backup = await store.createBookBackup(target.bookId);
  const imported = await store.importBookBackup(backup);
  const importedBook = await store.readBook(imported.id);
  const importedChapter = await store.readChapter(
    imported.id, target.sectionId, target.chapterId,
  );
  assert.equal(importedBook.memory.facts[0].status, 'active');
  assert.equal(importedChapter.published.bodyFingerprint, book.memory.facts[0].source.bodyFingerprint);
  assert.notEqual(importedChapter.bodyFingerprint, importedChapter.published.bodyFingerprint);
});

test('未发布修改的候选不能进入长期记忆，发布新版后才能确认', async () => {
  const target = await createChapterWithText();
  let chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  let book = await store.readBook(target.bookId);
  await store.publishChapterVersion(target.bookId, target.sectionId, target.chapterId, {
    expectedBodyFingerprint: chapter.bodyFingerprint,
    expectedMemoryRevision: store.bookMemoryRevision(book),
  });
  await store.versionSet(
    target.bookId, `section:${target.sectionId}:chapter:${target.chapterId}`,
    '未发布新版：林越每天可回溯三次。',
  );
  await extractCandidates(target, [abilityCandidate('每天最多使用三次')]);
  chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  book = await store.readBook(target.bookId);
  const candidate = chapter.memoryCandidates[0];
  await assert.rejects(() => store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, candidate.id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  ), /MEMORY_SOURCE_UNPUBLISHED/);

  await store.publishChapterVersion(target.bookId, target.sectionId, target.chapterId, {
    expectedBodyFingerprint: chapter.bodyFingerprint,
    expectedMemoryRevision: store.bookMemoryRevision(book),
  });
  book = await store.readBook(target.bookId);
  const accepted = await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, candidate.id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  assert.equal(accepted.fact.object, '每天最多使用三次');
});

test('发布新版会让同章旧发布事实失效，不沿用读者已被替换的真相', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [abilityCandidate()]);
  let chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  let book = await store.readBook(target.bookId);
  await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, chapter.memoryCandidates[0].id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  book = await store.readBook(target.bookId);
  await store.publishChapterVersion(target.bookId, target.sectionId, target.chapterId, {
    expectedBodyFingerprint: chapter.bodyFingerprint,
    expectedMemoryRevision: store.bookMemoryRevision(book),
  });
  await store.versionSet(
    target.bookId, `section:${target.sectionId}:chapter:${target.chapterId}`,
    '发布新版：林越已永久失去回溯。',
  );
  chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  book = await store.readBook(target.bookId);
  const secondPublication = await store.publishChapterVersion(
    target.bookId, target.sectionId, target.chapterId,
    {
      expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  assert.equal(secondPublication.published.publicationNumber, 2);
  assert.equal((await store.readBook(target.bookId)).memory.facts[0].status, 'stale');
});

test('旧页面不能用陈旧记忆修订号覆盖另一页面的决定', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [abilityCandidate()]);
  const chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  const book = await store.readBook(target.bookId);
  const revision = store.bookMemoryRevision(book);
  const candidate = chapter.memoryCandidates[0];
  await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, candidate.id,
    { action: 'reject', expectedBodyFingerprint: chapter.bodyFingerprint, expectedMemoryRevision: revision },
  );
  await assert.rejects(() => store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, candidate.id,
    { action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint, expectedMemoryRevision: revision },
  ), /MEMORY_REVISION_CONFLICT/);
});

test('确认记忆会改变实际使用它的生成与审稿上下文修订号', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [abilityCandidate()]);
  const beforeGeneration = await store.readChapterGenerationContext(
    target.bookId, target.sectionId, target.chapterId,
  );
  const beforeReview = await store.readChapterReviewContext(
    target.bookId, target.sectionId, target.chapterId,
  );
  await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId,
    beforeGeneration.chapter.memoryCandidates[0].id,
    {
      action: 'accept',
      expectedBodyFingerprint: beforeGeneration.chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(beforeGeneration.book),
    },
  );
  const afterGeneration = await store.readChapterGenerationContext(
    target.bookId, target.sectionId, target.chapterId,
  );
  const afterReview = await store.readChapterReviewContext(
    target.bookId, target.sectionId, target.chapterId,
  );
  assert.notEqual(afterGeneration.contextRevision, beforeGeneration.contextRevision);
  assert.notEqual(afterReview.contextRevision, beforeReview.contextRevision);
});

test('中央记忆库可撤销确认并保留失效历史', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [abilityCandidate()]);
  const chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  let book = await store.readBook(target.bookId);
  const accepted = await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, chapter.memoryCandidates[0].id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  const library = await store.readBookMemory(target.bookId);
  assert.equal(library.facts[0].status, 'active');
  assert.equal(library.memoryRevision, accepted.memoryRevision);

  const revoked = await store.deactivateMemoryFact(
    target.bookId, library.facts[0].id,
    { expectedMemoryRevision: library.memoryRevision },
  );
  assert.equal(revoked.fact.status, 'stale');
  assert.notEqual(revoked.memoryRevision, library.memoryRevision);
  book = await store.readBook(target.bookId);
  assert.equal(book.memory.facts[0].status, 'stale');
  assert.doesNotMatch(buildContext({ book, section: {}, prevChapter: null }), /回溯使用上限/);
  await assert.rejects(() => store.deactivateMemoryFact(
    target.bookId, `memory_${'f'.repeat(32)}`,
    { expectedMemoryRevision: revoked.memoryRevision },
  ), /MEMORY_FACT_NOT_FOUND/);
});

test('删除章节会让其活动事实失效并移除该章候选的拒绝记录', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [
    abilityCandidate(),
    {
      kind: 'location', subject: '林越', predicate: '当前所在地', object: '北港',
      evidence: '人物抵达北港', importance: 4,
    },
  ]);
  let chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  let book = await store.readBook(target.bookId);
  await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, chapter.memoryCandidates[0].id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  book = await store.readBook(target.bookId);
  await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, chapter.memoryCandidates[1].id,
    {
      action: 'reject', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  assert.equal((await store.readBook(target.bookId)).memory.rejectedCandidateIds.length, 1);

  await store.deleteChapter(target.bookId, target.sectionId, target.chapterId);
  book = await store.readBook(target.bookId);
  assert.equal(book.memory.facts[0].status, 'stale');
  assert.deepEqual(book.memory.rejectedCandidateIds, []);
  assert.doesNotMatch(buildContext({ book, section: {}, prevChapter: null }), /回溯使用上限/);
});

test('删去前章会重算后续活动事实的来源章序号', async () => {
  const target = await createChapterWithText('第一章正文');
  const second = await store.addChapter(target.bookId, target.sectionId, {});
  await store.versionSet(
    target.bookId, `section:${target.sectionId}:chapter:${second.id}`,
    '林越抵达北港。',
  );
  const secondTarget = { ...target, chapterId: second.id };
  await extractCandidates(secondTarget, [{
    kind: 'location', subject: '林越', predicate: '当前所在地', object: '北港',
    evidence: '人物抵达北港', importance: 4,
  }]);
  const chapter = await store.readChapter(target.bookId, target.sectionId, second.id);
  let book = await store.readBook(target.bookId);
  await store.decideMemoryCandidate(
    target.bookId, target.sectionId, second.id, chapter.memoryCandidates[0].id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  assert.equal((await store.readBook(target.bookId)).memory.facts[0].source.chapterIndex, 2);

  await store.deleteChapter(target.bookId, target.sectionId, target.chapterId);
  book = await store.readBook(target.bookId);
  assert.equal(book.memory.facts[0].status, 'active');
  assert.equal(book.memory.facts[0].source.chapterIndex, 1);
  const backup = await store.createBookBackup(target.bookId);
  await assert.doesNotReject(() => store.importBookBackup(backup));
});

test('备份导入拒绝无法追溯到当前正文的活动事实', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [abilityCandidate()]);
  const chapter = await store.readChapter(target.bookId, target.sectionId, target.chapterId);
  let book = await store.readBook(target.bookId);
  await store.decideMemoryCandidate(
    target.bookId, target.sectionId, target.chapterId, chapter.memoryCandidates[0].id,
    {
      action: 'accept', expectedBodyFingerprint: chapter.bodyFingerprint,
      expectedMemoryRevision: store.bookMemoryRevision(book),
    },
  );
  const backup = await store.createBookBackup(target.bookId);
  backup.book.memory.facts[0].source.chapterId = 'chapter-999';
  await assert.rejects(() => store.importBookBackup(backup), /BACKUP_INVALID/);

  const backupPath = join(root, 'invalid-memory-source.json');
  await writeFile(backupPath, JSON.stringify(backup));
  await assert.rejects(
    () => store.importBookBackupFile(backupPath, { highWaterMark: 9 }),
    /BACKUP_INVALID/,
  );
  book = await store.readBook(target.bookId);
  assert.equal(book.memory.facts[0].status, 'active');
});

test('长期记忆上下文优先相关和高重要度事实并显式标记预算省略', () => {
  const facts = Array.from({ length: 100 }, (_, index) => ({
    id: `memory_${index.toString(16).padStart(32, '0')}`,
    kind: 'other', subject: index === 99 ? '林越' : `主体${index}`,
    predicate: '状态', object: 'x'.repeat(80), importance: index === 99 ? 5 : 1,
    status: 'active', source: { chapterIndex: index + 1 },
    updatedAt: new Date(index * 1000).toISOString(),
  }));
  const rows = generationMemoryRows({ facts }, { relevantText: '林越正在行动', maxChars: 300 });
  assert.match(rows[0], /林越/);
  assert.match(rows.at(-1), /预算省略/);
  assert.ok(rows.join('\n').length <= 300);
});

test('本章策划点名的久远低优先事实先于近期高优先事实进入 API 上下文', () => {
  const facts = Array.from({ length: 30 }, (_, index) => activeMemoryFact(index));
  facts.push(activeMemoryFact(99, {
    id: 'fact-target', subject: '沉星钥匙', predicate: '真实限制',
    object: '只能开启一次北境星门', importance: 1,
    updatedAt: '2001-01-01T00:00:00.000Z', source: { chapterIndex: 3 },
  }));

  const selection = generationChapterMemorySelection({ facts }, {
    book: {}, section: {}, prevChapter: null,
    chapterPlan: { goal: '找回沉星钥匙并赶赴北境' }, maxChars: 260,
  });

  assert.match(selection.rows[0], /沉星钥匙.*只能开启一次北境星门/);
  assert.equal(selection.taskRelevantCount, 1);
  assert.equal(selection.selectedTaskRelevantCount, 1);
  assert.equal(selection.truncated, true);
  assert.ok(selection.omittedCount > 0);
});

test('待审正文直接提到的旧人物或物品也会触发任务级记忆召回', () => {
  const facts = Array.from({ length: 25 }, (_, index) => activeMemoryFact(index));
  facts.push(activeMemoryFact(88, {
    id: 'fact-body-target', kind: 'foreshadow', subject: '断齿铜环',
    predicate: '读者已知用途', object: '能辨认旧王庭密使', importance: 1,
    updatedAt: '2002-01-01T00:00:00.000Z', source: { chapterIndex: 12 },
  }));

  const selection = generationChapterMemorySelection({ facts }, {
    book: {}, section: {}, prevChapter: null,
    currentContent: '他从尸体袖中摸出断齿铜环，却没有立刻声张。', maxChars: 260,
  });

  assert.match(selection.rows[0], /断齿铜环.*旧王庭密使/);
  assert.equal(selection.selectedTaskRelevantCount, 1);
});

test('任务直接相关的长事实不会被无关短事实套利挤出预算', () => {
  const facts = [activeMemoryFact(900, {
    id: 'fact-long-target', subject: '青铜钥匙', predicate: '取得经过',
    object: `由陆昭在第40章取得，${'关键细节'.repeat(100)}`,
    importance: 5, updatedAt: '2001-01-01T00:00:00.000Z',
  })];
  for (let index = 0; index < 20; index += 1) {
    facts.push(activeMemoryFact(index, {
      subject: `路人${index}`, predicate: '位置', object: '站在街上', importance: 1,
    }));
  }

  const selection = generationMemorySelection({ facts }, {
    taskRelevantText: '本章陆昭要用青铜钥匙开门', maxChars: 200,
  });

  assert.equal(selection.taskRelevantCount, 1);
  assert.equal(selection.selectedTaskRelevantCount, 1);
  assert.match(selection.rows[0], /青铜钥匙/u);
  assert.doesNotMatch(selection.rows[0], /路人/u);
  assert.ok(selection.rows.join('\n').length <= 200);
});

test('单字主体不因普通词组误命中任务相关性', () => {
  const selection = generationMemorySelection({ facts: [activeMemoryFact(1, {
    subject: '火', predicate: '属于', object: '禁忌元素', importance: 5,
  })] }, {
    taskRelevantText: '本章主角在灯火通明的宴会上敬酒', maxChars: 300,
  });
  assert.equal(selection.taskRelevantCount, 0);
  assert.equal(selection.selectedTaskRelevantCount, 0);
});

test('事实别名可以召回主体，并在发送行中明确标出同一实体', () => {
  const selection = generationMemorySelection({ facts: [activeMemoryFact(1, {
    subject: '陆昭', aliases: ['昭哥', '那个瞎子'],
    predicate: '持有物', object: '青铜钥匙', importance: 3,
  })] }, {
    taskRelevantText: '昭哥把钥匙藏进袖口', maxChars: 300,
  });
  assert.equal(selection.taskRelevantCount, 1);
  assert.equal(selection.selectedTaskRelevantCount, 1);
  assert.match(selection.rows[0], /陆昭（别名：昭哥、那个瞎子）/u);
});

test('省略提示给出事实总数和仍未装入的任务相关数量', () => {
  const facts = Array.from({ length: 20 }, (_, index) => activeMemoryFact(index, {
    subject: `青铜钥匙${index}`, predicate: '状态', object: '关键事实'.repeat(30),
  }));
  const selection = generationMemorySelection({ facts }, {
    taskRelevantText: facts.map((fact) => fact.subject).join('、'), maxChars: 120,
  });
  assert.ok(selection.omittedCount > 0);
  assert.ok(selection.selectedTaskRelevantCount < selection.taskRelevantCount);
  assert.match(selection.rows.at(-1), new RegExp(`另有 ${selection.omittedCount} 条`, 'u'));
  assert.match(
    selection.rows.at(-1),
    new RegExp(`${selection.taskRelevantCount - selection.selectedTaskRelevantCount} 条与本章直接相关`, 'u'),
  );
});

test('大型相关文本使用精确索引并正确匹配跨代理对的事实', () => {
  const factCount = 10_000;
  const facts = Array.from({ length: factCount }, (_, index) => ({
    id: `memory_${index.toString(16).padStart(32, '0')}`,
    kind: 'other',
    subject: index === factCount - 1 ? '英雄😀' : `主体${index}`,
    predicate: '状态',
    object: `不会出现的对象${index}`,
    importance: index === factCount - 1 ? 1 : 5,
    status: 'active', source: { chapterIndex: index + 1 },
    updatedAt: new Date(index * 1000).toISOString(),
  }));
  const relevantText = `${'无关上下文'.repeat(20_000)}英雄😀正在行动`;
  const startedAt = performance.now();

  const rows = generationMemoryRows({ facts }, { relevantText, maxChars: 300 });
  const durationMs = performance.now() - startedAt;

  assert.match(rows[0], /英雄😀/);
  assert.match(rows.at(-1), /预算省略/);
  assert.ok(rows.join('\n').length <= 300);
  assert.ok(durationMs < 1_000, `大型记忆筛选耗时异常：${durationMs.toFixed(1)}ms`);
});

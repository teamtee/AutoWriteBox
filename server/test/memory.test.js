import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as store from '../store.js';
import { buildContext } from '../prompts.js';
import { generationMemoryRows } from '../generation-context.js';
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

test('人工确认后事实进入上下文并随单书备份保存', async () => {
  const target = await createChapterWithText();
  await extractCandidates(target, [abilityCandidate()]);
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
  assert.match(buildContext({ book, section: {}, prevChapter: null }), /回溯使用上限/);
  assert.match(buildContext({ book, section: {}, prevChapter: null }), /限制=每天最多使用两次/);
  assert.match(buildContext({ book, section: {}, prevChapter: null }), /地点=北港钟楼/);
  assert.equal(store.chapterMemoryCandidatesView(book, chapter)[0].status, 'accepted');

  const backup = await store.createBookBackup(target.bookId);
  assert.equal(backup.book.memory.facts[0].id, candidate.id);
  assert.equal(backup.book.memory.facts[0].details.limitation, '每天最多使用两次');
  assert.equal(backup.sections[0].chapters[0].memoryCandidates[0].id, candidate.id);

  const imported = await store.importBookBackup(backup);
  const importedBook = await store.readBook(imported.id);
  const importedChapter = await store.readChapter(
    imported.id, target.sectionId, target.chapterId,
  );
  assert.equal(importedBook.memory.facts[0].status, 'active');
  assert.equal(importedBook.memory.facts[0].details.location, '北港钟楼');
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

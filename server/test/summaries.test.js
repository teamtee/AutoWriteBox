import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.js';
import { buildContext } from '../prompts.js';
import {
  bookSectionSummaryWindow, buildBookSummaryFromSectionSummaries,
  generationPriorSectionSummary,
} from '../generation-context.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-summaries-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

async function addDigestedChapter(bookId, sectionId, text, summary) {
  const chapter = await store.addChapter(bookId, sectionId, {});
  await store.versionSet(
    bookId, `section:${sectionId}:chapter:${chapter.id}`, text,
  );
  const saved = await store.readChapter(bookId, sectionId, chapter.id);
  await store.applyChapterDigest(bookId, sectionId, chapter.id, {
    summary, progress: `${summary}之后`, newCharacters: [], memoryCandidates: [],
  }, { expectedBodyFingerprint: saved.bodyFingerprint });
  return store.readChapter(bookId, sectionId, chapter.id);
}

test('章摘要聚合为分部摘要，并建立只含此前分部的全书前情窗口', async () => {
  const book = await store.createBook({ premise: '跨分部摘要', title: '长篇' });
  const first = await store.addSection(book.id, { title: '启程' });
  await addDigestedChapter(book.id, first.id, '主角离开故乡。', '主角离开故乡');
  const second = await store.addSection(book.id, { title: '北境' });
  const secondChapter = await addDigestedChapter(
    book.id, second.id, '主角抵达北境。', '主角抵达北境',
  );

  const storedBook = await store.readBook(book.id);
  const storedFirst = await store.readSection(book.id, first.id);
  const storedSecond = await store.readSection(book.id, second.id);
  assert.match(storedFirst.summary, /第1章：主角离开故乡/);
  assert.match(storedBook.sectionSummaries[first.id].summary, /主角离开故乡/);
  assert.match(storedBook.summary, /第1部 · 启程/);
  assert.match(storedBook.summary, /第2部 · 北境/);

  const prior = generationPriorSectionSummary(storedBook, second.id);
  assert.match(prior, /主角离开故乡/);
  assert.doesNotMatch(prior, /主角抵达北境/);
  const prompt = buildContext({ book: storedBook, section: storedSecond });
  assert.match(prompt, /【此前分部剧情】/);
  assert.match(prompt, /【本部前情】/);
  assert.ok(prompt.indexOf('主角离开故乡') < prompt.indexOf('主角抵达北境'));

  const reviewBefore = store.chapterReviewContextRevision({
    book: storedBook, section: storedSecond, chapter: secondChapter,
  });
  const firstChapterId = storedFirst.chapters[0];
  await store.versionSet(
    book.id, `section:${first.id}:chapter:${firstChapterId}`, '主角改为留守故乡。',
  );
  let changedBook = await store.readBook(book.id);
  assert.doesNotMatch(generationPriorSectionSummary(changedBook, second.id), /离开故乡/);
  let changedChapter = await store.readChapter(book.id, first.id, firstChapterId);
  await store.applyChapterDigest(book.id, first.id, firstChapterId, {
    summary: '主角决定留守故乡', progress: '调查故乡异变',
    newCharacters: [], memoryCandidates: [],
  }, { expectedBodyFingerprint: changedChapter.bodyFingerprint });
  changedBook = await store.readBook(book.id);
  const changedSecond = await store.readSection(book.id, second.id);
  assert.match(generationPriorSectionSummary(changedBook, second.id), /留守故乡/);
  assert.notEqual(reviewBefore, store.chapterReviewContextRevision({
    book: changedBook, section: changedSecond, chapter: secondChapter,
  }));

  const backup = await store.createBookBackup(book.id);
  const imported = await store.importBookBackup(backup);
  assert.equal(
    generationPriorSectionSummary(await store.readBook(imported.id), second.id),
    generationPriorSectionSummary(changedBook, second.id),
  );
});

test('删除唯一来源章会从跨分部前情中移除对应分部摘要', async () => {
  const book = await store.createBook({ premise: '删除摘要', title: '删除测试' });
  const first = await store.addSection(book.id, { title: '旧部' });
  const chapter = await addDigestedChapter(book.id, first.id, '旧剧情。', '旧剧情成立');
  const second = await store.addSection(book.id, { title: '新部' });
  await addDigestedChapter(book.id, second.id, '新剧情。', '新剧情成立');
  assert.match(
    generationPriorSectionSummary(await store.readBook(book.id), second.id), /旧剧情成立/,
  );

  await store.deleteChapter(book.id, first.id, chapter.id);
  const changed = await store.readBook(book.id);
  assert.equal(changed.sectionSummaries[first.id], undefined);
  assert.doesNotMatch(generationPriorSectionSummary(changed, second.id), /旧剧情成立/);
});

test('跨分部摘要预算保留最近剧情并明确标记更早内容省略', () => {
  const sections = Array.from({ length: 10 }, (_, index) => `section-${index}`);
  const sectionSummaries = Object.fromEntries(sections.map((id, index) => [id, {
    index: index + 1, title: `分部${index + 1}`,
    summary: `${index + 1}-${'剧情'.repeat(300)}`,
  }]));
  const summary = buildBookSummaryFromSectionSummaries(
    { sections, sectionSummaries }, 1_000,
  );
  assert.ok(summary.length <= 1_000);
  assert.match(summary, /更早分部剧情已因上下文预算省略/);
  assert.match(summary, /分部10/);
  assert.doesNotMatch(summary, /分部1：/);
});

test('长篇跨部前情同时保留最近分部与本章点名的久远旧部', () => {
  const sections = Array.from({ length: 14 }, (_, index) => `section-${index + 1}`);
  const sectionSummaries = Object.fromEntries(sections.map((id, sectionIndex) => [id, {
    index: sectionIndex + 1,
    title: `分部${sectionIndex + 1}`,
    summary: Array.from({ length: 100 }, (_, chapterIndex) => {
      if (sectionIndex === 1 && chapterIndex === 40) {
        return `第${chapterIndex + 1}章：沈星钥匙被埋进旧王陵，只有陆昭知道入口`;
      }
      return `第${chapterIndex + 1}章：第${sectionIndex + 1}部普通剧情${'旧'.repeat(40)}`;
    }).join('\n'),
  }]));
  const book = {
    sections,
    sectionSummaries,
    memory: { facts: [{
      status: 'active', subject: '沈星钥匙', aliases: ['星钥'],
      predicate: '位置', object: '旧王陵',
    }] },
  };

  const prior = generationPriorSectionSummary(book, 'section-14', 8_000, {
    taskRelevantText: '本章要找回星钥并进入旧王陵',
  });

  assert.match(prior, /第2部 · 分部2/u, '久远但直接相关的第2部必须召回');
  assert.match(prior, /沈星钥匙被埋进旧王陵/u);
  assert.match(prior, /第13部 · 分部13/u, '最近分部仍是直接连续性的底座');
  assert.match(prior, /更早分部剧情已因上下文预算省略/u);
  assert.ok(prior.length <= 8_000);
});

test('单部分部摘要超限时保留开场、相关旧条目和收尾，不再只切尾窗', () => {
  const lines = Array.from({ length: 120 }, (_, index) =>
    index === 0 ? '第1章：主角离开故乡'
      : index === 50 ? '第51章：沈星钥匙被封进旧王陵'
        : index === 119 ? '第120章：北境战争结束'
          : `第${index + 1}章：普通过渡剧情${'中'.repeat(30)}`);
  const window = bookSectionSummaryWindow(lines.join('\n'), 1_000, ['沈星钥匙']);
  assert.match(window, /主角离开故乡/u);
  assert.match(window, /沈星钥匙被封进旧王陵/u);
  assert.match(window, /北境战争结束/u);
  assert.match(window, /条章节摘要因预算省略/u);
  assert.ok(window.length <= 1_000);
});

test('阶段摘要可编辑冻结，并代替已覆盖分部进入后续上下文', async () => {
  const book = await store.createBook({ premise: '阶段摘要', title: '长篇' });
  const first = await store.addSection(book.id, { title: '起航' });
  await addDigestedChapter(book.id, first.id, '林越离家。', '林越离开故乡');
  const second = await store.addSection(book.id, { title: '北境' });
  await addDigestedChapter(book.id, second.id, '林越结盟。', '林越与北境军结盟');
  const third = await store.addSection(book.id, { title: '王都' });
  await addDigestedChapter(book.id, third.id, '林越入京。', '林越进入王都');

  const before = await store.readBook(book.id);
  const saved = await store.saveStageSummary(book.id, {
    id: store.createStageSummaryId(), title: '北上阶段',
    startSectionId: first.id, endSectionId: second.id,
    summary: '林越离乡后与北境军结盟，即将前往王都。', status: 'frozen',
  }, { expectedStageSummaryRevision: store.stageSummaryRevision(before) });
  assert.equal(saved.item.status, 'frozen');
  assert.equal(saved.item.stale, false);

  const stored = await store.readBook(book.id);
  const prior = generationPriorSectionSummary(stored, third.id);
  assert.match(prior, /阶段·北上阶段/);
  assert.match(prior, /离乡后与北境军结盟/);
  assert.doesNotMatch(prior, /第1部 · 起航/);

  const library = await store.readBookMemory(book.id);
  assert.equal(library.stageSummaries.length, 1);
  assert.match(library.stageSummaryRevision, /^[A-Za-z0-9_-]{43}$/);
});

test('来源改变后草稿阶段摘要标记过期并退出上下文，冻结项保持权威', async () => {
  const book = await store.createBook({ premise: '过期阶段', title: '过期' });
  const first = await store.addSection(book.id, { title: '旧事' });
  const chapter = await addDigestedChapter(book.id, first.id, '主角出城。', '主角出城');
  const second = await store.addSection(book.id, { title: '新章' });
  await addDigestedChapter(book.id, second.id, '主角返回。', '主角返回');
  const initial = await store.readBook(book.id);
  const draftId = store.createStageSummaryId();
  await store.saveStageSummary(book.id, {
    id: draftId, title: '旧事阶段', startSectionId: first.id,
    endSectionId: first.id, summary: '旧摘要权威文本', status: 'draft',
  }, { expectedStageSummaryRevision: store.stageSummaryRevision(initial) });

  await store.versionSet(
    book.id, `section:${first.id}:chapter:${chapter.id}`, '主角改为留在城内。',
  );
  const changedChapter = await store.readChapter(book.id, first.id, chapter.id);
  await store.applyChapterDigest(book.id, first.id, chapter.id, {
    summary: '主角留在城内', progress: '调查城内',
    newCharacters: [], memoryCandidates: [],
  }, { expectedBodyFingerprint: changedChapter.bodyFingerprint });

  let library = await store.readBookMemory(book.id);
  assert.equal(library.stageSummaries[0].stale, true);
  let prior = generationPriorSectionSummary(await store.readBook(book.id), second.id);
  assert.doesNotMatch(prior, /旧摘要权威文本/);
  assert.match(prior, /留在城内/);

  await store.saveStageSummary(book.id, {
    id: draftId, title: '旧事阶段', startSectionId: first.id,
    endSectionId: first.id, summary: '作者冻结的旧事版本', status: 'frozen',
  }, { expectedStageSummaryRevision: library.stageSummaryRevision });
  library = await store.readBookMemory(book.id);
  assert.equal(library.stageSummaries[0].stale, false);
  prior = generationPriorSectionSummary(await store.readBook(book.id), second.id);
  assert.match(prior, /作者冻结的旧事版本/);

  const changedAgain = await store.readChapter(book.id, first.id, chapter.id);
  await store.versionSet(
    book.id, `section:${first.id}:chapter:${chapter.id}`, '主角最终决定烧毁城门。',
    { expectedRevision: store.versionRevision(changedAgain.body) },
  );
  const finalChapter = await store.readChapter(book.id, first.id, chapter.id);
  await store.applyChapterDigest(book.id, first.id, chapter.id, {
    summary: '主角烧毁城门', progress: '与旧城彻底决裂',
    newCharacters: [], memoryCandidates: [],
  }, { expectedBodyFingerprint: finalChapter.bodyFingerprint });
  library = await store.readBookMemory(book.id);
  assert.equal(library.stageSummaries[0].stale, true);
  prior = generationPriorSectionSummary(await store.readBook(book.id), second.id);
  assert.match(prior, /作者冻结版与当前来源不一致/);
  assert.match(prior, /以当前正文派生摘要为已发生事实/);
  assert.match(prior, /作者冻结的旧事版本/);
  assert.match(prior, /主角烧毁城门/);
});

test('阶段摘要重算用来源指纹阻止迟到结果，并跟随整书备份', async () => {
  const book = await store.createBook({ premise: '重算竞态', title: '竞态' });
  const first = await store.addSection(book.id, { title: '第一部' });
  const chapter = await addDigestedChapter(book.id, first.id, '旧正文。', '旧摘要');
  const id = store.createStageSummaryId();
  let current = await store.readBook(book.id);
  const revision = store.stageSummaryRevision(current);
  const source = await store.readStageSummarySource(book.id, {
    id, title: '第一阶段', startSectionId: first.id, endSectionId: first.id,
  }, { expectedStageSummaryRevision: revision });

  await store.versionSet(book.id, `section:${first.id}:chapter:${chapter.id}`, '新正文。');
  const changed = await store.readChapter(book.id, first.id, chapter.id);
  await store.applyChapterDigest(book.id, first.id, chapter.id, {
    summary: '新摘要', progress: '新路标', newCharacters: [], memoryCandidates: [],
  }, { expectedBodyFingerprint: changed.bodyFingerprint });
  await assert.rejects(store.saveGeneratedStageSummary(book.id, {
    id, title: '第一阶段', startSectionId: first.id,
    endSectionId: first.id, summary: '迟到的模型摘要',
  }, {
    expectedStageSummaryRevision: revision,
    expectedSourceFingerprint: source.fingerprint,
  }), /STAGE_SUMMARY_SOURCE_STALE/);

  current = await store.readBook(book.id);
  await store.saveStageSummary(book.id, {
    id, title: '第一阶段', startSectionId: first.id,
    endSectionId: first.id, summary: '新阶段摘要', status: 'draft',
  }, { expectedStageSummaryRevision: store.stageSummaryRevision(current) });
  const backup = await store.createBookBackup(book.id);
  const imported = await store.importBookBackup(backup);
  const importedLibrary = await store.readBookMemory(imported.id);
  assert.equal(importedLibrary.stageSummaries[0].summary, '新阶段摘要');
  assert.equal(importedLibrary.stageSummaries[0].stale, false);
});

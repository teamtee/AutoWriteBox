import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.js';
import {
  GOLDEN_THREE_CHECK_IDS, normalizeGoldenThreeReview,
} from '../golden-three-review-schema.js';
import {
  buildGoldenThreeReviewInstruction, GOLDEN_THREE_REVIEW_SYSTEM_PROMPT,
} from '../golden-three-review-prompt.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => { root = makeTestTempDir('golden-three-'); store.setDataRoot(root); });
afterEach(cleanupTestTempDirs);

const CHAPTER_TEXTS = [
  '第一章：主角接下破败试炼场。',
  '第二章：他主动招揽第一位客人。',
  '第三章：客人通关，试炼场获得第一笔收入。',
];

function modelReview({ quoted = false } = {}) {
  return {
    score: 76,
    verdict: '题材机制已经露出，但人物依恋与第一次兑现仍需加强。',
    checks: GOLDEN_THREE_CHECK_IDS.map((id, index) => ({
      id, status: index % 2 ? 'risk' : 'pass', summary: `${id} 的整体结论`,
      evidence: quoted ? [{
        chapter: (index % 3) + 1,
        quote: CHAPTER_TEXTS[index % 3],
        analysis: `第 ${index + 1} 项如何证明整体判断`,
      }] : [{ chapter: (index % 3) + 1, detail: `第 ${index + 1} 项正文证据` }],
    })),
    fixes: [{
      target: 'chapter-2', label: '提前主动选择', problem: '主角连续旁观。',
      instruction: '只改第二章，让主角主动承担一次有代价的选择，保留其它已成功场景。',
    }],
  };
}

async function addChapterWithText(bookId, sectionId, text) {
  const section = await store.readSection(bookId, sectionId);
  const chapter = await store.addChapter(bookId, sectionId, {
    expectedLastChapterId: section.chapters.at(-1) ?? null,
  });
  await store.versionSet(
    bookId, `section:${sectionId}:chapter:${chapter.id}`, text,
    { expectedRevision: store.versionRevision(chapter.body) },
  );
  return chapter.id;
}

test('联合审稿结构要求九项检查完整、唯一且带章号证据', () => {
  const review = modelReview();
  assert.deepEqual(normalizeGoldenThreeReview(review), review);
  assert.equal(normalizeGoldenThreeReview({
    ...review, checks: review.checks.slice(1),
  }), null);
  assert.equal(normalizeGoldenThreeReview({
    ...review, checks: review.checks.map((item, index) => index === 1
      ? { ...item, id: review.checks[0].id } : item),
  }), null);
  assert.equal(normalizeGoldenThreeReview({
    ...review, checks: review.checks.map((item, index) => index === 0
      ? { ...item, evidence: [{ chapter: 4, detail: '越界' }] } : item),
  }), null);
});

test('联合审稿的新证据必须逐字属于标注章节，旧存储形状仍兼容读取', () => {
  const quoted = modelReview({ quoted: true });
  assert.ok(normalizeGoldenThreeReview(quoted, {
    chapterContents: CHAPTER_TEXTS, requireEvidenceQuotes: true,
  }));
  const fabricated = structuredClone(quoted);
  fabricated.checks[0].evidence[0].quote = '正文中不存在的首位客人';
  assert.equal(normalizeGoldenThreeReview(fabricated, {
    chapterContents: CHAPTER_TEXTS, requireEvidenceQuotes: true,
  }), null);
  const wrongChapter = structuredClone(quoted);
  wrongChapter.checks[0].evidence[0] = {
    chapter: 1, quote: CHAPTER_TEXTS[1], analysis: '串用了第二章证据',
  };
  assert.equal(normalizeGoldenThreeReview(wrongChapter, {
    chapterContents: CHAPTER_TEXTS, requireEvidenceQuotes: true,
  }), null);
  assert.deepEqual(normalizeGoldenThreeReview(modelReview()), modelReview());
});

test('联合提示词明确跨章判断、正文证据和非加总评分', () => {
  const instruction = buildGoldenThreeReviewInstruction({
    title: '试炼之城', premise: '少年经营濒临倒闭的试炼场。', outline: '三章完成首位客人。',
    core: { world: '城邦', style: '利落', constraints: '', pacing: '快' },
    storyEngine: { readerExperience: '经营兑现' },
    chapters: [1, 2, 3].map((index) => ({
      bookChapterIndex: index, title: `章${index}`, content: `正文${index}`,
    })),
  });
  assert.match(GOLDEN_THREE_REVIEW_SYSTEM_PROMPT, /不能把三张单章评分相加/);
  assert.match(instruction, /全书第 1 章 · 章1/);
  assert.match(instruction, /全书第 2 章 · 章2/);
  assert.match(instruction, /全书第 3 章 · 章3/);
  assert.match(instruction, /所有证据必须来自正文|正文证据/);
  assert.match(instruction, /quote 逐字复制该章当前正文/);
  assert.match(instruction, /不得引用其它章/);
  for (const id of GOLDEN_THREE_CHECK_IDS) assert.match(instruction, new RegExp(id));
});

test('前三章按全书顺序跨分部读取，正文或作品承诺变化会使旧总检过期', async () => {
  const book = await store.createBook({ premise: '经营试炼场', title: '试炼之城' });
  const section1 = await store.addSection(book.id, { expectedLastSectionId: null });
  const firstId = await addChapterWithText(book.id, section1.id, CHAPTER_TEXTS[0]);
  await addChapterWithText(book.id, section1.id, CHAPTER_TEXTS[1]);
  const section2 = await store.addSection(book.id, { expectedLastSectionId: section1.id });
  const thirdId = await addChapterWithText(book.id, section2.id, CHAPTER_TEXTS[2]);

  const initial = await store.readGoldenThreeReviewContext(book.id);
  assert.equal(initial.ready, true);
  assert.deepEqual(initial.sources.map((item) => item.sectionId), [
    section1.id, section1.id, section2.id,
  ]);
  assert.deepEqual(initial.sources.map((item) => item.bookChapterIndex), [1, 2, 3]);
  const saved = await store.saveGoldenThreeReview(book.id, modelReview({ quoted: true }), {
    expectedContextRevision: initial.contextRevision,
  });
  assert.equal(saved.applied, true);
  assert.equal((await store.readGoldenThreeReviewContext(book.id)).isCurrent, true);
  const backup = await store.createBookBackup(book.id);
  assert.equal(backup.book.settings.goldenThreeReview.score, 76);
  const imported = await store.importBookBackup(backup);
  const importedContext = await store.readGoldenThreeReviewContext(imported.id);
  assert.equal(importedContext.review.score, 76);
  assert.equal(importedContext.isCurrent, true);

  await store.renameBook(book.id, '试炼新城', { expectedTitle: '试炼之城' });
  const afterTitle = await store.readGoldenThreeReviewContext(book.id);
  assert.notEqual(afterTitle.contextRevision, initial.contextRevision);
  assert.equal(afterTitle.isCurrent, false);
  await store.renameBook(book.id, '试炼之城', { expectedTitle: '试炼新城' });

  const first = await store.readChapter(book.id, section1.id, firstId);
  await store.versionSet(book.id, `section:${section1.id}:chapter:${firstId}`,
    '第一章改稿：主角为了妹妹接下试炼场。',
    { expectedRevision: store.versionRevision(first.body) });
  const afterBody = await store.readGoldenThreeReviewContext(book.id);
  assert.notEqual(afterBody.contextRevision, initial.contextRevision);
  assert.equal(afterBody.isCurrent, false);
  assert.equal((await store.saveGoldenThreeReview(book.id, modelReview({ quoted: true }), {
    expectedContextRevision: initial.contextRevision,
  })).applied, false);

  const third = await store.readChapter(book.id, section2.id, thirdId);
  assert.ok(third.bodyFingerprint);
});

test('前三章缺章或空正文时不允许产生联合审稿上下文', async () => {
  const book = await store.createBook({ premise: '缺章测试', title: '未完成' });
  const section = await store.addSection(book.id, { expectedLastSectionId: null });
  await addChapterWithText(book.id, section.id, '第一章正文');
  const missing = await store.readGoldenThreeReviewContext(book.id);
  assert.equal(missing.ready, false);
  assert.equal(missing.reason, 'chapters');
  await store.addChapter(book.id, section.id, {
    expectedLastChapterId: (await store.readSection(book.id, section.id)).chapters.at(-1),
  });
  await store.addChapter(book.id, section.id, {
    expectedLastChapterId: (await store.readSection(book.id, section.id)).chapters.at(-1),
  });
  const empty = await store.readGoldenThreeReviewContext(book.id);
  assert.equal(empty.ready, false);
  assert.equal(empty.reason, 'body');
  assert.deepEqual(empty.missingChapterIndexes, [2, 3]);
});

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as store from '../store.js';
import {
  MAX_BOOK_OUTLINE_PROMPT_CHARS, MAX_CORE_PROMPT_FIELD_CHARS,
  MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS,
  MAX_SECTION_OUTLINE_PROMPT_CHARS, MAX_SECTION_PROMPT_SUMMARY_CHARS,
  MAX_STORAGE_ROOT_DIRECTORY_ENTRIES, MAX_STORED_CHARACTERS,
  MAX_VERSION_HISTORY_ITEMS, MAX_VERSION_TEXT_CHARS,
} from '../limits.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let root;
beforeEach(() => { root = makeTestTempDir('novelbox-'); store.setDataRoot(root); });
afterEach(cleanupTestTempDirs);

async function deleteCurrentBook(id) {
  const book = await store.readBook(id);
  return store.deleteBook(id, { expectedUpdatedAt: book.updatedAt });
}

test('章节生成提交在同一锁域内拒绝已经变化的提示词上下文', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const previous = await store.addChapter(b.id, s.id, {});
  const target = await store.addChapter(b.id, s.id, {});
  const previousPath = `section:${s.id}:chapter:${previous.id}`;
  await store.versionSet(b.id, previousPath, '生成开始时的上一章');
  const prepared = await store.readChapterGenerationContext(b.id, s.id, target.id);

  await store.versionSet(b.id, previousPath, '生成期间改写的上一章');
  await assert.rejects(
    () => store.commitGeneratedChapter(b.id, s.id, target.id, '迟到生成结果', {
      expectedRevision: prepared.targetRevision,
      expectedContextRevision: prepared.contextRevision,
      expectedPreviousChapterId: prepared.previousChapterId,
      expectedPreviousChapterSectionId: prepared.previousChapterSectionId,
    }),
    /GENERATION_CONTEXT_CONFLICT/,
  );

  const savedTarget = await store.readChapter(b.id, s.id, target.id);
  assert.deepEqual(savedTarget.body.versions, ['']);
});

test('生成与审稿修订号只锚定实际发送的最近本部摘要窗口', () => {
  const sharedTail = '共同的最近剧情'.repeat(MAX_SECTION_PROMPT_SUMMARY_CHARS);
  const makeSection = (oldSummary, latest = sharedTail) => ({
    outline: { content: '本部大纲' },
    summary: `${oldSummary}\n${latest}`,
    characters: [],
  });
  const book = {
    outline: { versions: ['全书大纲'], cursor: 0 },
    settings: { core: {
      world: { versions: [''], cursor: 0 },
      style: { versions: [''], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
    characters: [],
  };
  const chapter = { id: 'chapter-2', index: 2 };
  const previousChapter = {
    id: 'chapter-1', body: { versions: ['上一章正文'], cursor: 0 },
    progress: '继续前进', characters: [],
  };

  const reviewA = store.chapterReviewContextRevision({
    book, section: makeSection('很早的摘要 A'), chapter,
  });
  const reviewB = store.chapterReviewContextRevision({
    book, section: makeSection('很早的摘要 B'), chapter,
  });
  const generationA = store.chapterGenerationContextRevision({
    book, section: makeSection('很早的摘要 A'), chapter,
    previousChapter, previousChapterSectionId: 'section-1',
  });
  const generationB = store.chapterGenerationContextRevision({
    book, section: makeSection('很早的摘要 B'), chapter,
    previousChapter, previousChapterSectionId: 'section-1',
  });

  assert.equal(reviewA, reviewB);
  assert.equal(generationA, generationB);
  assert.notEqual(reviewA, store.chapterReviewContextRevision({
    book, section: makeSection('很早的摘要 A', `${sharedTail}变化`), chapter,
  }));
});

test('章节生成与审稿修订号锚定实际发送的书名和作品简介', () => {
  const makeBook = (title, premise) => ({
    title,
    premise,
    outline: { versions: ['全书大纲'], cursor: 0 },
    settings: { core: {
      world: { versions: [''], cursor: 0 },
      style: { versions: [''], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
    characters: [],
  });
  const section = { id: 'section-1', outline: { content: '' }, summary: '', characters: [] };
  const chapter = { id: 'chapter-2', index: 2 };
  const previousChapter = {
    id: 'chapter-1', body: { versions: ['上一章'], cursor: 0 },
    progress: '', characters: [],
  };
  const baseBook = makeBook('旧书名', '旧简介承诺');
  const baseReview = store.chapterReviewContextRevision({ book: baseBook, section, chapter });
  const baseGeneration = store.chapterGenerationContextRevision({
    book: baseBook, section, chapter, previousChapter,
    previousChapterSectionId: 'section-1',
  });

  for (const changedBook of [
    makeBook('新书名', '旧简介承诺'),
    makeBook('旧书名', '新简介承诺'),
  ]) {
    assert.notEqual(baseReview, store.chapterReviewContextRevision({
      book: changedBook, section, chapter,
    }));
    assert.notEqual(baseGeneration, store.chapterGenerationContextRevision({
      book: changedBook, section, chapter, previousChapter,
      previousChapterSectionId: 'section-1',
    }));
  }
});

test('生成与审稿修订号只锚定人物提示词保留的主要与最近条目', () => {
  const characters = Array.from({ length: MAX_STORED_CHARACTERS }, (_, index) => ({
    name: `人物${index}`,
    role: '角色',
    desc: '状态'.repeat(250),
  }));
  const bookFor = (nextCharacters) => ({
    outline: { versions: ['全书大纲'], cursor: 0 },
    settings: { core: {
      world: { versions: [''], cursor: 0 },
      style: { versions: [''], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
    characters: nextCharacters,
  });
  const section = { outline: { content: '' }, summary: '', characters: [] };
  const chapter = { id: 'chapter-2', index: 2 };
  const base = store.chapterReviewContextRevision({
    book: bookFor(characters), section, chapter,
  });

  const omittedChange = structuredClone(characters);
  omittedChange[500].desc = '变化'.repeat(250);
  assert.equal(base, store.chapterReviewContextRevision({
    book: bookFor(omittedChange), section, chapter,
  }));

  const retainedChange = structuredClone(characters);
  retainedChange[0].desc = '变化'.repeat(250);
  assert.notEqual(base, store.chapterReviewContextRevision({
    book: bookFor(retainedChange), section, chapter,
  }));
});

test('上下文修订号忽略核心设定中段和上一章早期正文，只锚定实际提示词窗口', () => {
  const coreTail = '核心结尾';
  const coreText = `核心开头${'中'.repeat(MAX_CORE_PROMPT_FIELD_CHARS * 2)}${coreTail}`;
  const coreMiddleChanged = `${coreText.slice(0, MAX_CORE_PROMPT_FIELD_CHARS)}变${coreText.slice(MAX_CORE_PROMPT_FIELD_CHARS + 1)}`;
  const makeBook = (world) => ({
    premise: '故事设想',
    outline: { versions: ['全书大纲'], cursor: 0 },
    settings: { core: {
      world: { versions: [world], cursor: 0 },
      style: { versions: [''], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
    characters: [],
  });
  const section = { outline: { content: '本部大纲' }, summary: '', characters: [] };
  const chapter = { id: 'chapter-2', index: 2 };
  const previousTail = '末'.repeat(MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS);
  const previousFor = (prefix, tail = previousTail) => ({
    id: 'chapter-1',
    body: { versions: [`${prefix}${tail}`], cursor: 0 },
    progress: '继续前进',
    handoff: { location: '旧桥', ongoingAction: '正过桥' },
    characters: [],
  });

  assert.equal(
    store.bookGenerationContextRevision(makeBook(coreText)),
    store.bookGenerationContextRevision(makeBook(coreMiddleChanged)),
  );
  assert.notEqual(
    store.bookGenerationContextRevision(makeBook(coreText)),
    store.bookGenerationContextRevision(makeBook(`变${coreText.slice(1)}`)),
  );

  const base = store.chapterGenerationContextRevision({
    book: makeBook(coreText), section, chapter,
    previousChapter: previousFor('旧的早期正文 A'),
    previousChapterSectionId: 'section-1',
  });
  assert.equal(base, store.chapterGenerationContextRevision({
    book: makeBook(coreMiddleChanged), section, chapter,
    previousChapter: previousFor('完全不同的早期正文 B'),
    previousChapterSectionId: 'section-1',
  }));
  assert.notEqual(base, store.chapterGenerationContextRevision({
    book: makeBook(coreText), section, chapter,
    previousChapter: previousFor('旧的早期正文 A', `变${previousTail.slice(1)}`),
    previousChapterSectionId: 'section-1',
  }));
  assert.notEqual(base, store.chapterGenerationContextRevision({
    book: makeBook(coreText), section, chapter,
    previousChapter: {
      ...previousFor('旧的早期正文 A'),
      handoff: { location: '新桥', ongoingAction: '正过桥' },
    },
    previousChapterSectionId: 'section-1',
  }));

  const baseReview = store.chapterReviewContextRevision({
    book: makeBook(coreText), section, chapter,
    previousChapter: previousFor('旧的早期正文 A'),
    previousChapterSectionId: 'section-1',
  });
  assert.equal(baseReview, store.chapterReviewContextRevision({
    book: makeBook(coreMiddleChanged), section, chapter,
    previousChapter: previousFor('完全不同的早期正文 B'),
    previousChapterSectionId: 'section-1',
  }));
  assert.notEqual(baseReview, store.chapterReviewContextRevision({
    book: makeBook(coreText), section, chapter,
    previousChapter: previousFor('旧的早期正文 A', `变${previousTail.slice(1)}`),
    previousChapterSectionId: 'section-1',
  }));
  assert.notEqual(baseReview, store.chapterReviewContextRevision({
    book: makeBook(coreText), section, chapter,
    previousChapter: {
      ...previousFor('旧的早期正文 A'),
      handoff: { location: '新桥', ongoingAction: '正过桥' },
    },
    previousChapterSectionId: 'section-1',
  }));
});

test('章节上下文修订号只锚定实际发送的大纲窗口，分部规划仍锚定完整全书大纲', () => {
  const longText = (prefix, limit, suffix) =>
    `${prefix}${'中'.repeat(limit * 2)}${suffix}`;
  const outline = longText('全书开头', MAX_BOOK_OUTLINE_PROMPT_CHARS, '全书结尾');
  const changedOutline = `${outline.slice(0, MAX_BOOK_OUTLINE_PROMPT_CHARS)}变${outline.slice(MAX_BOOK_OUTLINE_PROMPT_CHARS + 1)}`;
  const sectionOutline = longText(
    '本部开头', MAX_SECTION_OUTLINE_PROMPT_CHARS, '本部结尾',
  );
  const changedSectionOutline = `${sectionOutline.slice(0, MAX_SECTION_OUTLINE_PROMPT_CHARS)}变${sectionOutline.slice(MAX_SECTION_OUTLINE_PROMPT_CHARS + 1)}`;
  const bookFor = (text) => ({
    outline: { versions: [text], cursor: 0 },
    settings: { core: {
      world: { versions: [''], cursor: 0 },
      style: { versions: [''], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
    characters: [],
  });
  const sectionFor = (text) => ({
    outline: { content: text }, summary: '', characters: [],
  });
  const chapter = { id: 'chapter-1', index: 1 };
  const base = store.chapterReviewContextRevision({
    book: bookFor(outline), section: sectionFor(sectionOutline), chapter,
  });

  assert.equal(base, store.chapterReviewContextRevision({
    book: bookFor(changedOutline), section: sectionFor(changedSectionOutline), chapter,
  }));
  assert.notEqual(base, store.chapterReviewContextRevision({
    book: bookFor(`变${outline.slice(1)}`), section: sectionFor(sectionOutline), chapter,
  }));
  assert.notEqual(base, store.chapterReviewContextRevision({
    book: bookFor(outline), section: sectionFor(`变${sectionOutline.slice(1)}`), chapter,
  }));
  assert.notEqual(
    store.sectionPlanContextRevision(bookFor(outline)),
    store.sectionPlanContextRevision(bookFor(changedOutline)),
  );
});

test('同部生成上下文跳过连续空章，并在空章后来写入时拒绝旧结果', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const completed = await store.addChapter(b.id, s.id, {});
  const empty = await store.addChapter(b.id, s.id, {});
  const target = await store.addChapter(b.id, s.id, {});
  await store.versionSet(
    b.id, `section:${s.id}:chapter:${completed.id}`, '真正的上一章正文',
  );
  const savedCompleted = await store.readChapter(b.id, s.id, completed.id);
  await store.applyChapterDigest(b.id, s.id, completed.id, {
    summary: '上一章摘要', progress: '沿河追踪失踪者',
    handoff: {
      viewpoint: '林越', time: '当夜', location: '河岸', ongoingAction: '正登船',
      immediatePressure: '巡逻队逼近', characterState: '衣服湿透', resourceState: '票根在手',
      knowledgeBoundary: '只知失踪者登船', unresolvedCausality: '船即将离岸',
    },
    newCharacters: [{ name: '船夫', role: '目击者', desc: '看见失踪者登船' }],
  }, { expectedBodyFingerprint: savedCompleted.bodyFingerprint });

  const prepared = await store.readChapterGenerationContext(b.id, s.id, target.id);
  assert.equal(prepared.previousChapterId, completed.id);
  assert.equal(store.currentText(prepared.previousChapter.body), '真正的上一章正文');
  assert.equal(prepared.previousChapter.progress, '沿河追踪失踪者');
  assert.equal(prepared.previousChapter.handoff.location, '河岸');

  // 原本为空的中间章一旦出现正文，就成为新的实际上一章；基于更早
  // 前情生成的结果必须被上下文锚点拒绝。
  await store.versionSet(b.id, `section:${s.id}:chapter:${empty.id}`, '后来补写的中间章');
  await assert.rejects(
    () => store.commitGeneratedChapter(b.id, s.id, target.id, '基于旧前情的迟到正文', {
      expectedRevision: prepared.targetRevision,
      expectedContextRevision: prepared.contextRevision,
      expectedPreviousChapterId: prepared.previousChapterId,
      expectedPreviousChapterSectionId: prepared.previousChapterSectionId,
    }),
    /GENERATION_CONTEXT_CONFLICT/,
  );
  assert.deepEqual((await store.readChapter(b.id, s.id, target.id)).body.versions, ['']);
});

test('新分部首章会跳过尾部空章和仅含空章的分部承接全书前情', async () => {
  const b = await store.createBook({ premise: 'p' });
  const previousSection = await store.addSection(b.id, {});
  const previous = await store.addChapter(b.id, previousSection.id, {});
  await store.versionSet(
    b.id,
    `section:${previousSection.id}:chapter:${previous.id}`,
    '上一部末尾：主角推开了石门。',
  );
  const savedPrevious = await store.readChapter(
    b.id, previousSection.id, previous.id,
  );
  await store.applyChapterDigest(b.id, previousSection.id, previous.id, {
    summary: '主角找到石门',
    progress: '进入石门后的地下城',
    newCharacters: [{ name: '守门人', role: '引路人', desc: '掌握地下城地图' }],
  }, { expectedBodyFingerprint: savedPrevious.bodyFingerprint });
  await store.addChapter(b.id, previousSection.id, {});
  const emptySection = await store.addSection(b.id, {});
  await store.addChapter(b.id, emptySection.id, {});
  const targetSection = await store.addSection(b.id, {});
  const target = await store.addChapter(b.id, targetSection.id, {});

  const context = await store.readChapterGenerationContext(
    b.id, targetSection.id, target.id,
  );

  assert.equal(context.previousChapterSectionId, previousSection.id);
  assert.equal(context.previousChapterId, previous.id);
  assert.equal(
    store.currentText(context.previousChapter.body),
    '上一部末尾：主角推开了石门。',
  );
  assert.equal(context.previousChapter.progress, '进入石门后的地下城');
  assert.deepEqual(context.previousChapter.characters, [
    { name: '守门人', role: '引路人', desc: '掌握地下城地图' },
  ]);
});

test('跨分部上一章在生成期间变化时拒绝迟到正文', async () => {
  const b = await store.createBook({ premise: 'p' });
  const previousSection = await store.addSection(b.id, {});
  const previous = await store.addChapter(b.id, previousSection.id, {});
  const previousPath = `section:${previousSection.id}:chapter:${previous.id}`;
  await store.versionSet(b.id, previousPath, '生成开始时的上一部末章');
  const targetSection = await store.addSection(b.id, {});
  const target = await store.addChapter(b.id, targetSection.id, {});
  const prepared = await store.readChapterGenerationContext(
    b.id, targetSection.id, target.id,
  );

  await store.versionSet(b.id, previousPath, '生成期间改写的上一部末章');
  await assert.rejects(
    () => store.commitGeneratedChapter(
      b.id, targetSection.id, target.id, '基于旧跨部前情的迟到正文', {
        expectedRevision: prepared.targetRevision,
        expectedContextRevision: prepared.contextRevision,
        expectedPreviousChapterId: prepared.previousChapterId,
        expectedPreviousChapterSectionId: prepared.previousChapterSectionId,
      },
    ),
    /GENERATION_CONTEXT_CONFLICT/,
  );

  assert.deepEqual(
    (await store.readChapter(b.id, targetSection.id, target.id)).body.versions,
    [''],
  );
});

test('生成与审稿上下文中途取消会停止快照组装并释放章节锁', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  await store.addChapter(b.id, s.id, {});
  const target = await store.addChapter(b.id, s.id, {});

  let generationChecks = 0;
  const generationSignal = {
    reason: new Error('CLIENT_ABORTED'),
    get aborted() {
      generationChecks += 1;
      // 外层、锁内起点、分部、当前章以及上一章读取后取消。
      return generationChecks >= 5;
    },
  };
  await assert.rejects(
    () => store.readChapterGenerationContext(
      b.id, s.id, target.id, { signal: generationSignal },
    ),
    /CLIENT_ABORTED/,
  );

  let reviewChecks = 0;
  const reviewSignal = {
    reason: new Error('CLIENT_ABORTED'),
    get aborted() {
      reviewChecks += 1;
      // 外层、锁内起点、分部以及作品/章节并行读取后取消。
      return reviewChecks >= 4;
    },
  };
  await assert.rejects(
    () => store.readChapterReviewContext(
      b.id, s.id, target.id, { signal: reviewSignal },
    ),
    /CLIENT_ABORTED/,
  );

  // 两次取消都必须经过 finally 释放锁，后续正文保存不能被挂住。
  const path = `section:${s.id}:chapter:${target.id}`;
  const before = await store.readChapter(b.id, s.id, target.id);
  await store.versionSet(b.id, path, '取消后的正常保存', {
    expectedRevision: store.versionRevision(before.body),
  });
  assert.equal(
    store.currentText((await store.readChapter(b.id, s.id, target.id)).body),
    '取消后的正常保存',
  );
});

test('生成提交与下一章创建在等待作品锁时可取消且不会迟到落盘', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const chapterContext = await store.readChapterGenerationContext(b.id, s.id, c.id);
  const preparedBook = await store.readBook(b.id);
  const outlineRevision = store.versionRevision(preparedBook.outline);
  const bookContextRevision = store.bookGenerationContextRevision(preparedBook);

  let releaseBookLock;
  let markBookLockHeld;
  const bookLockHeld = new Promise((resolve) => { markBookLockHeld = resolve; });
  const blocker = store.withStoreLock(`book:${b.id}:book-json`, async () => {
    markBookLockHeld();
    await new Promise((resolve) => { releaseBookLock = resolve; });
  });
  await bookLockHeld;

  const chapterController = new AbortController();
  const outlineController = new AbortController();
  const addController = new AbortController();
  const committingChapter = store.commitGeneratedChapter(
    b.id, s.id, c.id, '不应落盘的正文', {
      expectedRevision: chapterContext.targetRevision,
      expectedContextRevision: chapterContext.contextRevision,
      expectedPreviousChapterId: chapterContext.previousChapterId,
      expectedPreviousChapterSectionId: chapterContext.previousChapterSectionId,
      signal: chapterController.signal,
    },
  );
  const committingOutline = store.commitGeneratedBookVersion(
    b.id, 'outline', '不应落盘的大纲', {
      expectedRevision: outlineRevision,
      expectedContextRevision: bookContextRevision,
      signal: outlineController.signal,
    },
  );
  const addingChapter = store.addChapter(b.id, s.id, {
    expectedLastChapterId: c.id,
    signal: addController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  chapterController.abort(new Error('CLIENT_ABORTED'));
  outlineController.abort(new Error('CLIENT_ABORTED'));
  addController.abort(new Error('CLIENT_ABORTED'));

  const bounded = (operation) => {
    let timer;
    return Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('CANCEL_WAIT_TIMEOUT')), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  try {
    await Promise.all([
      assert.rejects(bounded(committingChapter), /CLIENT_ABORTED/),
      assert.rejects(bounded(committingOutline), /CLIENT_ABORTED/),
      assert.rejects(bounded(addingChapter), /CLIENT_ABORTED/),
    ]);
  } finally {
    releaseBookLock();
    await blocker;
  }

  assert.deepEqual((await store.readBook(b.id)).outline.versions, ['']);
  assert.deepEqual((await store.readChapter(b.id, s.id, c.id)).body.versions, ['']);
  assert.deepEqual((await store.readSection(b.id, s.id)).chapters, [c.id]);

  // 取消路径必须释放先取得的章节结构锁，后续正常创建不能挂住。
  const created = await store.addChapter(b.id, s.id, { expectedLastChapterId: c.id });
  assert.equal(created.id, 'chapter-02');
});

test('生成后处理在等待作品锁时可取消且不写入摘要、审稿或自动书名', async () => {
  const b = await store.createBook({ premise: '默认作品名' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  await store.versionSet(
    b.id, `section:${s.id}:chapter:${c.id}`, '正文',
  );
  const chapter = await store.readChapter(b.id, s.id, c.id);
  const reviewContext = await store.readChapterReviewContext(b.id, s.id, c.id);
  const preparedBook = await store.readBook(b.id);

  let releaseBookLock;
  let markBookLockHeld;
  const bookLockHeld = new Promise((resolve) => { markBookLockHeld = resolve; });
  const blocker = store.withStoreLock(`book:${b.id}:book-json`, async () => {
    markBookLockHeld();
    await new Promise((resolve) => { releaseBookLock = resolve; });
  });
  await bookLockHeld;

  const titleController = new AbortController();
  const digestController = new AbortController();
  const reviewController = new AbortController();
  const settingTitle = store.setGeneratedBookTitle(b.id, '迟到书名', {
    expectedOutlineRevision: store.versionRevision(preparedBook.outline),
    expectedContextRevision: store.bookGenerationContextRevision(preparedBook),
    signal: titleController.signal,
  });
  const applyingDigest = store.applyChapterDigest(b.id, s.id, c.id, {
    chapterTitle: '迟到章名', sectionTitle: '迟到部名',
    summary: '迟到摘要', progress: '迟到进度', newCharacters: [],
  }, {
    expectedBodyFingerprint: chapter.bodyFingerprint,
    signal: digestController.signal,
  });
  const savingReview = store.saveChapterReview(b.id, s.id, c.id, {
    score: 80,
    verdict: '迟到审稿',
    issues: [{ title: '问题', detail: '详情' }],
    suggestions: [{ label: '建议', instruction: '修改' }],
  }, {
    expectedBodyFingerprint: chapter.bodyFingerprint,
    expectedContextRevision: reviewContext.contextRevision,
    signal: reviewController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  titleController.abort(new Error('CLIENT_ABORTED'));
  digestController.abort(new Error('CLIENT_ABORTED'));
  reviewController.abort(new Error('CLIENT_ABORTED'));

  const bounded = (operation) => {
    let timer;
    return Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('CANCEL_WAIT_TIMEOUT')), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    await Promise.all([
      assert.rejects(bounded(settingTitle), /CLIENT_ABORTED/),
      assert.rejects(bounded(applyingDigest), /CLIENT_ABORTED/),
      assert.rejects(bounded(savingReview), /CLIENT_ABORTED/),
    ]);
  } finally {
    releaseBookLock();
    await blocker;
  }

  const savedBook = await store.readBook(b.id);
  const savedSection = await store.readSection(b.id, s.id);
  const savedChapter = await store.readChapter(b.id, s.id, c.id);
  assert.equal(savedBook.title, '默认作品名');
  assert.equal(savedBook.titleSource, 'default');
  assert.equal(savedSection.title, '');
  assert.equal(savedSection.summary, '');
  assert.equal(savedChapter.title, '');
  assert.equal(savedChapter.summary, '');
  assert.equal(savedChapter.review, undefined);
});

test('书级生成提交在同一锁内拒绝已经变化的核心设定上下文', async () => {
  const b = await store.createBook({ premise: 'p' });
  const preparedBook = await store.readBook(b.id);
  const targetRevision = store.versionRevision(preparedBook.outline);
  const contextRevision = store.bookGenerationContextRevision(preparedBook);
  await store.versionSet(b.id, 'core:constraints', '生成期间新增的约束');

  await assert.rejects(
    () => store.commitGeneratedBookVersion(b.id, 'outline', '迟到大纲', {
      expectedRevision: targetRevision,
      expectedContextRevision: contextRevision,
    }),
    /GENERATION_CONTEXT_CONFLICT/,
  );
  const saved = await store.readBook(b.id);
  assert.deepEqual(saved.outline.versions, ['']);
  assert.equal(store.currentText(saved.settings.core.constraints), '生成期间新增的约束');
});

test('迟到审稿不覆盖期间保存的新正文', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  await store.versionSet(b.id, path, '审稿基线');
  const baseline = await store.readChapter(b.id, s.id, c.id);
  await store.versionSet(b.id, path, '用户新正文');

  const result = await store.saveChapterReview(b.id, s.id, c.id, {
    score: 80, verdict: '旧审稿', issues: [], suggestions: [],
  }, { expectedBodyFingerprint: baseline.bodyFingerprint });

  assert.equal(result.applied, false);
  const back = await store.readChapter(b.id, s.id, c.id);
  assert.equal(store.currentText(back.body), '用户新正文');
  assert.equal(back.review, undefined);
});

test('迟到审稿不附着到已经变化的故事上下文', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  await store.versionSet(b.id, `section:${s.id}:chapter:${c.id}`, '正文');
  const prepared = await store.readChapterReviewContext(b.id, s.id, c.id);
  await store.versionSet(b.id, 'outline', '审稿期间更新的大纲');

  const result = await store.saveChapterReview(b.id, s.id, c.id, {
    score: 80, verdict: '旧审稿', issues: [], suggestions: [],
  }, {
    expectedBodyFingerprint: prepared.chapter.bodyFingerprint,
    expectedContextRevision: prepared.contextRevision,
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'context');
  assert.equal((await store.readChapter(b.id, s.id, c.id)).review, undefined);
});

test('删除中间章后审稿读取与保存使用同一逻辑章节序号', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  await store.addChapter(b.id, s.id, {});
  const removed = await store.addChapter(b.id, s.id, {});
  const target = await store.addChapter(b.id, s.id, {});
  await store.versionSet(
    b.id, `section:${s.id}:chapter:${target.id}`, '删章后的待审正文',
  );
  await store.deleteChapter(b.id, s.id, removed.id);
  const prepared = await store.readChapterReviewContext(b.id, s.id, target.id);

  const result = await store.saveChapterReview(b.id, s.id, target.id, {
    score: 88, verdict: '逻辑第二章审稿', issues: [], suggestions: [],
  }, {
    expectedBodyFingerprint: prepared.chapter.bodyFingerprint,
    expectedContextRevision: prepared.contextRevision,
  });

  assert.equal(prepared.chapter.index, 2);
  assert.equal(result.applied, true);
  const saved = await store.readChapter(b.id, s.id, target.id);
  assert.equal(saved.index, 2);
  assert.equal(saved.review.verdict, '逻辑第二章审稿');
});

test('生成与审稿上下文按全书章序识别黄金三章，不在新分部重算', async () => {
  const b = await store.createBook({ premise: '全书章序' });
  const firstSection = await store.addSection(b.id, { title: '上部' });
  await store.addChapter(b.id, firstSection.id, {});
  await store.addChapter(b.id, firstSection.id, {});
  await store.addChapter(b.id, firstSection.id, {});
  const secondSection = await store.addSection(b.id, { title: '下部' });
  const target = await store.addChapter(b.id, secondSection.id, {});

  const review = await store.readChapterReviewContext(
    b.id, secondSection.id, target.id,
  );
  const generation = await store.readChapterGenerationContext(
    b.id, secondSection.id, target.id,
  );

  assert.equal(review.chapter.index, 1);
  assert.equal(review.bookChapterIndex, 4);
  assert.equal(generation.chapter.index, 1);
  assert.equal(generation.bookChapterIndex, 4);
  assert.equal(review.contextRevision, store.chapterReviewContextRevision({
    book: review.book,
    section: review.section,
    chapter: review.chapter,
    bookChapterIndex: 4,
  }));
  assert.notEqual(review.contextRevision, store.chapterReviewContextRevision({
    book: review.book,
    section: review.section,
    chapter: review.chapter,
    bookChapterIndex: 1,
  }));
});

test('后续生成与审稿读取最近章节节奏信号并随记录变化更新修订号', async () => {
  const b = await store.createBook({ premise: '节奏历史' });
  const s = await store.addSection(b.id, {});
  const previous = await store.addChapter(b.id, s.id, {});
  await store.versionSet(
    b.id, `section:${s.id}:chapter:${previous.id}`, '上一章有冲突和兑现',
  );
  const previousBody = await store.readChapter(b.id, s.id, previous.id);
  await store.saveChapterReview(b.id, s.id, previous.id, {
    score: 80, verdict: '可读',
    issues: [{ title: '风险', detail: '连续追逐可能疲劳' }],
    suggestions: [{ label: '调整', instruction: '下一章改变冲突和情绪形态' }],
    webFictionSignals: {
      chapterFunction: '冲突推进', conflictType: '追逐', emotionTone: '紧张',
      payoffType: '脱险', dominantMode: '行动',
    },
  }, { expectedBodyFingerprint: previousBody.bodyFingerprint });
  const target = await store.addChapter(b.id, s.id, {});

  const before = await store.readChapterReviewContext(b.id, s.id, target.id);
  const generation = await store.readChapterGenerationContext(b.id, s.id, target.id);
  assert.deepEqual(before.recentReviewSignals.map(
    ({ bookChapterIndex, sectionChapterIndex, signals }) =>
      ({ bookChapterIndex, sectionChapterIndex, signals }),
  ), [{
    bookChapterIndex: 1,
    sectionChapterIndex: 1,
    signals: {
      chapterFunction: '冲突推进', conflictType: '追逐', emotionTone: '紧张',
      payoffType: '脱险', dominantMode: '行动',
    },
  }]);
  // 体量与质感度量不依赖审稿，只要有已保存正文就应当存在。
  assert.ok(before.recentReviewSignals[0].prose.chars > 0);
  assert.deepEqual(generation.recentReviewSignals, before.recentReviewSignals);

  const currentPrevious = await store.readChapter(b.id, s.id, previous.id);
  await store.saveChapterReview(b.id, s.id, previous.id, {
    score: 80, verdict: '可读',
    issues: [{ title: '风险', detail: '关系推进仍可加强' }],
    suggestions: [{ label: '调整', instruction: '让关系变化落到具体选择' }],
    webFictionSignals: {
      chapterFunction: '关系缓冲', conflictType: '试探', emotionTone: '温暖',
      payoffType: '关系兑现', dominantMode: '对话',
    },
  }, { expectedBodyFingerprint: currentPrevious.bodyFingerprint });

  const after = await store.readChapterReviewContext(b.id, s.id, target.id);
  assert.notEqual(after.contextRevision, before.contextRevision);
  assert.equal(after.recentReviewSignals[0].signals.emotionTone, '温暖');
  assert.equal(after.recentReviewSignals[0].signals.dominantMode, '对话');
});

test('迟到 digest 在正文变更后整体丢弃', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  await store.versionSet(b.id, path, '生成正文');
  const generated = await store.readChapter(b.id, s.id, c.id);
  await store.versionSet(b.id, path, '用户修订');

  const result = await store.applyChapterDigest(b.id, s.id, c.id, {
    chapterTitle: '旧标题', sectionTitle: '旧部名', summary: '旧摘要', progress: '旧进度',
    newCharacters: [{ name: '甲', role: '路人', desc: '旧人物' }],
  }, { expectedBodyFingerprint: generated.bodyFingerprint });

  assert.equal(result.applied, false);
  const chapter = await store.readChapter(b.id, s.id, c.id);
  const section = await store.readSection(b.id, s.id);
  const book = await store.readBook(b.id);
  assert.equal(store.currentText(chapter.body), '用户修订');
  assert.equal(chapter.summary, '');
  assert.equal(section.summary, '');
  assert.equal(book.progress, '');
});

test('同一正文重复 digest 覆盖摘要和人物，不累加幽灵人物', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  const path = `section:${s.id}:chapter:${c.id}`;
  await store.versionSet(b.id, path, '正文');
  const chapter = await store.readChapter(b.id, s.id, c.id);
  const firstCharacter = { name: '甲', role: '路人', desc: '第一次识别' };
  const replacementCharacter = { name: '乙', role: '证人', desc: '第二次识别' };

  await store.applyChapterDigest(b.id, s.id, c.id, {
    summary: '第一份摘要', progress: '', newCharacters: [firstCharacter],
  }, { expectedBodyFingerprint: chapter.bodyFingerprint });
  await store.applyChapterDigest(b.id, s.id, c.id, {
    summary: '更新后摘要', progress: '', newCharacters: [replacementCharacter],
  }, { expectedBodyFingerprint: chapter.bodyFingerprint });

  const chapterBack = await store.readChapter(b.id, s.id, c.id);
  const sectionBack = await store.readSection(b.id, s.id);
  assert.equal(chapterBack.summary, '更新后摘要');
  assert.deepEqual(chapterBack.characters, [replacementCharacter]);
  assert.equal(sectionBack.summary, '第1章：更新后摘要');

  const next = await store.addChapter(b.id, s.id, {});
  const context = await store.readChapterGenerationContext(b.id, s.id, next.id);
  assert.deepEqual(context.previousChapter.characters, [replacementCharacter]);
});

test('digest 中断后流式扫描大型章节历史并重建摘要和路标', async () => {
  const book = await store.createBook({ premise: '摘要恢复' });
  const section = await store.addSection(book.id, {});
  const first = await store.addChapter(book.id, section.id, {});
  const second = await store.addChapter(book.id, section.id, {});
  await store.versionSet(book.id, `section:${section.id}:chapter:${first.id}`, '第一章正文');
  await store.versionSet(book.id, `section:${section.id}:chapter:${second.id}`, '第二章正文');
  const savedFirst = await store.readChapter(book.id, section.id, first.id);
  await store.applyChapterDigest(book.id, section.id, first.id, {
    summary: '第一章摘要', progress: '第一章路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedFirst.bodyFingerprint });
  const largeFirst = await store.readChapter(book.id, section.id, first.id);
  largeFirst.body = {
    versions: Array.from(
      { length: MAX_VERSION_HISTORY_ITEMS },
      () => '大型历史'.repeat(10_000),
    ),
    cursor: 8,
  };
  await store.writeChapter(book.id, section.id, first.id, largeFirst);

  const transactionPath = join(
    root, 'books', book.id, section.id, '.chapter-digest-transaction.json',
  );
  const partialChapter = await store.readChapter(book.id, section.id, second.id);
  partialChapter.summary = '第二章摘要';
  partialChapter.progress = '第二章路标';
  const partialBook = await store.readBook(book.id);
  partialBook.progress = '第二章路标';
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-chapter-digest-transaction',
    version: 1,
    bookId: book.id,
    sectionId: section.id,
    chapterId: second.id,
    bodyFingerprint: partialChapter.bodyFingerprint,
  });
  // 模拟 digest 已写 book/chapter、尚未写 section 时进程退出。
  await store.atomicWriteJson(join(root, 'books', book.id, 'book.json'), partialBook);
  await store.atomicWriteJson(
    join(root, 'books', book.id, section.id, `${second.id}.json`), partialChapter,
  );

  const diagnostics = await store.diagnoseStorage();
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'CHAPTER_DIGEST_TRANSACTION_PENDING'
      && issue.bookId === book.id && issue.sectionId === section.id));

  const originalJsonParse = JSON.parse;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.length > 64 * 1024) {
      throw new Error('WHOLE_CHAPTER_JSON_PARSE_FORBIDDEN');
    }
    return originalJsonParse(text, ...args);
  };
  try {
    await store.readBookStructure(book.id);
  } finally {
    JSON.parse = originalJsonParse;
  }
  assert.equal(existsSync(transactionPath), false);
  const recoveredSection = await store.readSection(book.id, section.id);
  assert.equal(
    recoveredSection.summary,
    '第1章：第一章摘要\n第2章：第二章摘要',
  );
  assert.equal(recoveredSection.progress, '第二章路标');
  assert.equal((await store.readBook(book.id)).progress, '第二章路标');
});

test('digest 明确返回空人物列表时清除同一正文的旧人物', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  await store.versionSet(b.id, `section:${s.id}:chapter:${c.id}`, '正文');
  const chapter = await store.readChapter(b.id, s.id, c.id);

  await store.applyChapterDigest(b.id, s.id, c.id, {
    summary: '第一份摘要', progress: '',
    newCharacters: [{ name: '甲', role: '路人', desc: '误识别' }],
  }, { expectedBodyFingerprint: chapter.bodyFingerprint });
  await store.applyChapterDigest(b.id, s.id, c.id, {
    summary: '更新后摘要', progress: '', newCharacters: [],
  }, { expectedBodyFingerprint: chapter.bodyFingerprint });

  assert.deepEqual((await store.readChapter(b.id, s.id, c.id)).characters, []);
});

test('同一章并发 digest 的人物结果保持整份快照，不会合并', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const c = await store.addChapter(b.id, s.id, {});
  await store.versionSet(b.id, `section:${s.id}:chapter:${c.id}`, '正文');
  const chapter = await store.readChapter(b.id, s.id, c.id);
  const firstCharacters = [{ name: '甲', role: '路人', desc: '第一份结果' }];
  const secondCharacters = [{ name: '乙', role: '证人', desc: '第二份结果' }];

  await Promise.all([
    store.applyChapterDigest(b.id, s.id, c.id, {
      summary: '第一份摘要', progress: '', newCharacters: firstCharacters,
    }, { expectedBodyFingerprint: chapter.bodyFingerprint }),
    store.applyChapterDigest(b.id, s.id, c.id, {
      summary: '第二份摘要', progress: '', newCharacters: secondCharacters,
    }, { expectedBodyFingerprint: chapter.bodyFingerprint }),
  ]);

  const characters = (await store.readChapter(b.id, s.id, c.id)).characters;
  assert.ok(
    JSON.stringify(characters) === JSON.stringify(firstCharacters)
      || JSON.stringify(characters) === JSON.stringify(secondCharacters),
  );
});

test('重写本部较早章节时新 digest 不会让分部和全书路标倒退', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const early = await store.addChapter(b.id, s.id, {});
  const late = await store.addChapter(b.id, s.id, {});
  const earlyPath = `section:${s.id}:chapter:${early.id}`;
  const latePath = `section:${s.id}:chapter:${late.id}`;
  await store.versionSet(b.id, earlyPath, '第一章旧正文');
  await store.versionSet(b.id, latePath, '第二章正文');
  let savedEarly = await store.readChapter(b.id, s.id, early.id);
  const savedLate = await store.readChapter(b.id, s.id, late.id);
  await store.applyChapterDigest(b.id, s.id, early.id, {
    summary: '第一章旧摘要', progress: '第一章旧路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedEarly.bodyFingerprint });
  await store.applyChapterDigest(b.id, s.id, late.id, {
    summary: '第二章摘要', progress: '第二章最新路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedLate.bodyFingerprint });

  await store.versionSet(b.id, earlyPath, '第一章重写正文');
  savedEarly = await store.readChapter(b.id, s.id, early.id);
  await store.applyChapterDigest(b.id, s.id, early.id, {
    summary: '第一章新摘要', progress: '第一章重写路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedEarly.bodyFingerprint });

  const [earlyBack, sectionBack, bookBack] = await Promise.all([
    store.readChapter(b.id, s.id, early.id),
    store.readSection(b.id, s.id),
    store.readBook(b.id),
  ]);
  assert.equal(earlyBack.progress, '第一章重写路标');
  assert.equal(sectionBack.progress, '第二章最新路标');
  assert.equal(bookBack.progress, '第二章最新路标');
  assert.equal(sectionBack.summary, '第1章：第一章新摘要\n第2章：第二章摘要');
});

test('删除中间章后分部聚合摘要按当前正文顺序重新编号', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const chapters = [];
  for (const [index, label] of ['一', '二', '三'].entries()) {
    const chapter = await store.addChapter(b.id, s.id, {});
    await store.versionSet(
      b.id, `section:${s.id}:chapter:${chapter.id}`, `第${label}章正文`,
    );
    const saved = await store.readChapter(b.id, s.id, chapter.id);
    await store.applyChapterDigest(b.id, s.id, chapter.id, {
      summary: `第${label}章摘要`, progress: `第${label}章路标`, newCharacters: [],
    }, { expectedBodyFingerprint: saved.bodyFingerprint });
    chapters[index] = chapter;
  }

  await store.deleteChapter(b.id, s.id, chapters[1].id);

  const section = await store.readSection(b.id, s.id);
  assert.equal(section.summary, '第1章：第一章摘要\n第2章：第三章摘要');
  assert.deepEqual(section.chapters, [chapters[0].id, chapters[2].id]);
});

test('重写较早分部末章时只更新该分部路标，不覆盖全书末章路标', async () => {
  const b = await store.createBook({ premise: 'p' });
  const earlySection = await store.addSection(b.id, {});
  const early = await store.addChapter(b.id, earlySection.id, {});
  const lateSection = await store.addSection(b.id, {});
  const late = await store.addChapter(b.id, lateSection.id, {});
  const earlyPath = `section:${earlySection.id}:chapter:${early.id}`;
  const latePath = `section:${lateSection.id}:chapter:${late.id}`;
  await store.versionSet(b.id, earlyPath, '上一部旧正文');
  await store.versionSet(b.id, latePath, '当前部末章正文');
  let savedEarly = await store.readChapter(b.id, earlySection.id, early.id);
  const savedLate = await store.readChapter(b.id, lateSection.id, late.id);
  await store.applyChapterDigest(b.id, earlySection.id, early.id, {
    summary: '上一部旧摘要', progress: '上一部旧路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedEarly.bodyFingerprint });
  await store.applyChapterDigest(b.id, lateSection.id, late.id, {
    summary: '当前部摘要', progress: '全书最新路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedLate.bodyFingerprint });

  await store.versionSet(b.id, earlyPath, '上一部重写正文');
  savedEarly = await store.readChapter(b.id, earlySection.id, early.id);
  await store.applyChapterDigest(b.id, earlySection.id, early.id, {
    summary: '上一部新摘要', progress: '上一部重写路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedEarly.bodyFingerprint });

  assert.equal(
    (await store.readSection(b.id, earlySection.id)).progress,
    '上一部重写路标',
  );
  assert.equal((await store.readBook(b.id)).progress, '全书最新路标');
});

test('跨分部 digest 并发时全书路标始终归属正文顺序中的末章', async () => {
  const b = await store.createBook({ premise: 'p' });
  const earlySection = await store.addSection(b.id, {});
  const early = await store.addChapter(b.id, earlySection.id, {});
  const lateSection = await store.addSection(b.id, {});
  const late = await store.addChapter(b.id, lateSection.id, {});
  await store.versionSet(
    b.id, `section:${earlySection.id}:chapter:${early.id}`, '早期分部正文',
  );
  await store.versionSet(
    b.id, `section:${lateSection.id}:chapter:${late.id}`, '后期分部正文',
  );
  const [savedEarly, savedLate] = await Promise.all([
    store.readChapter(b.id, earlySection.id, early.id),
    store.readChapter(b.id, lateSection.id, late.id),
  ]);

  // 故意先发起末章 digest，再发起早期章节 digest。无论锁调度顺序
  // 如何，后完成的早期 digest 也不得把全书路标拉回去。
  await Promise.all([
    store.applyChapterDigest(b.id, lateSection.id, late.id, {
      summary: '后期摘要', progress: '全书末章路标', newCharacters: [],
    }, { expectedBodyFingerprint: savedLate.bodyFingerprint }),
    store.applyChapterDigest(b.id, earlySection.id, early.id, {
      summary: '早期摘要', progress: '早期章节路标', newCharacters: [],
    }, { expectedBodyFingerprint: savedEarly.bodyFingerprint }),
  ]);

  assert.equal((await store.readSection(b.id, earlySection.id)).progress, '早期章节路标');
  assert.equal((await store.readSection(b.id, lateSection.id)).progress, '全书末章路标');
  assert.equal((await store.readBook(b.id)).progress, '全书末章路标');
});

test('清空末章正文时分部和全书路标回到上一个非空章节', async () => {
  const b = await store.createBook({ premise: 'p' });
  const s = await store.addSection(b.id, {});
  const first = await store.addChapter(b.id, s.id, {});
  const last = await store.addChapter(b.id, s.id, {});
  const firstPath = `section:${s.id}:chapter:${first.id}`;
  const lastPath = `section:${s.id}:chapter:${last.id}`;
  await store.versionSet(b.id, firstPath, '上一章正文');
  await store.versionSet(b.id, lastPath, '末章正文');
  const [savedFirst, savedLast] = await Promise.all([
    store.readChapter(b.id, s.id, first.id),
    store.readChapter(b.id, s.id, last.id),
  ]);
  await store.applyChapterDigest(b.id, s.id, first.id, {
    summary: '上一章摘要', progress: '上一章路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedFirst.bodyFingerprint });
  await store.applyChapterDigest(b.id, s.id, last.id, {
    summary: '末章摘要', progress: '末章路标', newCharacters: [],
  }, { expectedBodyFingerprint: savedLast.bodyFingerprint });

  const beforeClear = await store.readChapter(b.id, s.id, last.id);
  await store.versionSet(b.id, lastPath, '', {
    expectedRevision: store.versionRevision(beforeClear.body),
  });

  assert.equal((await store.readSection(b.id, s.id)).progress, '上一章路标');
  assert.equal((await store.readBook(b.id)).progress, '上一章路标');
});

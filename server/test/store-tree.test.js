import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../store.js';
import {
  MAX_BOOK_SECTIONS, MAX_SECTION_CHAPTERS, MAX_STRUCTURE_TRANSACTION_JSON_BYTES,
  MAX_TITLE_CHARS, MAX_TOTAL_BOOK_CHAPTERS, MAX_VERSION_HISTORY_ITEMS,
} from '../limits.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';

let bookId;
let root;
beforeEach(async () => {
  root = makeTestTempDir('novelbox-');
  store.setDataRoot(root);
  const b = await store.createBook({ premise: 'p', title: 't' });
  bookId = b.id;
});
afterEach(cleanupTestTempDirs);

test('addSection 追加进 book.sections', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  assert.equal(s.index, 1);
  assert.equal(s.title, '起源');
  assert.equal(s.titleSource, 'manual');
  assert.match(s.id, /^section-01$/);
  const book = await store.readBook(bookId);
  assert.deepEqual(book.sections, ['section-01']);
});

test('导入作品已有按数量生成的分部 ID 时新建分部不能伪成功或覆盖', async () => {
  const sourceSection = await store.addSection(bookId, { title: '导入前已有部' });
  const backup = await store.createBookBackup(bookId);
  backup.book.sections[0] = 'section-02';
  backup.sections[0].section.id = 'section-02';
  const imported = await store.importBookBackup(backup);

  const created = await store.addSection(imported.id, {
    title: '真正新增部',
    expectedLastSectionId: 'section-02',
  });
  const savedBook = await store.readBook(imported.id);

  assert.equal(created.id, 'section-03');
  assert.equal(created.index, 2);
  assert.equal(created.title, '真正新增部');
  assert.deepEqual(savedBook.sections, ['section-02', created.id]);
  assert.equal((await store.readSection(imported.id, 'section-02')).title, sourceSection.title);
  assert.equal((await store.readSection(imported.id, created.id)).title, '真正新增部');
  assert.equal((await store.diagnoseStorage({ deep: true })).ok, true);
});

test('残留的已提交分部事务不会冒充下一次新建分部成功', async () => {
  const previous = await store.addSection(bookId, { title: '上一笔' });
  const edited = await store.readSection(bookId, previous.id);
  edited.title = '上一笔提交后的编辑';
  await store.writeSection(bookId, previous.id, edited);
  await store.atomicWriteJson(
    join(root, 'books', bookId, '.book-structure-transaction.json'),
    {
      format: 'auto-novel-box-structure-transaction', version: 1, type: 'add-section',
      bookId, sectionId: previous.id, section: previous,
    },
  );

  await assert.rejects(
    () => store.addSection(bookId, { title: '本次请求' }),
    /STRUCTURE_TRANSACTION_RECOVERED/,
  );
  assert.deepEqual((await store.readBook(bookId)).sections, ['section-01']);
  assert.equal(
    (await store.readSection(bookId, previous.id)).title,
    '上一笔提交后的编辑',
  );
  assert.equal(existsSync(join(root, 'books', bookId, '.book-structure-transaction.json')), false);

  const created = await store.addSection(bookId, { title: '本次请求' });
  assert.equal(created.id, 'section-02');
  assert.equal(created.title, '本次请求');
});

test('并发 addSection 仍生成连续且不重复的部 id', async () => {
  const sections = await Promise.all([
    store.addSection(bookId, { title: '一' }),
    store.addSection(bookId, { title: '二' }),
    store.addSection(bookId, { title: '三' }),
    store.addSection(bookId, { title: '四' }),
    store.addSection(bookId, { title: '五' }),
  ]);

  assert.deepEqual(sections.map((s) => s.id), [
    'section-01',
    'section-02',
    'section-03',
    'section-04',
    'section-05',
  ]);
  const book = await store.readBook(bookId);
  assert.deepEqual(book.sections, [
    'section-01',
    'section-02',
    'section-03',
    'section-04',
    'section-05',
  ]);
});

test('相同末部锚点的并发 addSection 只有一个可以提交', async () => {
  const previous = await store.addSection(bookId, { title: '已有末部' });

  const results = await Promise.allSettled([
    store.addSection(bookId, {
      title: '请求甲', expectedLastSectionId: previous.id,
    }),
    store.addSection(bookId, {
      title: '请求乙', expectedLastSectionId: previous.id,
    }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.match(String(rejected?.reason?.message), /NEXT_SECTION_CONFLICT/);
  const saved = await store.readBook(bookId);
  assert.equal(saved.sections.length, 2);
  assert.equal(saved.sections[0], previous.id);
});

test('addChapter 追加进 section.chapters，序号递增', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  const c1 = await store.addChapter(bookId, s.id, { title: '初见' });
  const c2 = await store.addChapter(bookId, s.id, {});
  assert.equal(c1.index, 1);
  assert.equal(c1.status, 'done');
  assert.equal(c1.title, '初见');
  assert.equal(c1.titleSource, 'manual');
  assert.match(c1.id, /^chapter-01$/);
  assert.equal(c2.title, '');
  assert.equal(c2.titleSource, 'default');
  assert.match(c2.id, /^chapter-02$/);  // 序号递增且两位格式
  const sec = await store.readSection(bookId, s.id);
  assert.deepEqual(sec.chapters, ['chapter-01', 'chapter-02']);
});

test('导入作品的超长数字章节 ID 不会让后续新增生成非法路径或阻塞事务', async () => {
  const sourceSection = await store.addSection(bookId, { title: '长 ID 部' });
  const sourceChapter = await store.addChapter(bookId, sourceSection.id, { title: '导入前章节' });
  const backup = await store.createBookBackup(bookId);
  const longChapterId = `chapter-${'9'.repeat(120)}`;
  backup.sections[0].section.chapters[0] = longChapterId;
  backup.sections[0].chapters[0].id = longChapterId;
  const imported = await store.importBookBackup(backup);

  const created = await store.addChapter(imported.id, sourceSection.id, {
    title: '导入后新增章',
    expectedLastChapterId: longChapterId,
  });
  const savedSection = await store.readSection(imported.id, sourceSection.id);

  assert.equal(created.index, 2);
  assert.equal(created.id, 'chapter-u-02');
  assert.notEqual(created.id, longChapterId);
  assert.deepEqual(savedSection.chapters, [longChapterId, created.id]);
  assert.equal(
    (await store.readChapter(imported.id, sourceSection.id, longChapterId)).title,
    sourceChapter.title,
  );
  assert.equal((await store.diagnoseStorage({ deep: true })).ok, true);
});

test('导入作品的自定义章节 ID 可以正常删除且不留下阻塞事务', async () => {
  const sourceSection = await store.addSection(bookId, { title: '兼容旧数据' });
  await store.addChapter(bookId, sourceSection.id, { title: '待删除章' });
  const backup = await store.createBookBackup(bookId);
  const customChapterId = 'legacy_chapter';
  backup.sections[0].section.chapters[0] = customChapterId;
  backup.sections[0].chapters[0].id = customChapterId;
  const imported = await store.importBookBackup(backup);

  await store.deleteChapter(imported.id, sourceSection.id, customChapterId);

  assert.deepEqual((await store.readSection(imported.id, sourceSection.id)).chapters, []);
  assert.equal(
    existsSync(join(
      root, 'books', imported.id, sourceSection.id, '.section-structure-transaction.json',
    )),
    false,
  );
  assert.equal((await store.diagnoseStorage({ deep: true })).ok, true);
});

test('残留的已提交章节事务不会冒充下一次新建章节成功', async () => {
  const section = await store.addSection(bookId, { title: '起源' });
  const previous = await store.addChapter(bookId, section.id, { title: '上一笔' });
  await store.versionSet(
    bookId, `section:${section.id}:chapter:${previous.id}`, '上一笔提交后的正文',
  );
  await store.atomicWriteJson(
    join(root, 'books', bookId, section.id, '.section-structure-transaction.json'),
    {
      format: 'auto-novel-box-structure-transaction', version: 1, type: 'add-chapter',
      bookId, sectionId: section.id, chapterId: previous.id, chapter: previous,
    },
  );

  await assert.rejects(
    () => store.addChapter(bookId, section.id, { title: '本次请求' }),
    /STRUCTURE_TRANSACTION_RECOVERED/,
  );
  assert.deepEqual((await store.readSection(bookId, section.id)).chapters, ['chapter-01']);
  assert.equal(
    store.currentText((await store.readChapter(bookId, section.id, previous.id)).body),
    '上一笔提交后的正文',
  );
  assert.equal(existsSync(join(
    root, 'books', bookId, section.id, '.section-structure-transaction.json',
  )), false);

  const created = await store.addChapter(bookId, section.id, { title: '本次请求' });
  assert.equal(created.id, 'chapter-02');
  assert.equal(created.title, '本次请求');
});

test('readBookStructure 只返回章节元数据，正文按引用单独读取', async () => {
  const section = await store.addSection(bookId, { title: '起源' });
  const chapter = await store.addChapter(bookId, section.id, { title: '觉醒' });
  await store.versionSet(bookId, `section:${section.id}:chapter:${chapter.id}`, '完整正文');

  const structure = await store.readBookStructure(bookId);
  const summary = structure.sections[0].chapters[0];
  assert.deepEqual(summary, {
    id: chapter.id,
    index: 1,
    title: '觉醒',
    titleSource: 'manual',
    status: 'done',
    hasContent: true,
    characterCount: 4,
    publicationStatus: 'unpublished',
  });
  assert.equal(summary.body, undefined);
  assert.equal(summary.content, undefined);

  const loaded = await store.readReferencedChapter(bookId, section.id, chapter.id);
  assert.equal(store.currentText(loaded.body), '完整正文');
});

test('作品树投影统计存稿字数并区分发布状态，不加载正文到树', async () => {
  const section = await store.addSection(bookId, { title: '连载' });
  const chapter = await store.addChapter(bookId, section.id, { title: '上架' });
  const path = `section:${section.id}:chapter:${chapter.id}`;
  await store.versionSet(bookId, path, '正 文\n😀');

  let summary = (await store.readBookStructure(bookId)).sections[0].chapters[0];
  assert.equal(summary.characterCount, 3);
  assert.equal(summary.publicationStatus, 'unpublished');
  assert.equal(summary.body, undefined);
  assert.equal(summary.content, undefined);

  const current = await store.readChapter(bookId, section.id, chapter.id);
  await store.publishChapterVersion(bookId, section.id, chapter.id, {
    expectedBodyFingerprint: current.bodyFingerprint,
    expectedMemoryRevision: store.bookMemoryRevision(await store.readBook(bookId)),
  });
  summary = (await store.readBookStructure(bookId)).sections[0].chapters[0];
  assert.equal(summary.publicationStatus, 'published');
  assert.equal(summary.publishedCharacterCount, 3);
  assert.equal(summary.publicationNumber, 1);
  assert.ok(Number.isFinite(Date.parse(summary.publishedAt)));

  await store.versionSet(bookId, path, '新的存稿', {
    expectedRevision: store.versionRevision((await store.readChapter(
      bookId, section.id, chapter.id,
    )).body),
  });
  summary = (await store.readBookStructure(bookId)).sections[0].chapters[0];
  assert.equal(summary.publicationStatus, 'modified');
  assert.equal(summary.characterCount, 4);
  assert.equal(summary.publishedCharacterCount, 3);
});

test('每日字数目标持久化、带修订冲突保护并进入作品备份', async () => {
  const initial = (await store.readBookStructure(bookId)).book.settings.serialization;
  assert.equal(initial.dailyWordGoal, 2000);
  assert.match(initial.revision, /^[A-Za-z0-9_-]{43}$/);

  const saved = await store.updateBookSerializationSettings(bookId, {
    dailyWordGoal: 6000,
    expectedRevision: initial.revision,
  });
  assert.equal(saved.dailyWordGoal, 6000);
  assert.notEqual(saved.revision, initial.revision);
  await assert.rejects(
    () => store.updateBookSerializationSettings(bookId, {
      dailyWordGoal: 8000, expectedRevision: initial.revision,
    }),
    /SERIALIZATION_CONFLICT/,
  );
  await assert.rejects(
    () => store.updateBookSerializationSettings(bookId, {
      dailyWordGoal: 0, expectedRevision: saved.revision,
    }),
    /BAD_DAILY_WORD_GOAL/,
  );

  const backup = await store.createBookBackup(bookId);
  assert.equal(backup.book.settings.serialization.dailyWordGoal, 6000);
  const imported = await store.importBookBackup(backup);
  assert.equal((await store.readBookStructure(imported.id))
    .book.settings.serialization.dailyWordGoal, 6000);
});

test('作品树流式验证大型版本历史且以实际游标正文判断空值', async () => {
  const section = await store.addSection(bookId, { title: '大型历史部' });
  const chapter = await store.addChapter(bookId, section.id, { title: '大型历史章' });
  const stored = await store.readChapter(bookId, section.id, chapter.id);
  const currentIndex = 13;
  stored.body = {
    versions: Array.from(
      { length: MAX_VERSION_HISTORY_ITEMS },
      (_, index) => index === currentIndex ? ' \n\t' : 'x'.repeat(50_000),
    ),
    cursor: currentIndex,
  };
  // 派生缓存故意与正文同时陈旧；作品树必须以 body.cursor 为准。
  stored.content = '陈旧缓存仍然非空';
  stored.bodyFingerprint = store.contentFingerprint(stored.content);
  await store.writeChapter(bookId, section.id, chapter.id, stored);

  const originalJsonParse = JSON.parse;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.length > 64 * 1024) {
      throw new Error('WHOLE_CHAPTER_JSON_PARSE_FORBIDDEN');
    }
    return originalJsonParse(text, ...args);
  };
  try {
    const structure = await store.readBookStructure(bookId);
    assert.equal(structure.sections[0].chapters[0].hasContent, false);
  } finally {
    JSON.parse = originalJsonParse;
  }

  stored.body.cursor = currentIndex - 1;
  await store.writeChapter(bookId, section.id, chapter.id, stored);
  assert.equal(
    (await store.readBookStructure(bookId)).sections[0].chapters[0].hasContent,
    true,
  );
});

test('作品树严格扫描大型分部聚合数据但不整份解析', async () => {
  const section = await store.addSection(bookId, { title: '大型聚合部' });
  const chapter = await store.addChapter(bookId, section.id, { title: '第一章' });
  section.chapters = [chapter.id];
  section.summary = '聚合摘要'.repeat(200_000);
  section.chapterSummaries = {
    [chapter.id]: { index: 1, summary: '本章摘要' },
  };
  await store.writeSection(bookId, section.id, section);

  const originalJsonParse = JSON.parse;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.length > 64 * 1024) {
      throw new Error('WHOLE_SECTION_JSON_PARSE_FORBIDDEN');
    }
    return originalJsonParse(text, ...args);
  };
  try {
    const structure = await store.readBookStructure(bookId);
    assert.equal(structure.sections[0].title, '大型聚合部');
    assert.deepEqual(
      structure.sections[0].chapters.map((item) => item.id),
      [chapter.id],
    );
  } finally {
    JSON.parse = originalJsonParse;
  }

  const sectionPath = join(root, 'books', bookId, section.id, 'section.json');
  writeFileSync(sectionPath, `${JSON.stringify(section)} trailing`, 'utf8');
  await assert.rejects(
    () => store.readBookStructure(bookId),
    /Stored JSON is invalid/,
  );
});

test('作品树对早期分部标题来源类型回退完整规范化', async () => {
  const section = await store.addSection(bookId, { title: '旧分部' });
  section.titleSource = 7;
  await store.writeSection(bookId, section.id, section);

  const loaded = (await store.readBookStructure(bookId)).sections[0];
  assert.equal(loaded.title, '旧分部');
  assert.equal(loaded.titleSource, 'manual');
});

test('新增章核对全书总数时不整份解析其它大型分部', async () => {
  const largeSection = await store.addSection(bookId, { title: '大型前部' });
  largeSection.summary = '前情'.repeat(300_000);
  await store.writeSection(bookId, largeSection.id, largeSection);
  const targetSection = await store.addSection(bookId, { title: '目标部' });

  const originalJsonParse = JSON.parse;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.length > 64 * 1024) {
      throw new Error('WHOLE_SECTION_JSON_PARSE_FORBIDDEN');
    }
    return originalJsonParse(text, ...args);
  };
  try {
    const created = await store.addChapter(bookId, targetSection.id, {
      title: '新章',
      expectedLastChapterId: null,
    });
    assert.equal(created.id, 'chapter-01');
  } finally {
    JSON.parse = originalJsonParse;
  }
});

test('清空末章回退剧情路标时只流式提取前章当前版', async () => {
  const section = await store.addSection(bookId, { title: '路标部' });
  const previous = await store.addChapter(bookId, section.id, { title: '前章' });
  const target = await store.addChapter(bookId, section.id, { title: '末章' });
  await store.versionSet(
    bookId,
    `section:${section.id}:chapter:${target.id}`,
    '即将清空的末章',
  );

  const storedPrevious = await store.readChapter(bookId, section.id, previous.id);
  storedPrevious.body = {
    versions: Array.from(
      { length: MAX_VERSION_HISTORY_ITEMS },
      () => '前章大型历史'.repeat(7_000),
    ),
    cursor: 9,
  };
  storedPrevious.progress = '前章剧情路标';
  await store.writeChapter(bookId, section.id, previous.id, storedPrevious);

  const originalJsonParse = JSON.parse;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.length > 64 * 1024) {
      throw new Error('WHOLE_CHAPTER_JSON_PARSE_FORBIDDEN');
    }
    return originalJsonParse(text, ...args);
  };
  try {
    await store.versionSet(
      bookId,
      `section:${section.id}:chapter:${target.id}`,
      '',
    );
  } finally {
    JSON.parse = originalJsonParse;
  }

  assert.equal((await store.readSection(bookId, section.id)).progress, '前章剧情路标');
  assert.equal((await store.readBook(bookId)).progress, '前章剧情路标');
});

test('跨分部寻找上一章时不整份解析前部聚合数据', async () => {
  const previousSection = await store.addSection(bookId, { title: '前部' });
  const previous = await store.addChapter(bookId, previousSection.id, { title: '前章' });
  await store.versionSet(
    bookId,
    `section:${previousSection.id}:chapter:${previous.id}`,
    '跨分部前章正文',
  );
  previousSection.chapters = [previous.id];
  previousSection.summary = '大型前部聚合'.repeat(150_000);
  await store.writeSection(bookId, previousSection.id, previousSection);

  const currentSection = await store.addSection(bookId, { title: '当前部' });
  const target = await store.addChapter(bookId, currentSection.id, { title: '待生成章' });
  const originalJsonParse = JSON.parse;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.length > 64 * 1024) {
      throw new Error('WHOLE_SECTION_JSON_PARSE_FORBIDDEN');
    }
    return originalJsonParse(text, ...args);
  };
  try {
    const context = await store.readChapterGenerationContext(
      bookId, currentSection.id, target.id,
    );
    assert.equal(context.previousChapterId, previous.id);
    assert.equal(context.previousChapterSectionId, previousSection.id);
    assert.equal(store.currentText(context.previousChapter.body), '跨分部前章正文');
  } finally {
    JSON.parse = originalJsonParse;
  }
});

test('作品树对早期章节正文结构回退完整迁移读取', async () => {
  const section = await store.addSection(bookId, { title: '旧数据部' });
  const chapter = await store.addChapter(bookId, section.id, { title: '旧数据章' });
  const stored = await store.readChapter(bookId, section.id, chapter.id);
  delete stored.body;
  delete stored.bodyFingerprint;
  stored.content = '旧版正文';
  stored.history = ['旧版历史'];
  await store.writeChapter(bookId, section.id, chapter.id, stored);

  const summary = (await store.readBookStructure(bookId)).sections[0].chapters[0];
  assert.equal(summary.hasContent, true);
  assert.equal(summary.title, '旧数据章');
});

test('readBookStructure 跨分部并发读取仍保持章节顺序和归属', async () => {
  const firstSection = await store.addSection(bookId, { title: '上部' });
  const first = await store.addChapter(bookId, firstSection.id, { title: '一' });
  const second = await store.addChapter(bookId, firstSection.id, { title: '二' });
  const secondSection = await store.addSection(bookId, { title: '下部' });
  const third = await store.addChapter(bookId, secondSection.id, { title: '三' });

  const structure = await store.readBookStructure(bookId);

  assert.deepEqual(structure.sections.map((section) => section.id), [firstSection.id, secondSection.id]);
  assert.deepEqual(structure.sections[0].chapters.map((chapter) => chapter.id), [first.id, second.id]);
  assert.deepEqual(structure.sections[1].chapters.map((chapter) => chapter.id), [third.id]);
});

test('作品树读取先完成残留删章事务，不展示随后必然消失的章节', async () => {
  const section = await store.addSection(bookId, { title: '事务恢复部' });
  const removed = await store.addChapter(bookId, section.id, { title: '待删除章' });
  const kept = await store.addChapter(bookId, section.id, { title: '保留章' });
  const transactionPath = join(
    root, 'books', bookId, section.id, '.section-structure-transaction.json',
  );
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-structure-transaction', version: 1,
    type: 'delete-chapter', bookId, sectionId: section.id, chapterId: removed.id,
  });

  const structure = await store.readBookStructure(bookId);

  assert.deepEqual(
    structure.sections[0].chapters.map((chapter) => chapter.id),
    [kept.id],
  );
  assert.equal(existsSync(transactionPath), false);
  assert.deepEqual((await store.readSection(bookId, section.id)).chapters, [kept.id]);
  await assert.rejects(
    () => store.readChapter(bookId, section.id, removed.id),
    /ENOENT/,
  );
});

test('作品树读取先完成残留新增分部事务，不漏掉随后必然接入的分部', async () => {
  const pendingSection = await store.addSection(bookId, { title: '待接入部' });
  const book = await store.readBook(bookId);
  book.sections = [];
  await store.writeBook(bookId, book);
  const transactionPath = join(
    root, 'books', bookId, '.book-structure-transaction.json',
  );
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-structure-transaction', version: 1,
    type: 'add-section', bookId, sectionId: pendingSection.id,
    section: pendingSection,
  });

  const structure = await store.readBookStructure(bookId);

  assert.deepEqual(structure.sections.map((section) => section.id), [pendingSection.id]);
  assert.equal(structure.sections[0].title, '待接入部');
  assert.equal(existsSync(transactionPath), false);
  assert.deepEqual((await store.readBook(bookId)).sections, [pendingSection.id]);
});

test('readBookStructure 与随后开始的删章按整书锁序列化，不拼出混合快照', async () => {
  const section = await store.addSection(bookId, { title: '并发部' });
  const chapter = await store.addChapter(bookId, section.id, { title: '即将删除' });

  // 读取先登记 book-json 锁，删除随后排队；返回的树必须完整对应删除前状态。
  const reading = store.readBookStructure(bookId);
  const deleting = store.deleteChapter(bookId, section.id, chapter.id);
  const [snapshot] = await Promise.all([reading, deleting]);

  assert.deepEqual(snapshot.sections[0].chapters.map((item) => item.id), [chapter.id]);
  assert.deepEqual((await store.readSection(bookId, section.id)).chapters, []);
  await assert.rejects(
    () => store.readChapter(bookId, section.id, chapter.id),
    /ENOENT/,
  );
});

test('作品树拒绝过量和重复的分部、章节索引', async () => {
  const section = await store.addSection(bookId, { title: '起源' });
  const chapter = await store.addChapter(bookId, section.id, { title: '觉醒' });
  const bookPath = join(root, 'books', bookId, 'book.json');
  const sectionPath = join(root, 'books', bookId, section.id, 'section.json');

  const book = await store.readBook(bookId);
  book.sections = [section.id, section.id];
  await store.atomicWriteJson(bookPath, book);
  await assert.rejects(() => store.readBookStructure(bookId), /STORAGE_DATA_INVALID/);
  assert.deepEqual(await store.listBooks(), []);

  book.sections = [section.id];
  await store.atomicWriteJson(bookPath, book);
  section.chapters = [chapter.id, chapter.id];
  await store.atomicWriteJson(sectionPath, section);
  await assert.rejects(() => store.readBookStructure(bookId), /STORAGE_DATA_INVALID/);
  await assert.rejects(
    () => store.readReferencedChapter(bookId, section.id, chapter.id),
    /STORAGE_DATA_INVALID/,
  );

  section.chapters = Array.from(
    { length: MAX_SECTION_CHAPTERS + 1 }, (_, index) => `chapter-over-${index}`,
  );
  await store.atomicWriteJson(sectionPath, section);
  await assert.rejects(
    () => store.readBookStructure(bookId),
    /STORAGE_DATA_INVALID/,
  );
});

test('作品树和单章读取只返回受约束的已知字段', async () => {
  const section = await store.addSection(bookId, { title: '起源' });
  const chapter = await store.addChapter(bookId, section.id, { title: '觉醒' });
  const book = await store.readBook(bookId);
  book.injected = { secret: '不应返回' };
  await store.writeBook(bookId, book);
  const storedSection = await store.readSection(bookId, section.id);
  storedSection.injected = { secret: '不应返回' };
  await store.writeSection(bookId, section.id, storedSection);
  const storedChapter = await store.readChapter(bookId, section.id, chapter.id);
  storedChapter.injected = { secret: '不应返回' };
  storedChapter.index = 999;
  await store.writeChapter(bookId, section.id, chapter.id, storedChapter);

  const tree = await store.readBookStructure(bookId);
  assert.deepEqual(Object.keys(tree.book).sort(), [
    'id', 'outline', 'sectionPlanContextRevision', 'settings', 'title', 'titleSource',
  ]);
  assert.match(tree.book.sectionPlanContextRevision, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(tree.sections[0]).sort(), [
    'chapters', 'id', 'index', 'title', 'titleSource',
  ]);
  assert.equal(tree.book.injected, undefined);
  assert.equal(tree.sections[0].injected, undefined);
  assert.equal(tree.sections[0].chapters[0].index, 1);

  const loadedSection = await store.readReferencedSection(bookId, section.id);
  const loadedChapter = await store.readReferencedChapter(bookId, section.id, chapter.id);
  assert.equal(loadedSection.injected, undefined);
  assert.equal(loadedChapter.injected, undefined);
  assert.equal(loadedChapter.index, 1);
});

test('作品树拒绝超出边界的书籍、分部和章节元数据', async () => {
  const section = await store.addSection(bookId, { title: '起源' });
  const chapter = await store.addChapter(bookId, section.id, { title: '觉醒' });
  const book = await store.readBook(bookId);
  const sectionPath = join(root, 'books', bookId, section.id, 'section.json');
  const chapterPath = join(root, 'books', bookId, section.id, `${chapter.id}.json`);

  book.title = 'x'.repeat(MAX_TITLE_CHARS + 1);
  await store.writeBook(bookId, book);
  await assert.rejects(() => store.readBookStructure(bookId), /STORAGE_DATA_INVALID/);
  assert.deepEqual(await store.listBooks(), []);

  book.title = 't';
  await store.writeBook(bookId, book);
  section.title = 'x'.repeat(MAX_TITLE_CHARS + 1);
  section.chapters = [chapter.id];
  await store.atomicWriteJson(sectionPath, section);
  await assert.rejects(() => store.readBookStructure(bookId), /STORAGE_DATA_INVALID/);

  section.title = '起源';
  await store.atomicWriteJson(sectionPath, section);
  chapter.title = 'x'.repeat(MAX_TITLE_CHARS + 1);
  await store.atomicWriteJson(chapterPath, chapter);
  await assert.rejects(() => store.readBookStructure(bookId), /STORAGE_DATA_INVALID/);
  await assert.rejects(
    () => store.readReferencedChapter(bookId, section.id, chapter.id),
    /STORAGE_DATA_INVALID/,
  );
});

test('整书章节总数上限同时约束新增和作品树加载', async () => {
  const sections = [];
  for (let index = 0; index < 6; index += 1) {
    sections.push(await store.addSection(bookId, { title: `第 ${index + 1} 部` }));
  }
  for (let sectionIndex = 0; sectionIndex < 5; sectionIndex += 1) {
    const section = sections[sectionIndex];
    section.chapters = Array.from(
      { length: MAX_SECTION_CHAPTERS },
      (_, chapterIndex) => `legacy-${sectionIndex}-${chapterIndex}`,
    );
    await store.atomicWriteJson(
      join(root, 'books', bookId, section.id, 'section.json'), section,
    );
  }
  assert.equal(MAX_SECTION_CHAPTERS * 5, MAX_TOTAL_BOOK_CHAPTERS);
  await assert.rejects(
    () => store.addChapter(bookId, sections[5].id, {}),
    /BOOK_CHAPTER_LIMIT/,
  );

  sections[5].chapters = ['legacy-over-total'];
  await store.atomicWriteJson(
    join(root, 'books', bookId, sections[5].id, 'section.json'), sections[5],
  );
  await assert.rejects(
    () => store.readBookStructure(bookId),
    /BOOK_CHAPTERS_LIMIT_EXCEEDED/,
  );
  assert.deepEqual(await store.listBooks(), []);
});

test('并发 addChapter 仍生成连续且不重复的章 id', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  const chapters = await Promise.all([
    store.addChapter(bookId, s.id, { title: '一' }),
    store.addChapter(bookId, s.id, { title: '二' }),
    store.addChapter(bookId, s.id, { title: '三' }),
    store.addChapter(bookId, s.id, { title: '四' }),
    store.addChapter(bookId, s.id, { title: '五' }),
  ]);

  assert.deepEqual(chapters.map((c) => c.id), [
    'chapter-01',
    'chapter-02',
    'chapter-03',
    'chapter-04',
    'chapter-05',
  ]);
  const sec = await store.readSection(bookId, s.id);
  assert.deepEqual(sec.chapters, [
    'chapter-01',
    'chapter-02',
    'chapter-03',
    'chapter-04',
    'chapter-05',
  ]);
});

test('相同末章锚点的并发 addChapter 只有一个可以提交', async () => {
  const section = await store.addSection(bookId, { title: '起源' });
  const previous = await store.addChapter(bookId, section.id, { title: '已有末章' });

  const results = await Promise.allSettled([
    store.addChapter(bookId, section.id, {
      title: '请求甲', expectedLastChapterId: previous.id,
    }),
    store.addChapter(bookId, section.id, {
      title: '请求乙', expectedLastChapterId: previous.id,
    }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.match(String(rejected?.reason?.message), /NEXT_CHAPTER_CONFLICT/);
  const saved = await store.readSection(bookId, section.id);
  assert.equal(saved.chapters.length, 2);
  assert.equal(saved.chapters[0], previous.id);
});

test('作品树中途取消会停止章节扫描并释放整书锁', async () => {
  const book = await store.createBook({ premise: '取消作品树扫描' });
  const section = await store.addSection(book.id, {});
  const chapter = await store.addChapter(book.id, section.id, {});
  let checks = 0;
  const signal = {
    get aborted() {
      checks += 1;
      // 第八个取消点位于章节文件读取完成后、摘要树返回之前。
      return checks >= 8;
    },
    reason: new Error('CLIENT_ABORTED'),
  };

  await assert.rejects(
    () => store.readBookStructure(book.id, { signal }),
    /CLIENT_ABORTED/,
  );
  assert.ok(checks >= 8);
  await store.versionSet(
    book.id,
    `section:${section.id}:chapter:${chapter.id}`,
    '取消扫描后仍可保存',
  );
  assert.equal(
    store.currentText((await store.readChapter(book.id, section.id, chapter.id)).body),
    '取消扫描后仍可保存',
  );
});

test('重启恢复能幂等完成中断的新增部、新增章和删除章事务', async () => {
  const bookRoot = join(root, 'books', bookId);
  const section = {
    id: 'section-01', index: 1, title: '恢复部', titleSource: 'manual',
    outline: { content: '', history: [] }, characters: [], summary: '', progress: '',
    chapters: [], chapterSummaries: {},
  };
  await store.atomicWriteJson(join(bookRoot, '.book-structure-transaction.json'), {
    format: 'auto-novel-box-structure-transaction', version: 1, type: 'add-section',
    bookId, sectionId: section.id, section,
  });

  let recovery = await store.recoverInterruptedTransactions();
  assert.equal(recovery.recovered, 1);
  assert.deepEqual((await store.readBook(bookId)).sections, [section.id]);
  assert.equal((await store.readSection(bookId, section.id)).title, '恢复部');
  assert.equal(existsSync(join(bookRoot, '.book-structure-transaction.json')), false);

  const chapter = {
    id: 'chapter-01', index: 1, title: '恢复章', titleSource: 'manual',
    body: store.emptyVersioned(), content: '', bodyFingerprint: store.contentFingerprint(''),
    characters: [], summary: '', progress: '', status: 'done',
  };
  const sectionRoot = join(bookRoot, section.id);
  const beforeChapterRecovery = (await store.readBook(bookId)).updatedAt;
  await store.atomicWriteJson(join(sectionRoot, '.section-structure-transaction.json'), {
    format: 'auto-novel-box-structure-transaction', version: 1, type: 'add-chapter',
    bookId, sectionId: section.id, chapterId: chapter.id, chapter,
  });

  recovery = await store.recoverInterruptedTransactions();
  assert.equal(recovery.recovered, 1);
  assert.deepEqual((await store.readSection(bookId, section.id)).chapters, [chapter.id]);
  assert.equal((await store.readChapter(bookId, section.id, chapter.id)).title, '恢复章');
  const afterChapterRecovery = await store.readBook(bookId);
  assert.ok(Date.parse(afterChapterRecovery.updatedAt) > Date.parse(beforeChapterRecovery));
  await assert.rejects(
    () => store.deleteBook(bookId, { expectedUpdatedAt: beforeChapterRecovery }),
    /BOOK_DELETE_CONFLICT/,
  );

  const beforeDeleteRecovery = afterChapterRecovery.updatedAt;
  await store.atomicWriteJson(join(sectionRoot, '.section-structure-transaction.json'), {
    format: 'auto-novel-box-structure-transaction', version: 1, type: 'delete-chapter',
    bookId, sectionId: section.id, chapterId: chapter.id,
  });
  recovery = await store.recoverInterruptedTransactions();
  assert.equal(recovery.recovered, 1);
  assert.deepEqual((await store.readSection(bookId, section.id)).chapters, []);
  assert.equal(existsSync(join(sectionRoot, `${chapter.id}.json`)), false);
  assert.equal(existsSync(join(sectionRoot, '.section-structure-transaction.json')), false);
  assert.ok(Date.parse((await store.readBook(bookId)).updatedAt) > Date.parse(beforeDeleteRecovery));

  const digestChapter = await store.addChapter(bookId, section.id, { title: '待恢复摘要' });
  await store.versionSet(
    bookId, `section:${section.id}:chapter:${digestChapter.id}`, '恢复摘要正文',
  );
  const partialDigest = await store.readChapter(bookId, section.id, digestChapter.id);
  partialDigest.summary = '恢复出的摘要';
  partialDigest.progress = '恢复出的路标';
  const digestTransactionPath = join(sectionRoot, '.chapter-digest-transaction.json');
  await store.atomicWriteJson(digestTransactionPath, {
    format: 'auto-novel-box-chapter-digest-transaction', version: 1,
    bookId, sectionId: section.id, chapterId: digestChapter.id,
    bodyFingerprint: partialDigest.bodyFingerprint,
  });
  await store.atomicWriteJson(
    join(sectionRoot, `${digestChapter.id}.json`), partialDigest,
  );

  recovery = await store.recoverInterruptedTransactions();
  assert.equal(recovery.recovered, 1);
  assert.equal((await store.readSection(bookId, section.id)).summary, '第1章：恢复出的摘要');
  assert.equal((await store.readBook(bookId)).progress, '恢复出的路标');
  assert.equal(existsSync(digestTransactionPath), false);
});

test('重启恢复不会跳过备份保留的自定义分部 ID 中的章节事务', async () => {
  const sourceSection = await store.addSection(bookId, { title: '旧版分部' });
  const sourceChapter = await store.addChapter(bookId, sourceSection.id, { title: '待恢复删除' });
  const backup = await store.createBookBackup(bookId);
  const customSectionId = 'arc-one';
  backup.book.sections[0] = customSectionId;
  backup.sections[0].section.id = customSectionId;
  const imported = await store.importBookBackup(backup);
  const sectionRoot = join(root, 'books', imported.id, customSectionId);
  const transactionPath = join(sectionRoot, '.section-structure-transaction.json');
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-structure-transaction', version: 1, type: 'delete-chapter',
    bookId: imported.id, sectionId: customSectionId, chapterId: sourceChapter.id,
  });

  const recovery = await store.recoverInterruptedTransactions();

  assert.equal(recovery.recovered, 1);
  assert.deepEqual((await store.readSection(imported.id, customSectionId)).chapters, []);
  assert.equal(existsSync(join(sectionRoot, `${sourceChapter.id}.json`)), false);
  assert.equal(existsSync(transactionPath), false);
});

test('损坏的结构事务只进入诊断，不覆盖或删除作品', async () => {
  const transactionPath = join(root, 'books', bookId, '.book-structure-transaction.json');
  writeFileSync(transactionPath, '{ bad transaction', 'utf8');

  const recovery = await store.recoverInterruptedTransactions();
  assert.equal(recovery.recovered, 0);
  assert.equal(recovery.failures.length, 1);
  assert.deepEqual((await store.readBook(bookId)).sections, []);
  assert.equal(existsSync(transactionPath), true);
  assert.ok((await store.diagnoseStorage()).issues.some((issue) =>
    issue.code === 'BOOK_STRUCTURE_TRANSACTION_INVALID' && issue.bookId === bookId));
});

test('启动恢复达到失败上限后停止扫描并保留事务文件', async () => {
  const sections = [];
  for (let index = 0; index < 3; index += 1) {
    const section = await store.addSection(bookId, { title: `损坏分部 ${index + 1}` });
    sections.push(section);
    writeFileSync(
      join(root, 'books', bookId, section.id, '.section-structure-transaction.json'),
      '{ damaged transaction',
      'utf8',
    );
  }

  const recovery = await store.recoverInterruptedTransactions({ maxFailures: 2 });

  assert.equal(recovery.recovered, 0);
  assert.equal(recovery.failures.length, 2);
  assert.equal(recovery.truncated, true);
  for (const section of sections) {
    assert.equal(existsSync(join(
      root, 'books', bookId, section.id, '.section-structure-transaction.json',
    )), true);
  }
});

test('语法正确但非规范的结构事务不会新增或删除作品数据', async () => {
  const bookRoot = join(root, 'books', bookId);
  const invalidSection = {
    id: 'section-01', index: 1, title: 'x'.repeat(201), titleSource: 'manual',
    outline: { content: '', history: [] }, characters: [], summary: '', progress: '',
    chapters: [], chapterSummaries: {},
  };
  const bookTransaction = join(bookRoot, '.book-structure-transaction.json');
  await store.atomicWriteJson(bookTransaction, {
    format: 'auto-novel-box-structure-transaction', version: 1, type: 'add-section',
    bookId, sectionId: invalidSection.id, section: invalidSection,
  });

  let recovery = await store.recoverInterruptedTransactions();
  assert.equal(recovery.recovered, 0);
  assert.equal(recovery.failures.length, 1);
  assert.deepEqual((await store.readBook(bookId)).sections, []);
  assert.equal(existsSync(join(bookRoot, invalidSection.id)), false);
  assert.equal(existsSync(bookTransaction), true);
  assert.ok((await store.diagnoseStorage()).issues.some((issue) =>
    issue.code === 'BOOK_STRUCTURE_TRANSACTION_INVALID' && issue.bookId === bookId));

  // 清掉上一条测试事务，创建一章后验证带未知字段的删除事务不会被执行。
  unlinkSync(bookTransaction);
  const section = await store.addSection(bookId, { title: '安全部' });
  const chapter = await store.addChapter(bookId, section.id, { title: '不可误删' });
  const sectionRoot = join(bookRoot, section.id);
  const sectionTransaction = join(sectionRoot, '.section-structure-transaction.json');
  await store.atomicWriteJson(sectionTransaction, {
    format: 'auto-novel-box-structure-transaction', version: 1, type: 'delete-chapter',
    bookId, sectionId: section.id, chapterId: chapter.id, unexpected: true,
  });

  recovery = await store.recoverInterruptedTransactions();
  assert.equal(recovery.recovered, 0);
  assert.ok(recovery.failures.some((failure) => failure.sectionId === section.id));
  assert.deepEqual((await store.readSection(bookId, section.id)).chapters, [chapter.id]);
  assert.equal(existsSync(join(sectionRoot, `${chapter.id}.json`)), true);
  assert.equal(existsSync(sectionTransaction), true);
  assert.ok((await store.diagnoseStorage()).issues.some((issue) =>
    issue.code === 'SECTION_STRUCTURE_TRANSACTION_INVALID'
      && issue.bookId === bookId
      && issue.sectionId === section.id));
});

test('恢复不会把同 ID 但内容不同的孤立分部或章节接入索引', async () => {
  const bookRoot = join(root, 'books', bookId);

  const diskSection = await store.addSection(bookId, { title: '磁盘上的分部' });
  const book = await store.readBook(bookId);
  book.sections = [];
  await store.writeBook(bookId, book);
  const bookTransaction = join(bookRoot, '.book-structure-transaction.json');
  await store.atomicWriteJson(bookTransaction, {
    format: 'auto-novel-box-structure-transaction', version: 1, type: 'add-section',
    bookId, sectionId: diskSection.id,
    section: { ...diskSection, title: '事务中的另一个分部' },
  });

  let recovery = await store.recoverInterruptedTransactions();
  assert.equal(recovery.recovered, 0);
  assert.ok(recovery.failures.some((failure) =>
    failure.error === 'STRUCTURE_TRANSACTION_TARGET_CONFLICT'));
  assert.deepEqual((await store.readBook(bookId)).sections, []);
  assert.equal((await store.readSection(bookId, diskSection.id)).title, '磁盘上的分部');
  assert.equal(existsSync(bookTransaction), true);

  // 清理上面的冲突现场，只为在同一本测试作品里继续验证章节目标。
  unlinkSync(bookTransaction);
  book.sections = [diskSection.id];
  await store.writeBook(bookId, book);
  const diskChapter = await store.addChapter(
    bookId, diskSection.id, { title: '磁盘上的章节' },
  );
  const section = await store.readSection(bookId, diskSection.id);
  section.chapters = [];
  await store.writeSection(bookId, diskSection.id, section, {
    preserveExistingChapters: false,
  });
  const sectionRoot = join(bookRoot, diskSection.id);
  const sectionTransaction = join(sectionRoot, '.section-structure-transaction.json');
  await store.atomicWriteJson(sectionTransaction, {
    format: 'auto-novel-box-structure-transaction', version: 1, type: 'add-chapter',
    bookId, sectionId: diskSection.id, chapterId: diskChapter.id,
    chapter: { ...diskChapter, title: '事务中的另一个章节' },
  });

  recovery = await store.recoverInterruptedTransactions();
  assert.equal(recovery.recovered, 0);
  assert.ok(recovery.failures.some((failure) =>
    failure.sectionId === diskSection.id
      && failure.error === 'STRUCTURE_TRANSACTION_TARGET_CONFLICT'));
  assert.deepEqual((await store.readSection(bookId, diskSection.id)).chapters, []);
  assert.equal(
    (await store.readChapter(bookId, diskSection.id, diskChapter.id)).title,
    '磁盘上的章节',
  );
  assert.equal(existsSync(sectionTransaction), true);
});

test('摘要事务目标已不在分部索引时保留现场并报告存储冲突', async () => {
  const section = await store.addSection(bookId, { title: '安全部' });
  const transactionPath = join(
    root, 'books', bookId, section.id, '.chapter-digest-transaction.json',
  );
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-chapter-digest-transaction',
    version: 1,
    bookId,
    sectionId: section.id,
    chapterId: 'chapter-missing',
    bodyFingerprint: store.contentFingerprint('已删除正文'),
  });

  const diagnostics = await store.diagnoseStorage();
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT'
      && issue.bookId === bookId && issue.sectionId === section.id));

  const recovery = await store.recoverInterruptedTransactions();
  assert.equal(recovery.recovered, 0);
  assert.ok(recovery.failures.some((failure) =>
    failure.bookId === bookId
      && failure.sectionId === section.id
      && failure.error === 'CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT'));
  assert.equal(existsSync(transactionPath), true);
  assert.deepEqual((await store.readSection(bookId, section.id)).chapters, []);
});

test('摘要事务正文指纹失配时深检和恢复均保留现场', async () => {
  const section = await store.addSection(bookId, { title: '安全部' });
  const chapter = await store.addChapter(bookId, section.id, { title: '安全章' });
  await store.versionSet(
    bookId, `section:${section.id}:chapter:${chapter.id}`, '当前正文',
  );
  const transactionPath = join(
    root, 'books', bookId, section.id, '.chapter-digest-transaction.json',
  );
  await store.atomicWriteJson(transactionPath, {
    format: 'auto-novel-box-chapter-digest-transaction',
    version: 1,
    bookId,
    sectionId: section.id,
    chapterId: chapter.id,
    bodyFingerprint: store.contentFingerprint('另一份正文'),
  });

  const diagnostics = await store.diagnoseStorage({ deep: true });
  assert.ok(diagnostics.issues.some((issue) =>
    issue.code === 'CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT'
      && issue.bookId === bookId && issue.sectionId === section.id));

  const recovery = await store.recoverInterruptedTransactions();
  assert.equal(recovery.recovered, 0);
  assert.ok(recovery.failures.some((failure) =>
    failure.bookId === bookId
      && failure.sectionId === section.id
      && failure.error === 'CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT'));
  assert.equal(existsSync(transactionPath), true);
  assert.equal(
    store.currentText((await store.readChapter(bookId, section.id, chapter.id)).body),
    '当前正文',
  );
});

test('异常大的删除事务不会载入内存或删除章节', async () => {
  const section = await store.addSection(bookId, { title: '安全部' });
  const chapter = await store.addChapter(bookId, section.id, { title: '不可误删' });
  const sectionRoot = join(root, 'books', bookId, section.id);
  const transactionPath = join(sectionRoot, '.section-structure-transaction.json');
  writeFileSync(transactionPath, '{}', 'utf8');
  truncateSync(transactionPath, MAX_STRUCTURE_TRANSACTION_JSON_BYTES + 1);

  const recovery = await store.recoverInterruptedTransactions();

  assert.equal(recovery.recovered, 0);
  assert.ok(recovery.failures.some((failure) => failure.sectionId === section.id));
  assert.deepEqual((await store.readSection(bookId, section.id)).chapters, [chapter.id]);
  assert.equal(existsSync(join(sectionRoot, `${chapter.id}.json`)), true);
  assert.ok((await store.diagnoseStorage()).issues.some((issue) =>
    issue.code === 'SECTION_STRUCTURE_TRANSACTION_TOO_LARGE'
      && issue.sectionId === section.id));
});

test('旧 section 快照写回摘要时不覆盖期间新增的章节列表', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  const stale = await store.readSection(bookId, s.id);
  const c = await store.addChapter(bookId, s.id, { title: '新章' });

  stale.summary = 'digest 小结';
  await store.writeSection(bookId, s.id, stale);

  const back = await store.readSection(bookId, s.id);
  assert.equal(back.summary, 'digest 小结');
  assert.deepEqual(back.chapters, [c.id]);
});

test('旧 section 快照写回摘要时不复活期间已删除的章节引用', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  const doomed = await store.addChapter(bookId, s.id, { title: '待删章' });
  const stale = await store.readSection(bookId, s.id);

  await store.deleteChapter(bookId, s.id, doomed.id);
  stale.summary = '迟到 digest 小结';
  await store.writeSection(bookId, s.id, stale);

  const back = await store.readSection(bookId, s.id);
  assert.deepEqual(back.chapters, []);
  assert.equal(existsSync(join(root, 'books', bookId, s.id, `${doomed.id}.json`)), false);
});

test('store 不暴露只删除引用的章节删除入口', () => {
  assert.equal(store.removeChapterReference, undefined);
});

test('脱离 book 索引的孤立分部不能再读取或新增章节', async () => {
  const section = await store.addSection(bookId, { title: '待孤立' });
  const chapter = await store.addChapter(bookId, section.id, { title: '旧章' });
  const book = await store.readBook(bookId);
  book.sections = [];
  await store.writeBook(bookId, book);

  await assert.rejects(
    () => store.readReferencedSection(bookId, section.id),
    /SECTION_NOT_FOUND/,
  );
  await assert.rejects(
    () => store.readReferencedChapter(bookId, section.id, chapter.id),
    /SECTION_NOT_FOUND/,
  );
  await assert.rejects(
    () => store.addChapter(bookId, section.id, { title: '不应新增' }),
    /SECTION_NOT_FOUND/,
  );
  assert.deepEqual((await store.readSection(bookId, section.id)).chapters, [chapter.id]);
});

test('新建分部和章节在存储层执行数量上限', async () => {
  const book = await store.readBook(bookId);
  book.sections = Array.from({ length: MAX_BOOK_SECTIONS }, (_, index) => `legacy-${index}`);
  await store.writeBook(bookId, book);
  await assert.rejects(() => store.addSection(bookId, {}), /BOOK_SECTION_LIMIT/);

  book.sections = [];
  await store.writeBook(bookId, book);
  const section = await store.addSection(bookId, {});
  section.chapters = Array.from(
    { length: MAX_SECTION_CHAPTERS },
    (_, index) => `legacy-chapter-${index}`,
  );
  await store.writeSection(bookId, section.id, section, { preserveExistingChapters: false });
  await assert.rejects(
    () => store.addChapter(bookId, section.id, {}),
    /SECTION_CHAPTER_LIMIT/,
  );
});

test('deleteChapter 与 addChapter 并发时不留下悬空章节引用', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  const doomed = await store.addChapter(bookId, s.id, { title: '失败空章' });

  const [, added] = await Promise.all([
    store.deleteChapter(bookId, s.id, doomed.id),
    store.addChapter(bookId, s.id, { title: '新章' }),
  ]);

  const back = await store.readSection(bookId, s.id);
  assert.deepEqual(back.chapters, [added.id]);
  await assert.doesNotReject(() => store.readChapter(bookId, s.id, added.id));
});

test('deleteChapter 与并发 versionSet 时不留下孤儿章节文件', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  const doomed = await store.addChapter(bookId, s.id, { title: '失败空章' });
  const path = `section:${s.id}:chapter:${doomed.id}`;

  await Promise.allSettled([
    store.deleteChapter(bookId, s.id, doomed.id),
    ...Array.from({ length: 20 }, (_, i) =>
      store.versionSet(bookId, path, `正文 ${i + 1}`)),
  ]);

  const back = await store.readSection(bookId, s.id);
  assert.equal(back.chapters.includes(doomed.id), false);
  assert.equal(existsSync(join(root, 'books', bookId, s.id, `${doomed.id}.json`)), false);
});

test('临时章节回滚遇到其它已提交修改时不倒退作品更新时间', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  const created = await store.addChapter(bookId, s.id, {
    title: '临时空章', includeRollbackMetadata: true,
  });
  await store.versionSet(bookId, 'outline', '另一页面保存的大纲');
  const concurrentUpdatedAt = (await store.readBook(bookId)).updatedAt;

  await store.deleteChapter(bookId, s.id, created.chapter.id, {
    expectedRevision: store.versionRevision(created.chapter.body),
    restoreBookUpdatedAt: created.rollback,
  });

  const afterRollback = await store.readBook(bookId);
  assert.equal(store.currentText(afterRollback.outline), '另一页面保存的大纲');
  assert.ok(Date.parse(afterRollback.updatedAt) > Date.parse(concurrentUpdatedAt));
  assert.notEqual(afterRollback.updatedAt, created.rollback.previousBookUpdatedAt);
});

test('删除中间章后新增章不复用已存在的 id', async () => {
  const s = await store.addSection(bookId, { title: '起源' });
  const first = await store.addChapter(bookId, s.id, {});
  const second = await store.addChapter(bookId, s.id, {});
  const third = await store.addChapter(bookId, s.id, {});

  await store.deleteChapter(bookId, s.id, second.id);
  const thirdContext = await store.readChapterGenerationContext(bookId, s.id, third.id);
  const fourth = await store.addChapter(bookId, s.id, {});
  const fourthContext = await store.readChapterGenerationContext(bookId, s.id, fourth.id);
  const section = await store.readSection(bookId, s.id);

  assert.equal(first.id, 'chapter-01');
  assert.equal(third.id, 'chapter-03');
  assert.equal(thirdContext.chapter.index, 2);
  assert.equal(fourth.id, 'chapter-04');
  assert.equal(fourth.index, 3);
  assert.equal(fourthContext.chapter.index, 3);
  assert.deepEqual(section.chapters, ['chapter-01', 'chapter-03', 'chapter-04']);
});

test('pushHistory（覆盖前存档）与 rollback 还原正文', () => {
  const ch = { content: '第一版', history: [] };
  // 约定：先存档当前值，再改写
  store.pushHistory(ch, 'content');
  ch.content = '第二版';
  assert.deepEqual(ch.history, ['第一版']);
  const ok = store.rollback(ch, 'content');
  assert.equal(ok, true);
  assert.equal(ch.content, '第一版');  // 真正还原到存档值
  const empty = store.rollback({ content: 'x', history: [] }, 'content');
  assert.equal(empty, false);
});

test('pushHistory 处理非 content 字段（outline）并可回退', () => {
  const sec = { outline: { content: '大纲 A', history: [] } };
  store.pushHistory(sec, 'outline');
  sec.outline.content = '大纲 B';
  assert.deepEqual(sec.outline.history, ['大纲 A']);
  assert.equal(store.rollback(sec, 'outline'), true);
  assert.equal(sec.outline.content, '大纲 A');
});

test('history 栈深上限 20，超出丢弃最旧', () => {
  const ch = { content: '', history: [] };
  for (let i = 1; i <= 25; i++) { ch.content = `v${i}`; store.pushHistory(ch, 'content'); }
  assert.equal(ch.history.length, 20);      // 裁剪到 20
  assert.equal(ch.history[0], 'v6');        // v1..v5 被丢弃
  assert.equal(ch.history[19], 'v25');
});

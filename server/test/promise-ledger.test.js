import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../index.js';
import * as store from '../store.js';
import {
  chapterPlanPromiseAlignment, generationPromiseLedgerRows, normalizePromiseEntryInput,
  normalizePromiseLedger, promiseLedgerRevision,
} from '../promise-ledger-schema.js';
import { buildContext } from '../prompts.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';
import { startTestServer, stopTestServer } from './http-test-server.js';

const ENTRY_ID = `promise_${'a'.repeat(32)}`;
const SECOND_ID = `promise_${'b'.repeat(32)}`;
const PROGRESS_ID = `progress_${'c'.repeat(32)}`;

function evidenceBeat(overrides = {}) {
  return {
    id: PROGRESS_ID, chapter: 8, note: '缺角车票把师父旧线指向旧城', beat: 'pressure',
    readerBefore: '读者只知师父隐瞒了真相', readerAfter: '读者怀疑隐瞒与旧城有关',
    actionConsequence: '主角放弃官道转去旧城', worldLink: 'none',
    worldEffect: '不关联本章世界层级推进', evidence: '车票缺角处有旧城印记',
    source: {
      sectionId: 'section-1', chapterId: 'chapter-8', bodyFingerprint: 'A'.repeat(43),
    },
    status: 'active', confirmedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

function v3DebtPlan({
  action = '推进债务', beat = '变义',
  before = '读者怀疑隐瞒与旧城有关',
  after = '读者确认旧城只是转运站',
} = {}) {
  return {
    qualityProtocolVersion: 3,
    foreshadowing: `旧线/阅读债务：[${action}:${ENTRY_ID}] 推进师父隐瞒线；叙事节拍：${beat}；认知变化：${before}→${after}；具体载体：缺角车票与货箱编号冲突；当下作用：用来选择追踪路线；行动影响：主角放弃旧城改追货运队；世界线作用：不关联本章世界层级推进；保留未知：不揭示师父真正目的`,
  };
}

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-promise-ledger-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

function entry(overrides = {}) {
  return {
    id: ENTRY_ID,
    kind: 'main',
    status: 'open',
    importance: 5,
    promise: '主角必须查清师父为何隐瞒灭门真相',
    introducedChapter: 2,
    expectedStartChapter: 8,
    expectedEndChapter: 10,
    progress: [],
    resolution: '',
    resolvedChapter: null,
    nextPromise: '',
    notes: '不能用失忆解释',
    ...overrides,
  };
}

function stored(overrides = {}) {
  return {
    ...entry(overrides),
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  };
}

async function createTarget() {
  const book = await store.createBook({ premise: '承诺账本测试', title: '长篇' });
  const section = await store.addSection(book.id, { title: '第一部' });
  const chapter = await store.addChapter(book.id, section.id, { title: '第一章' });
  return { book, section, chapter };
}

test('承诺条目严格区分计划、已建立、兑现和放弃，并约束章序与推进记录', () => {
  assert.deepEqual(normalizePromiseEntryInput(entry()).progress, []);
  assert.throws(
    () => normalizePromiseEntryInput(entry({ expectedStartChapter: 11 })),
    /BAD_PROMISE_ENTRY/,
  );
  assert.throws(
    () => normalizePromiseEntryInput(entry({ status: 'paid', resolution: '查明真相' })),
    /BAD_PROMISE_ENTRY/,
  );
  assert.throws(
    () => normalizePromiseEntryInput(entry({ resolution: '未结束' })),
    /BAD_PROMISE_ENTRY/,
  );
  assert.throws(
    () => normalizePromiseEntryInput(entry({
      progress: Array.from({ length: 51 }, (_, index) => ({
        id: `progress_${index.toString(16).padStart(32, '0')}`,
        chapter: index + 1,
        note: '推进',
      })),
    })),
    /PROMISE_LEDGER_TOO_LARGE/,
  );
  assert.throws(
    () => normalizePromiseLedger({ entries: [stored(), stored()] }),
    /BAD_PROMISE_LEDGER/,
  );
  assert.match(promiseLedgerRevision({ entries: [stored()] }), /^[A-Za-z0-9_-]{43}$/);
});

test('生成上下文优先发送逾期读者债务，并明确计划中承诺并非读者已知', () => {
  const ledger = { entries: [
    stored(),
    stored({
      id: SECOND_ID,
      status: 'planned',
      promise: '后续考虑引入失踪的皇女',
      introducedChapter: null,
      expectedStartChapter: 20,
      expectedEndChapter: 25,
      importance: 3,
    }),
  ] };
  const rows = generationPromiseLedgerRows(ledger, { bookChapterIndex: 13 });
  assert.match(rows[0], new RegExp(`债务ID:${ENTRY_ID}`));
  assert.match(rows[0], /已建立待兑现/);
  assert.match(rows[0], /已逾期3章/);
  assert.match(rows.join('\n'), /计划中（尚未向读者建立）/);

  const context = buildContext({
    book: { settings: { promiseLedger: ledger } },
    bookChapterIndex: 13,
  });
  assert.match(context, /承诺—推进—兑现账本/);
  assert.match(context, /“计划中”尚未证明读者已经看到/);
  assert.match(context, /师父为何隐瞒灭门真相/);
});

test('章节策划用稳定债务 ID 区分推进、兑现、建立与无效引用', () => {
  const ledger = { entries: [
    stored(),
    stored({
      id: SECOND_ID, status: 'planned', promise: '皇女失踪线尚未向读者建立',
      introducedChapter: null, expectedStartChapter: 20, expectedEndChapter: 25,
    }),
  ] };
  const missing = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9, plan: { foreshadowing: '推进师父旧线' },
  });
  assert.equal(missing.requiresAction, true);
  assert.equal(missing.satisfied, false);

  const progressed = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9,
    plan: { foreshadowing: `[推进债务:${ENTRY_ID}] 师父旧线` },
  });
  assert.equal(progressed.satisfied, true);
  assert.deepEqual(progressed.addressedUrgentIds, [ENTRY_ID]);

  const invalid = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9,
    plan: { foreshadowing: `[推进债务:${SECOND_ID}] 把计划线冒充已建立` },
  });
  assert.equal(invalid.invalidReferences.length, 1);
  const established = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 1,
    plan: { foreshadowing: `[建立承诺:${SECOND_ID}] 正文首次建立皇女线` },
  });
  assert.deepEqual(established.invalidReferences, []);

  const conflicting = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9,
    plan: {
      foreshadowing: `[推进债务:${ENTRY_ID}]`,
      notes: `[兑现债务:${ENTRY_ID}]`,
    },
  });
  assert.equal(conflicting.invalidReferences.length, 2);
  const emptyDelay = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9,
    plan: { notes: `[延期债务:${ENTRY_ID}] 延期原因：；下一检查点：` },
  });
  assert.equal(emptyDelay.invalidReferences.length, 1);
  const explainedDelay = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9,
    plan: { notes: `[延期债务:${ENTRY_ID}] 延期原因：主角正在逃亡；下一检查点：抵达旧城之后` },
  });
  assert.equal(explainedDelay.satisfied, true);
  const malformed = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9,
    plan: { foreshadowing: '[推进债务:随便写的编号]' },
  });
  assert.equal(malformed.invalidReferences.length, 1);
  const wrongField = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9,
    plan: { notes: `[推进债务:${ENTRY_ID}] 不应放在补充说明` },
  });
  assert.equal(wrongField.invalidReferences.length, 1);

  const noTask = '无埋点理由：本章专注兑现旧友决裂；本章聚焦：主角承担关系代价；既有未知处理：师父真相保持原状';
  const noTaskWithoutDelay = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9, plan: { foreshadowing: noTask },
  });
  assert.equal(noTaskWithoutDelay.noForeshadowingTask, true);
  assert.equal(noTaskWithoutDelay.satisfied, false);
  const noTaskWithDelay = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9,
    plan: {
      foreshadowing: noTask,
      notes: `[延期债务:${ENTRY_ID}] 延期原因：本章先结清旧友决裂；下一检查点：第十章进入师门旧址`,
    },
  });
  assert.equal(noTaskWithDelay.satisfied, true);
  assert.deepEqual(noTaskWithDelay.invalidReferences, []);
  const contradictoryNoTask = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9,
    plan: { foreshadowing: `${noTask}[推进债务:${ENTRY_ID}]` },
  });
  assert.equal(contradictoryNoTask.invalidReferences.length, 1);
});

test('关键阅读债务不能被低优先级支线遮蔽，并允许有理由延期', () => {
  const mainId = ENTRY_ID;
  const sideId = SECOND_ID;
  const ledger = { entries: [
    stored({
      id: mainId, kind: 'main', importance: 5,
      expectedStartChapter: 5, expectedEndChapter: 7,
      promise: '主角必须查清师父为何隐瞒灭门真相',
    }),
    stored({
      id: sideId, kind: 'relationship', importance: 3,
      expectedStartChapter: 10, expectedEndChapter: 12,
      promise: '主角需要决定是否重新信任旧友',
    }),
  ] };
  const sideOnly = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 11,
    plan: { foreshadowing: `[推进债务:${sideId}] 旧友关系线` },
  });
  assert.deepEqual(sideOnly.blockingUrgentIds, [mainId]);
  assert.deepEqual(sideOnly.addressedUrgentIds, [sideId]);
  assert.deepEqual(sideOnly.addressedBlockingUrgentIds, []);
  assert.equal(sideOnly.satisfied, false);

  const sideWithMainDelay = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 11,
    plan: {
      foreshadowing: `[推进债务:${sideId}] 旧友关系线`,
      notes: `[延期债务:${mainId}] 延期原因：本章先完成旧友决裂的即时后果；下一检查点：第十二章进入师门旧址`,
    },
  });
  assert.equal(sideWithMainDelay.satisfied, true);
  assert.deepEqual(sideWithMainDelay.addressedBlockingUrgentIds, [mainId]);
});

test('刚在上一章推进的关键债务暂不阻塞，让其它线获得交替窗口', () => {
  const main = stored({
    expectedStartChapter: 5, expectedEndChapter: 7,
    progress: [evidenceBeat({ chapter: 10 })],
  });
  const side = stored({
    id: SECOND_ID, kind: 'relationship', importance: 3,
    expectedStartChapter: 10, expectedEndChapter: 12,
    promise: '主角需要决定是否重新信任旧友',
  });
  const result = chapterPlanPromiseAlignment({ entries: [main, side] }, {
    bookChapterIndex: 11,
    plan: { foreshadowing: `[推进债务:${SECOND_ID}] 旧友关系线` },
  });
  assert.deepEqual(result.blockingUrgentIds, [SECOND_ID]);
  assert.equal(result.satisfied, true);
});

test('v3 阅读债务强制动作节拍匹配且读者认知跨章接续', () => {
  const ledger = { entries: [stored({ progress: [evidenceBeat()] })] };
  const connected = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9, plan: v3DebtPlan(),
  });
  assert.deepEqual(connected.narrativeConflicts, []);

  const disconnected = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9,
    plan: v3DebtPlan({ before: '读者仍然只知师父隐瞒了真相' }),
  });
  assert.equal(disconnected.narrativeConflicts[0].reason, 'reader-state-disconnected');

  const falsePayoff = chapterPlanPromiseAlignment(ledger, {
    bookChapterIndex: 9, plan: v3DebtPlan({ action: '兑现债务' }),
  });
  assert.equal(falsePayoff.narrativeConflicts[0].reason, 'action-beat-mismatch');

  const repeatedLedger = { entries: [stored({ progress: [
    evidenceBeat(),
    evidenceBeat({
      id: `progress_${'d'.repeat(32)}`, chapter: 9,
      readerBefore: '读者怀疑隐瞒与旧城有关',
      readerAfter: '读者确认旧城线还有第二个中间人',
    }),
  ] })] };
  const repeated = chapterPlanPromiseAlignment(repeatedLedger, {
    bookChapterIndex: 10,
    plan: v3DebtPlan({
      beat: '加压', before: '读者确认旧城线还有第二个中间人',
    }),
  });
  assert.deepEqual(repeated.narrativeConflicts, []);
  assert.deepEqual(repeated.repeatedBeatIds, [ENTRY_ID]);

  const multiLedger = { entries: [
    stored({ progress: [evidenceBeat()] }),
    stored({
      id: SECOND_ID, promise: '旧城印记背后还有另一名操纵者',
      progress: [evidenceBeat({
        id: `progress_${'e'.repeat(32)}`,
        readerAfter: '读者确认第二名操纵者已进入旧城',
      })],
    }),
  ] };
  const multi = chapterPlanPromiseAlignment(multiLedger, {
    bookChapterIndex: 10,
    plan: {
      ...v3DebtPlan(),
      foreshadowing: v3DebtPlan().foreshadowing.replace(
        '推进师父隐瞒线', `推进师父隐瞒线[\u63a8进债务:${SECOND_ID}]`,
      ),
    },
  });
  assert.equal(multi.narrativeConflicts.filter((item) =>
    item.reason === 'multiple-debt-actions').length, 2);
});

test('账本保存使用作品级乐观修订号，相同输入幂等且陈旧页面不能覆盖', async () => {
  const { book } = await createTarget();
  const initial = await store.readPromiseLedger(book.id);
  assert.deepEqual(initial.entries, []);
  const saved = await store.savePromiseLedgerEntry(book.id, entry(), {
    expectedRevision: initial.revision,
  });
  assert.notEqual(saved.revision, initial.revision);
  assert.equal(saved.entry.promise, entry().promise);

  const same = await store.savePromiseLedgerEntry(book.id, entry(), {
    expectedRevision: saved.revision,
  });
  assert.equal(same.revision, saved.revision);
  assert.equal(same.entry.updatedAt, saved.entry.updatedAt);
  await assert.rejects(
    () => store.savePromiseLedgerEntry(book.id, entry({ promise: '旧页面覆盖' }), {
      expectedRevision: initial.revision,
    }),
    /PROMISE_LEDGER_CONFLICT/,
  );

  const paid = await store.savePromiseLedgerEntry(book.id, entry({
    status: 'paid',
    progress: [{ id: PROGRESS_ID, chapter: 9, note: '取得师父留下的密信' }],
    resolution: '师父隐瞒是为了保护唯一幸存者',
    resolvedChapter: 10,
    nextPromise: '幸存者究竟投靠了谁',
  }), { expectedRevision: saved.revision });
  assert.equal(paid.entry.status, 'paid');
  assert.equal(paid.entry.progress[0].chapter, 9);
  assert.equal(paid.entry.createdAt, saved.entry.createdAt);
});

test('高优先级账本变化更新生成与审稿上下文，并拒绝旧账本下迟到的正文', async () => {
  const { book, section, chapter } = await createTarget();
  const generationBefore = await store.readChapterGenerationContext(
    book.id, section.id, chapter.id,
  );
  const reviewBefore = await store.readChapterReviewContext(
    book.id, section.id, chapter.id,
  );
  const ledger = await store.readPromiseLedger(book.id);
  await store.savePromiseLedgerEntry(book.id, entry({
    expectedStartChapter: 1,
    expectedEndChapter: 1,
  }), { expectedRevision: ledger.revision });
  const generationAfter = await store.readChapterGenerationContext(
    book.id, section.id, chapter.id,
  );
  const reviewAfter = await store.readChapterReviewContext(
    book.id, section.id, chapter.id,
  );
  assert.notEqual(generationAfter.contextRevision, generationBefore.contextRevision);
  assert.notEqual(reviewAfter.contextRevision, reviewBefore.contextRevision);
  await assert.rejects(
    () => store.commitGeneratedChapter(book.id, section.id, chapter.id, '迟到正文', {
      expectedRevision: generationBefore.targetRevision,
      expectedContextRevision: generationBefore.contextRevision,
      expectedPreviousChapterId: generationBefore.previousChapterId,
      expectedPreviousChapterSectionId: generationBefore.previousChapterSectionId,
    }),
    /GENERATION_CONTEXT_CONFLICT/,
  );
});

test('作品备份完整保留承诺账本，旧备份缺少账本时迁移为空账本', async () => {
  const { book } = await createTarget();
  const initial = await store.readPromiseLedger(book.id);
  await store.savePromiseLedgerEntry(book.id, entry(), {
    expectedRevision: initial.revision,
  });
  const backup = await store.createBookBackup(book.id);
  assert.equal(backup.book.settings.promiseLedger.entries[0].id, ENTRY_ID);
  const imported = await store.importBookBackup(backup);
  assert.equal((await store.readPromiseLedger(imported.id)).entries[0].promise, entry().promise);

  const legacy = structuredClone(backup);
  delete legacy.book.settings.promiseLedger;
  const migrated = await store.importBookBackup(legacy);
  assert.deepEqual((await store.readPromiseLedger(migrated.id)).entries, []);
});

test('承诺账本 HTTP 独立加载，树接口不泄漏大账本且冲突返回 409', async () => {
  const started = await startTestServer(createApp());
  try {
    const { book } = await createTarget();
    const base = `${started.base}/api/books/${book.id}`;
    const tree = await (await fetch(`${base}/tree`)).json();
    assert.equal(tree.book.settings.promiseLedger, undefined);
    const initial = await (await fetch(`${base}/promise-ledger`)).json();
    const save = (input, expectedRevision) => fetch(`${base}/promise-ledger/entries`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: input, expectedRevision }),
    });
    const savedResponse = await save(entry(), initial.revision);
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    const conflict = await save(entry({ promise: '旧页面写入' }), initial.revision);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'PROMISE_LEDGER_CONFLICT' });
    const removed = await fetch(`${base}/promise-ledger/entries/${ENTRY_ID}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: saved.revision }),
    });
    assert.equal(removed.status, 200);
    assert.deepEqual((await (await fetch(`${base}/promise-ledger`)).json()).entries, []);
  } finally {
    await stopTestServer(started.server);
  }
});

test('章节快照给策划卡返回有界债务选项，并把债务对齐并入写前门槛', async () => {
  const started = await startTestServer(createApp());
  try {
    const { book, section, chapter } = await createTarget();
    const initial = await store.readPromiseLedger(book.id);
    await store.savePromiseLedgerEntry(book.id, entry({
      expectedStartChapter: 1, expectedEndChapter: 1,
    }), { expectedRevision: initial.revision });
    const chapterUrl = `${started.base}/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}`;
    const snapshot = await (await fetch(chapterUrl)).json();
    assert.equal(snapshot.promiseActions.length, 1);
    assert.equal(snapshot.promiseActions[0].id, ENTRY_ID);
    assert.equal(snapshot.promiseActions[0].urgent, true);
    assert.ok(snapshot.plan.readiness.checks.some((check) =>
      check.id === 'reading-debt-action' && check.pass === false));

    const saved = await store.saveChapterPlan(book.id, section.id, chapter.id, {
      foreshadowing: `[推进债务:${ENTRY_ID}] 师父旧线`,
    }, { expectedRevision: snapshot.plan.revision });
    assert.ok(saved.readiness.checks.some((check) =>
      check.id === 'reading-debt-action' && check.pass === true));
  } finally {
    await stopTestServer(started.server);
  }
});

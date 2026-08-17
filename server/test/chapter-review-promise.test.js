import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../store.js';
import {
  normalizeChapterReviewPromiseCandidates,
} from '../chapter-review-promise-schema.js';
import { chapterReviewRevision } from '../chapter-review-revision-prompt.js';
import { extractChapterReview } from '../llm.js';
import { buildChapterReviewInstruction } from '../prompts.js';
import { mountBookRoutes } from '../routes/books.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';
import { startTestServer, stopTestServer } from './http-test-server.js';

const ENTRY_ID = `promise_${'d'.repeat(32)}`;
const EVIDENCE = '缺角车票背面多出一道刚压下的蓝色检票印。';
const READER_BEFORE = '车票只证明失踪者曾在封锁区内乘车';
const READER_AFTER = '车票被封锁区外线路重新检过，失踪者路线跨越两地';
const ACTION_CONSEQUENCE = '主角放弃北门并改查昨夜出城货车';
const WORLD_EFFECT = '深化当前层：证明本城封锁与城外运输线存在执行接口';
let root;

beforeEach(() => {
  root = makeTestTempDir('review-promise-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

function entry() {
  return {
    id: ENTRY_ID, kind: 'mystery', status: 'open', importance: 4,
    promise: '缺角车票来自封锁区外的同一批失踪者',
    introducedChapter: 1, expectedStartChapter: 1, expectedEndChapter: 8,
    progress: [], resolution: '', resolvedChapter: null, nextPromise: '', notes: '',
  };
}

function review() {
  return {
    score: 84, verdict: '车票旧线通过可验证物证获得有效推进',
    issues: [{ title: '余波偏短', detail: '发现新印记后的人物决策仍可再具体。' }],
    suggestions: [{ label: '补余波', instruction: '补写主角如何因蓝色检票印改变路线。' }],
    planComparison: {
      overall: 'aligned', summary: '策划中的车票推进已落地。',
      items: [{ target: 'foreshadowing', outcome: 'fulfilled', evidence: EVIDENCE }],
      carryovers: [],
    },
    promiseLedgerCandidates: [{
      entryId: ENTRY_ID, action: 'advance',
      summary: '蓝色检票印把缺角车票与封锁区外线路建立了可验证联系。',
      evidence: EVIDENCE,
      beat: 'reinterpret',
      readerBefore: READER_BEFORE,
      readerAfter: READER_AFTER,
      actionConsequence: ACTION_CONSEQUENCE,
      worldLink: 'deepen-current',
      worldEffect: WORLD_EFFECT,
    }],
  };
}

async function setup() {
  const book = await store.createBook({ premise: '追查失踪者', title: '蓝色车票' });
  const section = await store.addSection(book.id, { title: '第一部' });
  const chapter = await store.addChapter(book.id, section.id, { title: '检票印' });
  await store.versionSet(book.id, `section:${section.id}:chapter:${chapter.id}`,
    `他把车票翻到灯下。${EVIDENCE}他当即放弃北门，改查昨夜出城的货车。`, {
      expectedRevision: store.versionRevision(chapter.body),
    });
  const initialLedger = await store.readPromiseLedger(book.id);
  await store.savePromiseLedgerEntry(book.id, entry(), {
    expectedRevision: initialLedger.revision,
  });
  const loaded = await store.readChapter(book.id, section.id, chapter.id);
  await store.saveChapterPlan(book.id, section.id, chapter.id, {
    qualityProtocolVersion: 3,
    foreshadowing: `旧线/阅读债务：[推进债务:${ENTRY_ID}] 推进缺角车票来源；叙事节拍：变义；认知变化：${READER_BEFORE}→${READER_AFTER}；具体载体：蓝色检票印；当下作用：证明车票曾离开封锁区；行动影响：${ACTION_CONSEQUENCE}；世界线作用：${WORLD_EFFECT}；保留未知：不揭示失踪者去向`,
  }, { expectedRevision: store.chapterPlanRevision(loaded.plan) });
  const context = await store.readChapterReviewContext(book.id, section.id, chapter.id);
  const saved = await store.saveChapterReview(book.id, section.id, chapter.id, review(), {
    expectedBodyFingerprint: context.chapter.bodyFingerprint,
    expectedContextRevision: context.contextRevision,
  });
  return { book, section, chapter, saved };
}

test('账本候选必须匹配策划动作、账本状态和正文连续原文', () => {
  const plan = {
    qualityProtocolVersion: 3,
    foreshadowing: `旧线/阅读债务：[推进债务:${ENTRY_ID}] 推进车票旧线；叙事节拍：变义；认知变化：${READER_BEFORE}→${READER_AFTER}；具体载体：蓝色检票印；当下作用：核验跨区路线；行动影响：${ACTION_CONSEQUENCE}；世界线作用：${WORLD_EFFECT}；保留未知：失踪者去向`,
  };
  const ledger = { entries: [{
    ...entry(), createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }] };
  const valid = normalizeChapterReviewPromiseCandidates(
    review().promiseLedgerCandidates,
    { chapterPlan: plan, promiseLedger: ledger, chapterContent: `前文${EVIDENCE}后文` },
  );
  assert.equal(valid[0].promise, entry().promise);
  assert.equal(valid[0].beat, 'reinterpret');
  assert.equal(normalizeChapterReviewPromiseCandidates(
    [{ ...review().promiseLedgerCandidates[0], action: 'pay' }],
    { chapterPlan: plan, promiseLedger: ledger, chapterContent: EVIDENCE },
  ), null);
  assert.equal(normalizeChapterReviewPromiseCandidates(
    [{ ...review().promiseLedgerCandidates[0], readerAfter: READER_BEFORE }],
    { chapterPlan: plan, promiseLedger: ledger, chapterContent: EVIDENCE },
  ), null);
  assert.equal(normalizeChapterReviewPromiseCandidates(
    [{ ...review().promiseLedgerCandidates[0], evidence: '模型概括的证据，不是正文原文' }],
    { chapterPlan: plan, promiseLedger: ledger, chapterContent: EVIDENCE },
  ), null);
});

test('有稳定债务动作时审稿协议强制返回候选数组，允许以空数组表示未落地', () => {
  const chapterPlan = {
    qualityProtocolVersion: 3,
    foreshadowing: `旧线/阅读债务：[推进债务:${ENTRY_ID}] 推进车票旧线；叙事节拍：变义；认知变化：${READER_BEFORE}→${READER_AFTER}；具体载体：蓝色检票印；当下作用：核验跨区路线；行动影响：${ACTION_CONSEQUENCE}；世界线作用：${WORLD_EFFECT}；保留未知：失踪者去向`,
  };
  const payload = {
    score: 70, verdict: '正文尚未真正推进车票线',
    issues: [{ title: '证据缺失', detail: '正文没有出现新的可验证车票证据。' }],
    suggestions: [{ label: '补证据', instruction: '让主角从车票上发现可核验的新信息。' }],
    planComparison: {
      overall: 'partial', summary: '埋点任务没有落地。',
      items: [{ target: 'foreshadowing', outcome: 'missed', evidence: '正文只提到旧车票。' }],
      carryovers: [],
    },
  };
  const ledger = { entries: [{
    ...entry(), createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }] };
  assert.equal(extractChapterReview(JSON.stringify(payload), {
    chapterPlan, promiseLedger: ledger, chapterContent: '他再次看见旧车票。',
  }), null);
  const parsed = extractChapterReview(JSON.stringify({
    ...payload, promiseLedgerCandidates: [],
  }), {
    chapterPlan, promiseLedger: ledger, chapterContent: '他再次看见旧车票。',
  });
  assert.deepEqual(parsed.promiseLedgerCandidates, []);
  const instruction = buildChapterReviewInstruction({
    chapterIndex: 1, content: '正文', context: '上下文', chapterPlan,
  });
  assert.match(instruction, /正文连续原文/);
  assert.match(instruction, /不得自创 ID/);
  assert.match(instruction, /promiseLedgerCandidates/);
  assert.match(instruction, /readerBefore/);
});

test('作者确认后才把审稿证据写入推进记录，并拒绝旧账本版本', async () => {
  const { book, section, chapter, saved } = await setup();
  const ledger = await store.readPromiseLedger(book.id);
  assert.equal(ledger.entries[0].progress.length, 0);
  const result = await store.applyChapterReviewPromiseCandidate(
    book.id, section.id, chapter.id, ENTRY_ID,
    {
      expectedBodyFingerprint: saved.review.sourceFingerprint,
      expectedReviewRevision: chapterReviewRevision(saved.review),
      expectedPromiseLedgerRevision: ledger.revision,
    },
  );
  assert.equal(result.entry.progress.length, 1);
  assert.equal(result.entry.progress[0].chapter, 1);
  assert.equal(result.entry.progress[0].beat, 'reinterpret');
  assert.equal(result.entry.progress[0].readerAfter, READER_AFTER);
  assert.equal(result.entry.progress[0].source.bodyFingerprint,
    saved.review.sourceFingerprint);
  assert.match(result.entry.progress[0].id, /^progress_[0-9a-f]{32}$/);
  const retried = await store.applyChapterReviewPromiseCandidate(
    book.id, section.id, chapter.id, ENTRY_ID,
    {
      expectedBodyFingerprint: saved.review.sourceFingerprint,
      expectedReviewRevision: chapterReviewRevision(saved.review),
      expectedPromiseLedgerRevision: ledger.revision,
    },
  );
  assert.equal(retried.alreadyApplied, true);
  assert.equal(retried.entry.progress.length, 1);
});

test('证据正文被改写后节拍退出上下文，账本表单不能伪造证据节拍', async () => {
  const { book, section, chapter, saved } = await setup();
  let ledger = await store.readPromiseLedger(book.id);
  await store.applyChapterReviewPromiseCandidate(
    book.id, section.id, chapter.id, ENTRY_ID,
    {
      expectedBodyFingerprint: saved.review.sourceFingerprint,
      expectedReviewRevision: chapterReviewRevision(saved.review),
      expectedPromiseLedgerRevision: ledger.revision,
    },
  );
  ledger = await store.readPromiseLedger(book.id);
  await assert.rejects(() => store.savePromiseLedgerEntry(book.id, {
    ...ledger.entries[0],
    progress: [{ ...ledger.entries[0].progress[0], readerAfter: '作者伪造的新认知' }],
  }, { expectedRevision: ledger.revision }), /PROMISE_EVIDENCE_IMMUTABLE/);
  await assert.rejects(() => store.deletePromiseLedgerEntry(book.id, ENTRY_ID, {
    expectedRevision: ledger.revision,
  }), /PROMISE_EVIDENCE_IMMUTABLE/);

  const loaded = await store.readChapter(book.id, section.id, chapter.id);
  await store.versionSet(
    book.id, `section:${section.id}:chapter:${chapter.id}`,
    '他只看了一眼旧车票，没有发现任何新印记，仍按原路线行动。',
    { expectedRevision: store.versionRevision(loaded.body) },
  );
  ledger = await store.readPromiseLedger(book.id);
  assert.equal(ledger.entries[0].progress[0].status, 'stale');
  assert.doesNotMatch(
    (await import('../promise-ledger-schema.js')).generationPromiseLedgerRows(
      ledger, { bookChapterIndex: 2 },
    ).join('\n'),
    /蓝色检票印把缺角车票/,
  );
});

test('本地草稿保留旧发布节拍，但发布新版后旧节拍失效', async () => {
  const { book, section, chapter, saved } = await setup();
  let ledger = await store.readPromiseLedger(book.id);
  await store.applyChapterReviewPromiseCandidate(
    book.id, section.id, chapter.id, ENTRY_ID,
    {
      expectedBodyFingerprint: saved.review.sourceFingerprint,
      expectedReviewRevision: chapterReviewRevision(saved.review),
      expectedPromiseLedgerRevision: ledger.revision,
    },
  );
  let loaded = await store.readChapter(book.id, section.id, chapter.id);
  ledger = await store.readPromiseLedger(book.id);
  await store.publishChapterVersion(book.id, section.id, chapter.id, {
    expectedBodyFingerprint: loaded.bodyFingerprint,
    expectedMemoryRevision: store.bookMemoryRevision(await store.readBook(book.id)),
  });
  await store.versionSet(
    book.id, `section:${section.id}:chapter:${chapter.id}`,
    '新版中车票没有蓝印，主角仍按原路线调查。',
    { expectedRevision: store.versionRevision(loaded.body) },
  );
  ledger = await store.readPromiseLedger(book.id);
  assert.equal(ledger.entries[0].progress[0].status, 'active');

  loaded = await store.readChapter(book.id, section.id, chapter.id);
  await store.publishChapterVersion(book.id, section.id, chapter.id, {
    expectedBodyFingerprint: loaded.bodyFingerprint,
    expectedMemoryRevision: store.bookMemoryRevision(await store.readBook(book.id)),
  });
  ledger = await store.readPromiseLedger(book.id);
  assert.equal(ledger.entries[0].progress[0].status, 'stale');
});

test('内存和流式备份均拒绝脱离当前或发布正文的活跃节拍证据', async () => {
  const { book, section, chapter, saved } = await setup();
  const ledger = await store.readPromiseLedger(book.id);
  await store.applyChapterReviewPromiseCandidate(
    book.id, section.id, chapter.id, ENTRY_ID,
    {
      expectedBodyFingerprint: saved.review.sourceFingerprint,
      expectedReviewRevision: chapterReviewRevision(saved.review),
      expectedPromiseLedgerRevision: ledger.revision,
    },
  );
  const backup = await store.createBookBackup(book.id);
  backup.book.settings.promiseLedger.entries[0].progress[0].evidence = '正文中从未出现的伪造证据';
  await assert.rejects(() => store.importBookBackup(backup), /BACKUP_INVALID/);
  const backupPath = join(root, 'forged-promise-evidence.json');
  writeFileSync(backupPath, JSON.stringify(backup));
  await assert.rejects(
    () => store.importBookBackupFile(backupPath, { highWaterMark: 9 }),
    /BACKUP_INVALID/,
  );
});

test('HTTP 确认接口要求正文、审稿和账本三重锚点', async () => {
  const { book, section, chapter, saved } = await setup();
  const ledger = await store.readPromiseLedger(book.id);
  const app = express(); app.use(express.json()); mountBookRoutes(app, { nonStreamChat: async () => '' });
  const started = await startTestServer(app);
  try {
    const response = await fetch(`${started.base}/api/books/${book.id}/sections/${section.id}`
      + `/chapters/${chapter.id}/review-promise-candidates/${ENTRY_ID}/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedBodyFingerprint: saved.review.sourceFingerprint,
        expectedReviewRevision: chapterReviewRevision(saved.review),
        expectedPromiseLedgerRevision: ledger.revision,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.entry.progress[0].note,
      '蓝色检票印把缺角车票与封锁区外线路建立了可验证联系。');
  } finally {
    await stopTestServer(started.server);
  }
});

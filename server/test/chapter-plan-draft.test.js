import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { join } from 'node:path';
import * as store from '../store.js';
import { mountGenRoutes } from '../routes/gen.js';
import { chapterPlanRevision } from '../chapter-plan-schema.js';
import { extractChapterPlanDraft } from '../llm.js';
import { narrativeDesignPlanFields } from '../narrative-design-schema.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';
import { startTestServer, stopTestServer } from './http-test-server.js';

const generatedDesign = {
  designProtocolVersion: 1,
  chapterFunction: 'investigation',
  decision: {
    currentBelief: '主角相信假证仍能安全通过旧友核验',
    action: '主角主动使用假证并在失败后公开身份引走守卫',
    harmedStakeholder: '旧友失去对站台和证人的控制',
    counteraction: '旧友依据公开身份启动通缉并封锁货厢',
    responseChoice: '主角公开真实身份引走守卫并让证人从货厢撤离',
    stateBefore: '主角隐藏身份但无法接近证人',
    stateAfter: '主角见到证人并获得车票但身份暴露',
    nextDebt: '主角必须在通缉合围前找到车票另一半',
  },
  knowledge: {
    mode: 'task',
    question: '缺角车票能证明什么',
    visibleEvidence: '车票缺角与证人票根吻合且背面出现主角真名',
    allowedConclusion: '车票既用于身份核验也记录过主角名字',
    alternatives: ['证人亲手写下名字', '内鬼提前栽入名字'],
    crossValidation: ['证人保留的票根', '车站纸质检票孔记录'],
    protectedUnknown: '不确认笔迹来源和内鬼身份',
  },
};
const generatedDesignFields = narrativeDesignPlanFields(generatedDesign);

const generatedPlan = {
  qualityProtocolVersion: 3,
  designProtocolVersion: 1,
  rhythmIntentVersion: 1,
  rhythmIntent: {
    pressurePattern: 'false-relief', resolutionMethod: 'wit', payoffScale: 'chapter',
    hookMechanism: 'new-information', costType: 'identity',
  },
  goal: '在封锁前找到失踪证人',
  obstacle: '旧友带队封锁车站并逐级核验身份',
  choice: '主角公开自己的假身份，引开守卫',
  payoff: '证人趁混乱主动现身并交出半张车票',
  hook: '车票背面写着主角真名',
  tensionArc: '压力来源：封站倒计时和旧友逐级核验压缩潜入时间；变化链：假证即将通过→因此旧友亲自核验使假证失效→因此主角公开身份引走守卫后证人现身；选择高点：主角必须用身份暴露换证人安全；兑现与余波：证人交出车票，但主角进入通缉名单',
  foreshadowing: '旧线/阅读债务：推进失踪证人与内鬼线；叙事节拍：变义；认知变化：读者原以为车票只证明证人身份→读者确认车票还记录了主角真名；具体载体：缺角车票和背面真名笔迹；当下作用：缺角证明证人身份；行动影响：主角因此放弃撤离并追查另一半；世界线作用：深化当前层的跨区身份记录制度；保留未知：不解释笔迹来源和内鬼身份',
  worldExpansion: '展开前认知：读者与主角只知道本城封锁由本地守卫执行，尚不知道旧案是否跨区；既有依据：世界观中的跨区封锁制度；可验证证据：车票检票孔对应城外封锁区；边界增量/机制深化：主角与读者确认旧案存在跨城运作；选择与代价：主角必须带车票越过封锁并承担通缉风险；保留未知：不揭示上层组织全貌',
  decisionChain: generatedDesignFields.decisionChain,
  knowledgeDesign: generatedDesignFields.knowledgeDesign,
  notes: '不能让账册在本章出现',
  scenes: [{
    title: '闯封锁线', trigger: '上一章收到证人的限时求救，封站倒计时开始',
    desire: '主角要赶在封站前进入站台',
    obstacle: '旧友亲自核验每一张通行证', action: '主角公开假身份制造追捕',
    turn: '旧友带人离岗，证人从货厢现身', cost: '主角的卧底身份进入通缉名单',
  }],
};
const DEBT_ID = `promise_${'d'.repeat(32)}`;

let root;
beforeEach(async () => {
  root = makeTestTempDir('novelbox-plan-draft-');
  store.setDataRoot(root);
  await store.writeConfig({
    baseUrl: 'https://model.test/v1', model: 'planner-model', apiKey: 'test-key',
  });
});
afterEach(cleanupTestTempDirs);

async function createTarget() {
  const book = await store.createBook({
    premise: '卧底必须在身份暴露前找出内鬼', title: '雾站名单',
  });
  const section = await store.addSection(book.id, { title: '封锁之夜' });
  const chapter = await store.addChapter(book.id, section.id, { title: '最后一班车' });
  return { book, section, chapter };
}

function appWithPlanner(nonStreamChat, { design = generatedDesign } = {}) {
  const app = express();
  app.use(express.json());
  mountGenRoutes(app, {
    async *streamChat() { yield ''; },
    async nonStreamChat(input) {
      if (/制作“叙事骨架”/u.test(input.messages?.[0]?.content ?? '')) {
        return JSON.stringify(design);
      }
      return nonStreamChat(input);
    },
  });
  return app;
}

function request(base, target, extra = {}, signal) {
  return fetch(`${base}/api/gen/chapter-plan-draft`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({
      bookId: target.book.id,
      sectionId: target.section.id,
      chapterId: target.chapter.id,
      expectedPlanRevision: chapterPlanRevision(target.chapter.plan),
      seedPlan: {
        qualityProtocolVersion: 0,
        goal: '找到失踪证人', obstacle: '', choice: '', payoff: '', hook: '',
        notes: '不能让账册在本章出现', scenes: [],
      },
      ...extra,
    }),
  });
}

test('模型策划解析容忍包裹说明并按业务边界截断', () => {
  const oversized = {
    ...generatedPlan,
    goal: `目标${'长'.repeat(600)}`,
    scenes: Array.from({ length: 13 }, (_, index) => ({
      ...generatedPlan.scenes[0], title: `场景${index + 1}`,
    })),
  };
  const parsed = extractChapterPlanDraft(`说明文字\n\`\`\`json\n${JSON.stringify(oversized)}\n\`\`\``);
  assert.ok(parsed);
  assert.equal(Array.from(parsed.goal).length, 500);
  assert.equal(parsed.scenes.length, 12);
  assert.equal(parsed.scenes[11].title, '场景12');
  assert.equal(extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan, hook: '',
  })), null);
  assert.equal(extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan, choice: '待进一步明确',
  })), null);
  assert.equal(extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan, qualityProtocolVersion: 1,
  })), null);
  assert.equal(extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan, designProtocolVersion: 0,
  })), null);
  assert.equal(extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan, knowledgeDesign: '当前问题：车票是谁的',
  })), null);
  assert.equal(extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan, rhythmIntent: { ...generatedPlan.rhythmIntent, costType: 'free' },
  })), null);
  assert.equal(extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan, rhythmIntent: { ...generatedPlan.rhythmIntent, costType: '' },
  })), null);
  assert.equal(extractChapterPlanDraft(JSON.stringify((({ qualityProtocolVersion, ...rest }) => rest)(generatedPlan))), null);
});

test('两阶段解析把模型自然语言变化链和认知前后句规范化，不因标点格式误杀', () => {
  const verboseWorld = [
    `展开前认知：${'主角只知道旧站台规则仍在运转'.repeat(8)}`,
    `既有依据：${'车站档案制度要求纸质记录与闸机日志并存'.repeat(8)}`,
    `可验证证据：${'主角能核对票根和检票孔记录'.repeat(8)}`,
    `边界增量：${'本章只确认旧证件已经接入追踪'.repeat(8)}`,
    `选择与代价：${'证据迫使主角公开身份并失去隐蔽性'.repeat(8)}`,
    `保留未知：${'不确认是谁下令标记证件'.repeat(8)}`,
  ].join('；');
  const parsed = extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan,
    rhythmIntent: { ...generatedPlan.rhythmIntent, resolutionMethod: 'choice-led' },
    tensionArc: '压力来源：守卫正在合围；变化链：主角刷证进入站台，局势A；守卫发现异常并锁门，局势B；主角公开身份引走守卫，局势C',
    foreshadowing: '旧线/阅读债务：推进缺角车票；叙事节拍：线索碰撞；认知变化：读者原先认为旧证件仍安全，本章结束后认识到证件已经接入追踪；具体载体：闸机警报编号；当下作用：警报迫使主角改变路线；行动影响：主角公开身份引走守卫；世界线作用：深化当前层的车站审计制度；保留未知：不确认谁标记了证件',
    worldExpansion: verboseWorld,
  }), { narrativeDesign: generatedDesign });
  assert.ok(parsed);
  assert.equal(parsed.rhythmIntent.resolutionMethod, 'mixed');
  assert.match(parsed.tensionArc, /选择高点：/u);
  assert.match(parsed.tensionArc, /兑现与余波：/u);
  assert.match(parsed.tensionArc, /→因此/u);
  assert.match(parsed.foreshadowing, /认知变化：[^；]+→/u);
  assert.ok(Array.from(parsed.worldExpansion).length <= 500);
  assert.match(parsed.worldExpansion, /边界增量\/机制深化：/u);
  assert.match(parsed.worldExpansion, /保留未知：/u);
});

test('AI 只返回章节与场景策划候选，不保存策划卡或生成正文', async () => {
  const target = await createTarget();
  let captured;
  const started = await startTestServer(appWithPlanner(async (input) => {
    captured = input;
    return JSON.stringify(generatedPlan);
  }));
  try {
    const response = await request(started.base, target);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.plan, generatedPlan);
    assert.equal(result.basePlanRevision, chapterPlanRevision(target.chapter.plan));
    assert.equal(captured.config.model, 'planner-model');
    assert.ok(captured.signal instanceof AbortSignal);
    assert.match(captured.system, /长期网文创作准则/);
    assert.match(captured.messages[0].content, /卧底必须在身份暴露前找出内鬼/);
    assert.match(captured.messages[0].content, /作者当前策划草稿/);
    assert.match(captured.messages[0].content, /已验证叙事骨架/);
    assert.match(captured.messages[0].content, /不得重新发明线索、反制或章节功能/);
    assert.match(captured.messages[0].content, /找到失踪证人/);
    assert.match(captured.messages[0].content, /不要写正文，不要声称已经保存/);
    assert.match(captured.messages[0].content, /连续因果/);
    assert.match(captured.messages[0].content, /删掉前一场/);
    assert.match(captured.messages[0].content, /trigger、desire/);
    assert.match(captured.messages[0].content, /门槛、危险、期限或救援承诺/);
    assert.match(captured.messages[0].content, /职业与能力必须至少一次用于改变局面/);
    assert.match(captured.messages[0].content, /不能连续包办路线、工具和答案/);
    assert.match(captured.messages[0].content, /利益受损者/);
    assert.match(captured.messages[0].content, /至少保留两个当时合理的替代解释/);
    assert.match(captured.messages[0].content, /designProtocolVersion 必须为 1/);
    assert.match(captured.messages[0].content, /先安排人物据此行动并承受后果/);
    assert.match(captured.messages[0].content, /张力曲线/);
    assert.match(captured.messages[0].content, /至少两次变化/);
    assert.match(captured.messages[0].content, /分层埋点/);
    assert.match(captured.messages[0].content, /世界边界扩张/);
    assert.match(captured.messages[0].content, /没有新增伏笔时/);
    assert.match(captured.messages[0].content, /物证、地域、制度、历史痕迹或力量差/);
    const stored = await store.readChapter(
      target.book.id, target.section.id, target.chapter.id,
    );
    assert.equal(chapterPlanRevision(stored.plan), chapterPlanRevision(target.chapter.plan));
    assert.equal(store.currentText(stored.body), '');
  } finally {
    await stopTestServer(started.server);
  }
});

test('AI 下一章候选原样重复前章结论、证据、反制、兑现和钩子时被确定性门禁拒绝', async () => {
  const target = await createTarget();
  await store.saveChapterPlan(
    target.book.id, target.section.id, target.chapter.id, generatedPlan,
    { expectedRevision: chapterPlanRevision(target.chapter.plan) },
  );
  await store.versionSet(
    target.book.id,
    `section:${target.section.id}:chapter:${target.chapter.id}`,
    '前章正文已经兑现了缺角车票、旧友追捕和身份暴露。',
  );
  const nextChapter = await store.addChapter(
    target.book.id, target.section.id, { title: '重复的一章' },
  );
  const started = await startTestServer(appWithPlanner(async () =>
    JSON.stringify(generatedPlan)));
  try {
    const response = await request(started.base, { ...target, chapter: nextChapter });
    assert.match(await response.text(), /CHAPTER_PLAN_DRAFT_FAILED/);
    const stored = await store.readChapter(
      target.book.id, target.section.id, nextChapter.id,
    );
    assert.equal(stored.plan.goal, '');
  } finally {
    await stopTestServer(started.server);
  }
});

test('叙事骨架不完整时在第二次模型调用前拒绝，不让完整策划自行补洞', async () => {
  const target = await createTarget();
  let finalCalls = 0;
  const started = await startTestServer(appWithPlanner(async () => {
    finalCalls += 1;
    return JSON.stringify(generatedPlan);
  }, {
    design: {
      ...generatedDesign,
      knowledge: { ...generatedDesign.knowledge, alternatives: ['只有一个解释'] },
    },
  }));
  try {
    const response = await request(started.base, target);
    assert.match(await response.text(), /CHAPTER_PLAN_DRAFT_FAILED/);
    assert.equal(finalCalls, 0);
  } finally {
    await stopTestServer(started.server);
  }
});

test('模型候选缺少必要章级或场景因果字段时不回填半成品', async () => {
  const target = await createTarget();
  const started = await startTestServer(appWithPlanner(async () => JSON.stringify({
    ...generatedPlan,
    scenes: [{ ...generatedPlan.scenes[0], turn: '' }],
  })));
  try {
    const response = await request(started.base, target);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'CHAPTER_PLAN_DRAFT_FAILED' });
  } finally {
    await stopTestServer(started.server);
  }
});

test('模型候选不能回避已到期债务、杜撰 ID 或把后台锚点放错字段', async () => {
  const target = await createTarget();
  const initial = await store.readPromiseLedger(target.book.id);
  await store.savePromiseLedgerEntry(target.book.id, {
    id: DEBT_ID, kind: 'mystery', status: 'open', importance: 5,
    promise: '车票背面的真名属于谁', introducedChapter: 1,
    expectedStartChapter: 1, expectedEndChapter: 1, progress: [],
    resolution: '', resolvedChapter: null, nextPromise: '', notes: '',
  }, { expectedRevision: initial.revision });
  const candidates = [
    generatedPlan,
    { ...generatedPlan, foreshadowing: generatedPlan.foreshadowing.replace(
      '旧线/阅读债务：', `旧线/阅读债务：[推进债务:promise_${'e'.repeat(32)}] `,
    ) },
    { ...generatedPlan, notes: `[推进债务:${DEBT_ID}] ${generatedPlan.notes}` },
  ];
  let index = 0;
  const started = await startTestServer(appWithPlanner(async () =>
    JSON.stringify(candidates[index++])));
  try {
    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      const response = await request(started.base, target);
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: 'CHAPTER_PLAN_DRAFT_FAILED' });
    }
  } finally {
    await stopTestServer(started.server);
  }
});

test('模型候选正确锚定到期债务后可以返回，但仍不保存策划', async () => {
  const target = await createTarget();
  const initial = await store.readPromiseLedger(target.book.id);
  await store.savePromiseLedgerEntry(target.book.id, {
    id: DEBT_ID, kind: 'mystery', status: 'open', importance: 5,
    promise: '车票背面的真名属于谁', introducedChapter: 1,
    expectedStartChapter: 1, expectedEndChapter: 1, progress: [],
    resolution: '', resolvedChapter: null, nextPromise: '', notes: '',
  }, { expectedRevision: initial.revision });
  const aligned = {
    ...generatedPlan,
    foreshadowing: generatedPlan.foreshadowing.replace(
      '旧线/阅读债务：', `旧线/阅读债务：[推进债务:${DEBT_ID}] `,
    ),
  };
  const started = await startTestServer(appWithPlanner(async () => JSON.stringify(aligned)));
  try {
    const response = await request(started.base, target);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).plan.foreshadowing, aligned.foreshadowing);
    assert.equal((await store.readChapter(
      target.book.id, target.section.id, target.chapter.id,
    )).plan.foreshadowing, '');
  } finally {
    await stopTestServer(started.server);
  }
});

test('没有到期债务时模型可选择具体的无埋点合同，不必硬造新谜团', () => {
  const noTaskPlan = {
    ...generatedPlan,
    foreshadowing: '无埋点理由：本章先兑现主角暴露身份的后果，不在逃亡现场另开谜团；本章聚焦：主角利用旧后门救出证人并承担被通缉代价；既有未知处理：内鬼身份与真名笔迹保持原有未知，本章不提供新证据也不提前揭示',
  };
  const parsed = extractChapterPlanDraft(JSON.stringify(noTaskPlan));
  assert.equal(parsed?.foreshadowing, noTaskPlan.foreshadowing);
});

test('模型候选缺少场景承接触发时不接受并列事件拼盘', () => {
  assert.equal(extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan,
    scenes: [{ ...generatedPlan.scenes[0], trigger: '' }],
  })), null);
});

test('模型候选拒绝只有结构词、没有载体和行动后果的空泛质量字段', () => {
  assert.equal(extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan,
    tensionArc: '受阻→希望→反转→选择',
  })), null);
  assert.equal(extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan,
    foreshadowing: '旧线/阅读债务：内鬼线；具体载体：车票；当下作用：伏笔；行动影响：推进剧情；保留未知：真相',
  })), null);
  assert.equal(extractChapterPlanDraft(JSON.stringify({
    ...generatedPlan,
    worldExpansion: '出现更大的城外势力和更强敌人',
  })), null);
});

test('陈旧策划修订号在调用模型前被拒绝', async () => {
  const target = await createTarget();
  let called = false;
  const started = await startTestServer(appWithPlanner(async () => {
    called = true;
    return JSON.stringify(generatedPlan);
  }));
  try {
    const response = await request(started.base, target, {
      expectedPlanRevision: 'R'.repeat(43),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'CHAPTER_PLAN_CONFLICT' });
    assert.equal(called, false);
  } finally {
    await stopTestServer(started.server);
  }
});

test('模型等待期间正文变化会让迟到策划候选作废', async () => {
  const target = await createTarget();
  let notifyStarted;
  let release;
  const modelStarted = new Promise((resolve) => { notifyStarted = resolve; });
  const canFinish = new Promise((resolve) => { release = resolve; });
  const started = await startTestServer(appWithPlanner(async () => {
    notifyStarted();
    await canFinish;
    return JSON.stringify(generatedPlan);
  }));
  try {
    const pending = request(started.base, target);
    await modelStarted;
    await store.versionSet(
      target.book.id,
      `section:${target.section.id}:chapter:${target.chapter.id}`,
      '另一页面在策划期间保存的新正文',
    );
    release();
    const response = await pending;
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'GENERATION_CONTEXT_CONFLICT' });
  } finally {
    release?.();
    await stopTestServer(started.server);
  }
});

test('模型等待期间本次种子策划命中的长期事实变化会让候选作废', async () => {
  const target = await createTarget();
  const storedBook = await store.readBook(target.book.id);
  const source = {
    sectionId: target.section.id, chapterId: target.chapter.id,
    chapterIndex: 1, bodyFingerprint: target.chapter.bodyFingerprint,
  };
  storedBook.memory.facts = Array.from({ length: 140 }, (_, index) => ({
    id: `memory_${index.toString(16).padStart(32, '0')}`,
    kind: 'item', subject: `普通遗物${index}`, predicate: '限制',
    object: `只能由第${index}位守门人使用${'旧'.repeat(70)}`,
    evidence: '历史正文证据', importance: 5, status: 'active', source,
    confirmedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: new Date(Date.UTC(2026, 0, (index % 28) + 1)).toISOString(),
  }));
  storedBook.memory.facts.push({
    id: `memory_${'f'.repeat(32)}`, kind: 'character', subject: '失踪证人',
    predicate: '真实身份', object: '北境星门守钥人', evidence: '早期正文证据',
    importance: 1, status: 'active', source,
    confirmedAt: '2001-01-01T00:00:00.000Z', updatedAt: '2001-01-01T00:00:00.000Z',
  });
  const bookPath = join(root, 'books', target.book.id, 'book.json');
  await store.atomicWriteJson(bookPath, storedBook);

  let notifyStarted;
  let release;
  let capturedPrompt = '';
  const modelStarted = new Promise((resolve) => { notifyStarted = resolve; });
  const canFinish = new Promise((resolve) => { release = resolve; });
  const started = await startTestServer(appWithPlanner(async (input) => {
    capturedPrompt = input.messages[0].content;
    notifyStarted();
    await canFinish;
    return JSON.stringify(generatedPlan);
  }));
  try {
    const pending = request(started.base, target);
    await modelStarted;
    assert.match(capturedPrompt, /失踪证人｜真实身份｜北境星门守钥人/);
    const changedBook = await store.readBook(target.book.id);
    const targetFact = changedBook.memory.facts.find((fact) => fact.subject === '失踪证人');
    targetFact.object = '北境议会派出的假证人';
    targetFact.updatedAt = '2026-02-01T00:00:00.000Z';
    await store.atomicWriteJson(bookPath, changedBook);
    release();
    const response = await pending;
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'GENERATION_CONTEXT_CONFLICT' });
  } finally {
    release?.();
    await stopTestServer(started.server);
  }
});

test('非法修订号和超长种子草稿在调用模型前返回稳定错误', async () => {
  const target = await createTarget();
  let called = false;
  const started = await startTestServer(appWithPlanner(async () => {
    called = true;
    return JSON.stringify(generatedPlan);
  }));
  try {
    const badRevision = await request(started.base, target, {
      expectedPlanRevision: 'not-a-revision',
    });
    assert.equal(badRevision.status, 400);
    assert.deepEqual(await badRevision.json(), { error: 'BAD_CHAPTER_PLAN_REVISION' });
    const oversized = await request(started.base, target, {
      seedPlan: { goal: '长'.repeat(501), scenes: [] },
    });
    assert.equal(oversized.status, 400);
    assert.deepEqual(await oversized.json(), { error: 'CHAPTER_PLAN_TOO_LARGE' });
    assert.equal(called, false);
  } finally {
    await stopTestServer(started.server);
  }
});

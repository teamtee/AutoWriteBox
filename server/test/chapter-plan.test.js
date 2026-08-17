import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../store.js';
import { createApp } from '../index.js';
import {
  chapterPlanReadiness, chapterPlanRevision, chapterPlanView, emptyChapterPlan,
  normalizeChapterPlan,
} from '../chapter-plan-schema.js';
import { cleanupTestTempDirs, makeTestTempDir } from './test-temp-dir.js';
import { startTestServer, stopTestServer } from './http-test-server.js';
import { validChapterPlanFixture } from './chapter-plan-fixture.js';

let root;
beforeEach(() => {
  root = makeTestTempDir('novelbox-chapter-plan-');
  store.setDataRoot(root);
});
afterEach(cleanupTestTempDirs);

async function createTarget() {
  const book = await store.createBook({ premise: '策划卡测试', title: '长篇' });
  const section = await store.addSection(book.id, { title: '第一部' });
  const chapter = await store.addChapter(book.id, section.id, { title: '第一章' });
  return { book, section, chapter };
}

test('章节策划卡规范化、修订号和字段上限保持稳定', () => {
  const normalized = normalizeChapterPlan({
    goal: '  找到证人  ', payoff: '揭露假线索',
    scenes: [{
      title: '  车站堵截 ', desire: ' 主角想先找到证人 ', obstacle: ' 封锁线 ',
      action: '伪造调令', turn: '守卫放行', cost: '身份留下记录',
    }, {}],
  });
  assert.deepEqual(normalized, {
    goal: '找到证人', obstacle: '', choice: '', payoff: '揭露假线索',
    hook: '', tensionArc: '', foreshadowing: '', worldExpansion: '',
    decisionChain: '', knowledgeDesign: '', notes: '',
    scenes: [{
      title: '车站堵截', desire: '主角想先找到证人', obstacle: '封锁线',
      action: '伪造调令', turn: '守卫放行', cost: '身份留下记录',
    }],
  });
  assert.match(chapterPlanRevision(normalized), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    chapterPlanRevision({ ...normalized, qualityProtocolVersion: 0 }),
    chapterPlanRevision(normalized),
  );
  assert.equal(chapterPlanView(normalized).qualityProtocolVersion, 0);
  assert.equal(chapterPlanView(normalized).isEmpty, false);
  assert.equal(chapterPlanView(emptyChapterPlan()).isEmpty, true);
  assert.equal(chapterPlanView(emptyChapterPlan()).qualityProtocolVersion, 3);
  assert.equal(chapterPlanView(emptyChapterPlan()).designProtocolVersion, 1);
  assert.equal(chapterPlanView(emptyChapterPlan()).rhythmIntentVersion, 1);
  assert.equal(chapterPlanView(emptyChapterPlan()).readiness.ready, false);
  assert.ok(chapterPlanView(emptyChapterPlan()).readiness.checks.some((check) =>
    check.id === 'tension-design' && !check.advisory));
  assert.throws(
    () => normalizeChapterPlan({ goal: '长'.repeat(501) }),
    /CHAPTER_PLAN_TOO_LARGE/,
  );
  assert.throws(() => normalizeChapterPlan({ goal: 42 }), /BAD_CHAPTER_PLAN/);
  assert.throws(
    () => normalizeChapterPlan({ scenes: Array.from({ length: 13 }, () => ({ title: '场景' })) }),
    /CHAPTER_PLAN_TOO_LARGE/,
  );
  assert.throws(
    () => normalizeChapterPlan({ scenes: [{ action: 42 }] }),
    /BAD_CHAPTER_PLAN/,
  );
  assert.throws(() => normalizeChapterPlan({
    rhythmIntentVersion: 1,
    rhythmIntent: {
      pressurePattern: '热血', resolutionMethod: 'wit', payoffScale: 'chapter',
      hookMechanism: 'new-threat', costType: 'identity',
    },
  }), /BAD_CHAPTER_PLAN/);
});

test('新版写前节奏意图必须完整，重复历史只形成可解释建议', () => {
  const base = {
    qualityProtocolVersion: 0,
    goal: '找到证人', obstacle: '车站封锁', choice: '暴露假身份',
    payoff: '证人现身', hook: '出现新的追捕令',
    scenes: [{
      trigger: '上一章收到求救', desire: '进入车站', obstacle: '身份核验',
      action: '公开假身份', turn: '证人现身', cost: '假身份报废',
    }],
  };
  const incomplete = chapterPlanReadiness({
    ...base, rhythmIntentVersion: 1,
    rhythmIntent: {
      pressurePattern: 'false-relief', resolutionMethod: '', payoffScale: 'chapter',
      hookMechanism: 'new-threat', costType: 'identity',
    },
  });
  assert.equal(incomplete.ready, false);
  const rhythmIntent = {
    pressurePattern: 'false-relief', resolutionMethod: 'sacrifice',
    payoffScale: 'chapter', hookMechanism: 'new-threat', costType: 'relationship',
  };
  const recentReviewSignals = [7, 8].map((bookChapterIndex) => ({
    bookChapterIndex,
    signals: {
      chapterFunction: '转折', conflictType: '追捕', emotionTone: '紧张',
      payoffType: '脱险', dominantMode: '行动', rhythmFingerprint: rhythmIntent,
    },
  }));
  const ready = chapterPlanReadiness({
    ...base, rhythmIntentVersion: 1, rhythmIntent,
  }, { recentReviewSignals, bookChapterIndex: 9 });
  assert.equal(ready.ready, true);
  assert.ok(ready.checks.some((check) =>
    check.id === 'rhythm-variation' && check.advisory && /连续使用/.test(check.detail)));
});

test('写前门槛要求人物行动、场景因果与有代价的兑现，不接受占位策划', () => {
  const ready = chapterPlanReadiness({
    goal: '抢在封城前找到失踪证人', obstacle: '安保逐层核验通行身份',
    choice: '主角调用自己留下后门并暴露旧身份', payoff: '证人主动交出账本',
    hook: '账本最后一页写着妹妹的编号',
    scenes: [{
      desire: '主角必须进入封锁站台', obstacle: '闸机开始核验生物签名',
      action: '主角重放自己三年前写入的维护指令', turn: '闸机放行却触发旧身份警报',
      cost: '追捕系统重新确认主角仍然活着',
    }],
  });
  assert.equal(ready.ready, true);
  assert.ok(ready.checks.every((check) => check.pass || check.advisory));
  assert.ok(ready.checks.some((check) => check.id === 'tension-design'
    && check.advisory));
  assert.ok(ready.checks.some((check) => check.id === 'scene-linkage'
    && check.advisory));

  const linkedPlan = {
    qualityProtocolVersion: 0,
    goal: '找到证人', obstacle: '车站封锁', choice: '暴露假身份',
    payoff: '证人现身', hook: '证人指出内鬼',
    scenes: [{
      trigger: '上一章收到限时求救', desire: '进入车站', obstacle: '身份核验',
      action: '公开假身份', turn: '守卫离岗追捕', cost: '假身份报废',
    }, {
      trigger: '守卫离岗使货厢无人看守', desire: '找到证人', obstacle: '货厢即将发车',
      action: '跳上货厢', turn: '证人现身却拒绝交证据', cost: '主角被困在列车上',
    }],
  };
  const linked = chapterPlanReadiness(linkedPlan);
  assert.equal(linked.ready, true);
  assert.ok(linked.checks.some((check) => check.id === 'scene-linkage' && check.pass));

  const partiallyLinked = chapterPlanReadiness({
    ...linkedPlan,
    scenes: linkedPlan.scenes.map((scene, index) => index ? { ...scene, trigger: '' } : scene),
  });
  assert.equal(partiallyLinked.ready, false);
  assert.ok(partiallyLinked.checks.some((check) => check.id === 'scene-linkage'
    && !check.pass && !check.advisory));

  const vagueQuality = chapterPlanReadiness({
    ...linkedPlan, qualityProtocolVersion: 1,
    tensionArc: '受阻→希望→反转→选择',
    foreshadowing: '车票推进伏笔', worldExpansion: '出现城外势力',
  });
  assert.equal(vagueQuality.ready, false);
  for (const id of [
    'tension-design', 'foreshadowing-design', 'world-expansion-design',
  ]) assert.ok(vagueQuality.checks.some((check) => check.id === id
    && !check.pass && !check.advisory));

  const qualityReady = chapterPlanReadiness({
    ...linkedPlan, qualityProtocolVersion: 1,
    tensionArc: '压力来源：封站倒计时；变化链：假证即将通过→旧友核验使假证失效→公开身份引走守卫；选择高点：主角用暴露换通路；兑现与余波：证人现身但主角被通缉',
    foreshadowing: '旧线/阅读债务：推进内鬼线；具体载体：缺角车票；当下作用：证明求救者身份；行动影响：主角改去货厢追人；保留未知：不揭示内鬼姓名',
    worldExpansion: '既有依据：跨区封锁制度；可验证证据：城外检票孔；边界增量/机制深化：旧案确认跨城运作；选择与代价：主角带证据越区并失去假身份；保留未知：不揭示上层组织',
  });
  assert.equal(qualityReady.ready, true);
  assert.ok(qualityReady.checks.filter((check) => [
    'tension-design', 'foreshadowing-design', 'world-expansion-design',
  ].includes(check.id)).every((check) => check.pass));

  const qualityV2Ready = chapterPlanReadiness({
    ...linkedPlan, qualityProtocolVersion: 2,
    tensionArc: '压力来源：封站倒计时；变化链：假证即将通过→旧友核验使假证失效→公开身份引走守卫；选择高点：主角用暴露换通路；兑现与余波：证人现身但主角被通缉',
    foreshadowing: '旧线/阅读债务：推进内鬼线；具体载体：缺角车票；当下作用：证明求救者身份；行动影响：主角改去货厢追人；保留未知：不揭示内鬼姓名',
    worldExpansion: '展开前认知：主角与读者只知道本城封锁，尚不知道旧案跨区；既有依据：跨区封锁制度；可验证证据：城外检票孔；边界增量/机制深化：主角与读者确认旧案跨城运作；选择与代价：主角带证据越区并失去假身份；保留未知：不揭示上层组织',
  });
  assert.equal(qualityV2Ready.ready, true);

  const placeholder = chapterPlanReadiness({
    goal: '待定', obstacle: '暂无', choice: '待进一步明确',
    payoff: '无', hook: '待补充', scenes: [{ action: '不知道' }],
  });
  assert.equal(placeholder.ready, false);
  assert.ok(placeholder.checks.some((check) => check.id === 'agency' && !check.pass));
  assert.ok(placeholder.checks.some((check) => check.id === 'earned-payoff' && !check.pass));
});

test('首次生成严格要求 v3、逐场触发和完整节奏意图，旧稿读取仍兼容', () => {
  const valid = validChapterPlanFixture();
  assert.equal(chapterPlanReadiness(valid, { requireCurrentProtocol: true }).ready, true);

  const missingTrigger = {
    ...valid,
    scenes: valid.scenes.map(({ trigger: _trigger, ...scene }) => scene),
  };
  const triggerReadiness = chapterPlanReadiness(missingTrigger, {
    requireCurrentProtocol: true,
  });
  assert.equal(triggerReadiness.ready, false);
  assert.ok(triggerReadiness.checks.some((check) =>
    check.id === 'scene-linkage' && !check.pass && !check.advisory));

  const { rhythmIntent: _intent, rhythmIntentVersion: _version, ...missingRhythm } = valid;
  const rhythmReadiness = chapterPlanReadiness(missingRhythm, {
    requireCurrentProtocol: true,
  });
  assert.equal(rhythmReadiness.ready, false);
  assert.ok(rhythmReadiness.checks.some((check) =>
    check.id === 'rhythm-intent' && !check.pass && !check.advisory));

  const legacy = {
    goal: '找到证人', obstacle: '车站封锁', choice: '暴露假身份',
    payoff: '证人现身', hook: '新的追捕令',
    scenes: [{
      desire: '进入车站', obstacle: '身份核验', action: '公开假身份',
      turn: '证人现身', cost: '假身份报废',
    }],
  };
  assert.equal(chapterPlanReadiness(legacy).ready, true);
  assert.equal(chapterPlanReadiness(legacy, { requireCurrentProtocol: true }).ready, false);
});

test('v3 伏笔标记支撑下一层时必须锚定当前分部门槛', () => {
  const gate = '必须用正文行动完成第1层进入门槛';
  const sectionOutline = [
    '【世界层级】当前生活圈', '【世界阶段承诺】人物选择兑现阶段承诺',
    '【可验证世界证据】现场物证可交叉核验', '【人物行动】主角主动追查现场物证',
    '【世界选择与代价】主角保住证据并失去容身处', '【阶段认知增量】读者确认规则的社会影响',
    '【本部保留未知】不揭示幕后者身份', `【下一层门槛】${gate}`,
    '【门槛结果】本部完成门槛，下部进入下一层', '【门槛证据进度】主角正在核验第一份物证',
  ].join('\n');
  const basePlan = {
    qualityProtocolVersion: 3,
    foreshadowing: '旧线/阅读债务：推进城外检票线；叙事节拍：线索碰撞；认知变化：读者以为两地封锁各自独立→读者怀疑两地共用身份库；具体载体：两枚编号一致的检票印；当下作用：选择追踪出城货车；行动影响：主角携证据冒险越区；世界线作用：支撑下一层门槛，但暂未完成；保留未知：不揭示身份库控制者',
  };
  const missing = chapterPlanReadiness(basePlan, { sectionOutline });
  assert.ok(missing.checks.some((check) =>
    check.id === 'foreshadowing-world-gate' && !check.pass));
  const anchored = chapterPlanReadiness({
    ...basePlan,
    foreshadowing: basePlan.foreshadowing.replace(
      '支撑下一层门槛，但暂未完成', `支撑下一层门槛“${gate}”，但暂未完成`,
    ),
  }, { sectionOutline });
  assert.ok(anchored.checks.some((check) =>
    check.id === 'foreshadowing-world-gate' && check.pass));
});

test('新空章首次保存即使来自旧客户端也升级为质量合同，旧非空策划仍兼容', async () => {
  const { book, section, chapter } = await createTarget();
  const saved = await store.saveChapterPlan(book.id, section.id, chapter.id, {
    goal: '找到证人', obstacle: '车站封锁', choice: '暴露假身份',
    payoff: '证人现身', hook: '证人指出内鬼',
    scenes: [{
      desire: '进入车站', obstacle: '身份核验', action: '公开假身份',
      turn: '守卫离岗', cost: '假身份报废',
    }],
  }, { expectedRevision: chapterPlanRevision(chapter.plan) });
  assert.equal(saved.qualityProtocolVersion, 3);
  assert.equal(saved.readiness.ready, false);
  assert.ok(saved.readiness.checks.some((check) =>
    check.id === 'tension-design' && !check.advisory));

  const legacy = chapterPlanView({ goal: '旧书已有目标' });
  assert.equal(legacy.qualityProtocolVersion, 0);
  assert.ok(legacy.readiness.checks.some((check) =>
    check.id === 'tension-design' && check.advisory));
});

test('章节策划卡 HTTP 返回修订号并拒绝陈旧页面覆盖', async () => {
  const started = await startTestServer(createApp());
  try {
    const { book, section, chapter } = await createTarget();
    const path = `/api/books/${book.id}/sections/${section.id}/chapters/${chapter.id}`;
    const loaded = await (await fetch(started.base + path)).json();
    assert.equal(loaded.plan.isEmpty, true);
    assert.equal(loaded.plan.qualityProtocolVersion, 3);
    assert.equal(loaded.plan.readiness.ready, false);
    assert.match(loaded.plan.revision, /^[A-Za-z0-9_-]{43}$/);

    const post = (plan, expectedRevision) => fetch(`${started.base}${path}/plan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, expectedRevision }),
    });
    const savedResponse = await post(validChapterPlanFixture({
      goal: '找到失踪证人', obstacle: '对手封锁车站',
      choice: '主角公开通缉自己的假身份', payoff: '证人主动现身',
      hook: '证人称凶手就在队伍里',
      tensionArc: '压力来源：封站倒计时；变化链：假身份暂时放行→旧友核验使身份失效→公开通缉引走守卫；选择高点：主角暴露身份换证人通路；兑现与余波：证人现身但主角被通缉',
      foreshadowing: '旧线/阅读债务：推进旧案；叙事节拍：变义；认知变化：读者原以为车票只用于本城→读者确认车票曾被城外线路核验；具体载体：车票编号；当下作用：确认求救者身份；行动影响：主角转去货厢；世界线作用：深化当前层的跨区检票制度；保留未知：不揭示幕后人',
      worldExpansion: '展开前认知：主角与读者只知道本城封锁，尚不知道旧案跨区；既有依据：跨区封锁制度；可验证证据：城外权限记录；边界增量/机制深化：主角与读者确认旧案跨区；选择与代价：主角携证据越区且身份暴露；保留未知：不揭示负责人',
      notes: '保留车票线索',
      scenes: [{
        title: '闯封锁线', trigger: '上一章的求救信要求主角在封站前赶到',
        desire: '主角要进入车站', obstacle: '守卫核验身份',
        action: '公开假身份', turn: '证人主动现身', cost: '卧底身份暴露',
      }],
    }), loaded.plan.revision);
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.goal, '找到失踪证人');
    assert.match(saved.tensionArc, /旧友核验/);
    assert.match(saved.foreshadowing, /车票编号/);
    assert.match(saved.worldExpansion, /城外权限记录/);
    assert.equal(saved.scenes[0].turn, '证人主动现身');
    assert.equal(saved.readiness.ready, true);
    assert.ok(saved.readiness.checks.some((check) =>
      check.id === 'rhythm-intent' && check.pass && !check.advisory));
    assert.deepEqual(saved.readiness.checks
      .filter((check) => !check.pass && !check.advisory)
      .map((check) => check.id), []);
    assert.notEqual(saved.revision, loaded.plan.revision);

    const stale = await post({ goal: '旧页面目标' }, loaded.plan.revision);
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: 'CHAPTER_PLAN_CONFLICT' });
    const current = await (await fetch(started.base + path)).json();
    assert.equal(current.plan.goal, '找到失踪证人');
  } finally {
    await stopTestServer(started.server);
  }
});

test('策划卡保存使用乐观修订号，旧页面不能覆盖新版', async () => {
  const { book, section, chapter } = await createTarget();
  const initial = chapterPlanView(chapter.plan);
  const saved = await store.saveChapterPlan(
    book.id, section.id, chapter.id,
    { goal: '潜入仓库', obstacle: '守卫提前换班', hook: '门后传来熟悉声音' },
    { expectedRevision: initial.revision },
  );
  assert.equal(saved.goal, '潜入仓库');
  assert.equal(saved.obstacle, '守卫提前换班');
  assert.notEqual(saved.revision, initial.revision);
  assert.equal((await store.readChapter(book.id, section.id, chapter.id)).plan.hook,
    '门后传来熟悉声音');
  await assert.rejects(
    () => store.saveChapterPlan(
      book.id, section.id, chapter.id, { goal: '旧页面目标' },
      { expectedRevision: initial.revision },
    ),
    /CHAPTER_PLAN_CONFLICT/,
  );
});

test('新版质量合同不能被旧页面静默降级', async () => {
  const { book, section, chapter } = await createTarget();
  const upgraded = await store.saveChapterPlan(
    book.id, section.id, chapter.id,
    { qualityProtocolVersion: 2, tensionArc: '压力来源：尚在编辑；变化链：甲局势形成→乙局势改变→丙局势落定；选择高点：主角必须决定；兑现与余波：决定留下后果' },
    { expectedRevision: chapterPlanRevision(chapter.plan) },
  );
  await assert.rejects(
    () => store.saveChapterPlan(book.id, section.id, chapter.id, {
      qualityProtocolVersion: 0,
      tensionArc: upgraded.tensionArc,
    }, { expectedRevision: upgraded.revision }),
    /CHAPTER_PLAN_QUALITY_DOWNGRADE/,
  );
  const backup = await store.createBookBackup(book.id);
  const importedBook = await store.importBookBackup(backup);
  const imported = await store.readChapter(importedBook.id, section.id, chapter.id);
  assert.equal(imported.plan.qualityProtocolVersion, 3);
});

test('叙事设计合同不能被旧页面静默降级或抹掉', async () => {
  const { book, section, chapter } = await createTarget();
  const decisionChain = '当前误判/未决：主角相信旧证件安全；验证/争取行动：主角主动刷证进入仓库；利益受损者：主管失去入口控制；针对性反制：主管冻结账户并封锁出口；状态改写：主角身份隐藏→主角入内但身份暴露；后续索债：主角必须在合围前带证人离开';
  const knowledgeDesign = '当前问题：旧证件是否安全；可见依据：闸机放行后报警；允许结论：证件已接入追踪；替代解释：证件被标记｜闸机规则升级；交叉验证：闸机日志＋巡逻终端；保留未知：不确认标记者';
  const upgraded = await store.saveChapterPlan(
    book.id, section.id, chapter.id,
    { designProtocolVersion: 1, decisionChain, knowledgeDesign },
    { expectedRevision: chapterPlanRevision(chapter.plan) },
  );
  assert.equal(upgraded.designProtocolVersion, 1);
  await assert.rejects(
    () => store.saveChapterPlan(book.id, section.id, chapter.id, {
      designProtocolVersion: 0, decisionChain, knowledgeDesign,
    }, { expectedRevision: upgraded.revision }),
    /CHAPTER_PLAN_DESIGN_DOWNGRADE/,
  );
  const preserved = await store.saveChapterPlan(book.id, section.id, chapter.id, {
    goal: '旧客户端只修改目标',
  }, { expectedRevision: upgraded.revision });
  assert.equal(preserved.designProtocolVersion, 1);
  assert.equal(preserved.decisionChain, decisionChain);
  assert.equal(preserved.knowledgeDesign, knowledgeDesign);
});

test('v2 认知边界合同不能被 v1 页面静默覆盖', async () => {
  const { book, section, chapter } = await createTarget();
  const upgraded = await store.saveChapterPlan(
    book.id, section.id, chapter.id,
    {
      qualityProtocolVersion: 2,
      worldExpansion: '展开前认知：主角与读者只知道本城封锁；既有依据：跨区制度；可验证证据：城外印章；边界增量/机制深化：主角与读者确认旧案跨区；选择与代价：主角越区并暴露身份；保留未知：上层组织',
    },
    { expectedRevision: chapterPlanRevision(chapter.plan) },
  );
  await assert.rejects(
    () => store.saveChapterPlan(book.id, section.id, chapter.id, {
      qualityProtocolVersion: 1,
      worldExpansion: upgraded.worldExpansion,
    }, { expectedRevision: upgraded.revision }),
    /CHAPTER_PLAN_QUALITY_DOWNGRADE/,
  );
  assert.equal((await store.readChapter(book.id, section.id, chapter.id))
    .plan.qualityProtocolVersion, 3);
});

test('策划变化会更新生成与审稿上下文，并拒绝按旧策划返回的迟到正文', async () => {
  const { book, section, chapter } = await createTarget();
  const generationBefore = await store.readChapterGenerationContext(
    book.id, section.id, chapter.id,
  );
  const reviewBefore = await store.readChapterReviewContext(
    book.id, section.id, chapter.id,
  );
  await store.saveChapterPlan(
    book.id, section.id, chapter.id,
    { goal: '迫使对手公开站队', choice: '主角主动公开证据', payoff: '盟友倒戈' },
    { expectedRevision: chapterPlanRevision(chapter.plan) },
  );
  const generationAfter = await store.readChapterGenerationContext(
    book.id, section.id, chapter.id,
  );
  const reviewAfter = await store.readChapterReviewContext(
    book.id, section.id, chapter.id,
  );
  assert.notEqual(generationAfter.contextRevision, generationBefore.contextRevision);
  assert.notEqual(reviewAfter.contextRevision, reviewBefore.contextRevision);
  await assert.rejects(
    () => store.commitGeneratedChapter(book.id, section.id, chapter.id, '旧策划正文', {
      expectedRevision: generationBefore.targetRevision,
      expectedContextRevision: generationBefore.contextRevision,
      expectedPreviousChapterId: generationBefore.previousChapterId,
      expectedPreviousChapterSectionId: generationBefore.previousChapterSectionId,
    }),
    /GENERATION_CONTEXT_CONFLICT/,
  );
  assert.equal(store.currentText(
    (await store.readChapter(book.id, section.id, chapter.id)).body,
  ), '');
});

test('上章未决项进入下章策划投影，源策划变化后精确失效', async () => {
  const { book, section, chapter: first } = await createTarget();
  const second = await store.addChapter(book.id, section.id, { title: '第二章' });
  await store.versionSet(
    book.id, `section:${section.id}:chapter:${first.id}`, '主角拿回账本，但印章只剩一半。',
  );
  await store.saveChapterPlan(book.id, section.id, first.id, {
    goal: '拿回账本', payoff: '根据完整印章锁定内鬼',
  }, { expectedRevision: chapterPlanRevision(first.plan) });
  const firstContext = await store.readChapterReviewContext(
    book.id, section.id, first.id,
  );
  await store.saveChapterReview(book.id, section.id, first.id, {
    score: 75, verdict: '目标完成，兑现未完',
    issues: [{ title: '印章不全', detail: '尚不能锁定内鬼' }],
    suggestions: [{ label: '追印章', instruction: '下章追查印章另一半' }],
    planComparison: {
      overall: 'partial', summary: '账本已取回，但内鬼证据仍缺失。',
      items: [
        { target: 'goal', outcome: 'fulfilled', evidence: '正文明写主角拿回账本。' },
        { target: 'payoff', outcome: 'missed', evidence: '印章只剩一半，无法锁定内鬼。' },
      ],
      carryovers: [{
        sourceTarget: 'payoff', text: '找到印章另一半并锁定内鬼',
        reason: '这是上章已建立但未完成的证据链。', suggestedField: 'goal',
      }],
    },
  }, {
    expectedBodyFingerprint: firstContext.chapter.bodyFingerprint,
    expectedContextRevision: firstContext.contextRevision,
  });

  const nextGeneration = await store.readChapterGenerationContext(
    book.id, section.id, second.id,
  );
  const nextReview = await store.readChapterReviewContext(
    book.id, section.id, second.id,
  );
  assert.equal(nextGeneration.incomingPlanCarryover.items[0].suggestedField, 'goal');
  assert.equal(nextReview.incomingPlanCarryover.sourceChapterId, first.id);
  const storedFirst = await store.readChapter(book.id, section.id, first.id);
  await store.saveChapterPlan(book.id, section.id, first.id, {
    goal: '拿回账本', payoff: '保住半枚印章即可',
  }, { expectedRevision: chapterPlanRevision(storedFirst.plan) });
  const after = await store.readChapterGenerationContext(
    book.id, section.id, second.id,
  );
  assert.equal(after.incomingPlanCarryover, null);
  assert.equal(after.contextRevision, nextGeneration.contextRevision);
  assert.notEqual(after.planDraftContextRevision, nextGeneration.planDraftContextRevision);
});

test('作品备份完整保留章节策划卡', async () => {
  const { book, section, chapter } = await createTarget();
  const saved = await store.saveChapterPlan(
    book.id, section.id, chapter.id,
    {
      goal: '夺回账册', notes: '账册不能在本章被烧毁',
      rhythmIntentVersion: 1,
      rhythmIntent: {
        pressurePattern: 'false-relief', resolutionMethod: 'cooperation',
        payoffScale: 'chapter', hookMechanism: 'unfinished-action', costType: 'position',
      },
      scenes: [{
        title: '库房对峙', desire: '双方都要账册', obstacle: '火势蔓延',
        action: '主角先救旧敌', turn: '旧敌交出账册', cost: '出口被火封死',
      }],
    },
    { expectedRevision: chapterPlanRevision(chapter.plan) },
  );
  await store.versionSet(
    book.id, `section:${section.id}:chapter:${chapter.id}`,
    '主角先救下旧敌，旧敌因此交出账册，但火势封住了出口。',
  );
  const reviewContext = await store.readChapterReviewContext(
    book.id, section.id, chapter.id,
  );
  await store.saveChapterReview(book.id, section.id, chapter.id, {
    score: 80, verdict: '主体策划落地',
    issues: [{ title: '线索待处理', detail: '账册仍需后续核对' }],
    suggestions: [{ label: '补线索', instruction: '下章核对账册的涂改页' }],
    planComparison: {
      overall: 'partial', summary: '主要行动落地，账册线索待续。',
      items: [
        { target: 'goal', outcome: 'fulfilled', evidence: '旧敌已交出账册。' },
        { target: 'notes', outcome: 'fulfilled', evidence: '账册在正文中完好保留。' },
        { target: 'scene-1', outcome: 'fulfilled', evidence: '救人、交账册与火封出口形成完整因果。' },
        { target: 'rhythmIntent', outcome: 'fulfilled', evidence: '假缓和后以合作取得章级兑现。' },
      ],
      carryovers: [],
    },
  }, {
    expectedBodyFingerprint: reviewContext.chapter.bodyFingerprint,
    expectedContextRevision: reviewContext.contextRevision,
  });
  const backup = await store.createBookBackup(book.id);
  assert.equal(backup.sections[0].chapters[0].plan.goal, saved.goal);
  const importedBook = await store.importBookBackup(backup);
  const imported = await store.readChapter(importedBook.id, section.id, chapter.id);
  assert.equal(imported.plan.goal, '夺回账册');
  assert.equal(imported.plan.notes, '账册不能在本章被烧毁');
  assert.equal(imported.plan.scenes[0].cost, '出口被火封死');
  assert.equal(imported.plan.rhythmIntentVersion, 1);
  assert.deepEqual(imported.plan.rhythmIntent, saved.rhythmIntent);
  assert.equal(imported.review.planComparison.overall, 'partial');
  assert.equal(imported.review.planComparison.items[2].target, 'scene-1');
  assert.equal(imported.review.sourcePlanRevision, chapterPlanRevision(imported.plan));
});

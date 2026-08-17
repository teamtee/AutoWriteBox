import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAPTER_PLAN_QUALITY_FORMATS, chapterPlanContinuityDiagnostics,
  chapterPlanContinuityLedger, chapterPlanDesignDiagnostics,
  chapterPlanQualityDiagnostics,
} from '../chapter-plan-quality.js';
import { validChapterPlanFixture } from './chapter-plan-fixture.js';

test('连续性账本把前章状态、已知结论、已用证据和反制显式交给后章', () => {
  const ledger = chapterPlanContinuityLedger(validChapterPlanFixture());
  assert.equal(ledger.startState, '主角持有隐蔽通路');
  assert.equal(ledger.endState, '主角打开通路但位置暴露');
  assert.match(ledger.actionAlreadyTaken, /主动刷旧凭证/);
  assert.match(ledger.opponentCounteraction, /启动跨区追踪/);
  assert.match(ledger.unresolvedDebt, /追踪合围前/);
  assert.equal(ledger.conclusionAlreadyKnown, '凭证仍能开门但已被中央追踪');
  assert.equal(ledger.evidenceAlreadyUsed.length, 2);
  assert.match(ledger.payoffAlreadyDelivered, /新代价/);
  assert.match(ledger.hookAlreadyUsed, /未完后果/);
});

test('连续性账本拒绝无效或旧版半成品策划', () => {
  assert.equal(chapterPlanContinuityLedger({ goal: '只有目标' }), null);
});

test('确定性跨章门禁拒绝原样重复结论、证据、反制、兑现、钩子和状态复位', () => {
  const plan = validChapterPlanFixture();
  const diagnostics = chapterPlanContinuityDiagnostics(plan, plan);
  assert.equal(diagnostics.active, true);
  assert.equal(diagnostics.valid, false);
  const ids = diagnostics.risks.map((risk) => risk.id);
  assert.ok(ids.includes('repeated-known-conclusion'));
  assert.ok(ids.includes('repeated-evidence-package'));
  assert.ok(ids.includes('repeated-counteraction'));
  assert.ok(ids.includes('repeated-payoff'));
  assert.ok(ids.includes('repeated-hook'));
  assert.ok(ids.includes('state-reset'));
});

test('确定性跨章门禁接受承接前章末态且使用新行动、新证据和新兑现的计划', () => {
  const previous = validChapterPlanFixture();
  const next = validChapterPlanFixture({
    rhythmIntent: {
      pressurePattern: 'choice-led', resolutionMethod: 'sacrifice',
      payoffScale: 'stage', hookMechanism: 'forced-choice', costType: 'resource',
    },
    payoff: '主角取得第二份独立记录但失去旧凭证',
    hook: '旧凭证被对手公开作废，迫使主角转向证人保护',
    decisionChain: '当前误判/未决：主角以为暴露位置后仍可保留旧凭证；验证/争取行动：主角用旧凭证换取第二份纸质记录；利益受损者：负责人失去对纸质副本的控制；针对性反制：负责人公开注销凭证并追查副本流向；状态改写：主角打开通路但位置暴露→主角取得记录但旧凭证永久失效；后续索债：主角必须保护交出副本的证人',
    knowledgeDesign: '当前问题：第二份记录能否独立证明闸机警报被事后补写；可见依据：纸质交班簿的原始时间早于巡逻终端警报；允许结论：警报时间至少被有权限者事后修改；替代解释：终端时钟故障｜值班人补录延迟；交叉验证：纸质交班簿＋值班人签字时间；保留未知：不确认是谁修改以及修改目的',
  });
  const diagnostics = chapterPlanContinuityDiagnostics(previous, next);
  assert.equal(diagnostics.valid, true);
  assert.equal(diagnostics.checks.startAnchored, true);
  assert.equal(diagnostics.checks.rhythmRepeated, false);
});

test('章节质量合同拒绝结构词、原样示例和乱序标签', () => {
  const vague = chapterPlanQualityDiagnostics({
    tensionArc: '压力来源：更紧张；变化链：受阻→希望→反转；选择高点：选择；兑现与余波：余波',
    foreshadowing: CHAPTER_PLAN_QUALITY_FORMATS.foreshadowing,
    worldExpansion: '可验证证据：城外印章；既有依据：跨区制度；边界增量/机制深化：旧案跨区；选择与代价：主角越区被追捕；保留未知：幕后人身份',
  });
  assert.equal(vague.valid, false);
  assert.equal(vague.tension.chainValid, false);
  assert.ok(vague.foreshadowing.thinLabels.length > 0);
  assert.equal(vague.worldExpansion.orderValid, false);

  const malformed = chapterPlanQualityDiagnostics({
    tensionArc: '说明：压力来源：封站；变化链：闸机关闭→主角破门→警报响起；选择高点：主角继续潜入；兑现与余波：进入站台但暴露',
    foreshadowing: '旧线/阅读债务：推进内鬼线；具体载体：车票；当下作用：验证身份；行动影响：主角改道；保留未知：内鬼身份；具体载体：印章',
    worldExpansion: '既有依据：封锁制度；可验证证据：城外印章；边界增量/机制深化：确认跨区；选择与代价：越区受追捕；保留未知：上层组织',
  });
  assert.equal(malformed.tension.prefixValid, false);
  assert.deepEqual(malformed.foreshadowing.duplicateLabels, ['具体载体']);
  assert.equal(malformed.valid, false);
});

test('章节质量合同接受由证据、行动和后果组成的具体计划', () => {
  const result = chapterPlanQualityDiagnostics({
    qualityProtocolVersion: 2,
    tensionArc: '压力来源：封站倒计时逼近；变化链：假证暂时通过闸机→旧友复核使假证失效→主角公开身份引走守卫；选择高点：主角用暴露换取证人通路；兑现与余波：证人现身但追捕系统重新锁定主角',
    foreshadowing: '旧线/阅读债务：推进内鬼线；具体载体：缺角车票；当下作用：证明求救者身份；行动影响：主角改去货厢追人；保留未知：不揭示内鬼姓名',
    worldExpansion: '展开前认知：主角与读者只知道本城封锁，尚不知道旧案跨区；既有依据：既有跨区封锁制度；可验证证据：城外检票孔；边界增量/机制深化：主角与读者确认旧案跨城运作；选择与代价：主角携证据越区且失去假身份；保留未知：不揭示上层组织',
  });
  assert.equal(result.valid, true);
  assert.equal(result.tension.chainCount, 3);
});

test('v3 张力合同拒绝三个并列事故冒充跌宕，保留旧协议兼容', () => {
  const parallel = {
    qualityProtocolVersion: 3,
    tensionArc: '压力来源：主角必须在封站前找到证人；变化链：陌生乘客突然闯入站台→另一名守卫突然拔枪封门→货厢又突然传来爆炸声；选择高点：主角必须决定救人还是追证人；兑现与余波：主角救下乘客但错过证人',
    foreshadowing: '无埋点理由：本章专注封站追捕，不额外制造谜团；本章聚焦：主角在追人与救人之间主动选择；既有未知处理：内鬼身份保持未知，不新增假证据',
    worldExpansion: '展开前认知：主角与读者只知道站台执行本城封锁；既有依据：既有封站制度；可验证证据：守卫使用跨区警报器；边界增量/机制深化：确认车站受跨区系统调度；选择与代价：主角救人并暴露身份；保留未知：不揭示调度者',
  };
  const rejected = chapterPlanQualityDiagnostics(parallel);
  assert.equal(rejected.tension.parallelIncidentRisk, true);
  assert.equal(rejected.tension.chainValid, false);
  assert.equal(rejected.valid, false);

  const causal = chapterPlanQualityDiagnostics({
    ...parallel,
    tensionArc: '压力来源：主角必须在封站前找到证人；变化链：主角出示假证暂时通过闸机→假证触发旧档案使守卫转而封锁货厢→封锁迫使主角公开身份引走守卫；选择高点：主角必须用身份暴露换取证人通路；兑现与余波：证人现身但追捕系统锁定主角',
  });
  assert.equal(causal.tension.parallelIncidentRisk, false);
  assert.ok(causal.tension.causalTransitionCount >= 1);
  assert.equal(causal.valid, true);

  assert.equal(chapterPlanQualityDiagnostics({
    ...parallel, qualityProtocolVersion: 2,
  }).tension.chainValid, true);
});

test('叙事设计合同要求人物行动引发针对性反制并改写状态', () => {
  const result = chapterPlanDesignDiagnostics({
    decisionChain: '当前误判/未决：主角相信旧证件仍未暴露；验证/争取行动：主角主动刷证件进入封锁站台；利益受损者：内务主管失去对秘密出口的控制；针对性反制：主管依据本次刷卡签名封锁货厢并冻结主角账户；状态改写：主角拥有隐蔽身份和补给→主角进入站台但身份暴露且账户冻结；后续索债：主角必须在追捕到来前带证人离开',
    knowledgeDesign: '当前问题：旧证件是否仍是安全资源；可见依据：闸机先放行后同步身份警报；允许结论：证件还能开门但已接入中央追踪；替代解释：证件此前已被标记｜本次闸机升级了统一审计；交叉验证：闸机日志＋巡逻终端同一警报编号；保留未知：不确认是谁下令标记证件',
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.decision.stateChange, {
    before: '主角拥有隐蔽身份和补给',
    after: '主角进入站台但身份暴露且账户冻结',
  });
  assert.equal(result.knowledge.alternativeCount, 2);
  assert.equal(result.knowledge.crossValidationCount, 2);
});

test('叙事设计合同拒绝唯一解释、单一证据和没有前后状态的模板', () => {
  const result = chapterPlanDesignDiagnostics({
    decisionChain: CHAPTER_PLAN_QUALITY_FORMATS.decisionChain,
    knowledgeDesign: '当前问题：谁动了档案；可见依据：匿名短信；允许结论：赵主管就是凶手；替代解释：赵主管作案；交叉验证：匿名短信；保留未知：暂无',
  });
  assert.equal(result.valid, false);
  assert.equal(result.decision.valid, false);
  assert.equal(result.knowledge.alternativeCount, 1);
  assert.equal(result.knowledge.crossValidationCount, 1);
});

test('无认知任务合同允许余波章不硬造谜团，但仍要求决策后果', () => {
  const result = chapterPlanDesignDiagnostics({
    decisionChain: '当前误判/未决：主角以为道歉足以恢复合作；验证/争取行动：主角当众交还证物并承认违规；利益受损者：搭档失去继续隐瞒违规的安全空间；针对性反制：搭档拒绝私下和解并要求书面停职；状态改写：两人仍维持私人合作→搭档退出且主角被停职；后续索债：主角必须在没有内部权限时独自保护证人',
    knowledgeDesign: '无认知任务理由：上一章刚完成关键揭示，本章先消费关系与职业后果；本章聚焦：主角承担违规取证造成的停职和决裂；既有判断处理：凶手身份与证物来源保持原有未知，不新增证据也不提前确认',
  });
  assert.equal(result.valid, true);
  assert.equal(result.knowledge.mode, 'none');
});

test('v1 世界合同继续兼容，v2 必须给出展开前认知基线', () => {
  const worldExpansion = '既有依据：跨区封锁制度；可验证证据：城外检票孔；边界增量/机制深化：旧案确认跨城运作；选择与代价：主角越区且失去假身份；保留未知：不揭示上层组织';
  assert.equal(chapterPlanQualityDiagnostics({
    qualityProtocolVersion: 1,
    tensionArc: '压力来源：封站倒计时；变化链：闸机关闭→主角破门→警报响起；选择高点：主角继续潜入；兑现与余波：进入站台但暴露',
    foreshadowing: '旧线/阅读债务：推进内鬼线；具体载体：烧焦的旧车票；当下作用：验证身份；行动影响：主角改道；保留未知：内鬼身份',
    worldExpansion,
  }).valid, true);
  const upgraded = chapterPlanQualityDiagnostics({
    qualityProtocolVersion: 2,
    tensionArc: '压力来源：封站倒计时；变化链：闸机关闭→主角破门→警报响起；选择高点：主角继续潜入；兑现与余波：进入站台但暴露',
    foreshadowing: '旧线/阅读债务：推进内鬼线；具体载体：烧焦的旧车票；当下作用：验证身份；行动影响：主角改道；保留未知：内鬼身份',
    worldExpansion,
  });
  assert.equal(upgraded.valid, false);
  assert.deepEqual(upgraded.worldExpansion.missingLabels, ['展开前认知']);
});

test('没有埋点任务时接受具体聚焦合同，不强迫每章硬造新谜团', () => {
  const result = chapterPlanQualityDiagnostics({
    qualityProtocolVersion: 2,
    tensionArc: '压力来源：旧友要求主角当众归还赃物；变化链：主角交出赃物换来短暂停火→旧友发现赃物已损坏而拒绝和解→主角承担赔偿并主动离队；选择高点：主角必须在辩解与承担关系代价之间选择；兑现与余波：旧账当场结清但主角失去队伍庇护',
    foreshadowing: '无埋点理由：本章先兑现主角与旧友决裂的直接后果，避免在情绪落点前另开谜团；本章聚焦：主角主动归还赃物并承受失去盟友的关系代价；既有未知处理：内鬼身份与车票来源维持既有未知，本章不新增证据也不提前揭示',
    worldExpansion: '展开前认知：主角与读者已经知道离队者会被收回通行牌；既有依据：队伍既有的担保制度；可验证证据：旧友当场注销主角通行牌；边界增量/机制深化：读者看到担保制度会连带冻结住宿与补给；选择与代价：主角仍选择离队并失去当夜住处；保留未知：不展开制度背后的城政派系',
  });
  assert.equal(result.valid, true);
  assert.equal(result.foreshadowing.mode, 'none');

  const emptyTemplate = chapterPlanQualityDiagnostics({
    ...result,
    foreshadowing: '无埋点理由：为什么本章不推进、兑现或建立阅读债务；本章聚焦：本章把注意力用在哪项行动、关系或兑现上；既有未知处理：哪些既有未知保持原状态，既不假装推进也不提前揭示',
  });
  assert.equal(emptyTemplate.foreshadowing.valid, false);
});

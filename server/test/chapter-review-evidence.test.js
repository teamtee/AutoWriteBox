import test from 'node:test';
import assert from 'node:assert/strict';
import { extractChapterReview } from '../llm.js';
import { CHAPTER_REVIEW_CHECK_IDS } from '../chapter-review-schema.js';
import { MAX_VERSION_TEXT_CHARS } from '../limits.js';

const reviewChecks = (proseHumanity, payoffEvidence) => CHAPTER_REVIEW_CHECK_IDS.map((id) => ({
  id,
  status: id === 'proseHumanity' ? proseHumanity.status : 'pass',
  detail: id === 'proseHumanity' ? proseHumanity.detail : `${id} 的正文依据`,
  ...(id === 'proseHumanity' && proseHumanity.evidence
    ? { evidence: proseHumanity.evidence } : {}),
  ...(id === 'payoff' && payoffEvidence ? { payoffEvidence } : {}),
}));

const reviewPayload = (proseHumanity, payoffEvidence, options = {}) => {
  const incrementEvidence = Object.prototype.hasOwnProperty.call(options, 'incrementEvidence')
    ? options.incrementEvidence
    : payoffEvidence
      ? { triggerQuote: payoffEvidence.actionQuote, stateQuote: payoffEvidence.resultQuote }
      : undefined;
  const obstacleEvidence = Object.prototype.hasOwnProperty.call(options, 'obstacleEvidence')
    ? options.obstacleEvidence
    : payoffEvidence
      ? { baseQuote: payoffEvidence.actionQuote, escalatedQuote: payoffEvidence.resultQuote }
      : undefined;
  const choiceEvidence = Object.prototype.hasOwnProperty.call(options, 'choiceEvidence')
    ? options.choiceEvidence
    : payoffEvidence
      ? { pressureQuote: payoffEvidence.actionQuote, choiceQuote: payoffEvidence.resultQuote }
      : undefined;
  const goldenEvidence = Object.prototype.hasOwnProperty.call(options, 'goldenEvidence')
    ? options.goldenEvidence
    : undefined;
  const premiseEvidence = Object.prototype.hasOwnProperty.call(options, 'premiseEvidence')
    ? options.premiseEvidence
    : payoffEvidence
      ? { promiseQuote: payoffEvidence.actionQuote, deliveryQuote: payoffEvidence.resultQuote }
      : undefined;
  const goalEvidence = Object.prototype.hasOwnProperty.call(options, 'goalEvidence')
    ? options.goalEvidence
    : payoffEvidence
      ? { goalQuote: payoffEvidence.actionQuote, attemptQuote: payoffEvidence.resultQuote }
      : undefined;
  const longArcEvidence = Object.prototype.hasOwnProperty.call(options, 'longArcEvidence')
    ? options.longArcEvidence
    : payoffEvidence
      ? { threadQuote: payoffEvidence.actionQuote, progressQuote: payoffEvidence.resultQuote }
      : undefined;
  const tensionEvidence = Object.prototype.hasOwnProperty.call(options, 'tensionEvidence')
    ? options.tensionEvidence
    : undefined;
  const sceneEvidence = Object.prototype.hasOwnProperty.call(options, 'sceneEvidence')
    ? options.sceneEvidence
    : payoffEvidence
      ? (() => {
        const chars = Array.from(payoffEvidence.resultQuote);
        const middle = Math.max(1, Math.floor(chars.length / 2));
        return {
          actionQuote: payoffEvidence.actionQuote,
          reactionQuote: chars.slice(0, middle).join(''),
          turnQuote: chars.slice(middle).join(''),
        };
      })()
      : undefined;
  return {
  score: 68,
  verdict: '模板转折削弱现场感',
  webFictionSignals: options.webFictionSignals,
  webFictionChecks: reviewChecks(proseHumanity, payoffEvidence).map((item) => {
    if (item.id === 'goldenChapter') {
      if (Object.prototype.hasOwnProperty.call(options, 'goldenEvidence')) {
        return goldenEvidence ? { ...item, goldenEvidence } : item;
      }
      return { ...item, status: 'na', detail: '本用例按非全书前三章处理。' };
    }
    if (item.id === 'premisePromise') {
      if (Object.prototype.hasOwnProperty.call(options, 'premiseEvidence')) {
        return premiseEvidence ? { ...item, premiseEvidence } : item;
      }
      return premiseEvidence
        ? { ...item, premiseEvidence }
        : { ...item, status: 'risk', detail: '本用例不声明核心卖点兑现。' };
    }
    if (item.id === 'chapterGoal' && goalEvidence) {
      return { ...item, goalEvidence };
    }
    if (item.id === 'obstacleEscalation' && obstacleEvidence) {
      return { ...item, obstacleEvidence };
    }
    if (item.id === 'sceneExecution' && sceneEvidence) {
      return { ...item, sceneEvidence };
    }
    if (item.id === 'effectiveIncrement' && incrementEvidence) {
      return { ...item, incrementEvidence };
    }
    if (item.id === 'characterChoice') {
      return {
        ...item,
        ...(choiceEvidence ? { choiceEvidence } : {}),
        ...(options.costEvidence ? { costEvidence: options.costEvidence } : {}),
      };
    }
    if (item.id === 'tensionDynamics') {
      if (Object.prototype.hasOwnProperty.call(options, 'tensionEvidence')) {
        return tensionEvidence ? { ...item, tensionEvidence } : item;
      }
      return { ...item, status: 'risk', detail: '本用例不声明张力起伏通过。' };
    }
    if (item.id === 'endingHook' && options.hookEvidence) {
      return { ...item, hookEvidence: options.hookEvidence };
    }
    if (item.id === 'longArcProgress' && longArcEvidence) {
      return { ...item, longArcEvidence };
    }
    return item;
  }),
  issues: [{ title: '模板句', detail: '转折由作者总结代替人物即时反应。' }],
  suggestions: [{ label: '改现场反应', instruction: '把判断改成人物动作与感官反应。' }],
  };
};

test('extractChapterReview 要求自然人感风险引用当前正文连续原文', () => {
  const chapterContent = '他停在门口。不是因为害怕，而是因为风里有血腥味。门后传来第二声敲击。';
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload({
    status: 'risk', detail: '使用“不是……而是……”替读者总结。',
    evidence: '正文里并不存在的模型引文',
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload({
    status: 'risk', detail: '只写有 AI 味但没有正文引文。',
  })), { chapterContent }), null);
  const evidence = '不是因为害怕，而是因为风里有血腥味。';
  const parsed = extractChapterReview(JSON.stringify(reviewPayload({
    status: 'risk', detail: '模板转折直接解释人物判断。', evidence,
  }, {
    actionQuote: '他停在门口。', resultQuote: '门后传来第二声敲击。',
  })), { chapterContent });
  assert.equal(parsed.webFictionChecks.find((item) => item.id === 'proseHumanity').evidence,
    evidence);
});

test('extractChapterReview 要求正文引文足够长且在当前章唯一定位', () => {
  const chapterContent = '他推门进去，先看见桌上的血迹。后来他再次推门进去，却发现血迹消失了。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '他推门进去，先看见桌上的血迹。',
    resultQuote: '后来他再次推门进去，却发现血迹消失了。',
  };
  const payload = reviewPayload(prose, payoff);
  payload.webFictionChecks = payload.webFictionChecks.map((item) => item.id === 'contentRisk'
    ? { ...item, evidence: '推门进去' } : item);
  assert.equal(extractChapterReview(JSON.stringify(payload), { chapterContent }), null);
  payload.webFictionChecks = payload.webFictionChecks.map((item) => item.id === 'contentRisk'
    ? { ...item, evidence: '他推门进去，先看见桌上的血迹。' } : item);
  assert.ok(extractChapterReview(JSON.stringify(payload), { chapterContent }));
  const repeated = `${payoff.actionQuote}${payoff.actionQuote}${payoff.resultQuote}`;
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff)), {
    chapterContent: repeated,
  }), null);
});

test('extractChapterReview 拒绝超长引文而不是截断成正文前缀', () => {
  const chapterContent = `${'甲'.repeat(120)}正文结尾继续展开。尾声补充。`;
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = { actionQuote: '甲'.repeat(120), resultQuote: '正文结尾继续展开。' };
  const payload = reviewPayload(prose, payoff);
  payload.webFictionChecks = payload.webFictionChecks.map((item) => item.id === 'contentRisk'
    ? { ...item, evidence: '甲'.repeat(121) } : item);
  assert.equal(extractChapterReview(JSON.stringify(payload), { chapterContent }), null);
  payload.webFictionChecks = payload.webFictionChecks.map((item) => item.id === 'contentRisk'
    ? { ...item, evidence: '甲'.repeat(120) } : item);
  assert.ok(extractChapterReview(JSON.stringify(payload), { chapterContent }));
});

test('extractChapterReview 拒绝任意检查项携带虚构通用引文', () => {
  const chapterContent = '守卫扣住通行证，站台随即封锁并停止所有列车通行。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '守卫扣住通行证，', resultQuote: '站台随即封锁并停止所有列车通行。',
  };
  const payload = reviewPayload(prose, payoff);
  payload.webFictionChecks = payload.webFictionChecks.map((item) => item.id === 'contentRisk'
    ? { ...item, evidence: '模型虚构的通用风险引文' } : item);
  assert.equal(extractChapterReview(JSON.stringify(payload), { chapterContent }), null);
  payload.webFictionChecks = payload.webFictionChecks.map((item) => item.id === 'contentRisk'
    ? { ...item, evidence: '站台随即封锁并停止所有列车通行。' } : item);
  assert.ok(extractChapterReview(JSON.stringify(payload), { chapterContent }));
});

test('extractChapterReview 要求表达类风险引用当前正文连续原文', () => {
  const chapterContent = '他解释了三遍计划。她也解释了三遍计划。众人继续解释计划。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '他解释了三遍计划。',
    resultQuote: '她也解释了三遍计划。众人继续解释计划。',
  };
  const riskIds = ['expressionBalance', 'repetitionRisk', 'styleConsistency'];
  for (const id of riskIds) {
    const payload = reviewPayload(prose, payoff);
    payload.webFictionChecks = payload.webFictionChecks.map((item) => item.id === id
      ? { ...item, status: 'risk', detail: `${id} 风险`, evidence: '他解释了三遍计划。' }
      : item);
    assert.ok(extractChapterReview(JSON.stringify(payload), { chapterContent }));
    payload.webFictionChecks = payload.webFictionChecks.map((item) => item.id === id
      ? { ...item, evidence: '模型虚构的表达风险原句' } : item);
    assert.equal(extractChapterReview(JSON.stringify(payload), { chapterContent }), null);
    payload.webFictionChecks = payload.webFictionChecks.map((item) => item.id === id
      ? { id: item.id, status: item.status, detail: item.detail } : item);
    assert.equal(extractChapterReview(JSON.stringify(payload), { chapterContent }), null);
  }
});

test('extractChapterReview 要求有效兑现引用先行动后结果的正文证据', () => {
  const chapterContent = '主角撕掉伪造通行证，主动把真名报给守卫。闸门随后打开，失踪证人从货厢走出。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const actionQuote = '主角撕掉伪造通行证，主动把真名报给守卫。';
  const resultQuote = '闸门随后打开，失踪证人从货厢走出。';
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, {
    actionQuote, resultQuote,
  })), { chapterContent }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, {
    actionQuote: '模型虚构的主动行动', resultQuote,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, {
    actionQuote: resultQuote, resultQuote: actionQuote,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose)), {
    chapterContent,
  }), null);
});

test('extractChapterReview 要求非 none 代价引用先选择后后果的正文证据', () => {
  const chapterContent = '孩子和通行牌只能保住一个。她把唯一的通行牌交给孩子，选择留下断后。闸门落下，她从此失去离城资格。';
  const signals = {
    chapterFunction: '冲突推进', conflictType: '追捕', emotionTone: '决绝',
    payoffType: '救人', dominantMode: '行动', rhythmFingerprint: {
      pressurePattern: 'choice-led', resolutionMethod: 'sacrifice', payoffScale: 'chapter',
      hookMechanism: 'none', costType: 'position',
    },
  };
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '孩子和通行牌只能保住一个。',
    resultQuote: '闸门落下，她从此失去离城资格。',
  };
  const choiceQuote = '她把唯一的通行牌交给孩子，选择留下断后。';
  const choiceEvidence = { pressureQuote: payoff.actionQuote, choiceQuote };
  const costEvidence = { choiceQuote, consequenceQuote: payoff.resultQuote };
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    webFictionSignals: signals, choiceEvidence, costEvidence,
  })), { chapterContent }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    webFictionSignals: signals, choiceEvidence,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    webFictionSignals: signals, choiceEvidence,
    costEvidence: { choiceQuote: payoff.actionQuote, consequenceQuote: payoff.resultQuote },
  })), { chapterContent }), null);
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    webFictionSignals: {
      ...signals, rhythmFingerprint: { ...signals.rhythmFingerprint, costType: 'none' },
    }, choiceEvidence,
  })), { chapterContent }));
});

test('extractChapterReview 要求非 none 章尾钩子引用先铺垫后牵引的正文证据', () => {
  const chapterContent = '账本最后一页反复出现同一个港口编号。她合上账本时，门外的人低声报出了那个编号。';
  const signals = {
    chapterFunction: '线索推进', conflictType: '调查', emotionTone: '警觉',
    payoffType: '信息揭示', dominantMode: '调查', rhythmFingerprint: {
      pressurePattern: 'aftermath', resolutionMethod: 'discovery', payoffScale: 'micro',
      hookMechanism: 'new-information', costType: 'none',
    },
  };
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '账本最后一页反复出现同一个港口编号。',
    resultQuote: '她合上账本时，门外的人低声报出了那个编号。',
  };
  const hookEvidence = { setupQuote: payoff.actionQuote, hookQuote: payoff.resultQuote };
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    webFictionSignals: signals, hookEvidence,
  })), { chapterContent }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    webFictionSignals: signals,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    webFictionSignals: signals,
    hookEvidence: { setupQuote: payoff.resultQuote, hookQuote: payoff.actionQuote },
  })), { chapterContent }), null);
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    webFictionSignals: {
      ...signals, rhythmFingerprint: { ...signals.rhythmFingerprint, hookMechanism: 'none' },
    },
  })), { chapterContent }));
});

test('extractChapterReview 要求有效增量引用先触发后新状态的正文证据', () => {
  const chapterContent = '她把锈钥匙插进旧柜，找到一份未销毁的航线表。从这一刻起，队伍确认失踪船仍在城内河道活动。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '她把锈钥匙插进旧柜，找到一份未销毁的航线表。',
    resultQuote: '从这一刻起，队伍确认失踪船仍在城内河道活动。',
  };
  const incrementEvidence = {
    triggerQuote: payoff.actionQuote, stateQuote: payoff.resultQuote,
  };
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    incrementEvidence,
  })), { chapterContent }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    incrementEvidence: null,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    incrementEvidence: {
      triggerQuote: payoff.resultQuote, stateQuote: payoff.actionQuote,
    },
  })), { chapterContent }), null);
});

test('extractChapterReview 要求阻碍升级引用先门槛后更难局面的正文证据', () => {
  const chapterContent = '守卫先扣住通行证，要求她当场说明货物来源。她亮出商会印章后，守卫反而封锁整节货厢并开始逐箱搜查。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '守卫先扣住通行证，要求她当场说明货物来源。',
    resultQuote: '她亮出商会印章后，守卫反而封锁整节货厢并开始逐箱搜查。',
  };
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff)), {
    chapterContent,
  }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    obstacleEvidence: null,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    obstacleEvidence: {
      baseQuote: payoff.resultQuote, escalatedQuote: payoff.actionQuote,
    },
  })), { chapterContent }), null);
});

test('extractChapterReview 要求人物选择引用先取舍压力后主动决定的正文证据', () => {
  const chapterContent = '救证人会暴露盟友，保住盟友就只能放走证人。她最终烧掉藏身地址，转身去救证人。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '救证人会暴露盟友，保住盟友就只能放走证人。',
    resultQuote: '她最终烧掉藏身地址，转身去救证人。',
  };
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff)), {
    chapterContent,
  }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    choiceEvidence: null,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    choiceEvidence: {
      pressureQuote: payoff.resultQuote, choiceQuote: payoff.actionQuote,
    },
  })), { chapterContent }), null);
});

test('extractChapterReview 要求关键场景引用行动反应转折的有序正文证据', () => {
  const chapterContent = '她把账本拍在桌上。证人看见签名后立刻后退。守卫因此转身锁住唯一出口。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '她把账本拍在桌上。', resultQuote: '守卫因此转身锁住唯一出口。',
  };
  const sceneEvidence = {
    actionQuote: payoff.actionQuote,
    reactionQuote: '证人看见签名后立刻后退。',
    turnQuote: payoff.resultQuote,
  };
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    sceneEvidence,
  })), { chapterContent }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    sceneEvidence: null,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    sceneEvidence: {
      actionQuote: sceneEvidence.turnQuote,
      reactionQuote: sceneEvidence.reactionQuote,
      turnQuote: sceneEvidence.actionQuote,
    },
  })), { chapterContent }), null);
});

test('extractChapterReview 要求章节目标引用先人物目标后具体尝试的正文证据', () => {
  const chapterContent = '她今晚必须在换岗前找到失踪证人。她沿着血迹逐间敲开仓库的门。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '她今晚必须在换岗前找到失踪证人。',
    resultQuote: '她沿着血迹逐间敲开仓库的门。',
  };
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff)), {
    chapterContent,
  }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    goalEvidence: null,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    goalEvidence: {
      goalQuote: payoff.resultQuote, attemptQuote: payoff.actionQuote,
    },
  })), { chapterContent }), null);
});

test('extractChapterReview 要求长线推进引用先触及旧线后形成持续进展的正文证据', () => {
  const chapterContent = '失踪名单上再次出现父亲留下的三角印记。她据此锁定下一艘入港船，并约定黎明前登船核查。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '失踪名单上再次出现父亲留下的三角印记。',
    resultQuote: '她据此锁定下一艘入港船，并约定黎明前登船核查。',
  };
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff)), {
    chapterContent,
  }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    longArcEvidence: null,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    longArcEvidence: {
      threadQuote: payoff.resultQuote, progressQuote: payoff.actionQuote,
    },
  })), { chapterContent }), null);
});

test('extractChapterReview 要求张力起伏引用压力变化余波的有序正文证据', () => {
  const chapterContent = '守卫开始逐箱搜查，藏匿者只剩一扇死窗。她故意打翻油灯引开两名守卫，货厢短暂空出通道。警铃却因烟雾响起，整座站台随即封锁。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '守卫开始逐箱搜查，藏匿者只剩一扇死窗。',
    resultQuote: '警铃却因烟雾响起，整座站台随即封锁。',
  };
  const tensionEvidence = {
    pressureQuote: payoff.actionQuote,
    shiftQuote: '她故意打翻油灯引开两名守卫，货厢短暂空出通道。',
    aftermathQuote: payoff.resultQuote,
  };
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    tensionEvidence,
  })), { chapterContent }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    tensionEvidence: null,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    tensionEvidence: {
      pressureQuote: tensionEvidence.aftermathQuote,
      shiftQuote: tensionEvidence.shiftQuote,
      aftermathQuote: tensionEvidence.pressureQuote,
    },
  })), { chapterContent }), null);
});

test('extractChapterReview 要求核心卖点引用先机制运转后相关回报的正文证据', () => {
  const chapterContent = '她把敌人的谎言写进账本，账页立刻浮出一条可核验的银线。循着银线，她当场找出藏在仓底的失踪货物。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '她把敌人的谎言写进账本，账页立刻浮出一条可核验的银线。',
    resultQuote: '循着银线，她当场找出藏在仓底的失踪货物。',
  };
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff)), {
    chapterContent,
  }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    premiseEvidence: null,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    premiseEvidence: {
      promiseQuote: payoff.resultQuote, deliveryQuote: payoff.actionQuote,
    },
  })), { chapterContent }), null);
});

test('extractChapterReview 要求黄金章引用先职责起点后首次展示升级兑现', () => {
  const chapterContent = '第一夜，欠债人当众撕毁契约，把她赶出唯一的住处。她启用识谎账本，当场从契约灰烬里还原出幕后债主的名字。';
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const payoff = {
    actionQuote: '第一夜，欠债人当众撕毁契约，把她赶出唯一的住处。',
    resultQuote: '她启用识谎账本，当场从契约灰烬里还原出幕后债主的名字。',
  };
  const goldenEvidence = {
    setupQuote: payoff.actionQuote, fulfillmentQuote: payoff.resultQuote,
  };
  assert.ok(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    goldenEvidence,
  })), { chapterContent }));
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    goldenEvidence: null,
  })), { chapterContent }), null);
  assert.equal(extractChapterReview(JSON.stringify(reviewPayload(prose, payoff, {
    goldenEvidence: {
      setupQuote: payoff.resultQuote, fulfillmentQuote: payoff.actionQuote,
    },
  })), { chapterContent }), null);
});

test('接近正文上限的多证据审稿仍保持有界解析时间', { timeout: 2000 }, () => {
  const prefix = '普通叙述填充。'.repeat(Math.floor((MAX_VERSION_TEXT_CHARS - 200) / 7));
  const actionQuote = '她在正文末端明确选择打开最后一道门。';
  const resultQuote = '门后证人交出名单，局势从搜寻转为追捕。';
  const chapterContent = `${prefix}${actionQuote}${resultQuote}`;
  const prose = { status: 'pass', detail: '未见成片同构表达。' };
  const startedAt = performance.now();
  const parsed = extractChapterReview(JSON.stringify(reviewPayload(prose, {
    actionQuote, resultQuote,
  })), { chapterContent });
  const elapsed = performance.now() - startedAt;
  assert.ok(parsed);
  assert.ok(elapsed < 500, `证据解析耗时 ${elapsed.toFixed(1)}ms`);
});

test('历史审稿和自然人感通过项不强制补写风险引文', () => {
  const legacy = extractChapterReview(JSON.stringify(reviewPayload({
    status: 'risk', detail: '旧审稿只有文字诊断。',
  })));
  assert.ok(legacy);
  const currentPass = extractChapterReview(JSON.stringify(reviewPayload({
    status: 'pass', detail: '未见成片同构表达。',
  }, {
    actionQuote: '他推门进去。', resultQuote: '门内的灯随即亮了。',
  }, {
    incrementEvidence: {
      triggerQuote: '他推门进去。', stateQuote: '门内的灯随即亮了。',
    },
  })), { chapterContent: '他推门进去。门内的灯随即亮了。' });
  assert.ok(currentPass);
});

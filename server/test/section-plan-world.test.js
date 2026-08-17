import test from 'node:test';
import assert from 'node:assert/strict';

import { extractSectionsPlan } from '../llm.js';
import { buildSectionsInstruction } from '../prompts.js';
import { WORLD_REVEAL_STAGE_LABELS } from '../world-bible.js';

const worldRoute = WORLD_REVEAL_STAGE_LABELS.map((layer, index) => ({
  layer,
  readingPromise: `${index + 1}层承诺用人物选择兑现`,
  verifiableEvidence: `${index + 1}层现场证据可被核验`,
  characterAction: `主角追索${index + 1}层证据`,
  choiceAndCost: `主角为${index + 1}层证据失去资源`,
  knowledgeGain: `读者确认${index + 1}层规则`,
  protectedUnknown: `暂不回答${index + 1}层幕后者`,
  nextLayerGate: `${index + 1}层门槛必须用正文证据完成`,
}));

function section(layerIndex, gateOutcome, title = `阶段${layerIndex + 1}`) {
  const route = worldRoute[layerIndex];
  return {
    title,
    summary: '主角为了生存追查证据并付出代价',
    promise: '读者将看到旧规则如何真正改变人的命运',
    goal: '在敌对封锁前找到并保住可核验证据',
    obstacle: '守门势力掌控通行资源并追捕知情人',
    progress: '证据让主角可以进入下一个主线行动',
    climax: '主角在公开选边中保住证据但失去容身处',
    payoff: '旧规则的真实代价得到现场证明',
    stateChange: '主角从旁观者变成被制度和势力同时追索的行动者',
    worldProgression: {
      layer: route.layer,
      stagePromise: route.readingPromise,
      evidence: `${route.verifiableEvidence}，并在当场改变一次利益分配`,
      characterAction: `${route.characterAction}，主动和守门人交换信息`,
      choiceAndCost: `${route.choiceAndCost}，并与旧同伴决裂`,
      knowledgeGain: `${route.knowledgeGain}，视角人物也据此改变计划`,
      protectedUnknown: `${route.protectedUnknown}，不用旁白揭晓`,
      gateOutcome,
      gateCondition: route.nextLayerGate,
      gateProgress: gateOutcome === 'hold'
        ? '本部只获得局部证据，尚未完成进入条件'
        : '主角在正文中用证据完成门槛并承担不可逆代价',
    },
  };
}

const validSections = () => [
  section(0, 'hold', '火种'),
  section(0, 'open-next', '破门'),
  section(1, 'open-next', '越界'),
  section(2, 'complete-long', '回声'),
];

test('分部规划保留世界执行合同并允许同层深化', () => {
  const parsed = extractSectionsPlan(JSON.stringify({ sections: validSections() }), { worldRoute });
  assert.ok(parsed);
  assert.deepEqual(parsed.map((item) => item.worldProgression.layer), [
    '当前生活圈', '当前生活圈', '中期势力与地域', '长线文明与历史',
  ]);
  assert.equal(parsed[1].worldProgression.gateOutcome, 'open-next');
});

test('分部规划拒绝缺合同、占位符和改写世界圣经锚点', () => {
  const missing = validSections();
  delete missing[0].worldProgression;
  assert.equal(extractSectionsPlan(JSON.stringify({ sections: missing }), { worldRoute }), null);

  const placeholder = validSections();
  placeholder[0].worldProgression.evidence = '更大世界';
  assert.equal(extractSectionsPlan(JSON.stringify({ sections: placeholder }), { worldRoute }), null);

  const changedAnchor = validSections();
  changedAnchor[0].worldProgression.stagePromise = '模型自行篡改的新承诺';
  assert.equal(extractSectionsPlan(JSON.stringify({ sections: changedAnchor }), { worldRoute }), null);
});

test('分部规划拒绝未开门换层、跳层、倒退和非末部结算长线', () => {
  const closed = validSections();
  closed[1].worldProgression.gateOutcome = 'hold';
  assert.equal(extractSectionsPlan(JSON.stringify({ sections: closed }), { worldRoute }), null);

  const skip = [section(0, 'open-next'), section(2, 'complete-long')];
  assert.equal(extractSectionsPlan(JSON.stringify({ sections: skip }), { worldRoute }), null);

  const backwards = [
    section(0, 'open-next'), section(1, 'open-next'),
    section(2, 'hold'), section(1, 'open-next'), section(2, 'complete-long'),
  ];
  assert.equal(extractSectionsPlan(JSON.stringify({ sections: backwards }), { worldRoute }), null);

  const earlyComplete = validSections();
  earlyComplete[2].worldProgression.gateOutcome = 'complete-long';
  assert.equal(extractSectionsPlan(JSON.stringify({ sections: earlyComplete }), { worldRoute }), null);

  const unfinishedLong = validSections();
  unfinishedLong.at(-1).worldProgression.gateOutcome = 'hold';
  assert.equal(extractSectionsPlan(JSON.stringify({ sections: unfinishedLong }), { worldRoute }), null);
});

test('已有正文时可从证据支持的中层继续，新书则必须从生活圈开始', () => {
  const later = [section(1, 'open-next'), section(2, 'complete-long')];
  assert.equal(extractSectionsPlan(JSON.stringify({ sections: later }), { worldRoute }), null);
  assert.ok(extractSectionsPlan(JSON.stringify({ sections: later }), {
    worldRoute, allowAdvancedStart: true,
  }));
});

test('分部 Prompt 注入世界圣经原始承诺、门槛和已发生事实', () => {
  const prompt = buildSectionsInstruction({
    outline: '全书大纲内容', worldRoute,
    occurredSummary: '第1部：主角已拿到本地通行证据',
    allowAdvancedStart: true,
  });
  assert.match(prompt, /1层承诺用人物选择兑现/);
  assert.match(prompt, /1层门槛必须用正文证据完成/);
  assert.match(prompt, /主角已拿到本地通行证据/);
  assert.match(prompt, /gateOutcome/);
  assert.match(prompt, /不得倒退或跳层/);
  assert.match(prompt, /不得把仅写在大纲或世界圣经的未来计划当成已解锁/);
});

test('没有三层世界圣经时方案不能通过服务端硬门槛', () => {
  assert.equal(extractSectionsPlan(JSON.stringify({ sections: validSections() }), {
    worldRoute: [],
  }), null);
  assert.match(buildSectionsInstruction({ outline: '旧大纲', worldRoute: [] }),
    /先重构世界圣经/);
});

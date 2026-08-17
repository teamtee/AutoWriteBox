import { WORLD_REVEAL_STAGE_LABELS } from '../world-bible.js';

export function validWorldBibleFixture() {
  const route = WORLD_REVEAL_STAGE_LABELS.map((layer, index) =>
    `〔${layer}〕` + [
      `阅读承诺：第${index + 1}层承诺通过人物选择兑现`,
      `可验证证据：第${index + 1}层现场物证可被人物核验`,
      `人物行动：主角主动追查第${index + 1}层现场物证`,
      `选择与代价：主角保住证据并失去第${index + 1}层容身处`,
      `认知增量：读者确认第${index + 1}层规则的社会影响`,
      `保留未知：暂不揭示第${index + 1}层幕后者真实身份`,
      `进入下一层门槛：必须用正文行动完成第${index + 1}层进入门槛`,
    ].join('；')).join('\n');
  return `【分阶段揭示路线】\n${route}\n【秘密分层与认知边界】\n作者真相仍保持与读者认知分离。`;
}

export function validSectionPlanFixture() {
  return JSON.stringify({ sections: WORLD_REVEAL_STAGE_LABELS.map((layer, index) => ({
    title: ['起源', '越界', '回声'][index],
    summary: `主角在第${index + 1}层追查证据并承担代价`,
    promise: `读者将看到第${index + 1}层规则如何改变命运`,
    goal: `主角找到第${index + 1}层可核验证据`,
    obstacle: `守门势力阻止主角核验第${index + 1}层证据`,
    progress: `证据把主线推进到第${index + 1}层新局面`,
    climax: `主角公开选择保住第${index + 1}层证据`,
    payoff: `第${index + 1}层规则的代价得到现场证明`,
    stateChange: `主角因第${index + 1}层选择失去原有容身处`,
    worldProgression: {
      layer,
      stagePromise: `第${index + 1}层承诺通过人物选择兑现`,
      evidence: `第${index + 1}层现场物证可被人物交叉核验`,
      characterAction: `主角主动追查第${index + 1}层现场物证`,
      choiceAndCost: `主角保住证据并失去第${index + 1}层容身处`,
      knowledgeGain: `读者和主角确认第${index + 1}层规则影响`,
      protectedUnknown: `暂不揭示第${index + 1}层幕后者真实身份`,
      gateOutcome: index < 2 ? 'open-next' : 'complete-long',
      gateCondition: `必须用正文行动完成第${index + 1}层进入门槛`,
      gateProgress: `主角在高潮中用证据完成第${index + 1}层门槛`,
    },
  })) });
}

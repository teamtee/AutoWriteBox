import { WORLD_REVEAL_STAGE_LABELS } from './world-bible.js';

const FIELDS = Object.freeze([
  ['layer', '世界层级'],
  ['stagePromise', '世界阶段承诺'],
  ['evidence', '可验证世界证据'],
  ['characterAction', '人物行动'],
  ['choiceAndCost', '世界选择与代价'],
  ['knowledgeGain', '阶段认知增量'],
  ['protectedUnknown', '本部保留未知'],
  ['gateCondition', '下一层门槛'],
  ['gateOutcomeText', '门槛结果'],
  ['gateProgress', '门槛证据进度'],
]);

const GATE_OUTCOMES = Object.freeze({
  '本部不解锁下一层': 'hold',
  '本部完成门槛，下部进入下一层': 'open-next',
  '完成长线层本轮阶段兑现': 'complete-long',
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fieldValue(source, label) {
  const marker = `【${label}】`;
  const start = source.indexOf(marker);
  if (start < 0 || source.split(marker).length !== 2) return '';
  const contentStart = start + marker.length;
  const next = source.indexOf('【', contentStart);
  return source.slice(contentStart, next < 0 ? source.length : next).trim();
}

export function sectionWorldContract(value) {
  const source = text(value);
  if (!source) return null;
  const contract = Object.fromEntries(FIELDS.map(([field, label]) => [
    field, fieldValue(source, label),
  ]));
  if (FIELDS.some(([field]) => !contract[field])
    || !WORLD_REVEAL_STAGE_LABELS.includes(contract.layer)
    || !Object.prototype.hasOwnProperty.call(GATE_OUTCOMES, contract.gateOutcomeText)) return null;
  return {
    layer: contract.layer,
    stagePromise: contract.stagePromise,
    evidence: contract.evidence,
    characterAction: contract.characterAction,
    choiceAndCost: contract.choiceAndCost,
    knowledgeGain: contract.knowledgeGain,
    protectedUnknown: contract.protectedUnknown,
    gateCondition: contract.gateCondition,
    gateOutcome: GATE_OUTCOMES[contract.gateOutcomeText],
    gateProgress: contract.gateProgress,
  };
}

export function sectionWorldContractPrompt(value) {
  const contract = sectionWorldContract(value);
  if (!contract) return '';
  return [
    '【本部当前世界执行合同（高于未来世界计划）】',
    `- 当前层级：${contract.layer}`,
    `- 本层承诺：${contract.stagePromise}`,
    `- 本部可用证据：${contract.evidence}`,
    `- 应由人物采取的行动：${contract.characterAction}`,
    `- 选择与代价：${contract.choiceAndCost}`,
    `- 本部允许的认知增量：${contract.knowledgeGain}`,
    `- 必须保留的未知：${contract.protectedUnknown}`,
    `- 进入下一层门槛：${contract.gateCondition}`,
    `- 本部门槛状态：${contract.gateOutcome}`,
    `- 门槛证据进度：${contract.gateProgress}`,
    '世界圣经中较高层内容仍是作者后台未来计划。本章不得超出当前层级和本部认知增量；',
    '只有已发生正文真正完成门槛后，下一部才可使用相邻下一层。合同标签只属于编辑后台，不得写入小说正文。',
  ].join('\n');
}

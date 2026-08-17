import test from 'node:test';
import assert from 'node:assert/strict';

import {
  narrativeDesignPlanFields, normalizeNarrativeDesign,
} from '../narrative-design-schema.js';
import { extractNarrativeDesignDraft } from '../llm.js';

const taskDesign = {
  designProtocolVersion: 1,
  chapterFunction: 'investigation',
  decision: {
    currentBelief: '主角相信旧证件仍然安全',
    action: '主角主动刷旧证件进入封锁仓库',
    harmedStakeholder: '主管失去对秘密入口的控制',
    counteraction: '主管依据本次刷卡记录冻结账户并封锁出口',
    responseChoice: '主角公开真实身份引走守卫并让证人从货厢撤离',
    stateBefore: '主角身份隐藏但无法入内',
    stateAfter: '主角进入仓库但身份暴露且账户冻结',
    nextDebt: '主角必须在合围前带证人离开',
  },
  knowledge: {
    mode: 'task',
    question: '旧证件是否仍是安全资源',
    visibleEvidence: '闸机先放行，随后巡逻终端同步同一警报',
    allowedConclusion: '证件仍能开门但已接入中央追踪',
    alternatives: ['证件此前被人标记', '闸机刚升级统一审计'],
    crossValidation: ['闸机本地日志', '巡逻终端警报编号'],
    protectedUnknown: '不确认是谁下令标记证件',
  },
};

test('结构化叙事骨架稳定生成可持久化决策与证据合同', () => {
  const normalized = normalizeNarrativeDesign(taskDesign);
  const fields = narrativeDesignPlanFields(normalized);
  assert.equal(fields.designProtocolVersion, 1);
  assert.match(fields.decisionChain, /反制后选择：主角公开真实身份引走守卫/);
  assert.match(fields.decisionChain, /状态改写：主角身份隐藏但无法入内→主角进入仓库/);
  assert.match(fields.knowledgeDesign, /替代解释：证件此前被人标记｜闸机刚升级统一审计/);
  assert.match(fields.knowledgeDesign, /交叉验证：闸机本地日志＋巡逻终端警报编号/);
});

test('关系余波可明确无认知任务，不被迫新增神秘物件', () => {
  const fields = narrativeDesignPlanFields({
    ...taskDesign,
    chapterFunction: 'relationship',
    knowledge: {
      mode: 'none',
      noTaskReason: '上一章已经确认背叛事实，本章只消费关系后果',
      focus: '姐弟谈判新的照护边界并承担决裂风险',
      existingJudgment: '房产权属和卖房责任保持既有结论，不新增证据',
    },
  });
  assert.match(fields.knowledgeDesign, /^无认知任务理由：/u);
  assert.doesNotMatch(fields.knowledgeDesign, /替代解释/u);
});

test('叙事骨架拒绝随机事故反制形状、单一解释和单一来源的半成品', () => {
  assert.throws(() => normalizeNarrativeDesign({
    ...taskDesign,
    knowledge: { ...taskDesign.knowledge, alternatives: ['只有一个解释'] },
  }), /BAD_NARRATIVE_DESIGN/);
  assert.throws(() => normalizeNarrativeDesign({
    ...taskDesign,
    decision: { ...taskDesign.decision, stateAfter: '待定' },
  }), /BAD_NARRATIVE_DESIGN/);
});

test('模型叙事骨架解析容忍包裹文字并拒绝缺字段对象', () => {
  assert.deepEqual(
    extractNarrativeDesignDraft(`说明\n\`\`\`json\n${JSON.stringify(taskDesign)}\n\`\`\``),
    normalizeNarrativeDesign(taskDesign),
  );
  assert.equal(extractNarrativeDesignDraft(JSON.stringify({
    ...taskDesign, decision: { action: '继续调查' },
  })), null);
});

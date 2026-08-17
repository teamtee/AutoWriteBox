import test from 'node:test';
import assert from 'node:assert/strict';

import { chapterOutputLeakDiagnostics } from '../chapter-output-guard.js';
import { buildContext } from '../prompts.js';
import {
  sectionWorldContract, sectionWorldContractPrompt,
} from '../section-world-contract.js';

const outline = [
  '【本部概述】主角追查地下城失踪案',
  '【世界层级】当前生活圈',
  '【世界阶段承诺】看见城内制度如何改变普通人命运',
  '【可验证世界证据】通行牌被注销时住宿和补给同时冻结',
  '【人物行动】主角主动用失效通行牌追查受害者路线',
  '【世界选择与代价】主角保住证人并失去自己的假身份',
  '【阶段认知增量】读者与主角确认失踪案借制度网络协同完成',
  '【本部保留未知】不揭示制度背后的跨区上层组织',
  '【下一层门槛】拿到一份可跨区核验的组织名单',
  '【门槛结果】本部不解锁下一层',
  '【门槛证据进度】目前只找到单一受害者的城内流转记录',
].join('\n');

test('从采纳的分部大纲中提取可执行的当前世界合同', () => {
  assert.deepEqual(sectionWorldContract(outline), {
    layer: '当前生活圈',
    stagePromise: '看见城内制度如何改变普通人命运',
    evidence: '通行牌被注销时住宿和补给同时冻结',
    characterAction: '主角主动用失效通行牌追查受害者路线',
    choiceAndCost: '主角保住证人并失去自己的假身份',
    knowledgeGain: '读者与主角确认失踪案借制度网络协同完成',
    protectedUnknown: '不揭示制度背后的跨区上层组织',
    gateCondition: '拿到一份可跨区核验的组织名单',
    gateOutcome: 'hold',
    gateProgress: '目前只找到单一受害者的城内流转记录',
  });
  assert.equal(sectionWorldContract('【世界层级】当前生活圈'), null);
  assert.equal(sectionWorldContract(outline.replace('本部不解锁下一层', '模糊状态')), null);
});

test('章级共享上下文单列当前层级、保留未知和未完成门槛', () => {
  const context = buildContext({
    book: {
      title: '雾城', premise: '追查失踪案', sections: [],
      outline: { versions: ['长线会涉及跨区组织'], cursor: 0 },
      settings: {}, characters: [], memory: {},
    },
    section: {
      id: 'section-01', outline: { content: outline }, summary: '', characters: [],
    },
  });
  assert.match(context, /本部当前世界执行合同/);
  assert.match(context, /当前层级：当前生活圈/);
  assert.match(context, /必须保留的未知：不揭示制度背后的跨区上层组织/);
  assert.match(context, /本部门槛状态：hold/);
  assert.match(context, /本章不得超出当前层级/);
});

test('本部合同标签不得被 API 写进小说正文', () => {
  const leaked = chapterOutputLeakDiagnostics(
    '【世界层级】当前生活圈\n林越推开了门。',
  );
  assert.equal(leaked.valid, false);
  assert.ok(leaked.signals.includes('section-world-marker'));
  assert.equal(chapterOutputLeakDiagnostics('林越推开门，通行牌在掌心裂成两半。').valid, true);
});

test('世界合同的后台标签不会在提取失败时伪装成有效上下文', () => {
  assert.equal(sectionWorldContractPrompt('【世界层级】当前生活圈'), '');
});

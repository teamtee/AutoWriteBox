import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../prompts.js';
import { buildCoreFieldInstruction, buildSystemPrompt } from '../prompts.js';

test('buildSystemPrompt 跳过空字段', () => {
  const s = p.buildSystemPrompt({ world: '赛博深圳', style: '', constraints: '不写主角死', pacing: '' });
  assert.match(s, /赛博深圳/);
  assert.match(s, /不写主角死/);
  assert.doesNotMatch(s, /文风基调/);
});

test('buildContext 按作用域拼装人物', () => {
  const ctx = p.buildContext({
    book: { outline: { content: '全书大纲X' }, characters: [{ name: '陈默', role: '主角', desc: '警探' }] },
    section: { outline: { content: '本部大纲Y' }, summary: '本部前情Z', characters: [{ name: '林薇', role: '委托人', desc: '神秘' }] },
    prevChapter: { content: 'a'.repeat(500), progress: '去仓库', characters: [{ name: '老鼠', role: '线人', desc: '贩子' }] },
  });
  assert.match(ctx, /陈默/);
  assert.match(ctx, /林薇/);
  assert.match(ctx, /老鼠/);
  assert.match(ctx, /去仓库/);
  assert.match(ctx, /本部前情Z/);
});

test('buildChapterInstruction 抽打时嵌入训话且优先', () => {
  const i = p.buildChapterInstruction({ chapterIndex: 3, wordTarget: 2000, mode: 'whip', whip: '太平淡，加冲突' });
  assert.match(i, /太平淡，加冲突/);
  assert.match(i, /2000/);
});

test('DIGEST_INSTRUCTION 要求 JSON 三字段', () => {
  assert.match(p.DIGEST_INSTRUCTION, /summary/);
  assert.match(p.DIGEST_INSTRUCTION, /progress/);
  assert.match(p.DIGEST_INSTRUCTION, /newCharacters/);
});

test('buildSystemPrompt 兼容版本化 core', () => {
  const s = buildSystemPrompt({
    world: { versions: ['赛博都市'], cursor: 0 },
    style: { versions: ['冷硬'], cursor: 0 },
    constraints: { versions: [''], cursor: 0 },
    pacing: { versions: [''], cursor: 0 },
  });
  assert.match(s, /赛博都市/);
  assert.match(s, /冷硬/);
});

test('buildCoreFieldInstruction 生成该字段指令', () => {
  const book = {
    premise: '一个侦探故事',
    settings: { core: {
      world: { versions: ['旧世界观'], cursor: 0 },
      style: { versions: ['冷硬'], cursor: 0 },
      constraints: { versions: [''], cursor: 0 },
      pacing: { versions: [''], cursor: 0 },
    } },
  };
  const ins = buildCoreFieldInstruction('world', book);
  assert.match(ins, /世界观/);
  assert.match(ins, /一个侦探故事/);
  assert.match(ins, /冷硬/);          // 带上其它字段作参照
});

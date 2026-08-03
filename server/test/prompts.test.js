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

test('buildContext 忽略旧数据里的非法人物结构', () => {
  const ctx = p.buildContext({
    book: {
      characters: { bad: 'object' },
    },
    section: {
      characters: [
        null,
        'bad',
        { name: '缺身份' },
        { name: '林薇', role: '委托人', desc: '神秘' },
      ],
    },
    prevChapter: {
      characters: [42, { name: '老鼠', role: '线人', desc: '贩子' }],
    },
  });

  assert.match(ctx, /林薇/);
  assert.match(ctx, /老鼠/);
  assert.doesNotMatch(ctx, /undefined/);
  assert.doesNotMatch(ctx, /bad/);
  assert.doesNotMatch(ctx, /缺身份/);
});

test('buildChapterInstruction 抽打时嵌入训话且优先', () => {
  const i = p.buildChapterInstruction({ chapterIndex: 3, wordTarget: 2000, mode: 'whip', whip: '太平淡，加冲突' });
  assert.match(i, /太平淡，加冲突/);
  assert.match(i, /2000/);
});

test('DIGEST_INSTRUCTION 要求标题与原有 digest 五字段', () => {
  for (const field of ['chapterTitle', 'sectionTitle', 'summary', 'progress', 'newCharacters']) {
    assert.match(p.DIGEST_INSTRUCTION, new RegExp(field));
  }
  assert.match(p.DIGEST_INSTRUCTION, /10\s*字/);
});

test('buildBookTitleInstruction 带 premise、大纲和纯标题限制', () => {
  const s = p.buildBookTitleInstruction('赛博侦探', '主角追查意识失踪案');
  assert.match(s, /赛博侦探/);
  assert.match(s, /意识失踪案/);
  assert.match(s, /10\s*字/);
  assert.match(s, /只输出书名/);
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

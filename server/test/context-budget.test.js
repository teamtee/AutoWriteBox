import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChapterInstruction, buildContext, buildSystemPrompt,
} from '../prompts.js';
import {
  CHAPTER_CONTEXT_LAYERS, CHAPTER_PROMPT_FIXED_OVERHEAD_CHARS,
  allocateContextBudget, buildChapterContextBudget, budgetTrimNotice,
  chapterContextRequests,
} from '../context-budget.js';
import {
  MAX_BOOK_OUTLINE_PROMPT_CHARS, MAX_BOOK_PROMPT_SUMMARY_CHARS,
  MAX_CORE_PROMPT_FIELD_CHARS, MAX_LLM_INPUT_CHARS,
  MAX_PREMISE_CHARS, MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS,
  MAX_SECTION_OUTLINE_PROMPT_CHARS, MAX_SECTION_PROMPT_SUMMARY_CHARS,
  MAX_VERSION_TEXT_CHARS, MAX_WRITING_ASSET_CONTEXT_CHARS,
} from '../limits.js';

// 计划见 docs/上下文组织审视与修正计划.md 阶段 1。

const big = (n) => '字'.repeat(n);
const versioned = (n) => ({ versions: [big(n)], cursor: 0 });
const scopeCharacters = (count, prefix) => Array.from({ length: count }, (_, index) => ({
  name: `${prefix}${index}`, role: '配角', desc: big(400),
}));

function saturatedGenerationInput() {
  const sectionIds = Array.from({ length: 5 }, (_, index) => `section-0${index + 1}`);
  const book = {
    title: '满配作品',
    premise: big(MAX_PREMISE_CHARS),
    outline: versioned(MAX_BOOK_OUTLINE_PROMPT_CHARS),
    sections: sectionIds,
    sectionSummaries: Object.fromEntries(sectionIds.map((id, index) => [id, {
      index: index + 1, title: `第${index + 1}部`, summary: big(MAX_BOOK_PROMPT_SUMMARY_CHARS),
    }])),
    characters: scopeCharacters(60, '主'),
    memory: {
      facts: Array.from({ length: 800 }, (_, index) => ({
        id: `fact-${index}`, status: 'active', kind: 'other',
        subject: `实体${index}`, predicate: '当前状态为', object: big(60),
        importance: 5, updatedAt: '2026-01-01T00:00:00.000Z',
        source: { chapterIndex: index + 1 },
      })),
    },
    settings: {
      core: {
        world: versioned(MAX_CORE_PROMPT_FIELD_CHARS),
        style: versioned(MAX_CORE_PROMPT_FIELD_CHARS),
        constraints: versioned(MAX_CORE_PROMPT_FIELD_CHARS),
        pacing: versioned(MAX_CORE_PROMPT_FIELD_CHARS),
      },
      storyEngine: {},
    },
  };
  const section = {
    id: sectionIds.at(-1),
    outline: { content: big(MAX_SECTION_OUTLINE_PROMPT_CHARS) },
    summary: big(MAX_SECTION_PROMPT_SUMMARY_CHARS),
    characters: scopeCharacters(60, '部'),
  };
  const prevChapter = {
    content: big(MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS * 4),
    characters: scopeCharacters(60, '前'),
    progress: big(500),
  };
  const writingAssetContext = `【绑定创作资产】\n${big(MAX_WRITING_ASSET_CONTEXT_CHARS)}`;
  const currentContent = big(MAX_VERSION_TEXT_CHARS);
  return { book, section, prevChapter, writingAssetContext, currentContent };
}

function assembleChapterPrompt(input, budgetResult) {
  const { book, section, prevChapter, writingAssetContext, currentContent } = input;
  const budget = budgetResult?.allocation ?? null;
  const system = buildSystemPrompt(
    book.settings.core, writingAssetContext, book.settings.storyEngine, budget,
  );
  const context = buildContext({
    book, section, prevChapter, bookChapterIndex: 200,
    chapterPlan: null, currentContent: '',
    budget, budgetTrimmed: budgetResult?.trimmed ?? null,
  });
  const instruction = buildChapterInstruction({
    chapterIndex: 200, bookChapterIndex: 200, wordTarget: 3_000, mode: 'rewrite',
    currentContent, recentReviewSignals: [], budget,
  });
  return { system, context, instruction, total: system.length + context.length + instruction.length };
}

test('保底额度之和必须留在可分配预算内，否则低优先级层会被静默清零', () => {
  const floors = CHAPTER_CONTEXT_LAYERS.reduce((total, layer) => total + layer.floor, 0);
  const assignable = MAX_LLM_INPUT_CHARS - CHAPTER_PROMPT_FIXED_OVERHEAD_CHARS;
  assert.ok(
    floors <= assignable,
    `保底额度之和 ${floors} 超过可分配预算 ${assignable}；`
    + '新增上下文层时必须同时复核 floor，不能只加字段上限。',
  );
});

test('所有上下文子系统填满时，章节重写装配不再抛出输入超限', () => {
  const input = saturatedGenerationInput();
  const budgetResult = buildChapterContextBudget(input);
  const { total } = assembleChapterPrompt(input, budgetResult);
  assert.ok(
    total <= MAX_LLM_INPUT_CHARS,
    `满配装配 ${total} 字符仍超过 MAX_LLM_INPUT_CHARS ${MAX_LLM_INPUT_CHARS}。`,
  );
});

test('预算分配让满配调用保留明确安全余量，不依赖各字段上限碰巧相加不过线', () => {
  const input = saturatedGenerationInput();
  const unbudgeted = assembleChapterPrompt(input, null).total;
  const budgetResult = buildChapterContextBudget(input);
  const budgeted = assembleChapterPrompt(input, budgetResult).total;
  assert.ok(budgeted < unbudgeted, `预算后 ${budgeted} 应小于未预算 ${unbudgeted}`);
  assert.ok(
    budgeted <= MAX_LLM_INPUT_CHARS - 5_000,
    `满配预算后只剩 ${MAX_LLM_INPUT_CHARS - budgeted} 字符余量，固定指导语增长会再次越界。`,
  );
});

test('满配降级后每层仍拿到不低于保底的额度，禁忌约束不被裁剪', () => {
  const input = saturatedGenerationInput();
  const requests = chapterContextRequests(input);
  const { allocation } = buildChapterContextBudget(input);
  for (const layer of CHAPTER_CONTEXT_LAYERS) {
    // 没有内容的层不占额度，因此保底只在实际需求范围内生效。
    const expected = Math.min(layer.floor, requests[layer.id] ?? layer.cap);
    assert.ok(
      allocation[layer.id] >= expected,
      `${layer.label} 实得 ${allocation[layer.id]} 低于保底 ${expected}`,
    );
  }
  assert.equal(allocation.constraints, MAX_CORE_PROMPT_FIELD_CHARS);
});

test('满配降级后各段落仍然装入了对应材料，并显式标注了裁剪', () => {
  const input = saturatedGenerationInput();
  const budgetResult = buildChapterContextBudget(input);
  const { context } = assembleChapterPrompt(input, budgetResult);
  for (const label of [
    '全书大纲', '本部大纲', '此前分部剧情', '本部前情',
    '主要人物', '本部人物', '已确认长期记忆', '上一章结尾',
  ]) {
    assert.match(context, new RegExp(`【${label}`, 'u'), `降级后上下文缺少【${label}】`);
  }
  assert.ok(budgetResult.trimmed.length > 0, '满配输入应当产生裁剪记录');
  assert.match(context, /【本次上下文预算裁剪】/u);
  assert.match(context, /保留未知/u);
});

test('内容不足的作品不占用额度，空层的份额让给真正有内容的层', () => {
  const requests = chapterContextRequests({
    book: { premise: '短简介', settings: { core: {} } },
    section: { summary: big(300_000) },
  });
  assert.equal(requests.world, 0);
  const { allocation } = allocateContextBudget(200_000, requests);
  assert.equal(allocation.world, 0, '没写世界圣经的作品不应占住世界观额度');
  assert.equal(allocation.premise, '短简介'.length);
  assert.equal(allocation.sectionSummary, MAX_SECTION_PROMPT_SUMMARY_CHARS);
});

test('模型登记的较小上下文窗口会收紧本次预算，较大窗口仍受本地硬上限约束', () => {
  const input = saturatedGenerationInput();
  const small = buildChapterContextBudget(input, { modelContextChars: 32000 });
  assert.equal(small.ceiling, 32000);
  assert.equal(small.total, 8000);
  assert.equal(small.allocation.constraints, 8000);
  assert.equal(small.allocation.prevEnding, 0);
  const assembled = assembleChapterPrompt(input, small);
  assert.ok(
    assembled.total <= 32000,
    `32k 模型实际装配 ${assembled.total} 字符，说明 0 额度层仍回退到了默认窗口`,
  );
  assert.doesNotMatch(assembled.context, /【上一章结尾】/u);
  assert.doesNotMatch(assembled.instruction, /【当前章原文】/u);

  const large = buildChapterContextBudget(input, { modelContextChars: 1000000 });
  assert.equal(large.ceiling, MAX_LLM_INPUT_CHARS);
});

test('总额不足以覆盖全部保底时按优先级降级，而不是抛错', () => {
  const { allocation } = allocateContextBudget(5_000, {});
  assert.equal(allocation.constraints, 5_000, '最高优先级层先拿满保底');
  assert.equal(allocation.prevEnding, 0);
  assert.equal(allocation.style, 0);
});

test('裁剪说明列出被裁层并要求保留未知', () => {
  const notice = budgetTrimNotice([{ id: 'memory', label: '已确认长期记忆', chars: 2_000, want: 64_000 }]);
  assert.match(notice, /已确认长期记忆：本次只发送约 2000 字符，完整内容约 64000 字符/u);
  assert.match(notice, /未发送的部分依然存在于作品中/u);
  assert.equal(budgetTrimNotice([]), '');
});

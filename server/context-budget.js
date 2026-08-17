import {
  MAX_BOOK_OUTLINE_PROMPT_CHARS, MAX_BOOK_PROMPT_SUMMARY_CHARS,
  MAX_CHARACTER_CRAFT_CONTEXT_CHARS, MAX_CHARACTER_PROMPT_SCOPE_CHARS,
  MAX_CORE_PROMPT_FIELD_CHARS, MAX_LLM_INPUT_CHARS, MAX_MEMORY_CONTEXT_CHARS,
  MAX_PREMISE_CHARS, MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS,
  MAX_PROMISE_LEDGER_CONTEXT_CHARS, MAX_SECTION_OUTLINE_PROMPT_CHARS,
  MAX_SECTION_PROMPT_SUMMARY_CHARS, MAX_VERSION_TEXT_CHARS,
  MAX_WRITING_ASSET_CONTEXT_CHARS,
} from './limits.js';

// 单次调用的固定开销：角色声明、创作准则、分层说明、硬约束、判断依据、
// 策划卡、场景链、节奏与体量背景、任务句和各段落标签。这些内容不参与
// 分配（策划卡是本次任务最具体的指令，硬约束是正确性底线），但必须先
// 从总额里扣掉，否则可分配额度会被高估。
export const CHAPTER_PROMPT_FIXED_OVERHEAD_CHARS = 24_000;

// 各上下文层的优先级、保底额度和上限。priority 越大越先拿到额度；
// floor 是"即使总额紧张也必须保留"的下限，用来保证降级后仍然可用。
// 详见 docs/上下文组织审视与修正计划.md 阶段 1。
export const CHAPTER_CONTEXT_LAYERS = Object.freeze([
  { id: 'constraints', label: '禁忌约束', priority: 1000, floor: MAX_CORE_PROMPT_FIELD_CHARS, cap: MAX_CORE_PROMPT_FIELD_CHARS },
  { id: 'prevEnding', label: '上一章结尾', priority: 800, floor: 2_000, cap: MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS },
  { id: 'currentContent', label: '当前章原文', priority: 700, floor: 0, cap: MAX_VERSION_TEXT_CHARS },
  { id: 'memory', label: '已确认长期记忆', priority: 600, floor: 2_000, cap: MAX_MEMORY_CONTEXT_CHARS },
  { id: 'sectionSummary', label: '本部前情', priority: 500, floor: 4_000, cap: MAX_SECTION_PROMPT_SUMMARY_CHARS },
  { id: 'priorSections', label: '此前分部剧情', priority: 450, floor: 4_000, cap: MAX_BOOK_PROMPT_SUMMARY_CHARS },
  { id: 'sectionOutline', label: '本部大纲', priority: 400, floor: 2_000, cap: MAX_SECTION_OUTLINE_PROMPT_CHARS },
  { id: 'bookOutline', label: '全书大纲', priority: 380, floor: 2_000, cap: MAX_BOOK_OUTLINE_PROMPT_CHARS },
  { id: 'premise', label: '作品简介 / 初始设想', priority: 350, floor: 1_000, cap: MAX_PREMISE_CHARS },
  { id: 'promiseLedger', label: '承诺账本', priority: 300, floor: 1_000, cap: MAX_PROMISE_LEDGER_CONTEXT_CHARS },
  { id: 'characterCraft', label: '人物导演卡', priority: 290, floor: 1_000, cap: MAX_CHARACTER_CRAFT_CONTEXT_CHARS },
  { id: 'sectionCharacters', label: '本部人物', priority: 220, floor: 1_000, cap: MAX_CHARACTER_PROMPT_SCOPE_CHARS },
  { id: 'bookCharacters', label: '主要人物', priority: 210, floor: 1_000, cap: MAX_CHARACTER_PROMPT_SCOPE_CHARS },
  { id: 'prevCharacters', label: '上一章登场人物', priority: 200, floor: 500, cap: MAX_CHARACTER_PROMPT_SCOPE_CHARS },
  { id: 'pacing', label: '篇幅节奏', priority: 150, floor: 1_000, cap: MAX_CORE_PROMPT_FIELD_CHARS },
  { id: 'world', label: '世界观', priority: 120, floor: 2_000, cap: MAX_CORE_PROMPT_FIELD_CHARS },
  { id: 'style', label: '文风基调', priority: 110, floor: 2_000, cap: MAX_CORE_PROMPT_FIELD_CHARS },
  { id: 'writingAsset', label: '绑定创作资产', priority: 100, floor: 1_000, cap: MAX_WRITING_ASSET_CONTEXT_CHARS },
]);

const LAYER_BY_ID = new Map(CHAPTER_CONTEXT_LAYERS.map((layer) => [layer.id, layer]));

export function contextLayerCap(id) {
  const layer = LAYER_BY_ID.get(id);
  if (!layer) throw new Error('UNKNOWN_CONTEXT_LAYER');
  return layer.cap;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// 两轮分配：先按优先级发放保底额度，再按优先级把剩余额度补到 want。
// 总额不足以覆盖全部保底时，低优先级层会拿到 0——这仍然是可用降级，
// 比整次调用抛 LLM_INPUT_TOO_LARGE 让作者白等一次要好。
export function allocateContextBudget(total, requests = {}, {
  layers = CHAPTER_CONTEXT_LAYERS,
} = {}) {
  const budget = positiveInteger(total, MAX_LLM_INPUT_CHARS);
  const ordered = [...layers].sort((left, right) => right.priority - left.priority
    || left.id.localeCompare(right.id));
  const want = new Map(ordered.map((layer) => {
    const requested = requests[layer.id];
    const need = Number.isSafeInteger(requested) && requested >= 0 ? requested : layer.cap;
    return [layer.id, Math.min(need, layer.cap)];
  }));

  const granted = new Map(ordered.map((layer) => [layer.id, 0]));
  let remaining = budget;
  for (const layer of ordered) {
    const share = Math.min(layer.floor, want.get(layer.id), remaining);
    granted.set(layer.id, share);
    remaining -= share;
  }
  for (const layer of ordered) {
    if (remaining <= 0) break;
    const share = Math.min(want.get(layer.id) - granted.get(layer.id), remaining);
    if (share <= 0) continue;
    granted.set(layer.id, granted.get(layer.id) + share);
    remaining -= share;
  }

  const allocation = {};
  const trimmed = [];
  for (const layer of ordered) {
    const chars = granted.get(layer.id);
    allocation[layer.id] = chars;
    if (chars < want.get(layer.id)) {
      trimmed.push({ id: layer.id, label: layer.label, chars, want: want.get(layer.id) });
    }
  }
  return { allocation, trimmed, remaining, total: budget };
}

const textLength = (value) => (typeof value === 'string' ? value.length : 0);

function versionedLength(field) {
  if (!field) return 0;
  if (Array.isArray(field.versions)) return textLength(field.versions[field.cursor]);
  if (typeof field.content === 'string') return field.content.length;
  return textLength(field);
}

function chapterContentLength(chapter) {
  if (!chapter) return 0;
  const bodyLength = versionedLength(chapter.body);
  return bodyLength || textLength(chapter.content);
}

function characterScopeLength(characters) {
  return Array.isArray(characters)
    ? characters.reduce((total, item) => total + (item && typeof item.name === 'string'
      && typeof item.role === 'string' && typeof item.desc === 'string'
      ? item.name.length + item.role.length + item.desc.length + 6
      : 0), 0)
    : 0;
}

// 只统计"这本书实际有多少内容想进上下文"，不做裁剪。没写世界圣经的作品
// 不应该占住 2 万字符额度，让真正有内容的层被挤掉。
export function chapterContextRequests({
  book = {}, section = {}, prevChapter = null,
  currentContent = '', writingAssetContext = '',
} = {}) {
  const core = book?.settings?.core ?? {};
  return {
    constraints: versionedLength(core.constraints),
    world: versionedLength(core.world),
    style: versionedLength(core.style),
    pacing: versionedLength(core.pacing),
    writingAsset: textLength(writingAssetContext),
    premise: textLength(book.premise),
    bookOutline: versionedLength(book.outline),
    sectionOutline: textLength(section?.outline?.content),
    priorSections: Object.values(book?.sectionSummaries ?? {})
      .reduce((total, item) => total + textLength(item?.summary) + 24, 0),
    sectionSummary: textLength(section?.summary),
    bookCharacters: characterScopeLength(book.characters),
    sectionCharacters: characterScopeLength(section?.characters),
    prevCharacters: characterScopeLength(prevChapter?.characters),
    memory: Array.isArray(book?.memory?.facts)
      ? book.memory.facts.length * 80 : 0,
    prevEnding: chapterContentLength(prevChapter),
    promiseLedger: Array.isArray(book?.settings?.promiseLedger?.entries)
      ? book.settings.promiseLedger.entries.length * 200 : 0,
    characterCraft: Array.isArray(book?.settings?.characterCraft?.characters)
      ? book.settings.characterCraft.characters.length * 300 : 0,
    currentContent: textLength(currentContent),
  };
}

// 装配入口：给定一次章节调用的原始材料，返回每层可用字符数。
export function buildChapterContextBudget(input = {}, {
  modelContextChars,
  fixedOverheadChars = CHAPTER_PROMPT_FIXED_OVERHEAD_CHARS,
} = {}) {
  const ceiling = Math.min(
    positiveInteger(modelContextChars, MAX_LLM_INPUT_CHARS), MAX_LLM_INPUT_CHARS,
  );
  const overhead = Math.max(0, fixedOverheadChars);
  const assignable = Math.max(1, ceiling - overhead);
  return {
    ...allocateContextBudget(assignable, chapterContextRequests(input)),
    ceiling, fixedOverheadChars: overhead,
  };
}

// 被裁剪的层要在提示词里显式标注，模型才知道"没提到"不等于"不存在"。
export function budgetTrimNotice(trimmed) {
  if (!Array.isArray(trimmed) || !trimmed.length) return '';
  const rows = trimmed.map(({ label, chars, want }) =>
    `- ${label}：本次只发送约 ${chars} 字符，完整内容约 ${want} 字符`);
  return [
    '【本次上下文预算裁剪】\n',
    rows.join('\n'), '\n',
    '以上材料因单次输入预算被裁剪，未发送的部分依然存在于作品中。',
    '遇到本次上下文没有覆盖的人物、物品或旧线时，保留未知并让人物据此行动，',
    '不要临时补一个万能设定，也不要假设它已经不存在。\n',
  ].join('');
}

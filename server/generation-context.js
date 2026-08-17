import {
  MAX_BOOK_OUTLINE_PROMPT_CHARS, MAX_CHARACTER_PROMPT_SCOPE_CHARS,
  MAX_BOOK_PROMPT_SUMMARY_CHARS, MAX_BOOK_SECTION_SUMMARY_CHARS,
  MAX_CORE_PROMPT_FIELD_CHARS, MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS,
  MAX_MEMORY_CONTEXT_CHARS,
  MAX_SECTION_OUTLINE_PROMPT_CHARS, MAX_SECTION_PROMPT_SUMMARY_CHARS,
} from './limits.js';
import { stageSummaryIsStale } from './stage-summary-schema.js';
import { formatChapterHandoff } from './chapter-handoff-schema.js';
import {
  generationMemoryRelevantTerms, generationMemoryRows, generationMemorySelection,
} from './generation-memory-context.js';

export { generationMemoryRows, generationMemorySelection } from './generation-memory-context.js';

const OMITTED_SECTION_SUMMARY_PREFIX = '（较早的本部摘要已省略，以下为最近剧情）\n';
const OMITTED_BOOK_SUMMARY_ROW = '（更早分部剧情已因上下文预算省略）';
const OMITTED_BOOK_SECTION_PREFIX = '（本部中间剧情已省略，保留开场、相关条目与收尾）\n';
const OMITTED_CHARACTERS_ROW = '- …已省略中间人物，保留主要与最近条目…';
const OMITTED_TEXT_MARKER = '\n（中间内容已省略，保留开头与结尾）\n';

export function generationTextWindow(value, maxChars) {
  if (typeof value !== 'string' || !value) return '';
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 1;
  if (value.length <= limit) return value;
  if (limit <= OMITTED_TEXT_MARKER.length) return value.slice(0, limit);
  const available = limit - OMITTED_TEXT_MARKER.length;
  const headLength = Math.ceil(available / 2);
  const tailLength = available - headLength;
  return value.slice(0, headLength) + OMITTED_TEXT_MARKER + value.slice(-tailLength);
}

// 可选 maxChars 由分层预算分配器传入（context-budget.js）。缺省时回退到
// limits.js 的字段上限，旧调用方行为不变。
const windowLimit = (maxChars, fallback) => {
  if (maxChars === 0) return 0;
  return Number.isSafeInteger(maxChars) && maxChars > 0
    ? Math.min(maxChars, fallback) : fallback;
};

const budgetedWindow = (value, maxChars, fallback) => {
  const limit = windowLimit(maxChars, fallback);
  return limit === 0 ? '' : generationTextWindow(value, limit);
};

export const generationCoreFieldText = (value, maxChars) =>
  budgetedWindow(value, maxChars, MAX_CORE_PROMPT_FIELD_CHARS);

export const generationBookOutlineText = (value, maxChars) =>
  budgetedWindow(value, maxChars, MAX_BOOK_OUTLINE_PROMPT_CHARS);

export const generationSectionOutlineText = (value, maxChars) =>
  budgetedWindow(value, maxChars, MAX_SECTION_OUTLINE_PROMPT_CHARS);

export function generationChapterContent(chapter) {
  if (!chapter || typeof chapter !== 'object') return '';
  if (Array.isArray(chapter.body?.versions)) {
    return typeof chapter.body.versions[chapter.body.cursor] === 'string'
      ? chapter.body.versions[chapter.body.cursor] : '';
  }
  return typeof chapter.content === 'string' ? chapter.content : '';
}

export function previousChapterEndingText(value, maxChars) {
  if (typeof value !== 'string') return '';
  const limit = windowLimit(maxChars, MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS);
  return limit === 0 ? '' : value.slice(-limit);
}

export function previousChapterHandoffText(value) {
  return formatChapterHandoff(value);
}

function joinedRowsLength(rows) {
  return rows.reduce((total, row) => total + row.length, Math.max(0, rows.length - 1));
}

export function generationCharacterRows(
  value, maxChars = MAX_CHARACTER_PROMPT_SCOPE_CHARS,
) {
  if (!Array.isArray(value)) return [];
  const rows = value.flatMap((character) => {
    if (!character || typeof character.name !== 'string'
      || typeof character.role !== 'string' || typeof character.desc !== 'string') {
      return [];
    }
    return [`- ${character.name}（${character.role}）：${character.desc}`];
  });
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0
    ? maxChars
    : MAX_CHARACTER_PROMPT_SCOPE_CHARS;
  if (joinedRowsLength(rows) <= limit) return rows;

  const available = Math.max(0, limit - OMITTED_CHARACTERS_ROW.length - 2);
  const headBudget = Math.floor(available / 2);
  const tailBudget = available - headBudget;
  const head = [];
  let headLength = 0;
  for (const row of rows) {
    const cost = row.length + (head.length ? 1 : 0);
    if (headLength + cost > headBudget) break;
    head.push(row);
    headLength += cost;
  }
  const reversedTail = [];
  let tailLength = 0;
  for (let index = rows.length - 1; index >= head.length; index -= 1) {
    const row = rows[index];
    const cost = row.length + (reversedTail.length ? 1 : 0);
    if (tailLength + cost > tailBudget) break;
    reversedTail.push(row);
    tailLength += cost;
  }
  return [...head, OMITTED_CHARACTERS_ROW, ...reversedTail.reverse()];
}

export function recentSectionSummary(value, maxChars) {
  if (typeof value !== 'string' || !value) return '';
  const limit = windowLimit(maxChars, MAX_SECTION_PROMPT_SUMMARY_CHARS);
  if (limit === 0) return '';
  if (value.length <= limit) return value;
  const tailBudget = Math.max(
    0, limit - OMITTED_SECTION_SUMMARY_PREFIX.length,
  );
  let tail = value.slice(-tailBudget);
  // 聚合摘要通常一章一行。窗口若从行中间开始，优先丢弃这半行，避免
  // 把缺少章号和开头的残句交给模型；人工导入的单行摘要则保留尾部。
  const firstLineBreak = tail.indexOf('\n');
  if (firstLineBreak >= 0 && firstLineBreak < tail.length - 1) {
    tail = tail.slice(firstLineBreak + 1);
  }
  return OMITTED_SECTION_SUMMARY_PREFIX + tail;
}

export function bookSectionSummaryWindow(
  value, maxChars = MAX_BOOK_SECTION_SUMMARY_CHARS, relevantTerms = [],
) {
  if (typeof value !== 'string' || !value) return '';
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0
    ? maxChars : MAX_BOOK_SECTION_SUMMARY_CHARS;
  if (value.length <= limit) return value;
  const lines = value.split('\n').filter(Boolean);
  // 人工导入的单行长摘要没有章节边界，退化为首尾窗口，仍保住阶段起点。
  if (lines.length <= 1) return generationTextWindow(value, limit);

  const marker = `（本部有 ${lines.length} 条章节摘要因预算省略；保留开场、相关条目与收尾）`;
  const markerBudget = Math.min(limit, marker.length + 1);
  const available = Math.max(0, limit - markerBudget);
  const selected = new Set();
  let used = 0;
  const add = (index, quota = available) => {
    if (selected.has(index)) return false;
    const cost = lines[index].length + (selected.size ? 1 : 0);
    if (used + cost > Math.min(available, quota)) return false;
    selected.add(index);
    used += cost;
    return true;
  };

  // 先保留开场，再保留本章直接相关的旧条目，最后把剩余额度给收尾。
  const headQuota = Math.floor(available * 0.25);
  for (let index = 0; index < lines.length && add(index, headQuota); index += 1) {}
  const terms = relevantTerms.filter((term) =>
    typeof term === 'string' && term.length >= 2 && term.length <= 80);
  const relevantQuota = Math.floor(available * 0.60);
  for (let index = 0; index < lines.length; index += 1) {
    if (terms.some((term) => lines[index].includes(term))) add(index, relevantQuota);
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) add(index);

  const indexes = [...selected].sort((left, right) => left - right);
  const omitted = lines.length - indexes.length;
  if (omitted <= 0) return indexes.map((index) => lines[index]).join('\n').slice(0, limit);
  const firstTail = indexes.findIndex((index, position) => position > 0
    && index > indexes[position - 1] + 1);
  const split = firstTail < 0 ? Math.min(1, indexes.length) : firstTail;
  const before = indexes.slice(0, split).map((index) => lines[index]);
  const after = indexes.slice(split).map((index) => lines[index]);
  const omissionMarker = `（本部有 ${omitted} 条章节摘要因预算省略；保留开场、相关条目与收尾）`;
  return [...before, omissionMarker, ...after].join('\n').slice(0, limit);
}

function bookSummaryRows(book, beforeSectionId, relevantTerms = []) {
  if (!book || !Array.isArray(book.sections)
    || !book.sectionSummaries || typeof book.sectionSummaries !== 'object') return [];
  const beforeIndex = beforeSectionId === undefined
    ? book.sections.length : book.sections.indexOf(beforeSectionId);
  const end = beforeIndex < 0 ? 0 : beforeIndex;
  return book.sections.slice(0, end).flatMap((sectionId, position) => {
    const item = book.sectionSummaries[sectionId];
    if (!item || typeof item.summary !== 'string' || !item.summary) return [];
    const title = typeof item.title === 'string' && item.title
      ? ` · ${item.title}` : '';
    return [`第${position + 1}部${title}：\n${bookSectionSummaryWindow(
      item.summary, MAX_BOOK_SECTION_SUMMARY_CHARS, relevantTerms,
    )}`];
  });
}

function stageAwareBookSummaryRows(book, beforeSectionId, relevantTerms = []) {
  const sections = Array.isArray(book?.sections) ? book.sections : [];
  const beforeIndex = beforeSectionId === undefined
    ? sections.length : sections.indexOf(beforeSectionId);
  const end = beforeIndex < 0 ? 0 : beforeIndex;
  const candidates = (Array.isArray(book?.stageSummaries) ? book.stageSummaries : [])
    .flatMap((item) => {
      const startIndex = sections.indexOf(item?.startSectionId);
      const endIndex = sections.indexOf(item?.endSectionId);
      const stale = stageSummaryIsStale(book, item);
      if (startIndex < 0 || endIndex < startIndex || endIndex >= end
        || typeof item?.summary !== 'string' || !item.summary
        || (item.status !== 'frozen' && stale)) return [];
      return [{ item, startIndex, endIndex, stale }];
    })
    .sort((left, right) => left.startIndex - right.startIndex
      || right.endIndex - left.endIndex
      || String(right.item.updatedAt).localeCompare(String(left.item.updatedAt)));
  const selected = [];
  let coveredThrough = -1;
  for (const candidate of candidates) {
    if (candidate.startIndex <= coveredThrough) continue;
    selected.push(candidate);
    coveredThrough = candidate.endIndex;
  }
  if (!selected.length) return bookSummaryRows(book, beforeSectionId, relevantTerms);

  // 未过期阶段摘要可以替代其覆盖的逐部摘要。来源已变化的冻结版仍保留
  // 作者权威，但不能继续独占事实层：同时发送当前逐部摘要，让模型明确
  // 看见冲突并以最新正文派生内容为事实依据。
  const covered = new Set(selected.flatMap(({ startIndex, endIndex, stale }) =>
    stale ? [] : Array.from(
      { length: endIndex - startIndex + 1 }, (_, offset) => startIndex + offset,
    )));
  const stageAt = new Map(selected.map((item) => [item.startIndex, item]));
  const rows = [];
  for (let position = 0; position < end; position += 1) {
    const stage = stageAt.get(position);
    if (stage) {
      const suffix = stage.startIndex === stage.endIndex
        ? `第${stage.startIndex + 1}部`
        : `第${stage.startIndex + 1}–${stage.endIndex + 1}部`;
      rows.push(stage.stale
        ? `阶段·${stage.item.title}（${suffix}；作者冻结版与当前来源不一致）：\n`
          + '以下冻结文本保留作者意图，但若与随后列出的当前分部摘要冲突，以当前正文派生摘要为已发生事实。\n'
          + stage.item.summary
        : `阶段·${stage.item.title}（${suffix}）：\n${stage.item.summary}`);
      if (!stage.stale) continue;
    }
    if (covered.has(position)) continue;
    const sectionId = sections[position];
    const item = book?.sectionSummaries?.[sectionId];
    if (!item || typeof item.summary !== 'string' || !item.summary) continue;
    const title = typeof item.title === 'string' && item.title ? ` · ${item.title}` : '';
    rows.push(`第${position + 1}部${title}：\n${bookSectionSummaryWindow(
      item.summary, MAX_BOOK_SECTION_SUMMARY_CHARS, relevantTerms,
    )}`);
  }
  return rows;
}

function fitRecentBookSummaryRows(rows, maxChars, relevantTerms = []) {
  if (joinedRowsLength(rows) <= maxChars) return rows.join('\n');
  const available = Math.max(0, maxChars - OMITTED_BOOK_SUMMARY_ROW.length - 1);
  const selected = new Map();
  let used = 0;
  const addText = (index, text) => {
    if (!text || selected.has(index)) return false;
    const cost = text.length + (selected.size ? 1 : 0);
    if (used + cost > available) return false;
    selected.set(index, text);
    used += cost;
    return true;
  };
  const addFull = (index) => addText(index, rows[index]);

  // 最近一部是直接连续性的底座，即使单部窗口大于本次剩余额度也必须
  // 先留一份有界首尾快照。另一半额度供久远相关部和更多最近部竞争。
  if (rows.length && available > 0) {
    const latestBudget = Math.max(1, Math.floor(available * 0.52));
    addText(rows.length - 1, generationTextWindow(rows.at(-1), latestBudget));
  }
  for (let index = 0; index < rows.length - 1; index += 1) {
    if (!relevantTerms.some((term) => rows[index].includes(term))) continue;
    const remaining = available - used - (selected.size ? 1 : 0);
    if (remaining <= 0) break;
    addText(index, generationTextWindow(rows[index], Math.min(rows[index].length, remaining)));
  }
  for (let index = rows.length - 2; index >= 0; index -= 1) addFull(index);

  const output = [...selected.entries()].sort((left, right) => left[0] - right[0])
    .map(([, text]) => text);
  return [OMITTED_BOOK_SUMMARY_ROW, ...output].join('\n').slice(0, maxChars);
}

export function buildBookSummaryFromSectionSummaries(
  book, maxChars = MAX_BOOK_PROMPT_SUMMARY_CHARS,
) {
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0
    ? maxChars : MAX_BOOK_PROMPT_SUMMARY_CHARS;
  return fitRecentBookSummaryRows(bookSummaryRows(book), limit);
}

export function generationPriorSectionSummary(
  book, currentSectionId, maxChars = MAX_BOOK_PROMPT_SUMMARY_CHARS,
  { taskRelevantText = '' } = {},
) {
  if (maxChars === 0) return '';
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0
    ? maxChars : MAX_BOOK_PROMPT_SUMMARY_CHARS;
  const relevantTerms = generationMemoryRelevantTerms(book?.memory, taskRelevantText);
  const rows = stageAwareBookSummaryRows(book, currentSectionId, relevantTerms);
  if (rows.length) return fitRecentBookSummaryRows(rows, limit, relevantTerms);
  // 兼容早期只有 book.summary 的数据；一旦新的分部摘要索引建立，
  // 上面的按顺序选择会避免把当前部或未来部误当作前情。
  return !book?.sectionSummaries || !Object.keys(book.sectionSummaries).length
    ? generationTextWindow(book?.summary, limit)
    : '';
}

export function generationMemoryRelevantText({ book = {}, section = {}, prevChapter = null }) {
  return [
    generationPriorSectionSummary(book, section.id),
    recentSectionSummary(section.summary),
    previousChapterEndingText(generationChapterContent(prevChapter)),
    previousChapterHandoffText(prevChapter?.handoff),
    typeof prevChapter?.progress === 'string' ? prevChapter.progress : '',
    ...generationCharacterRows(book.characters),
    ...generationCharacterRows(section.characters),
    ...generationCharacterRows(prevChapter?.characters),
  ].filter(Boolean).join('\n');
}

function chapterPlanRelevantRows(chapterPlan) {
  return chapterPlan && typeof chapterPlan === 'object' ? [
    chapterPlan.goal, chapterPlan.obstacle, chapterPlan.choice,
    chapterPlan.payoff, chapterPlan.hook, chapterPlan.tensionArc,
    chapterPlan.foreshadowing, chapterPlan.worldExpansion,
    chapterPlan.decisionChain, chapterPlan.knowledgeDesign, chapterPlan.notes,
    ...(Array.isArray(chapterPlan.scenes) ? chapterPlan.scenes.flatMap((scene) =>
      scene && typeof scene === 'object' ? [
        scene.title, scene.trigger, scene.desire, scene.obstacle,
        scene.action, scene.turn, scene.cost,
      ] : []) : []),
  ].filter((value) => typeof value === 'string' && value) : [];
}

// 这是本地检索查询，不会原样发送给模型。当前策划和待审/待重写正文
// 代表“这次任务具体在写谁和什么”，应高于近期摘要与全书人物名册，
// 否则久未登场的物品、地点或旧伏笔容易在百万字记忆预算中被挤掉。
export function generationMemoryTaskRelevantText({
  chapterPlan = null, currentContent = '',
} = {}) {
  return [
    typeof currentContent === 'string' ? currentContent : '',
    ...chapterPlanRelevantRows(chapterPlan),
  ].filter(Boolean).join('\n');
}

export function generationCharacterCraftRelevantText({
  book = {}, section = {}, prevChapter = null, chapterPlan = null, currentContent = '',
}) {
  const planRows = chapterPlanRelevantRows(chapterPlan);
  return [
    generationPriorSectionSummary(book, section.id),
    generationSectionOutlineText(section.outline?.content),
    recentSectionSummary(section.summary),
    previousChapterEndingText(generationChapterContent(prevChapter)),
    previousChapterHandoffText(prevChapter?.handoff),
    typeof prevChapter?.progress === 'string' ? prevChapter.progress : '',
    generationTextWindow(currentContent, MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS),
    ...generationCharacterRows(section.characters),
    ...generationCharacterRows(prevChapter?.characters),
    ...planRows,
  ].filter((value) => typeof value === 'string' && value).join('\n');
}

export function generationChapterMemorySelection(memory, {
  book = {}, section = {}, prevChapter = null, chapterPlan = null,
  currentContent = '', maxChars = MAX_MEMORY_CONTEXT_CHARS,
} = {}) {
  return generationMemorySelection(memory, {
    relevantText: generationMemoryRelevantText({ book, section, prevChapter }),
    taskRelevantText: generationMemoryTaskRelevantText({ chapterPlan, currentContent }),
    maxChars,
  });
}

export function generationChapterMemoryRows(memory, options = {}) {
  return generationChapterMemorySelection(memory, options).rows;
}

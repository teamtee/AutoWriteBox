import {
  MAX_BOOK_OUTLINE_PROMPT_CHARS, MAX_CHARACTER_PROMPT_SCOPE_CHARS,
  MAX_BOOK_PROMPT_SUMMARY_CHARS, MAX_BOOK_SECTION_SUMMARY_CHARS,
  MAX_CORE_PROMPT_FIELD_CHARS, MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS,
  MAX_MEMORY_CONTEXT_CHARS,
  MAX_SECTION_OUTLINE_PROMPT_CHARS, MAX_SECTION_PROMPT_SUMMARY_CHARS,
} from './limits.js';
import { stageSummaryIsStale } from './stage-summary-schema.js';

const OMITTED_SECTION_SUMMARY_PREFIX = '（较早的本部摘要已省略，以下为最近剧情）\n';
const OMITTED_BOOK_SUMMARY_ROW = '（更早分部剧情已因上下文预算省略）';
const OMITTED_BOOK_SECTION_PREFIX = '（本部较早剧情已省略）\n';
const OMITTED_CHARACTERS_ROW = '- …已省略中间人物，保留主要与最近条目…';
const OMITTED_TEXT_MARKER = '\n（中间内容已省略，保留开头与结尾）\n';
const OMITTED_MEMORY_ROW = '- …其它已确认记忆因上下文预算省略…';
const MEMORY_DETAIL_LABELS = Object.freeze({
  target: '关系另一方', relationType: '关系类型', strength: '关系强度',
  visibility: '公开程度', changeReason: '变化原因', eventType: '事件',
  owner: '持有人', origin: '来源', quantity: '数量', status: '状态',
  lastLocation: '最后位置', cost: '代价', limitation: '限制', from: '起点',
  to: '终点', time: '时间', order: '先后', duration: '持续',
  participants: '参与者', location: '地点',
  role: '职位', alignment: '阵营', goal: '目标', relations: '对外关系',
  territory: '控制区域', foreshadowStatus: '伏笔状态', readerKnowledge: '读者已知',
  plannedPayoff: '计划回收', actualPayoff: '实际回收', dueChapter: '截止章',
  knowledgeOwner: '知情范围', knower: '知情人物', information: '已知信息',
  learnedAt: '获知时间',
});

function generationMemoryDetailParts(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  return Object.entries(MEMORY_DETAIL_LABELS).flatMap(([field, label]) => {
    const raw = details[field];
    const value = Array.isArray(raw)
      ? raw.filter((item) => typeof item === 'string').join('、')
      : typeof raw === 'string' ? raw : '';
    return value ? [`${label}=${value}`] : [];
  });
}

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

export const generationCoreFieldText = (value) =>
  generationTextWindow(value, MAX_CORE_PROMPT_FIELD_CHARS);

export const generationBookOutlineText = (value) =>
  generationTextWindow(value, MAX_BOOK_OUTLINE_PROMPT_CHARS);

export const generationSectionOutlineText = (value) =>
  generationTextWindow(value, MAX_SECTION_OUTLINE_PROMPT_CHARS);

export function previousChapterEndingText(value) {
  if (typeof value !== 'string') return '';
  return value.slice(-MAX_PREVIOUS_CHAPTER_ENDING_PROMPT_CHARS);
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

export function recentSectionSummary(value) {
  if (typeof value !== 'string' || !value) return '';
  if (value.length <= MAX_SECTION_PROMPT_SUMMARY_CHARS) return value;
  const tailBudget = Math.max(
    0, MAX_SECTION_PROMPT_SUMMARY_CHARS - OMITTED_SECTION_SUMMARY_PREFIX.length,
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
  value, maxChars = MAX_BOOK_SECTION_SUMMARY_CHARS,
) {
  if (typeof value !== 'string' || !value) return '';
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0
    ? maxChars : MAX_BOOK_SECTION_SUMMARY_CHARS;
  if (value.length <= limit) return value;
  const tailLength = Math.max(0, limit - OMITTED_BOOK_SECTION_PREFIX.length);
  let tail = value.slice(-tailLength);
  const lineBreak = tail.indexOf('\n');
  if (lineBreak >= 0 && lineBreak < tail.length - 1) tail = tail.slice(lineBreak + 1);
  return (OMITTED_BOOK_SECTION_PREFIX + tail).slice(0, limit);
}

function bookSummaryRows(book, beforeSectionId) {
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
    return [`第${position + 1}部${title}：\n${bookSectionSummaryWindow(item.summary)}`];
  });
}

function stageAwareBookSummaryRows(book, beforeSectionId) {
  const sections = Array.isArray(book?.sections) ? book.sections : [];
  const beforeIndex = beforeSectionId === undefined
    ? sections.length : sections.indexOf(beforeSectionId);
  const end = beforeIndex < 0 ? 0 : beforeIndex;
  const candidates = (Array.isArray(book?.stageSummaries) ? book.stageSummaries : [])
    .flatMap((item) => {
      const startIndex = sections.indexOf(item?.startSectionId);
      const endIndex = sections.indexOf(item?.endSectionId);
      if (startIndex < 0 || endIndex < startIndex || endIndex >= end
        || typeof item?.summary !== 'string' || !item.summary
        || (item.status !== 'frozen' && stageSummaryIsStale(book, item))) return [];
      return [{ item, startIndex, endIndex }];
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
  if (!selected.length) return bookSummaryRows(book, beforeSectionId);

  const covered = new Set(selected.flatMap(({ startIndex, endIndex }) =>
    Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => startIndex + offset)));
  const stageAt = new Map(selected.map((item) => [item.startIndex, item]));
  const rows = [];
  for (let position = 0; position < end; position += 1) {
    const stage = stageAt.get(position);
    if (stage) {
      const suffix = stage.startIndex === stage.endIndex
        ? `第${stage.startIndex + 1}部`
        : `第${stage.startIndex + 1}–${stage.endIndex + 1}部`;
      rows.push(`阶段·${stage.item.title}（${suffix}）：\n${stage.item.summary}`);
      continue;
    }
    if (covered.has(position)) continue;
    const sectionId = sections[position];
    const item = book?.sectionSummaries?.[sectionId];
    if (!item || typeof item.summary !== 'string' || !item.summary) continue;
    const title = typeof item.title === 'string' && item.title ? ` · ${item.title}` : '';
    rows.push(`第${position + 1}部${title}：\n${bookSectionSummaryWindow(item.summary)}`);
  }
  return rows;
}

function fitRecentBookSummaryRows(rows, maxChars) {
  if (joinedRowsLength(rows) <= maxChars) return rows.join('\n');
  const available = Math.max(0, maxChars - OMITTED_BOOK_SUMMARY_ROW.length - 1);
  const selected = [];
  let used = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const cost = row.length + (selected.length ? 1 : 0);
    if (used + cost > available) break;
    selected.unshift(row);
    used += cost;
  }
  if (!selected.length && rows.length && available > 0) {
    selected.push(generationTextWindow(rows.at(-1), available));
  }
  return [OMITTED_BOOK_SUMMARY_ROW, ...selected].join('\n').slice(0, maxChars);
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
) {
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0
    ? maxChars : MAX_BOOK_PROMPT_SUMMARY_CHARS;
  const rows = stageAwareBookSummaryRows(book, currentSectionId);
  if (rows.length) return fitRecentBookSummaryRows(rows, limit);
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
    previousChapterEndingText(prevChapter?.content),
    typeof prevChapter?.progress === 'string' ? prevChapter.progress : '',
    ...generationCharacterRows(book.characters),
    ...generationCharacterRows(section.characters),
    ...generationCharacterRows(prevChapter?.characters),
  ].filter(Boolean).join('\n');
}

export function generationMemoryRows(memory, {
  relevantText = '', maxChars = MAX_MEMORY_CONTEXT_CHARS,
} = {}) {
  if (!memory || !Array.isArray(memory.facts)) return [];
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0
    ? maxChars : MAX_MEMORY_CONTEXT_CHARS;
  const ranked = memory.facts.flatMap((fact, index) => {
    if (!fact || fact.status !== 'active'
      || typeof fact.subject !== 'string' || typeof fact.predicate !== 'string'
      || typeof fact.object !== 'string') return [];
    const importance = Number.isInteger(fact.importance) ? fact.importance : 1;
    const detailParts = generationMemoryDetailParts(fact.details);
    const detailText = detailParts.join('；');
    const relevant = Boolean(relevantText)
      && (relevantText.includes(fact.subject)
        || (fact.object.length >= 2 && fact.object.length <= 80 && relevantText.includes(fact.object))
        || detailParts.some((part) => {
          const value = part.slice(part.indexOf('=') + 1);
          return value.length >= 2 && value.length <= 80 && relevantText.includes(value);
        }));
    const updatedAt = Number.isFinite(Date.parse(fact.updatedAt)) ? Date.parse(fact.updatedAt) : 0;
    const sourceLabel = Number.isInteger(fact.source?.chapterIndex)
      ? `第${fact.source.chapterIndex}章确认` : '已确认';
    return [{
      row: `- [${fact.kind || 'other'}] ${fact.subject}｜${fact.predicate}｜${fact.object}`
        + `${detailText ? `；${detailText}` : ''}（${sourceLabel}）`,
      relevant, importance, updatedAt, index,
    }];
  }).sort((a, b) => Number(b.relevant) - Number(a.relevant)
    || b.importance - a.importance
    || b.updatedAt - a.updatedAt
    || a.index - b.index);
  const rows = ranked.map((item) => item.row);
  if (joinedRowsLength(rows) <= limit) return rows;
  const selected = [];
  let used = 0;
  const available = Math.max(0, limit - OMITTED_MEMORY_ROW.length - 1);
  for (const row of rows) {
    const cost = row.length + (selected.length ? 1 : 0);
    if (used + cost > available) continue;
    selected.push(row);
    used += cost;
  }
  return [...selected, OMITTED_MEMORY_ROW];
}

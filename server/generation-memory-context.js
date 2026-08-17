import { MAX_MEMORY_CONTEXT_CHARS } from './limits.js';
import { createSubstringLookup } from './substring-index.js';

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

function memoryDetailParts(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  return Object.entries(MEMORY_DETAIL_LABELS).flatMap(([field, label]) => {
    const raw = details[field];
    const value = Array.isArray(raw)
      ? raw.filter((item) => typeof item === 'string').join('、')
      : typeof raw === 'string' ? raw : '';
    return value ? [`${label}=${value}`] : [];
  });
}

function sourceLabel(fact) {
  return Number.isInteger(fact.source?.chapterIndex)
    ? `第${fact.source.chapterIndex}章确认` : '已确认';
}

function subjectLabel(fact) {
  const aliases = Array.isArray(fact.aliases)
    ? fact.aliases.filter((item) => typeof item === 'string' && item) : [];
  return aliases.length ? `${fact.subject}（别名：${aliases.join('、')}）` : fact.subject;
}

function factRow(fact) {
  const detailText = memoryDetailParts(fact.details).join('；');
  return `- [${fact.kind || 'other'}] ${subjectLabel(fact)}｜${fact.predicate}｜${fact.object}`
    + `${detailText ? `；${detailText}` : ''}（${sourceLabel(fact)}）`;
}

function omittedMemoryRow(omittedCount, omittedTaskRelevantCount) {
  if (omittedTaskRelevantCount > 0) {
    return `- …其它已确认记忆因上下文预算省略：另有 ${omittedCount} 条，其中 `
      + `${omittedTaskRelevantCount} 条与本章直接相关…`;
  }
  return `- …其它已确认记忆因上下文预算省略：另有 ${omittedCount} 条…`;
}

function truncatedFactRow(fact, limit) {
  const row = factRow(fact);
  if (row.length <= limit) return row;
  if (limit <= 1) return row.slice(0, limit);
  const marker = '…';
  // 开头保留 kind、主体、别名和谓词；结尾保留来源。长 object/details 在中间裁剪。
  const available = limit - marker.length;
  const head = Math.ceil(available * 0.75);
  return row.slice(0, head) + marker + row.slice(-(available - head));
}

function validMatchTerm(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 80;
}

export function generationMemoryRelevantTerms(memory, taskRelevantText) {
  if (!taskRelevantText || !Array.isArray(memory?.facts)) return [];
  const terms = [];
  const seen = new Set();
  for (const fact of memory.facts) {
    if (fact?.status !== 'active') continue;
    for (const term of [fact.subject, ...(Array.isArray(fact.aliases) ? fact.aliases : [])]) {
      if (!validMatchTerm(term) || seen.has(term) || !taskRelevantText.includes(term)) continue;
      seen.add(term);
      terms.push(term);
    }
  }
  return terms;
}

export function generationMemoryRows(memory, options = {}) {
  return generationMemorySelection(memory, options).rows;
}

export function generationMemorySelection(memory, {
  relevantText = '', taskRelevantText = '', maxChars = MAX_MEMORY_CONTEXT_CHARS,
} = {}) {
  const empty = {
    rows: [], activeCount: 0, selectedCount: 0, omittedCount: 0,
    taskRelevantCount: 0, selectedTaskRelevantCount: 0,
    contextRelevantCount: 0, truncated: false,
  };
  if (!memory || !Array.isArray(memory.facts)) return empty;
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0
    ? maxChars : MAX_MEMORY_CONTEXT_CHARS;
  const containsRelevantText = createSubstringLookup(relevantText, {
    estimatedPatternCount: memory.facts.length * 2,
  });
  const containsTaskRelevantText = createSubstringLookup(taskRelevantText, {
    estimatedPatternCount: memory.facts.length * 2,
  });
  const ranked = [];
  let totalRowsLength = 0;
  for (let index = 0; index < memory.facts.length; index += 1) {
    const fact = memory.facts[index];
    if (!fact || fact.status !== 'active'
      || typeof fact.subject !== 'string' || typeof fact.predicate !== 'string'
      || typeof fact.object !== 'string') continue;
    const importance = Number.isInteger(fact.importance) ? fact.importance : 1;
    const detailParts = memoryDetailParts(fact.details);
    const aliases = Array.isArray(fact.aliases)
      ? fact.aliases.filter(validMatchTerm) : [];
    const terms = [fact.subject, ...aliases].filter(validMatchTerm);
    const matches = (source, contains) => Boolean(source)
      && (terms.some((term) => contains(term))
        || (validMatchTerm(fact.object) && contains(fact.object))
        || detailParts.some((part) => {
          const value = part.slice(part.indexOf('=') + 1);
          return validMatchTerm(value) && contains(value);
        }));
    const taskRelevant = matches(taskRelevantText, containsTaskRelevantText);
    const contextRelevant = matches(relevantText, containsRelevantText);
    const parsedUpdatedAt = Date.parse(fact.updatedAt);
    const rowLength = factRow(fact).length;
    totalRowsLength += rowLength + (ranked.length ? 1 : 0);
    ranked.push({
      fact, rowLength, taskRelevant, contextRelevant, importance,
      updatedAt: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0, index,
    });
  }
  ranked.sort((a, b) => Number(b.taskRelevant) - Number(a.taskRelevant)
    || Number(b.contextRelevant) - Number(a.contextRelevant)
    || b.importance - a.importance || b.updatedAt - a.updatedAt || a.index - b.index);
  const taskRelevantCount = ranked.filter((item) => item.taskRelevant).length;
  const contextRelevantCount = ranked.filter((item) => item.contextRelevant).length;
  if (totalRowsLength <= limit) {
    return {
      rows: ranked.map((item) => factRow(item.fact)),
      activeCount: ranked.length, selectedCount: ranked.length, omittedCount: 0,
      taskRelevantCount, selectedTaskRelevantCount: taskRelevantCount,
      contextRelevantCount, truncated: false,
    };
  }

  // 预留按最大省略数构造的提示空间，确保最终替换成实际数字后不越界。
  const reserve = omittedMemoryRow(ranked.length, taskRelevantCount).length + 1;
  const available = Math.max(0, limit - reserve);
  const selected = [];
  let used = 0;

  const append = (item, { allowTruncate = false, remainingTaskItems = 1 } = {}) => {
    const separatorCost = selected.length ? 1 : 0;
    const remaining = available - used - separatorCost;
    if (remaining <= 0) return false;
    if (item.rowLength <= remaining) {
      selected.push({ row: factRow(item.fact), taskRelevant: item.taskRelevant });
      used += separatorCost + item.rowLength;
      return true;
    }
    if (!allowTruncate) return false;
    // 对任务直接相关事实，给尚未处理的相关项均分剩余空间。宁可压缩 object
    // 和 details，也不能整条丢掉后再用无关短事实填满预算。
    const share = Math.floor((available - used - separatorCost
      - Math.max(0, remainingTaskItems - 1)) / remainingTaskItems);
    if (share < 16) return false;
    const row = truncatedFactRow(item.fact, share);
    selected.push({ row, taskRelevant: true });
    used += separatorCost + row.length;
    return true;
  };

  const taskItems = ranked.filter((item) => item.taskRelevant);
  taskItems.forEach((item, index) => append(item, {
    allowTruncate: true, remainingTaskItems: taskItems.length - index,
  }));
  for (const item of ranked) {
    if (item.taskRelevant) continue;
    append(item);
  }

  const selectedTaskRelevantCount = selected.filter((item) => item.taskRelevant).length;
  const omittedCount = ranked.length - selected.length;
  const omittedTaskRelevantCount = taskRelevantCount - selectedTaskRelevantCount;
  const omission = omittedMemoryRow(omittedCount, omittedTaskRelevantCount);
  const rows = omittedCount > 0
    ? [...selected.map((item) => item.row), omission]
    : selected.map((item) => item.row);
  return {
    rows,
    activeCount: ranked.length, selectedCount: selected.length,
    omittedCount, taskRelevantCount,
    selectedTaskRelevantCount, contextRelevantCount,
    truncated: omittedCount > 0 || selected.some((item) => item.row.includes('…')),
  };
}

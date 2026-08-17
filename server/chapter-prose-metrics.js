import {
  CHAPTER_PROSE_DECLINE_STREAK,
  MIN_CHAPTER_BODY_CHARS,
  MIN_CHAPTER_SENSORY_DENSITY_PER_1K,
  MIN_CHAPTER_SLOW_PASSAGE_CHARS,
} from './limits.js';

// 身体与感官锚点词表。只收录不易出现在人名、地名和抽象议论中的词，
// 双字词排在单字词之前，保证正则交替按最长匹配计数。它衡量的是
// “读者能否用身体感觉到这一章”，不是文采评分，也不判断细节是否得当。
const SENSORY_TERMS = Object.freeze([
  '掌心', '指尖', '后背', '膝盖', '手腕', '手指', '肩膀', '肋骨', '喉咙', '鼻尖',
  '耳边', '舌头', '心跳', '呼吸', '气味', '发烫', '发抖', '屏住', '低头', '抬头',
  '闭眼', '睁眼', '攥紧', '松开', '蹲下', '跪下', '扶住', '喘息', '吸气', '吐气',
  '冷', '热', '烫', '冻', '痛', '疼', '酸', '胀', '麻', '痒',
  '腥', '臭', '汗', '血', '泪', '喘', '颤', '抖', '咬', '皱',
  '僵', '湿', '黏', '涩', '哑', '渴', '饿', '刺', '灼', '喉',
  '咽', '舔', '嗅',
]);

const SENSORY_PATTERN = new RegExp(SENSORY_TERMS.join('|'), 'gu');
const DIALOGUE_PATTERN = /[“”„「」『』]|^\s*[-—]{1,2}\s*\S/u;

function compactLength(value) {
  return value.replace(/\s+/gu, '').length;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 逐章确定性度量。它不调用模型，也不读取策划或审稿，
 * 因此可以在任何已保存正文上重复计算并直接比较。
 */
export function measureChapterProse(value) {
  const source = typeof value === 'string' ? value : '';
  const paragraphs = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const chars = compactLength(source);
  if (!chars) {
    return {
      chars: 0, paragraphs: 0, avgParagraphChars: 0, dialogueRatio: 0,
      sensoryHits: 0, sensoryDensity: 0, longestNarrationChars: 0,
    };
  }
  let dialogueParagraphs = 0;
  let narrationRun = 0;
  let longestNarrationChars = 0;
  for (const paragraph of paragraphs) {
    if (DIALOGUE_PATTERN.test(paragraph)) {
      dialogueParagraphs += 1;
      narrationRun = 0;
      continue;
    }
    narrationRun += compactLength(paragraph);
    if (narrationRun > longestNarrationChars) longestNarrationChars = narrationRun;
  }
  const sensoryHits = (source.match(SENSORY_PATTERN) ?? []).length;
  return {
    chars,
    paragraphs: paragraphs.length,
    avgParagraphChars: paragraphs.length ? Math.round(chars / paragraphs.length) : 0,
    dialogueRatio: paragraphs.length
      ? Math.round((dialogueParagraphs * 100) / paragraphs.length) : 0,
    sensoryHits,
    sensoryDensity: round((sensoryHits * 1000) / chars),
    longestNarrationChars,
  };
}

// 经验参考值，不是合格线。它们来自“低于此值的章节通常已经退化为纪要”的
// 观察，用来提示作者和模型复核，不用来判定某一章写得好不好。
const PROSE_REFERENCES = Object.freeze([
  {
    id: 'body-length',
    label: '正文体量',
    unit: '字符',
    reference: MIN_CHAPTER_BODY_CHARS,
    read: (metrics) => metrics.chars,
    observation: (actual, reference) =>
      `正文 ${actual} 个非空白字符，低于 ${reference} 字的连载参考体量；`
      + '短章往往是关键场景被压成概述的结果，也直接影响按千字计算的订阅收入。',
  },
  {
    id: 'slow-passage',
    label: '最长连续叙述块',
    unit: '字符',
    reference: MIN_CHAPTER_SLOW_PASSAGE_CHARS,
    read: (metrics) => metrics.longestNarrationChars,
    observation: (actual, reference) =>
      `全章最长的连续叙述块 ${actual} 个字符，低于 ${reference} 的参考值；`
      + '整章由短对话和短动作行平铺时密度完全均匀，这是读者辨认 AI 文本最快的线索。',
  },
  {
    id: 'sensory-anchor',
    label: '身体与感官锚点',
    unit: '处/千字',
    reference: MIN_CHAPTER_SENSORY_DENSITY_PER_1K,
    read: (metrics) => metrics.sensoryDensity,
    observation: (actual, reference) =>
      `身体与感官锚点约 ${actual} 处/千字，低于 ${reference} 处/千字的参考值；`
      + '正文可能正在变成“谁说了什么、谁决定了什么”的纪要。',
  },
]);

/**
 * 返回逐项统计与参考值对照。belowReference 只表示低于经验值，
 * 不表示不合格；本章是否本来就该短、该快，由作者判断。
 */
export function chapterProseReferenceRows(metrics) {
  const measured = metrics ?? measureChapterProse('');
  return PROSE_REFERENCES.map((entry) => {
    const actual = entry.read(measured);
    return {
      id: entry.id,
      label: entry.label,
      unit: entry.unit,
      reference: entry.reference,
      actual,
      belowReference: actual < entry.reference,
    };
  });
}

/** 低于参考值时给出的中性观察语句；全部达到参考值时返回空数组。 */
export function chapterProseObservations(metrics) {
  const measured = metrics ?? measureChapterProse('');
  return PROSE_REFERENCES
    .filter((entry) => entry.read(measured) < entry.reference)
    .map((entry) => entry.observation(entry.read(measured), entry.reference));
}

function chapterRange(indexes) {
  return indexes.map((index) => `第${index}章`).join('、');
}

function decliningTail(rows, read, streak) {
  if (rows.length < streak) return null;
  const tail = rows.slice(-streak);
  for (let index = 1; index < tail.length; index += 1) {
    if (read(tail[index].prose) >= read(tail[index - 1].prose)) return null;
  }
  return tail;
}

function mean(rows, read) {
  return rows.reduce((sum, row) => sum + read(row.prose), 0) / rows.length;
}

/**
 * 跨章退化雷达。输入按正文顺序升序排列的已测量章节，
 * 输出确定性趋势风险。它只描述已保存正文的可计算变化，
 * 不预测质量，也不要求作者机械拉长每一章。
 */
export function analyzeChapterProseTrend(rows = [], {
  streak = CHAPTER_PROSE_DECLINE_STREAK,
} = {}) {
  const measured = (Array.isArray(rows) ? rows : [])
    .filter((row) => Number.isInteger(row?.bookChapterIndex) && row?.prose?.chars > 0);
  const risks = [];
  if (measured.length >= 2) {
    const below = [];
    for (let index = measured.length - 1; index >= 0; index -= 1) {
      if (measured[index].prose.chars >= MIN_CHAPTER_BODY_CHARS) break;
      below.unshift(measured[index]);
    }
    if (below.length >= 2) {
      risks.push({
        id: 'body-length-below-quota-streak',
        severity: 'risk',
        bookChapterIndexes: below.map((row) => row.bookChapterIndex),
        message: `${chapterRange(below.map((row) => row.bookChapterIndex))}连续低于 ${MIN_CHAPTER_BODY_CHARS} 字下限`
          + `（最近一章 ${below[below.length - 1].prose.chars} 字符）；这是持续缩水，不是单章波动。`,
      });
    }
  }
  const shrinking = decliningTail(measured, (prose) => prose.chars, streak);
  if (shrinking) {
    risks.push({
      id: 'body-length-decline',
      severity: 'risk',
      bookChapterIndexes: shrinking.map((row) => row.bookChapterIndex),
      message: `${chapterRange(shrinking.map((row) => row.bookChapterIndex))}字数连续下滑`
        + `（${shrinking.map((row) => row.prose.chars).join(' → ')}）；请检查是否在用概述代替场景。`,
    });
  }
  if (measured.length >= streak * 2) {
    const early = mean(measured.slice(0, streak), (prose) => prose.chars);
    const late = mean(measured.slice(-streak), (prose) => prose.chars);
    if (early > 0 && late < early * 0.75) {
      risks.push({
        id: 'body-length-baseline-drift',
        severity: 'risk',
        bookChapterIndexes: measured.slice(-streak).map((row) => row.bookChapterIndex),
        message: `最近 ${streak} 章平均 ${Math.round(late)} 字符，只有最早 ${streak} 章平均 ${Math.round(early)} 字符的`
          + `${Math.round((late / early) * 100)}%；整体基线已经下移，单章比较看不出来。`,
      });
    }
  }
  const drying = decliningTail(measured, (prose) => prose.sensoryDensity, streak);
  if (drying) {
    risks.push({
      id: 'sensory-density-decline',
      severity: 'advisory',
      bookChapterIndexes: drying.map((row) => row.bookChapterIndex),
      message: `${chapterRange(drying.map((row) => row.bookChapterIndex))}身体与感官锚点密度连续下降`
        + `（${drying.map((row) => row.prose.sensoryDensity).join(' → ')} 处/千字）；正文正在变干。`,
    });
  }
  const fragmenting = decliningTail(measured, (prose) => prose.avgParagraphChars, streak);
  if (fragmenting) {
    risks.push({
      id: 'paragraph-length-decline',
      severity: 'advisory',
      bookChapterIndexes: fragmenting.map((row) => row.bookChapterIndex),
      message: `${chapterRange(fragmenting.map((row) => row.bookChapterIndex))}平均段长连续变短`
        + `（${fragmenting.map((row) => row.prose.avgParagraphChars).join(' → ')} 字符）；`
        + '碎段堆叠会让所有场景听起来强度相同。',
    });
  }
  risks.sort((left, right) => (left.severity === right.severity ? 0
    : left.severity === 'risk' ? -1 : 1));
  return {
    measuredCount: measured.length,
    rows: measured.map((row) => ({
      bookChapterIndex: row.bookChapterIndex,
      chars: row.prose.chars,
      avgParagraphChars: row.prose.avgParagraphChars,
      dialogueRatio: row.prose.dialogueRatio,
      sensoryDensity: row.prose.sensoryDensity,
      longestNarrationChars: row.prose.longestNarrationChars,
    })),
    risks: risks.slice(0, 6),
  };
}

/**
 * 体量与质感的写前背景。它给出目标、原因和可用的判断依据，
 * 不列举禁令，也不要求逐条满足；具体写法由模型根据本章实际需要决定。
 */
export function formatChapterProseContext(wordTarget) {
  const target = Number.isInteger(wordTarget) && wordTarget > MIN_CHAPTER_BODY_CHARS
    ? wordTarget : MIN_CHAPTER_BODY_CHARS;
  return [
    '【体量与质感的写前背景】\n',
    `- 本作在连载平台按千字获得订阅收入，单章目标体量约 ${target} 字（非空白字符）。`,
    '这是商业背景，不是字数任务：宁可把一场关键戏演足，也不要用重复心理、寒暄或景物凑长度。\n',
    `- 可参考的经验值：当全章最长的连续叙述块低于 ${MIN_CHAPTER_SLOW_PASSAGE_CHARS} 字、`,
    `或身体与感官锚点低于 ${MIN_CHAPTER_SENSORY_DENSITY_PER_1K} 处/千字时，`,
    '正文通常已经退化成“谁说了什么、谁决定了什么”的纪要。',
    '它们是供你自查的信号，不是需要打勾的指标；真正有效的是让体温、疼痛、气味、呼吸和手上的动作',
    '参与人物当下的处境，而不是在句子里添加形容词。\n',
    '- 一个值得利用的差异：人类作者的章节密度是不均匀的。',
    '他们会在真正在乎的一场戏突然放慢、铺开写，其它地方干脆带过，甚至允许一些不推进情节的闲笔。',
    '通篇保持同一语速和同一信息密度，是读者辨认 AI 文本最快的线索。',
    '本章哪一场值得放慢，由你根据剧情判断。\n',
  ].join('');
}

export function formatChapterProseTrend(analysis) {
  if (!analysis?.rows?.length) return '';
  const lines = analysis.rows.map((row) =>
    `- 全书第 ${row.bookChapterIndex} 章：${row.chars} 字符；平均段长 ${row.avgParagraphChars}`
    + `；对话段 ${row.dialogueRatio}%；感官锚点 ${row.sensoryDensity} 处/千字`
    + `；最长叙述块 ${row.longestNarrationChars} 字符`);
  const risks = analysis.risks.length
    ? `系统从上表读出的趋势：\n${analysis.risks.map((risk) => `- ${risk.message}`).join('\n')}\n`
    : '';
  return [
    '【你最近几章的实际表现（已保存正文的统计，不含原文）】\n',
    lines.join('\n'), '\n', risks,
    '提供这些是因为你看不到自己跨章的变化趋势，而读者能直接感受到。',
    '它们是诊断信息，不是指标任务：若你判断本章确实需要一个短而快的节奏，可以偏离它们，'
      + '只要理由来自叙事本身。\n',
  ].join('');
}

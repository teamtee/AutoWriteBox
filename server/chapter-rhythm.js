import {
  CHAPTER_RHYTHM_FINGERPRINT_FIELDS, normalizeChapterRhythmFingerprint,
} from './chapter-review-schema.js';

export const CHAPTER_RHYTHM_FIELD_LABELS = Object.freeze({
  pressurePattern: '压力曲线',
  resolutionMethod: '破局方式',
  payoffScale: '兑现规模',
  hookMechanism: '章末钩子',
  costType: '代价类型',
});

export const CHAPTER_RHYTHM_VALUE_LABELS = Object.freeze({
  'steady-rise': '单向升压', 'wave-rise': '多轮起伏',
  'false-relief': '假缓解后反噬', 'reversal-led': '关键反转主导',
  'choice-led': '关键选择抬压', aftermath: '余波重组',
  none: '无', force: '力量压制', skill: '能力/技艺', wit: '计谋判断',
  negotiation: '谈判交换', sacrifice: '主动牺牲', cooperation: '协作',
  endurance: '承受熬过', discovery: '发现信息', failure: '失败转场', mixed: '混合',
  micro: '微兑现', chapter: '本章兑现', stage: '阶段兑现', major: '重大兑现',
  'new-threat': '新威胁', 'new-information': '新信息',
  'unfinished-action': '行动未完', 'forced-choice': '被迫选择',
  'relationship-shift': '关系突变', 'world-opening': '世界边界打开',
  deadline: '期限逼近', 'aftermath-question': '余波疑问',
  physical: '身体', resource: '资源', identity: '身份', relationship: '关系',
  moral: '道德', time: '时间', position: '地位', knowledge: '认知/秘密',
});

function fingerprintFrom(row) {
  const normalized = normalizeChapterRhythmFingerprint(row?.signals?.rhythmFingerprint);
  return normalized && normalized !== null ? normalized : null;
}

function signature(fingerprint) {
  return CHAPTER_RHYTHM_FINGERPRINT_FIELDS.map((field) => fingerprint[field]).join('|');
}

function chapterRange(indexes) {
  return indexes.map((index) => `第${index}章`).join('、');
}

export function formatChapterRhythmFingerprint(fingerprint) {
  const normalized = normalizeChapterRhythmFingerprint(fingerprint);
  if (!normalized || normalized === null) return '';
  return CHAPTER_RHYTHM_FINGERPRINT_FIELDS.map((field) =>
    `${CHAPTER_RHYTHM_FIELD_LABELS[field]}=${CHAPTER_RHYTHM_VALUE_LABELS[normalized[field]]}`
      + `(${normalized[field]})`).join('；');
}

export function analyzeRecentChapterRhythm(rows = []) {
  const all = Array.isArray(rows) ? rows : [];
  const recorded = all.map((row) => ({
    chapter: row?.bookChapterIndex,
    fingerprint: fingerprintFrom(row),
  })).filter((row) => Number.isInteger(row.chapter) && row.fingerprint);
  const trailing = [];
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const fingerprint = fingerprintFrom(all[index]);
    if (!fingerprint || !Number.isInteger(all[index]?.bookChapterIndex)) break;
    trailing.unshift({ chapter: all[index].bookChapterIndex, fingerprint });
  }
  const risks = [];
  if (trailing.length >= 2) {
    const tail = trailing.slice(-2);
    if (signature(tail[0].fingerprint) === signature(tail[1].fingerprint)) {
      risks.push({
        id: 'exact-pattern-repeat', severity: 'advisory', field: 'composite',
        value: signature(tail[1].fingerprint), count: 2,
        bookChapterIndexes: tail.map((row) => row.chapter),
        message: `${chapterRange(tail.map((row) => row.chapter))}采用了完全相同的节奏指纹；下一章若仍延续，至少让一种破局、兑现、钩子或代价发生有因果的升级。`,
      });
    }
  }
  for (const field of CHAPTER_RHYTHM_FINGERPRINT_FIELDS) {
    if (trailing.length >= 3) {
      const tail = trailing.slice(-3);
      const value = tail[0].fingerprint[field];
      if (tail.every((row) => row.fingerprint[field] === value)) {
        risks.push({
          id: `${field}-streak`, severity: 'risk', field, value, count: 3,
          bookChapterIndexes: tail.map((row) => row.chapter),
          message: `${chapterRange(tail.map((row) => row.chapter))}连续使用${CHAPTER_RHYTHM_FIELD_LABELS[field]}“${CHAPTER_RHYTHM_VALUE_LABELS[value]}”；必须审查读者疲劳，不能只换名词。`,
        });
        continue;
      }
    }
    if (recorded.length >= 5) {
      const recent = recorded.slice(-5);
      const counts = new Map();
      for (const row of recent) {
        const value = row.fingerprint[field];
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      const repeated = [...counts.entries()].find(([, count]) => count >= 4);
      if (repeated) {
        const [value, count] = repeated;
        const matches = recent.filter((row) => row.fingerprint[field] === value);
        risks.push({
          id: `${field}-dominance`, severity: 'advisory', field, value, count,
          bookChapterIndexes: matches.map((row) => row.chapter),
          message: `最近5个有效记录中有${count}章使用${CHAPTER_RHYTHM_FIELD_LABELS[field]}“${CHAPTER_RHYTHM_VALUE_LABELS[value]}”；检查它是否仍在升级，而非机械复刻。`,
        });
      }
    }
  }
  risks.sort((left, right) => (left.severity === right.severity ? 0
    : left.severity === 'risk' ? -1 : 1));
  return {
    recordedCount: recorded.length,
    trailingCount: trailing.length,
    risks: risks.slice(0, 6),
  };
}

export function analyzePlannedChapterRhythm(intent, rows = [], bookChapterIndex) {
  const normalized = normalizeChapterRhythmFingerprint(intent);
  if (!normalized || normalized === null) return { risks: [] };
  const lastChapter = Array.isArray(rows)
    ? rows.reduce((max, row) => Number.isInteger(row?.bookChapterIndex)
      ? Math.max(max, row.bookChapterIndex) : max, 0) : 0;
  const chapter = Number.isInteger(bookChapterIndex) ? bookChapterIndex : lastChapter + 1;
  const analysis = analyzeRecentChapterRhythm([
    ...(Array.isArray(rows) ? rows : []),
    { bookChapterIndex: chapter, signals: { rhythmFingerprint: normalized } },
  ]);
  return {
    ...analysis,
    risks: analysis.risks.filter((risk) => risk.bookChapterIndexes.includes(chapter)),
  };
}

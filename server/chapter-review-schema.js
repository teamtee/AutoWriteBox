import {
  MAX_REVIEW_CHECK_DETAIL_CHARS, MAX_REVIEW_SIGNAL_CHARS,
} from './limits.js';

export const CHAPTER_REVIEW_CHECK_IDS = Object.freeze([
  'goldenChapter',
  'premisePromise',
  'chapterGoal',
  'obstacleEscalation',
  'characterChoice',
  'sceneExecution',
  'effectiveIncrement',
  'payoff',
  'endingHook',
  'tensionDynamics',
  'foreshadowingExecution',
  'worldExpansion',
  'proseHumanity',
  'expressionBalance',
  'repetitionRisk',
  'longArcProgress',
  'styleConsistency',
  'packagingPromise',
  'contentRisk',
]);

// 兼容加入张力、埋点、世界边界和去 AI 味专项检查前保存的旧审稿。
const PRE_PROMPT_QUALITY_CHAPTER_REVIEW_CHECK_IDS = CHAPTER_REVIEW_CHECK_IDS.filter(
  (id) => !['tensionDynamics', 'foreshadowingExecution', 'worldExpansion', 'proseHumanity']
    .includes(id),
);
const PRE_SCENE_CHAPTER_REVIEW_CHECK_IDS = PRE_PROMPT_QUALITY_CHAPTER_REVIEW_CHECK_IDS.filter(
  (id) => id !== 'sceneExecution',
);
const PREVIOUS_CHAPTER_REVIEW_CHECK_IDS = PRE_SCENE_CHAPTER_REVIEW_CHECK_IDS.filter(
  (id) => id !== 'contentRisk',
);
const PRE_PACKAGING_CHAPTER_REVIEW_CHECK_IDS = PREVIOUS_CHAPTER_REVIEW_CHECK_IDS.filter(
  (id) => id !== 'packagingPromise',
);
const PRE_STYLE_CHAPTER_REVIEW_CHECK_IDS = PRE_PACKAGING_CHAPTER_REVIEW_CHECK_IDS.filter(
  (id) => id !== 'styleConsistency',
);
const LEGACY_CHAPTER_REVIEW_CHECK_IDS = PRE_STYLE_CHAPTER_REVIEW_CHECK_IDS.filter(
  (id) => id !== 'longArcProgress',
);

export const CHAPTER_REVIEW_CHECK_STATUSES = Object.freeze(['pass', 'risk', 'na']);
export const CHAPTER_REVIEW_SIGNAL_FIELDS = Object.freeze([
  'chapterFunction',
  'conflictType',
  'emotionTone',
  'payoffType',
  'dominantMode',
]);
export const CHAPTER_RHYTHM_FINGERPRINT_OPTIONS = Object.freeze({
  pressurePattern: Object.freeze([
    'steady-rise', 'wave-rise', 'false-relief', 'reversal-led', 'choice-led', 'aftermath',
  ]),
  resolutionMethod: Object.freeze([
    'none', 'force', 'skill', 'wit', 'negotiation', 'sacrifice', 'cooperation',
    'endurance', 'discovery', 'failure', 'mixed',
  ]),
  payoffScale: Object.freeze(['none', 'micro', 'chapter', 'stage', 'major']),
  hookMechanism: Object.freeze([
    'none', 'new-threat', 'new-information', 'unfinished-action', 'forced-choice',
    'relationship-shift', 'world-opening', 'deadline', 'aftermath-question',
  ]),
  costType: Object.freeze([
    'none', 'physical', 'resource', 'identity', 'relationship', 'moral',
    'time', 'position', 'knowledge', 'mixed',
  ]),
});
export const CHAPTER_RHYTHM_FINGERPRINT_FIELDS = Object.freeze(
  Object.keys(CHAPTER_RHYTHM_FINGERPRINT_OPTIONS),
);

const CHECK_ID_SET = new Set(CHAPTER_REVIEW_CHECK_IDS);
const CHECK_STATUS_SET = new Set(CHAPTER_REVIEW_CHECK_STATUSES);

function cleanText(value, maxLength, truncate) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length > maxLength && !truncate) return null;
  return chars.slice(0, maxLength).join('');
}

function uniqueChapterQuote(quote, chapterContent, minimumLength = 4) {
  if (typeof chapterContent !== 'string') return true;
  if (Array.from(quote).length < minimumLength) return false;
  const first = chapterContent.indexOf(quote);
  return first >= 0 && chapterContent.indexOf(quote, first + 1) < 0;
}

function normalizeOrderedEvidence(value, fields, { chapterContent }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  let cursor = 0;
  for (const field of fields) {
    const quote = cleanText(value[field], MAX_REVIEW_CHECK_DETAIL_CHARS, false);
    if (!quote || !uniqueChapterQuote(quote, chapterContent)) return null;
    if (typeof chapterContent === 'string') {
      const index = chapterContent.indexOf(quote, cursor);
      if (index < 0) return null;
      cursor = index + quote.length;
    }
    result[field] = quote;
  }
  return result;
}

// 新模型输出必须在提供检查表时一次给齐，避免 UI 把“模型漏字段”误画成
// 通过。旧审稿没有该字段仍然合法，便于现有书籍和备份无损升级。
export function normalizeChapterReviewChecks(value, {
  truncate = false, chapterContent, requireProseHumanityEvidence = false,
  requirePayoffEvidence = false, requireCostEvidence = false,
  requireHookEvidence = false, requireIncrementEvidence = false,
  requireObstacleEvidence = false, requireChoiceEvidence = false,
  requireSceneEvidence = false, requireGoalEvidence = false,
  requireLongArcEvidence = false, requireTensionEvidence = false,
  requirePremiseEvidence = false, requireGoldenEvidence = false,
  requireStyleRiskEvidence = false,
} = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const expectedIds = value.length === CHAPTER_REVIEW_CHECK_IDS.length
    ? CHAPTER_REVIEW_CHECK_IDS
    : value.length === PRE_PROMPT_QUALITY_CHAPTER_REVIEW_CHECK_IDS.length
      ? PRE_PROMPT_QUALITY_CHAPTER_REVIEW_CHECK_IDS
      : value.length === PRE_SCENE_CHAPTER_REVIEW_CHECK_IDS.length
        ? PRE_SCENE_CHAPTER_REVIEW_CHECK_IDS
        : value.length === PREVIOUS_CHAPTER_REVIEW_CHECK_IDS.length
          ? PREVIOUS_CHAPTER_REVIEW_CHECK_IDS
          : value.length === PRE_PACKAGING_CHAPTER_REVIEW_CHECK_IDS.length
            ? PRE_PACKAGING_CHAPTER_REVIEW_CHECK_IDS
            : value.length === PRE_STYLE_CHAPTER_REVIEW_CHECK_IDS.length
              ? PRE_STYLE_CHAPTER_REVIEW_CHECK_IDS
              : value.length === LEGACY_CHAPTER_REVIEW_CHECK_IDS.length
                ? LEGACY_CHAPTER_REVIEW_CHECK_IDS
                : null;
  if (!expectedIds) return null;

  const byId = new Map();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !CHECK_ID_SET.has(item.id) || !CHECK_STATUS_SET.has(item.status)
      || byId.has(item.id)) {
      return null;
    }
    const detail = cleanText(item.detail, MAX_REVIEW_CHECK_DETAIL_CHARS, truncate);
    if (!detail) return null;
    const rawEvidence = Object.prototype.hasOwnProperty.call(item, 'evidence')
      ? item.evidence : undefined;
    const evidence = rawEvidence === undefined || rawEvidence === ''
      ? undefined
      : cleanText(rawEvidence, MAX_REVIEW_CHECK_DETAIL_CHARS, false);
    if (rawEvidence !== undefined && rawEvidence !== '' && !evidence) return null;
    if (evidence && !uniqueChapterQuote(evidence, chapterContent, 6)) return null;
    const evidenceRequired = item.status === 'risk'
      && (item.id === 'proseHumanity' && requireProseHumanityEvidence
        || requireStyleRiskEvidence
          && ['expressionBalance', 'repetitionRisk', 'styleConsistency'].includes(item.id));
    if (evidenceRequired
      && (!evidence || typeof chapterContent !== 'string'
        || !chapterContent.includes(evidence))) return null;
    let choiceEvidence;
    if (item.id === 'characterChoice' && item.status === 'pass'
      && (requireChoiceEvidence
        || Object.prototype.hasOwnProperty.call(item, 'choiceEvidence'))) {
      choiceEvidence = normalizeOrderedEvidence(
        item.choiceEvidence, ['pressureQuote', 'choiceQuote'], { chapterContent, truncate },
      );
      if (!choiceEvidence) return null;
    }
    let costEvidence;
    if (item.id === 'characterChoice' && item.status === 'pass'
      && (requireCostEvidence || Object.prototype.hasOwnProperty.call(item, 'costEvidence'))) {
      costEvidence = normalizeOrderedEvidence(
        item.costEvidence, ['choiceQuote', 'consequenceQuote'], { chapterContent, truncate },
      );
      if (!costEvidence
        || (choiceEvidence && choiceEvidence.choiceQuote !== costEvidence.choiceQuote)) return null;
    }
    let goldenEvidence;
    if (item.id === 'goldenChapter' && item.status === 'pass'
      && (requireGoldenEvidence
        || Object.prototype.hasOwnProperty.call(item, 'goldenEvidence'))) {
      goldenEvidence = normalizeOrderedEvidence(
        item.goldenEvidence, ['setupQuote', 'fulfillmentQuote'], { chapterContent, truncate },
      );
      if (!goldenEvidence) return null;
    }
    let premiseEvidence;
    if (item.id === 'premisePromise' && item.status === 'pass'
      && (requirePremiseEvidence
        || Object.prototype.hasOwnProperty.call(item, 'premiseEvidence'))) {
      premiseEvidence = normalizeOrderedEvidence(
        item.premiseEvidence, ['promiseQuote', 'deliveryQuote'], { chapterContent, truncate },
      );
      if (!premiseEvidence) return null;
    }
    let tensionEvidence;
    if (item.id === 'tensionDynamics' && item.status === 'pass'
      && (requireTensionEvidence
        || Object.prototype.hasOwnProperty.call(item, 'tensionEvidence'))) {
      tensionEvidence = normalizeOrderedEvidence(
        item.tensionEvidence, ['pressureQuote', 'shiftQuote', 'aftermathQuote'],
        { chapterContent, truncate },
      );
      if (!tensionEvidence) return null;
    }
    let longArcEvidence;
    if (item.id === 'longArcProgress' && item.status === 'pass'
      && (requireLongArcEvidence
        || Object.prototype.hasOwnProperty.call(item, 'longArcEvidence'))) {
      longArcEvidence = normalizeOrderedEvidence(
        item.longArcEvidence, ['threadQuote', 'progressQuote'], { chapterContent, truncate },
      );
      if (!longArcEvidence) return null;
    }
    let goalEvidence;
    if (item.id === 'chapterGoal' && item.status === 'pass'
      && (requireGoalEvidence || Object.prototype.hasOwnProperty.call(item, 'goalEvidence'))) {
      goalEvidence = normalizeOrderedEvidence(
        item.goalEvidence, ['goalQuote', 'attemptQuote'], { chapterContent, truncate },
      );
      if (!goalEvidence) return null;
    }
    let sceneEvidence;
    if (item.id === 'sceneExecution' && item.status === 'pass'
      && (requireSceneEvidence
        || Object.prototype.hasOwnProperty.call(item, 'sceneEvidence'))) {
      sceneEvidence = normalizeOrderedEvidence(
        item.sceneEvidence, ['actionQuote', 'reactionQuote', 'turnQuote'],
        { chapterContent, truncate },
      );
      if (!sceneEvidence) return null;
    }
    let obstacleEvidence;
    if (item.id === 'obstacleEscalation' && item.status === 'pass'
      && (requireObstacleEvidence
        || Object.prototype.hasOwnProperty.call(item, 'obstacleEvidence'))) {
      obstacleEvidence = normalizeOrderedEvidence(
        item.obstacleEvidence, ['baseQuote', 'escalatedQuote'], { chapterContent, truncate },
      );
      if (!obstacleEvidence) return null;
    }
    let incrementEvidence;
    if (item.id === 'effectiveIncrement' && item.status === 'pass'
      && (requireIncrementEvidence
        || Object.prototype.hasOwnProperty.call(item, 'incrementEvidence'))) {
      incrementEvidence = normalizeOrderedEvidence(
        item.incrementEvidence, ['triggerQuote', 'stateQuote'], { chapterContent, truncate },
      );
      if (!incrementEvidence) return null;
    }
    let hookEvidence;
    if (item.id === 'endingHook' && item.status === 'pass'
      && (requireHookEvidence || Object.prototype.hasOwnProperty.call(item, 'hookEvidence'))) {
      hookEvidence = normalizeOrderedEvidence(
        item.hookEvidence, ['setupQuote', 'hookQuote'], { chapterContent, truncate },
      );
      if (!hookEvidence) return null;
    }
    let payoffEvidence;
    if (item.id === 'payoff' && item.status === 'pass'
      && (requirePayoffEvidence || Object.prototype.hasOwnProperty.call(item, 'payoffEvidence'))) {
      payoffEvidence = normalizeOrderedEvidence(
        item.payoffEvidence, ['actionQuote', 'resultQuote'], { chapterContent, truncate },
      );
      if (!payoffEvidence) return null;
    }
    byId.set(item.id, {
      id: item.id, status: item.status, detail,
      ...(evidence === undefined ? {} : { evidence }),
      ...(goldenEvidence === undefined ? {} : { goldenEvidence }),
      ...(premiseEvidence === undefined ? {} : { premiseEvidence }),
      ...(goalEvidence === undefined ? {} : { goalEvidence }),
      ...(obstacleEvidence === undefined ? {} : { obstacleEvidence }),
      ...(sceneEvidence === undefined ? {} : { sceneEvidence }),
      ...(incrementEvidence === undefined ? {} : { incrementEvidence }),
      ...(choiceEvidence === undefined ? {} : { choiceEvidence }),
      ...(costEvidence === undefined ? {} : { costEvidence }),
      ...(payoffEvidence === undefined ? {} : { payoffEvidence }),
      ...(hookEvidence === undefined ? {} : { hookEvidence }),
      ...(tensionEvidence === undefined ? {} : { tensionEvidence }),
      ...(longArcEvidence === undefined ? {} : { longArcEvidence }),
    });
  }
  if (byId.size !== expectedIds.length
    || expectedIds.some((id) => !byId.has(id))) return null;
  return expectedIds.map((id) => byId.get(id));
}

export function normalizeChapterRhythmFingerprint(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const field of CHAPTER_RHYTHM_FINGERPRINT_FIELDS) {
    if (!CHAPTER_RHYTHM_FINGERPRINT_OPTIONS[field].includes(value[field])) return null;
    result[field] = value[field];
  }
  return result;
}

export function normalizeChapterReviewSignals(value, {
  truncate = false, requireRhythmFingerprint = false,
} = {}) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const field of CHAPTER_REVIEW_SIGNAL_FIELDS) {
    const text = cleanText(value[field], MAX_REVIEW_SIGNAL_CHARS, truncate);
    if (!text) return null;
    result[field] = text;
  }
  const rhythmFingerprint = normalizeChapterRhythmFingerprint(value.rhythmFingerprint);
  if (rhythmFingerprint === null
    || (requireRhythmFingerprint && rhythmFingerprint === undefined)) return null;
  return {
    ...result,
    ...(rhythmFingerprint === undefined ? {} : { rhythmFingerprint }),
  };
}

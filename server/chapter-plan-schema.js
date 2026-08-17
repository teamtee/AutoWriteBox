import { createHash } from 'node:crypto';
import {
  MAX_CHAPTER_PLAN_FIELD_CHARS, MAX_CHAPTER_PLAN_NOTES_CHARS,
  MAX_CHAPTER_PLAN_SCENES, MAX_CHAPTER_PLAN_SCENE_FIELD_CHARS,
  MAX_CHAPTER_PLAN_SCENE_TITLE_CHARS,
} from './limits.js';
import {
  chapterPlanDesignDiagnostics, chapterPlanQualityDiagnostics,
  chapterPlanWorldLinkAlignment,
} from './chapter-plan-quality.js';
import {
  CHAPTER_RHYTHM_FINGERPRINT_FIELDS, CHAPTER_RHYTHM_FINGERPRINT_OPTIONS,
} from './chapter-review-schema.js';
import { analyzePlannedChapterRhythm } from './chapter-rhythm.js';

export const CHAPTER_PLAN_FIELDS = Object.freeze([
  'goal', 'obstacle', 'choice', 'payoff', 'hook',
  'tensionArc', 'foreshadowing', 'worldExpansion',
  'decisionChain', 'knowledgeDesign', 'notes',
]);
export const CHAPTER_PLAN_SCENE_FIELDS = Object.freeze([
  'title', 'trigger', 'desire', 'obstacle', 'action', 'turn', 'cost',
]);
export const CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION = 3;
export const CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION = 1;
export const CHAPTER_PLAN_RHYTHM_INTENT_VERSION = 1;

export function emptyChapterRhythmIntent() {
  return Object.fromEntries(CHAPTER_RHYTHM_FINGERPRINT_FIELDS.map((field) => [field, '']));
}

function normalizeChapterRhythmIntent(value, errorCode) {
  if (value === undefined) return emptyChapterRhythmIntent();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(errorCode);
  const result = emptyChapterRhythmIntent();
  for (const field of CHAPTER_RHYTHM_FINGERPRINT_FIELDS) {
    const option = value[field] === undefined ? '' : value[field];
    if (typeof option !== 'string'
      || (option && !CHAPTER_RHYTHM_FINGERPRINT_OPTIONS[field].includes(option))) {
      throw new Error(errorCode);
    }
    result[field] = option;
  }
  return result;
}

export function chapterRhythmIntentComplete(value) {
  return value && CHAPTER_RHYTHM_FINGERPRINT_FIELDS.every((field) =>
    CHAPTER_RHYTHM_FINGERPRINT_OPTIONS[field].includes(value[field]));
}

const PLACEHOLDER_PLAN_TEXT = /^(?:待定|待补充|待完善|待确认|暂无|无|不知道|待进一步明确)[。！!？?]?$/u;

function meaningfulPlanText(value) {
  return typeof value === 'string' && Boolean(value.trim())
    && !PLACEHOLDER_PLAN_TEXT.test(value.trim());
}

export function chapterPlanReadiness(value, {
  promiseAlignment, sectionOutline, recentReviewSignals, bookChapterIndex,
  requireCurrentProtocol = false,
} = {}) {
  const plan = normalizeChapterPlan(value);
  const quality = chapterPlanQualityDiagnostics(plan);
  const design = chapterPlanDesignDiagnostics(plan);
  const qualityProtocolActive = (plan.qualityProtocolVersion ?? 0) >= 1;
  const designProtocolActive = plan.designProtocolVersion
    === CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION;
  const completeCore = ['goal', 'obstacle', 'choice', 'payoff', 'hook']
    .every((field) => meaningfulPlanText(plan[field]));
  const hasScenes = plan.scenes.length > 0;
  const completeScenes = hasScenes && plan.scenes.every((scene) =>
    ['desire', 'obstacle', 'action', 'turn', 'cost']
      .every((field) => meaningfulPlanText(scene[field])));
  const hasAnySceneTrigger = plan.scenes.some((scene) =>
    Object.prototype.hasOwnProperty.call(scene, 'trigger'));
  const completeSceneTriggers = hasScenes && plan.scenes.every((scene) =>
    meaningfulPlanText(scene.trigger));
  const checks = [
    ...(requireCurrentProtocol ? [{
      id: 'quality-protocol', label: '当前质量合同',
      pass: plan.qualityProtocolVersion === CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION,
      detail: plan.qualityProtocolVersion === CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION
        ? `已启用质量合同 v${CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION}。`
        : `首次生成必须保存质量合同 v${CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION}；旧策划只允许继续读取和重写已有正文。`,
    }, {
      id: 'design-protocol', label: '当前叙事设计合同',
      pass: designProtocolActive,
      detail: designProtocolActive
        ? `已启用叙事设计合同 v${CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION}。`
        : `首次生成必须保存叙事设计合同 v${CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION}，防止免费线索、万能解法和外挂钩子。`,
    }] : []),
    {
      id: 'movement', label: '故事推进', pass: completeCore,
      detail: completeCore ? '目标、阻碍、选择、兑现和后续牵引均已明确。'
        : '补全目标、具体阻碍、人物主动选择、兑现和章末牵引；不能用“待定”等占位。',
    },
    {
      id: 'agency', label: '主角行动',
      pass: meaningfulPlanText(plan.choice)
        && hasScenes && plan.scenes.every((scene) => meaningfulPlanText(scene.action)),
      detail: meaningfulPlanText(plan.choice)
        && hasScenes && plan.scenes.every((scene) => meaningfulPlanText(scene.action))
        ? '关键选择与每场具体行动均已落到策划。'
        : '写清人物必须做出的选择，并让每场都有具体行动，不能只听解释或被人带路。',
    },
    {
      id: 'causality', label: '场景因果', pass: completeScenes,
      detail: completeScenes ? '每场均具备欲望、阻碍、行动、转折和代价。'
        : '至少安排一个完整场景，并写清欲望、现场阻碍、行动、局势转折和代价。',
    },
    {
      id: 'scene-linkage', label: '场景承接',
      // 旧策划没有 trigger 字段时仍可继续使用；新策划一旦开始填写，就必须
      // 每场给齐，避免只给第一场加一句承接、后面仍是并列事件。
      pass: completeSceneTriggers,
      advisory: !requireCurrentProtocol && !hasAnySceneTrigger,
      detail: completeSceneTriggers
        ? '每场都明确由上一章、本章诱因或上一场结果触发。'
        : !hasAnySceneTrigger && !requireCurrentProtocol
          ? '旧策划未记录场景承接；建议写清第一场的来因，以及后续每场消费上一场的哪项结果或代价。'
          : '首次生成或一旦填写场景承接，每一场都必须写清为何此刻发生，不能留下断链场景。',
    },
    {
      id: 'decision-chain', label: '决策—反制—状态改写',
      pass: designProtocolActive && design.decision.valid,
      advisory: !requireCurrentProtocol && !designProtocolActive,
      detail: !designProtocolActive && !requireCurrentProtocol
        ? '旧策划未记录决策因果合同；采用新 AI 候选后，必须写清误判、不可撤回行动、利益受损者、针对性反制、状态改写和后续索债。'
        : design.decision.valid
          ? '人物行动、利益受损者、针对性反制、章末状态变化和后续债务均已明确。'
          : '按“当前误判/未决、验证/争取行动、利益受损者、针对性反制、状态改写、后续索债”填写；状态改写必须写成章初状态→章末状态。',
    },
    {
      id: 'knowledge-design', label: '认知与证据边界',
      pass: designProtocolActive && design.knowledge.valid,
      advisory: !requireCurrentProtocol && !designProtocolActive,
      detail: !designProtocolActive && !requireCurrentProtocol
        ? '旧策划未记录认知证据合同；采用新 AI 候选后，有判断任务时需保留替代解释并交叉验证，无任务时要明确聚焦。'
        : design.knowledge.valid
          ? design.knowledge.mode === 'none'
            ? '本章明确不新增或改写判断，篇幅聚焦与既有问题边界均已说明。'
            : `允许结论、保留未知、${design.knowledge.alternativeCount} 个替代解释和 ${design.knowledge.crossValidationCount} 个交叉来源均已明确。`
          : '有判断任务时按“当前问题、可见依据、允许结论、替代解释、交叉验证、保留未知”填写；替代解释至少两项并用“｜”分隔，交叉验证至少两个独立来源并用“＋”分隔。无判断任务时使用无认知任务合同。',
    },
    {
      id: 'earned-payoff', label: '有效兑现',
      pass: meaningfulPlanText(plan.obstacle) && meaningfulPlanText(plan.payoff)
        && hasScenes && plan.scenes.every((scene) => meaningfulPlanText(scene.cost)),
      detail: meaningfulPlanText(plan.obstacle) && meaningfulPlanText(plan.payoff)
        && hasScenes && plan.scenes.every((scene) => meaningfulPlanText(scene.cost))
        ? '阻碍、兑现与行动代价均已明确。'
        : '兑现必须由人物跨过具体阻碍并承担后果产生，不能让危险或门槛自行消失。',
    },
    {
      id: 'tension-design', label: '张力设计',
      pass: qualityProtocolActive && quality.tension.valid,
      advisory: !qualityProtocolActive,
      detail: !qualityProtocolActive
        ? '旧策划按兼容模式使用；采用新 AI 候选或升级模板后，将要求压力来源、具体变化链、选择高点、兑现与余波。'
        : quality.tension.valid
          ? `张力合同完整，变化链含 ${quality.tension.chainCount} 个具体局势节点。`
          : '按“压力来源、变化链、选择高点、兑现与余波”填写；变化链至少三个不同的具体局势，且后续节点要明确消费前一步行动或后果，不能只写“受阻→希望→反转”或三个并列事故。',
    },
    {
      id: 'foreshadowing-design', label: '埋点落地',
      pass: qualityProtocolActive && quality.foreshadowing.valid,
      advisory: !qualityProtocolActive,
      detail: !qualityProtocolActive
        ? '旧策划按兼容模式使用；采用新 AI 候选或升级模板后，将要求叙事节拍、认知变化、载体、行动后果、世界线作用和保留未知。'
        : quality.foreshadowing.valid
          ? quality.foreshadowing.mode === 'none'
            ? '本章明确不新增或处理埋点，并说明了聚焦功能与既有未知的边界。'
            : plan.qualityProtocolVersion >= 3
              ? '本章叙事节拍、读者认知变化、载体、行动后果、世界线作用和信息边界均已明确。'
              : '旧版线索合同完整；建议升级后明确叙事节拍、读者认知变化与世界线作用。'
          : plan.qualityProtocolVersion >= 3
            ? '有埋点任务时必须选择一个叙事节拍，写清认知变化、载体、当下作用、行动影响、世界线作用与保留未知；没有任务时使用无任务合同。'
            : '有埋点任务时按旧线、载体、当下作用、行动影响、保留未知填写；没有任务时使用无任务合同。',
    },
    {
      id: 'world-expansion-design', label: '世界展开',
      pass: qualityProtocolActive && quality.worldExpansion.valid,
      advisory: !qualityProtocolActive,
      detail: !qualityProtocolActive
        ? '旧策划按兼容模式使用；采用新 AI 候选或升级模板后，将增加展开前认知，并要求既有依据、证据、边界增量、选择代价和保留未知。'
        : quality.worldExpansion.valid
          ? plan.qualityProtocolVersion >= 2
            ? '世界展开已区分展开前后认知，并落实为既有规则、证据、人物选择与代价。'
            : 'v1 世界展开已落实既有规则、证据、人物选择与代价；建议升级后补充展开前认知。'
          : plan.qualityProtocolVersion >= 2
            ? '按“展开前认知、既有依据、可验证证据、边界增量/机制深化、选择与代价、保留未知”填写，不能只写“出现更大势力”。'
            : '按“既有依据、可验证证据、边界增量/机制深化、选择与代价、保留未知”填写；升级后还需补充展开前认知。',
    },
  ];
  const rhythmIntentActive = plan.rhythmIntentVersion === CHAPTER_PLAN_RHYTHM_INTENT_VERSION;
  const completeRhythmIntent = rhythmIntentActive && chapterRhythmIntentComplete(plan.rhythmIntent);
  checks.push({
    id: 'rhythm-intent', label: '节奏意图', pass: completeRhythmIntent,
    advisory: !requireCurrentProtocol && !rhythmIntentActive,
    detail: !rhythmIntentActive && !requireCurrentProtocol
      ? '旧策划未记录受控节奏意图；继续兼容，采用新 AI 候选后会补齐。'
      : !rhythmIntentActive
        ? '首次生成必须保存当前五维节奏意图，不能只写“跌宕”“反转”或自由文本。'
      : completeRhythmIntent
        ? '压力轨迹、破局方式、兑现规模、钩子机制和关键代价均已明确。'
        : '补全五维受控节奏意图；不能只写“跌宕”“反转”或自由文本。',
  });
  if (completeRhythmIntent && Array.isArray(recentReviewSignals)) {
    const variation = analyzePlannedChapterRhythm(
      plan.rhythmIntent, recentReviewSignals, bookChapterIndex,
    );
    if (variation.risks.length) {
      checks.push({
        id: 'rhythm-variation', label: '跨章节奏变奏', pass: false, advisory: true,
        detail: variation.risks.map((risk) => risk.message).join(' '),
      });
    }
  }
  const worldLinkAlignment = sectionOutline === undefined
    ? { required: false, valid: true, gateCondition: '' }
    : chapterPlanWorldLinkAlignment(plan, sectionOutline);
  if (worldLinkAlignment.required) {
    checks.push({
      id: 'foreshadowing-world-gate', label: '伏笔—世界门槛',
      pass: worldLinkAlignment.valid,
      detail: worldLinkAlignment.valid
        ? '伏笔世界线作用已逐字锚定当前分部的下一层门槛。'
        : worldLinkAlignment.gateCondition
          ? `选择“支撑下一层门槛”时，世界线作用必须逐字包含当前门槛：${worldLinkAlignment.gateCondition}`
          : '当前分部没有有效世界合同，不能把伏笔标成支撑下一层门槛。',
    });
  }
  if (promiseAlignment) {
    const pass = !promiseAlignment.invalidReferences?.length
      && !promiseAlignment.narrativeConflicts?.length
      && (!promiseAlignment.requiresAction || promiseAlignment.satisfied);
    checks.push({
      id: 'reading-debt-action', label: '阅读债务', pass,
      detail: promiseAlignment.invalidReferences?.length
        ? '策划中的债务 ID 或动作与账本状态不一致；不能把计划中承诺当成读者已知。'
        : promiseAlignment.narrativeConflicts?.length
          ? '策划同时安排多笔债务却只有一份节拍合同，叙事节拍与建立/推进/兑现动作不符，或“读者原先判断”没有接上上一个已确认节拍的“读者新判断”。'
        : promiseAlignment.requiresAction
          ? pass
            ? `已安排处理当前最高优先级阅读债务（${promiseAlignment.addressedBlockingUrgentIds?.length ?? promiseAlignment.addressedUrgentIds.length} 笔）。`
            : `有 ${promiseAlignment.urgentCount} 笔债务已进入兑现窗口或逾期，其中 ${promiseAlignment.blockingUrgentCount ?? promiseAlignment.urgentCount} 笔处于当前最高优先级；请选择其中一笔推进、兑现，或写明延期原因。`
          : '当前没有需要本章优先处理的阅读债务；不得为填字段临时制造谜团。',
    });
    if (promiseAlignment.repeatedBeatIds?.length) {
      checks.push({
        id: 'reading-debt-rhythm', label: '债务节拍变化', pass: false, advisory: true,
        detail: `该债务将连续第三次使用同一叙事节拍（${promiseAlignment.repeatedBeatIds.length} 笔）；若非因果链必需，应改用变义、碰撞或其他推进方式。`,
      });
    }
  }
  return { ready: checks.every((check) => check.pass || check.advisory), checks };
}

export function emptyChapterPlan() {
  return {
    goal: '', obstacle: '', choice: '', payoff: '', hook: '',
    tensionArc: '', foreshadowing: '', worldExpansion: '',
    decisionChain: '', knowledgeDesign: '', notes: '', scenes: [],
  };
}

function normalizeField(value, field, errorCode, sizeErrorCode) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(errorCode);
  const text = value.trim();
  const maxLength = field === 'notes'
    ? MAX_CHAPTER_PLAN_NOTES_CHARS
    : MAX_CHAPTER_PLAN_FIELD_CHARS;
  if (text.length > maxLength * 2 || Array.from(text).length > maxLength) {
    throw new Error(sizeErrorCode);
  }
  return text;
}

function normalizeSceneField(value, field, errorCode, sizeErrorCode) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error(errorCode);
  const text = value.trim();
  const maxLength = field === 'title'
    ? MAX_CHAPTER_PLAN_SCENE_TITLE_CHARS
    : MAX_CHAPTER_PLAN_SCENE_FIELD_CHARS;
  if (text.length > maxLength * 2 || Array.from(text).length > maxLength) {
    throw new Error(sizeErrorCode);
  }
  return text;
}

function normalizeScenes(value, errorCode, sizeErrorCode) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(errorCode);
  if (value.length > MAX_CHAPTER_PLAN_SCENES) throw new Error(sizeErrorCode);
  return value.flatMap((scene) => {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
      throw new Error(errorCode);
    }
    const normalized = {};
    for (const field of CHAPTER_PLAN_SCENE_FIELDS) {
      const fieldValue = normalizeSceneField(
        scene[field], field, errorCode, sizeErrorCode,
      );
      // 旧场景没有 trigger 属性。保留“字段缺席”和“新表单明确留空”的差异：
      // 前者只提示升级建议，后者阻止把新建的断链策划误判为可生成。
      if (field === 'trigger' && !fieldValue
        && !Object.prototype.hasOwnProperty.call(scene, field)) continue;
      normalized[field] = fieldValue;
    }
    return CHAPTER_PLAN_SCENE_FIELDS.some((field) => normalized[field])
      ? [normalized]
      : [];
  });
}

export function normalizeChapterPlan(value, {
  errorCode = 'BAD_CHAPTER_PLAN',
  sizeErrorCode = 'CHAPTER_PLAN_TOO_LARGE',
} = {}) {
  if (value === undefined) return emptyChapterPlan();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  const normalized = emptyChapterPlan();
  const rawProtocolVersion = value.qualityProtocolVersion;
  if (!Number.isInteger(rawProtocolVersion)
    && rawProtocolVersion !== undefined) {
    throw new Error(errorCode);
  }
  if (rawProtocolVersion !== undefined
    && ![0, 1, 2, CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION].includes(rawProtocolVersion)) {
    throw new Error(errorCode);
  }
  // 版本 0 是旧策划的兼容视图，不写回持久化对象，也不改变历史修订号。
  // 只有明确采用新版质量合同时才记录版本，旧备份因此仍保持原始形状。
  if ([1, 2, CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION].includes(rawProtocolVersion)) {
    normalized.qualityProtocolVersion = rawProtocolVersion;
  }
  const rawDesignProtocolVersion = value.designProtocolVersion;
  if (rawDesignProtocolVersion !== undefined
    && rawDesignProtocolVersion !== 0
    && rawDesignProtocolVersion !== CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION) {
    throw new Error(errorCode);
  }
  if (rawDesignProtocolVersion === CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION) {
    normalized.designProtocolVersion = CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION;
  }
  const rawRhythmIntentVersion = value.rhythmIntentVersion;
  if (rawRhythmIntentVersion !== undefined
    && rawRhythmIntentVersion !== 0
    && rawRhythmIntentVersion !== CHAPTER_PLAN_RHYTHM_INTENT_VERSION) throw new Error(errorCode);
  if (rawRhythmIntentVersion === CHAPTER_PLAN_RHYTHM_INTENT_VERSION) {
    normalized.rhythmIntentVersion = CHAPTER_PLAN_RHYTHM_INTENT_VERSION;
    normalized.rhythmIntent = normalizeChapterRhythmIntent(value.rhythmIntent, errorCode);
  } else if (value.rhythmIntent !== undefined) {
    const legacyIntent = normalizeChapterRhythmIntent(value.rhythmIntent, errorCode);
    if (Object.values(legacyIntent).some(Boolean)) throw new Error(errorCode);
  }
  for (const field of CHAPTER_PLAN_FIELDS) {
    normalized[field] = normalizeField(value[field], field, errorCode, sizeErrorCode);
  }
  normalized.scenes = normalizeScenes(value.scenes, errorCode, sizeErrorCode);
  return normalized;
}

export function chapterPlanRevision(value) {
  const plan = normalizeChapterPlan(value);
  return createHash('sha256').update(JSON.stringify(plan)).digest('base64url');
}

export function chapterPlanView(value, {
  promiseAlignment, sectionOutline, recentReviewSignals, bookChapterIndex,
  requireCurrentProtocol = false,
} = {}) {
  const plan = normalizeChapterPlan(value);
  const isEmpty = CHAPTER_PLAN_FIELDS.every((field) => !plan[field])
    && plan.scenes.length === 0;
  // 新空章直接使用当前协议，避免新写作继续落入旧版宽松门槛；已有非空旧策划
  // 仍显示为 v0 兼容模式，只有作者编辑质量字段或采用 AI 候选时才升级。
  const qualityProtocolVersion = [1, 2, CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION]
    .includes(plan.qualityProtocolVersion)
    ? plan.qualityProtocolVersion
    : isEmpty ? CHAPTER_PLAN_QUALITY_PROTOCOL_VERSION : 0;
  const designProtocolVersion = plan.designProtocolVersion
    === CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION
    ? CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION
    : isEmpty ? CHAPTER_PLAN_DESIGN_PROTOCOL_VERSION : 0;
  const rhythmIntentVersion = plan.rhythmIntentVersion === CHAPTER_PLAN_RHYTHM_INTENT_VERSION
    ? CHAPTER_PLAN_RHYTHM_INTENT_VERSION : isEmpty ? CHAPTER_PLAN_RHYTHM_INTENT_VERSION : 0;
  const publicPlan = {
    ...plan, qualityProtocolVersion, designProtocolVersion, rhythmIntentVersion,
    rhythmIntent: plan.rhythmIntent ?? emptyChapterRhythmIntent(),
  };
  return {
    ...publicPlan,
    revision: chapterPlanRevision(plan),
    isEmpty,
    readiness: chapterPlanReadiness(publicPlan, {
      promiseAlignment, sectionOutline, recentReviewSignals, bookChapterIndex,
      requireCurrentProtocol,
    }),
  };
}

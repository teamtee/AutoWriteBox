import {
  generationBookOutlineText, generationCharacterCraftRelevantText,
  generationChapterMemorySelection,
  generationCharacterRows, generationCoreFieldText,
  generationPriorSectionSummary, generationSectionOutlineText,
  previousChapterEndingText, recentSectionSummary,
  previousChapterHandoffText,
} from './generation-context.js';
import { normalizeChapterPlan } from './chapter-plan-schema.js';
import { normalizeStoryEngine } from './story-engine-schema.js';
import {
  chapterPlanPromiseAlignment, generationPromiseLedgerRows,
} from './promise-ledger-schema.js';
import { generationCharacterCraftRows } from './character-craft-schema.js';
import { WORLD_BIBLE_SECTION_LABELS, worldBibleDiagnostics } from './world-bible.js';
import { STYLE_BIBLE_SECTION_LABELS, styleBibleDiagnostics } from './style-bible.js';
import {
  chapterPlanDesignDiagnostics, chapterPlanQualityDiagnostics,
} from './chapter-plan-quality.js';
import { sectionWorldContract } from './section-world-contract.js';
import {
  worldProgressContextState, worldProgressPrompt,
} from './world-progress-schema.js';
import {
  analyzePlannedChapterRhythm, analyzeRecentChapterRhythm,
  formatChapterRhythmFingerprint,
} from './chapter-rhythm.js';
import {
  analyzeChapterProseTrend, chapterProseReferenceRows, measureChapterProse,
} from './chapter-prose-metrics.js';
import {
  buildChapterContextBudget, chapterContextRequests, CHAPTER_CONTEXT_LAYERS,
} from './context-budget.js';

const OMISSION_PATTERN = /(?:因上下文预算省略|中间内容已省略|较早[^\n]{0,30}已省略|已省略中间|较低优先级[^\n]{0,30}未发送|不相关[^\n]{0,30}未发送)/u;

function text(value) {
  return typeof value === 'string' ? value : '';
}

function currentText(versioned) {
  if (!versioned) return '';
  if (Array.isArray(versioned.versions)) return text(versioned.versions[versioned.cursor]);
  return text(versioned.content);
}

function item(id, label, value, { count, status, note, truncated } = {}) {
  const content = Array.isArray(value) ? value.join('\n') : text(value);
  return {
    id,
    label,
    status: status ?? (content ? 'included' : 'missing'),
    characters: content.length,
    ...(Number.isInteger(count) ? { count } : {}),
    ...(note ? { note } : {}),
    truncated: truncated ?? OMISSION_PATTERN.test(content),
  };
}

function nonEmptyCount(value) {
  return Object.values(value).filter((entry) => typeof entry === 'string' && entry).length;
}

function layer(id, label, items) {
  return { id, label, items };
}

function warning(id, severity, message) {
  return { id, severity, message };
}

export function buildChapterContextManifest({
  book = {}, section = {}, chapter = {}, previousChapter = null,
  bookChapterIndex = chapter?.index ?? 1, recentReviewSignals = [],
  writingAssetContext = { text: '', scene: null, assetIds: [] },
  modelContextChars,
} = {}) {
  const plan = normalizeChapterPlan(chapter.plan);
  const planQuality = chapterPlanQualityDiagnostics(plan);
  const proseTrend = analyzeChapterProseTrend(recentReviewSignals);
  const planDesign = chapterPlanDesignDiagnostics(plan);
  const rhythmAnalysis = analyzeRecentChapterRhythm(recentReviewSignals);
  const rhythmIntentText = formatChapterRhythmFingerprint(plan.rhythmIntent);
  const plannedRhythmAnalysis = analyzePlannedChapterRhythm(
    plan.rhythmIntent, recentReviewSignals, bookChapterIndex,
  );
  const storyEngine = normalizeStoryEngine(book?.settings?.storyEngine);
  const bookCharacters = generationCharacterRows(book.characters);
  const sectionCharacters = generationCharacterRows(section.characters);
  const previousCharacters = generationCharacterRows(previousChapter?.characters);
  const memorySelection = generationChapterMemorySelection(book.memory, {
    book, section, prevChapter: previousChapter, chapterPlan: plan,
    currentContent: currentText(chapter.body),
  });
  const memoryRows = memorySelection.rows;
  const promiseRows = generationPromiseLedgerRows(book?.settings?.promiseLedger, {
    bookChapterIndex,
  });
  const promiseAlignment = chapterPlanPromiseAlignment(book?.settings?.promiseLedger, {
    bookChapterIndex, plan,
  });
  const characterCraftRows = generationCharacterCraftRows(
    book?.settings?.characterCraft,
    { relevantText: generationCharacterCraftRelevantText({
      book, section, prevChapter: previousChapter,
      chapterPlan: plan, currentContent: currentText(chapter.body),
    }) },
  );
  const previousEnding = previousChapter
    ? previousChapterEndingText(currentText(previousChapter.body)) : '';
  const previousHandoff = previousChapterHandoffText(previousChapter?.handoff);
  const previousBody = currentText(previousChapter?.body);
  const currentBody = currentText(chapter.body);
  const budgetInput = {
    book, section, prevChapter: previousChapter, currentContent: currentBody,
    writingAssetContext: text(writingAssetContext?.text),
  };
  const budgetRequests = chapterContextRequests(budgetInput);
  const budgetResult = buildChapterContextBudget(budgetInput, { modelContextChars });
  const budgetTrimmedIds = new Set(budgetResult.trimmed.map((entry) => entry.id));
  const budgetLayers = CHAPTER_CONTEXT_LAYERS.map((entry) => ({
    id: entry.id, label: entry.label,
    want: Math.min(budgetRequests[entry.id] ?? entry.cap, entry.cap),
    characters: budgetResult.allocation[entry.id],
    floor: entry.floor,
    priority: entry.priority,
    truncated: budgetTrimmedIds.has(entry.id),
  }));
  const currentProse = measureChapterProse(currentBody);
  const proseReference = currentProse.chars ? chapterProseReferenceRows(currentProse) : null;
  const core = book?.settings?.core ?? {};
  const coreFields = Object.fromEntries(['world', 'style', 'constraints', 'pacing']
    .map((field) => [field, generationCoreFieldText(currentText(core[field]))]));
  const worldDiagnostics = worldBibleDiagnostics(coreFields.world);
  const sectionWorld = sectionWorldContract(section.outline?.content);
  const confirmedWorldProgress = worldProgressContextState(
    book?.settings?.worldProgressState, coreFields.world,
  );
  const confirmedWorldProgressText = worldProgressPrompt(
    book?.settings?.worldProgressState, coreFields.world,
  );
  const styleDiagnostics = styleBibleDiagnostics(coreFields.style);
  const planCoreFields = ['goal', 'obstacle', 'choice', 'payoff', 'hook'];
  const planQualityFields = [
    'tensionArc', 'foreshadowing', 'worldExpansion',
    'decisionChain', 'knowledgeDesign',
  ];
  const planRows = [...planCoreFields, ...planQualityFields, 'notes']
    .map((field) => plan[field]).filter(Boolean);
  const sceneRows = plan.scenes.flatMap((scene) => Object.values(scene).filter(Boolean));
  const linkedSceneCount = plan.scenes.filter((scene) => scene.trigger).length;
  const triggerAwareSceneCount = plan.scenes.filter((scene) =>
    Object.prototype.hasOwnProperty.call(scene, 'trigger')).length;
  const layers = [
    layer('facts', '已发生事实与连续性', [
      item('world-rules', '世界规则', coreFields.world, {
        note: coreFields.world
          ? `世界圣经栏目 ${worldDiagnostics.sectionCount}/${WORLD_BIBLE_SECTION_LABELS.length}；${worldDiagnostics.characters} 字符。`
          : '',
      }),
      item('hard-constraints', '禁忌硬约束', coreFields.constraints),
      item('prior-sections', '此前分部剧情', generationPriorSectionSummary(book, section.id)),
      item('section-summary', '本部前情', recentSectionSummary(section.summary)),
      item('confirmed-memory', '已确认长期记忆', memoryRows, {
        count: memorySelection.selectedCount,
        note: memorySelection.activeCount
          ? `活动事实 ${memorySelection.activeCount} 项；本次任务直接命中 ${memorySelection.selectedTaskRelevantCount}/${memorySelection.taskRelevantCount} 项；${memorySelection.omittedCount} 项因预算未装入。`
          : '',
        truncated: memorySelection.truncated,
      }),
      item('book-characters', '主要人物快照', bookCharacters, { count: bookCharacters.length }),
      item('section-characters', '本部人物快照', sectionCharacters, {
        count: sectionCharacters.length,
      }),
      item('previous-ending', '上一有效章结尾', previousEnding, {
        status: previousEnding ? 'included' : bookChapterIndex <= 1 ? 'not-applicable' : 'missing',
        note: previousEnding
          ? previousBody.length > previousEnding.length
            ? `超长章只携带末尾 ${previousEnding.length} 字符。`
            : '上一章未超过窗口，正文完整携带。'
          : '',
        truncated: previousBody.length > previousEnding.length,
      }),
      item('previous-handoff', '上一有效章场景交接快照', previousHandoff, {
        status: previousEnding
          ? previousHandoff ? 'included' : 'missing'
          : 'not-applicable',
        note: previousHandoff
          ? '由摘要 API 从上一章正文末态提取；与原文或已确认事实冲突时以后两者为准。'
          : '',
      }),
      item('previous-characters', '上一有效章登场人物', previousCharacters, {
        count: previousCharacters.length,
        status: previousEnding
          ? previousCharacters.length ? 'included' : 'missing'
          : 'not-applicable',
      }),
      item('current-body', '当前章正文', currentBody, {
        status: currentBody ? 'included' : 'not-applicable',
        note: currentBody
          ? '审稿与重写会携带完整当前正文；首次生成不携带空正文。'
          : '首次生成没有当前正文；生成后审稿将读取模型新正文。',
      }),
    ]),
    layer('plans', '作者方向与当前章计划', [
      item('book-title', '书名', text(book.title)),
      item('premise', '作品简介 / 初始设想', generationCoreFieldText(text(book.premise))),
      item('book-outline', '全书大纲', generationBookOutlineText(currentText(book.outline))),
      item('confirmed-world-progress', '已确认世界层级进度', confirmedWorldProgressText, {
        count: confirmedWorldProgress.activeGates.length,
        note: `后续新分部允许起始层：${confirmedWorldProgress.startLayer}。只有作者确认的正文证据才会推进。`,
      }),
      item('section-outline', '本部大纲', generationSectionOutlineText(section.outline?.content)),
      item('section-world-contract', '本部当前世界执行合同', sectionWorld
        ? Object.values(sectionWorld).join('\n') : '', {
        note: sectionWorld
          ? `当前层：${sectionWorld.layer}；门槛计划：${sectionWorld.gateOutcome}；保留未知、允许认知增量与进入门槛已单独注入。`
          : '当前本部大纲没有可提取的世界执行合同。',
      }),
      item('story-engine', '作品核心循环', Object.values(storyEngine).join('\n'), {
        count: nonEmptyCount(storyEngine),
      }),
      item('chapter-plan', '章节策划核心字段', planRows, { count: planRows.length }),
      item('rhythm-intent', '写前节奏意图', rhythmIntentText, {
        count: rhythmIntentText ? 5 : 0,
        note: rhythmIntentText
          ? `与最近记录比较后有 ${plannedRhythmAnalysis.risks.length} 项重复风险。`
          : '旧策划或尚未补全五维节奏意图。',
      }),
      item('scene-chain', '场景因果链', sceneRows, {
        count: plan.scenes.length,
        note: plan.scenes.length
          ? `承接触发 ${linkedSceneCount}/${plan.scenes.length} 场。` : '',
      }),
      item('next-progress', '上一章剧情路标', text(previousChapter?.progress), {
        status: previousChapter ? text(previousChapter.progress) ? 'included' : 'missing'
          : 'not-applicable',
      }),
    ]),
    layer('debts', '阅读债务与作者导演信息', [
      item('promise-ledger', '承诺—推进—兑现账本', promiseRows, {
        count: promiseRows.length,
      }),
      item('character-craft', '人物驱动力与声音', characterCraftRows, {
        count: characterCraftRows.length,
      }),
      item('recent-rhythm', '最近章节节奏记录', recentReviewSignals.map((row) =>
        row?.signals ? JSON.stringify(row.signals) : ''), {
        count: recentReviewSignals.filter((row) => row?.signals).length,
        note: rhythmAnalysis.recordedCount
          ? `受控指纹 ${rhythmAnalysis.recordedCount} 章；识别到 ${rhythmAnalysis.risks.length} 项跨章重复风险。`
          : '旧审稿可能只有自由文本标签，尚不能进行确定性跨章比较。',
      }),
    ]),
    layer('expression', '表达与去 AI 味约束', [
      item('style', '文风基调', coreFields.style, {
        note: coreFields.style
          ? `文风圣经栏目 ${styleDiagnostics.sectionCount}/${STYLE_BIBLE_SECTION_LABELS.length}；${styleDiagnostics.characters} 字符。`
          : '',
      }),
      item('pacing', '篇幅节奏', coreFields.pacing),
      item('writing-assets', '绑定创作资产', text(writingAssetContext?.text), {
        count: Array.isArray(writingAssetContext?.assetIds)
          ? writingAssetContext.assetIds.length : 0,
        note: writingAssetContext?.scene ? `当前场景：${writingAssetContext.scene}` : '',
      }),
      item('quality-rules', '通用网文章法与去 AI 味规则', '', {
        status: 'included', note: '由系统提示词固定注入。',
      }),
      item('prose-reference', '正文体量与质感参考', '', {
        status: 'included',
        note: proseReference
          ? `当前正文 ${currentProse.chars} 字符，`
            + `${proseReference.filter((row) => row.belowReference).length}/3 项低于经验参考值。`
          : '本章尚无正文；参考体量和写法背景会随生成指令一并发送。',
      }),
      item('prose-trend', '最近章节体量与质感趋势', '', {
        status: proseTrend.measuredCount ? 'included' : 'missing',
        count: proseTrend.measuredCount,
        note: proseTrend.measuredCount
          ? `已统计 ${proseTrend.measuredCount} 章；识别到 ${proseTrend.risks.length} 项退化趋势。`
          : '没有可比较的已保存正文，跨章退化无法确定性判断。',
      }),
    ]),
  ];
  const warnings = [];
  if (!coreFields.world) {
    warnings.push(warning('missing-world-rules', 'risk', '缺少世界规则，模型无法稳定约束能力、制度、地点与宏观冲突。'));
  } else if (!worldDiagnostics.valid) {
    warnings.push(warning(
      'thin-world-bible', 'advisory',
      `世界观仍是简略草稿（${worldDiagnostics.characters} 字符，结构栏目 ${worldDiagnostics.sectionCount}/${WORLD_BIBLE_SECTION_LABELS.length}）；建议用 API 重构世界圣经。`,
    ));
  }
  if (bookChapterIndex > 1 && !previousEnding) {
    warnings.push(warning(
      'missing-previous-ending', 'risk',
      '没有可用的上一有效章结尾，承接与人物即时状态只能依赖摘要。',
    ));
  }
  if (previousEnding && !previousHandoff) {
    warnings.push(warning(
      'missing-previous-handoff', 'advisory',
      '上一有效章还没有场景交接快照；API 仍会读取章末原文，但对视角、时间地点、进行中动作和物品/知识边界的显式接力较弱。可重算上一章记忆补齐。',
    ));
  }
  if (!generationBookOutlineText(currentText(book.outline))) {
    warnings.push(warning('missing-book-outline', 'advisory', '缺少全书大纲，长线方向约束较弱。'));
  }
  if (coreFields.world && !sectionWorld) {
    warnings.push(warning(
      'missing-section-world-contract', 'advisory',
      '本部没有可执行的世界层级合同；章节只能依靠世界圣经与策划卡判断认知边界。建议采用新版 API 分部规划。',
    ));
  }
  if (nonEmptyCount(storyEngine) < 5) {
    warnings.push(warning('incomplete-story-engine', 'advisory', '作品核心循环未完整，持续爽点与升级方式不够稳定。'));
  }
  if (memorySelection.taskRelevantCount > memorySelection.selectedTaskRelevantCount) {
    warnings.push(warning(
      'task-memory-truncated', 'risk',
      `当前策划或正文直接提及的长期事实有 ${memorySelection.taskRelevantCount - memorySelection.selectedTaskRelevantCount} 项未进入上下文；请精简同名冗余事实或拆分本章任务。`,
    ));
  }
  if ((plan.qualityProtocolVersion ?? 0) < 3 && planQuality.active) {
    warnings.push(warning(
      'legacy-plan-quality-contract', 'advisory',
      plan.qualityProtocolVersion === 2
        ? '当前 v2 策划已有世界认知边界，但伏笔尚未记录叙事节拍、读者认知变化与世界线作用；采用新 AI 候选或填入新版模板可升级。'
        : plan.qualityProtocolVersion === 1
          ? '当前 v1 策划缺少世界展开前认知及伏笔节拍链；采用新 AI 候选或填入新版模板可升级。'
          : '当前张力、埋点和世界展开来自旧策划，尚未按可执行标签校验；采用新 AI 候选或填入新版模板可升级。',
    ));
  }
  if (plan.designProtocolVersion !== 1 && (planRows.length || plan.scenes.length)) {
    warnings.push(warning(
      'missing-narrative-design-contract', 'advisory',
      '旧策划未记录决策反制与认知证据边界；采用新 AI 候选后可防止主角被线索牵着走、反派送证据和章尾外挂事故。',
    ));
  } else if (!planDesign.decision.valid) {
    warnings.push(warning(
      'invalid-decision-chain', 'risk',
      '决策因果链必须写清当前误判、不可撤回行动、利益受损者、针对性反制、章初→章末状态改写和后续索债。',
    ));
  } else if (!planDesign.knowledge.valid) {
    warnings.push(warning(
      'invalid-knowledge-design', 'risk',
      '认知证据合同必须限制允许结论，保留至少两个替代解释并安排两个独立交叉来源；无判断任务时应明确聚焦与既有判断边界。',
    ));
  }
  if (!plan.tensionArc) {
    warnings.push(warning('missing-tension-arc', 'advisory', '未填写张力曲线，正文容易全章同一强度。'));
  } else if (plan.qualityProtocolVersion >= 1 && !planQuality.tension.valid) {
    warnings.push(warning('invalid-tension-contract', 'risk', '张力合同缺少压力来源、三段具体局势、选择高点或兑现余波。'));
  }
  if (plan.rhythmIntentVersion === 1 && !rhythmIntentText) {
    warnings.push(warning('incomplete-rhythm-intent', 'risk', '写前节奏意图未补全，无法在正文生成前比较跨章同构。'));
  } else if (!rhythmIntentText && (planRows.length || plan.scenes.length)) {
    warnings.push(warning('missing-rhythm-intent', 'advisory', '旧策划未记录五维写前节奏意图；采用新 API 候选后可升级。'));
  }
  for (const risk of plannedRhythmAnalysis.risks) {
    warnings.push(warning(`planned-rhythm-${risk.id}`, 'advisory', `当前策划：${risk.message}`));
  }
  if (plan.scenes.length && !triggerAwareSceneCount) {
    warnings.push(warning(
      'missing-scene-linkage', 'advisory',
      '旧场景链未记录承接触发；正文可能把合格场景并列拼接，建议补清每场为何在此刻发生。',
    ));
  } else if (triggerAwareSceneCount && linkedSceneCount !== plan.scenes.length) {
    warnings.push(warning(
      'incomplete-scene-linkage', 'risk',
      `场景承接只完成 ${linkedSceneCount}/${plan.scenes.length}；后续场必须消费前场转折或代价。`,
    ));
  }
  if (!plan.foreshadowing) {
    warnings.push(warning('missing-foreshadowing', 'advisory', '未填写埋点任务或无任务理由，本章是否处理阅读债务与未知边界不明确。'));
  } else if (plan.qualityProtocolVersion >= 1 && !planQuality.foreshadowing.valid) {
    warnings.push(warning(
      'invalid-foreshadowing-contract', 'risk',
      plan.qualityProtocolVersion >= 3
        ? '埋点合同必须选择单一叙事节拍，完整说明认知变化、载体、当下作用、行动后果、世界线作用与保留未知，或使用无任务合同。'
        : '埋点合同必须完整说明旧线、载体、当下作用、行动影响与保留未知，或完整说明无埋点理由、本章聚焦与既有未知边界。',
    ));
  }
  if (promiseAlignment.invalidReferences.length) {
    warnings.push(warning(
      'invalid-reading-debt-reference', 'risk',
      '章节策划引用了不存在的债务，或把计划中承诺当成已建立债务；请按账本中的稳定 ID 和状态重新选择。',
    ));
  } else if (promiseAlignment.narrativeConflicts.length) {
    warnings.push(warning(
      'broken-reading-debt-chain', 'risk',
      '债务动作与叙事节拍错配，或本章“读者原判断”没有接上上一个已确认节拍的“读者新判断”。',
    ));
  } else if (promiseAlignment.requiresAction && !promiseAlignment.satisfied) {
    warnings.push(warning(
      'unaddressed-urgent-reading-debt', 'risk',
      `有 ${promiseAlignment.urgentCount} 笔已进入兑现窗口或逾期的阅读债务，其中 ${promiseAlignment.blockingUrgentCount ?? promiseAlignment.urgentCount} 笔处于当前最高优先级；本章未推进、兑现或有理由延期其中任何一笔。`,
    ));
  }
  if (promiseAlignment.repeatedBeatIds.length) {
    warnings.push(warning(
      'repeated-reading-debt-beat', 'advisory',
      `有 ${promiseAlignment.repeatedBeatIds.length} 笔债务连续第三次采用同一叙事节拍；审查是否已变成机械重复。`,
    ));
  }
  if (!plan.worldExpansion) {
    warnings.push(warning('missing-world-expansion', 'advisory', '未填写世界边界，本章可能只堆设定名词或没有认知增量。'));
  } else if (plan.qualityProtocolVersion >= 1 && !planQuality.worldExpansion.valid) {
    warnings.push(warning(
      'invalid-world-expansion-contract', 'risk',
      plan.qualityProtocolVersion >= 2
        ? '世界展开合同缺少展开前认知、既有依据、可验证证据、边界增量、选择代价或保留未知。'
        : '世界展开合同缺少既有依据、可验证证据、边界增量、选择代价或保留未知。',
    ));
  }
  if (!coreFields.style && !writingAssetContext?.text) {
    warnings.push(warning('missing-style-anchor', 'advisory', '没有文风设定或绑定资产，语言风格只能依赖通用规则。'));
  } else if (coreFields.style && !styleDiagnostics.valid) {
    warnings.push(warning(
      'thin-style-bible', 'advisory',
      `文风仍是简略草稿（${styleDiagnostics.characters} 字符，结构栏目 ${styleDiagnostics.sectionCount}/${STYLE_BIBLE_SECTION_LABELS.length}）；建议用 API 重构文风圣经。`,
    ));
  }
  if (bookChapterIndex > 3 && !promiseRows.length) {
    warnings.push(warning('missing-reading-debt', 'advisory', '没有相关承诺账本条目，长线阅读债务只能依赖大纲与摘要。'));
  }
  if (bookChapterIndex > 3 && !recentReviewSignals.some((row) => row?.signals)) {
    warnings.push(warning('missing-rhythm-history', 'advisory', '没有最近章节节奏记录，无法自动识别连续同质冲突与情绪疲劳。'));
  }
  for (const risk of rhythmAnalysis.risks) {
    warnings.push(warning(`rhythm-${risk.id}`, risk.severity, risk.message));
  }
  // 单章低于参考值不产生告警：一章写得短可以是正确选择，数字直接展示即可。
  // 只有跨章持续下滑才是作者看不见、而读者能感受到的信号。
  for (const risk of proseTrend.risks) {
    warnings.push(warning(`prose-trend-${risk.id}`, risk.severity, risk.message));
  }
  if (!characterCraftRows.length && (bookCharacters.length + sectionCharacters.length) > 1) {
    warnings.push(warning('missing-character-voice', 'advisory', '多人章节没有相关人物导演卡，对话声音分化约束较弱。'));
  }
  const truncatedItems = layers.flatMap((entry) => entry.items)
    .filter((entry) => entry.truncated).map((entry) => entry.id);
  if (truncatedItems.length) {
    warnings.push(warning(
      'context-truncated', 'advisory',
      `有 ${truncatedItems.length} 类材料按上下文预算裁剪；省略会在提示词中显式标记。`,
    ));
  }
  return {
    schemaVersion: 1,
    bookChapterIndex,
    layers,
    budget: {
      ceiling: budgetResult.ceiling,
      fixedOverheadCharacters: budgetResult.fixedOverheadChars,
      assignableCharacters: budgetResult.total,
      remainingCharacters: budgetResult.remaining,
      layers: budgetLayers,
    },
    prose: {
      current: currentProse.chars ? currentProse : null,
      reference: proseReference,
      trend: proseTrend,
    },
    warnings,
    riskCount: warnings.filter((entry) => entry.severity === 'risk').length,
    advisoryCount: warnings.filter((entry) => entry.severity === 'advisory').length,
    truncatedItems,
  };
}

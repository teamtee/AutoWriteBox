#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as store from '../server/store.js';
import {
  nonStreamChat, extractChapterPlanDraft, extractNarrativeDesignDraft,
} from '../server/llm.js';
import {
  buildChapterPlanDraftInstruction, buildNarrativeDesignDraftInstruction,
} from '../server/prompts.js';
import {
  chapterPlanDesignDiagnostics, chapterPlanQualityDiagnostics,
} from '../server/chapter-plan-quality.js';
import {
  chapterPlanReadiness, normalizeChapterPlan,
} from '../server/chapter-plan-schema.js';

const DATA_ROOT = path.resolve(process.cwd(), 'data');
const OUTPUT_ROOT = path.resolve(
  process.cwd(), 'data', '.generation-runs', 'narrative-capability-validation',
);
const SYSTEM = '你是严谨的长篇小说策划编辑。只输出用户要求的严格 JSON，不要 Markdown、代码围栏或解释。';
const JUDGE_SYSTEM = [
  '你是独立的长篇小说总编，只评价剧情设计的实际阅读效果，不奖励字段数量、术语或格式复杂度。',
  '必须检查人物主动性、对手是否聪明、因果接力、章末状态变化、信息边界、题材适配和继续阅读动力。',
  '只输出严格 JSON。',
].join('');

const SCENARIOS = Object.freeze([
  {
    id: 'suspense', name: '都市调查悬疑', chapterIndex: 6,
    context: [
      '故事：港口理货员沈砚调查哥哥在仓库坠亡的旧案。上一章他取得一张纸质交接单，显示哥哥死亡后两小时仍有人用其工号提货。',
      '本章目标：在不惊动港务主管罗荃的情况下核验工号使用者。沈砚只能使用已经成立的理货流程、纸质单据和同事关系；不能黑入系统、不能收到匿名答案。',
      '作者边界：本章最多证明死亡记录与提货记录不能同时为真，不能确认罗荃是凶手，也不能确认哥哥仍活着。',
    ].join('\n'),
  },
  {
    id: 'relationship', name: '家庭关系余波', chapterIndex: 18,
    context: [
      '故事：父亲葬礼后，姐姐程雁发现弟弟程野曾私自卖掉祖屋一半产权。上一章真相已经确认，本章不再调查新秘密。',
      '本章目标：姐弟必须在当天搬空祖屋前决定是否继续共同照顾患病母亲。姐姐想得到诚实与边界，弟弟想保住照护资格又害怕被赶走。',
      '作者边界：本章应消费背叛的关系后果，不新增遗嘱、私生子、神秘债主或突然疾病；结尾必须形成新的照护规则或决裂状态。',
    ].join('\n'),
  },
  {
    id: 'action', name: '灾难行动', chapterIndex: 27,
    context: [
      '故事：暴雨灌入地铁施工隧道，民间救援队长周渡要在二十分钟内带出七名工人。承包商安全主管魏成坚持先转移设备，担心违规记录曝光。',
      '本章目标：周渡必须用已建立的绳索、排水图和工人经验改变撤离路线；不能突然获得新装备、军方支援或超能力。',
      '作者边界：本章可以救出一部分人，但必须留下由周渡选择造成的资源、关系或时间代价；章末压力必须来自本章行动，不得另投放无关爆炸。',
    ].join('\n'),
  },
]);

function trimFence(value) {
  return String(value ?? '').trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '').trim();
}

function extractObject(value) {
  const text = trimFence(value);
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function ask(config, prompt, label, attempts = 2, system = SYSTEM) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const output = await nonStreamChat({
        config: { ...config, requestTimeoutMs: Math.max(config.requestTimeoutMs ?? 0, 300_000) },
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      if (!output?.trim()) throw new Error('EMPTY_OUTPUT');
      return output.trim();
    } catch (error) {
      lastError = error;
      process.stderr.write(`[${label}] attempt ${attempt} failed: ${error?.message || error}\n`);
    }
  }
  throw lastError;
}

function baselinePrompt(scenario) {
  return [
    `请为长篇小说第 ${scenario.chapterIndex} 章生成写前策划，不写正文。`,
    '上下文：', scenario.context,
    '策划要有明确目标、阻碍、人物选择、兑现、钩子和2到4个连续场景；不能凭空增加万能能力或工具。',
    '只返回严格 JSON：',
    '{"goal":"","obstacle":"","choice":"","payoff":"","hook":"",',
    '"tensionArc":"","foreshadowing":"","worldExpansion":"","notes":"",',
    '"scenes":[{"title":"","trigger":"","desire":"","obstacle":"","action":"","turn":"","cost":""}]}',
  ].join('\n');
}

function designPrompt(scenario) {
  return buildNarrativeDesignDraftInstruction({
    chapterIndex: scenario.chapterIndex,
    bookChapterIndex: scenario.chapterIndex,
    context: scenario.context,
    seedPlan: {},
    currentContent: '',
  });
}

function newPrompt(scenario, narrativeDesign) {
  return buildChapterPlanDraftInstruction({
    chapterIndex: scenario.chapterIndex,
    bookChapterIndex: scenario.chapterIndex,
    context: scenario.context,
    seedPlan: {},
    currentContent: '',
    recentReviewSignals: [],
    fixedNarrativeDesign: narrativeDesign,
  });
}

function planProjection(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    goal: plan.goal ?? '', obstacle: plan.obstacle ?? '', choice: plan.choice ?? '',
    payoff: plan.payoff ?? '', hook: plan.hook ?? '',
    tensionArc: plan.tensionArc ?? '', foreshadowing: plan.foreshadowing ?? '',
    worldExpansion: plan.worldExpansion ?? '',
    decisionChain: plan.decisionChain ?? '', knowledgeDesign: plan.knowledgeDesign ?? '',
    scenes: Array.isArray(plan.scenes) ? plan.scenes : [],
  };
}

function parserDiagnostics(rawObject) {
  if (!rawObject || typeof rawObject !== 'object') return { objectParsed: false };
  try {
    const normalized = normalizeChapterPlan(rawObject);
    const quality = chapterPlanQualityDiagnostics(normalized);
    const design = chapterPlanDesignDiagnostics(normalized);
    const readiness = chapterPlanReadiness(normalized, { requireCurrentProtocol: true });
    return {
      objectParsed: true,
      versions: {
        quality: rawObject.qualityProtocolVersion ?? null,
        design: rawObject.designProtocolVersion ?? null,
        rhythm: rawObject.rhythmIntentVersion ?? null,
      },
      missingFields: [
        'goal', 'obstacle', 'choice', 'payoff', 'hook', 'tensionArc',
        'foreshadowing', 'worldExpansion', 'decisionChain', 'knowledgeDesign',
      ].filter((field) => typeof rawObject[field] !== 'string' || !rawObject[field].trim()),
      qualityValid: quality.valid,
      designValid: design.valid,
      failedReadiness: readiness.checks.filter((check) => !check.pass && !check.advisory)
        .map((check) => ({ id: check.id, detail: check.detail })),
    };
  } catch (error) {
    return { objectParsed: true, normalizationError: error?.message || String(error) };
  }
}

function deterministicAssessment(plan, { strictParsed = Boolean(plan) } = {}) {
  const projection = planProjection(plan);
  const design = chapterPlanDesignDiagnostics(projection ?? {});
  return {
    parsed: Boolean(projection),
    strictParsed,
    sceneCount: projection?.scenes.length ?? 0,
    hasChoice: Boolean(projection?.choice?.trim()),
    hasAction: Boolean(projection?.scenes.some((scene) => scene?.action?.trim())),
    hasTriggeredScenes: Boolean(projection?.scenes.length
      && projection.scenes.every((scene) => scene?.trigger?.trim())),
    designActive: design.active,
    designValid: design.valid,
    decisionValid: design.decision.valid,
    knowledgeValid: design.knowledge.valid,
    knowledgeMode: design.knowledge.mode ?? null,
    alternativeCount: design.knowledge.alternativeCount ?? 0,
    crossValidationCount: design.knowledge.crossValidationCount ?? 0,
  };
}

function judgePrompt(scenario, left, right) {
  return [
    `比较同一题材下的两份第 ${scenario.chapterIndex} 章策划。不要根据字段多少或标签完整度打分，只看计划写成正文后是否更好看。`,
    '题材与边界：', scenario.context,
    '候选甲：', JSON.stringify(planProjection(left)),
    '候选乙：', JSON.stringify(planProjection(right)),
    '按0到10分分别评价：agency人物主动性、opposition针对性阻力、causality因果接力、stateChange章末状态变化、informationBoundary信息边界、genreFit题材适配、pull继续阅读动力、overall综合。',
    '返回严格JSON：{"winner":"甲|乙|平局","reason":"200字内，必须指出具体剧情差异",',
    '"甲":{"agency":0,"opposition":0,"causality":0,"stateChange":0,"informationBoundary":0,"genreFit":0,"pull":0,"overall":0},',
    '"乙":{"agency":0,"opposition":0,"causality":0,"stateChange":0,"informationBoundary":0,"genreFit":0,"pull":0,"overall":0}}',
  ].join('\n');
}

async function main() {
  store.setDataRoot(DATA_ROOT);
  const configured = await store.readConfigForTask('outline');
  const config = configured.model === 'deepseek-v4-flash'
    ? { ...configured, model: 'deepseek-chat' } : configured;
  const requestedIds = String(process.env.NARRATIVE_VALIDATION_SCENARIOS ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const selectedScenarios = requestedIds.length
    ? SCENARIOS.filter((scenario) => requestedIds.includes(scenario.id)) : SCENARIOS;
  if (!selectedScenarios.length || requestedIds.some((id) =>
    !SCENARIOS.some((scenario) => scenario.id === id))) {
    throw new Error('BAD_NARRATIVE_VALIDATION_SCENARIOS');
  }
  const runId = new Date().toISOString().replace(/[:.]/gu, '-');
  const runDir = path.join(OUTPUT_ROOT, runId);
  await fs.mkdir(runDir, { recursive: true });
  const rows = [];
  for (const scenario of selectedScenarios) {
    process.stdout.write(`[${scenario.id}] baseline\n`);
    const baselineRaw = await ask(config, baselinePrompt(scenario), `${scenario.id}-baseline`);
    const baseline = extractObject(baselineRaw);
    await fs.writeFile(path.join(runDir, `${scenario.id}-baseline.raw.txt`), baselineRaw);
    process.stdout.write(`[${scenario.id}] narrative-skeleton\n`);
    const designRaw = await ask(config, designPrompt(scenario), `${scenario.id}-design`);
    const narrativeDesign = extractNarrativeDesignDraft(designRaw);
    await fs.writeFile(path.join(runDir, `${scenario.id}-design.raw.txt`), designRaw);
    process.stdout.write(`[${scenario.id}] design-contract\n`);
    const enhancedRaw = narrativeDesign
      ? await ask(config, newPrompt(scenario, narrativeDesign), `${scenario.id}-enhanced`)
      : '';
    const enhancedObject = extractObject(enhancedRaw);
    const enhanced = narrativeDesign
      ? extractChapterPlanDraft(enhancedRaw, { narrativeDesign }) : null;
    await fs.writeFile(path.join(runDir, `${scenario.id}-enhanced.raw.txt`), enhancedRaw);
    const enhancedForJudge = enhanced ?? enhancedObject;
    const swap = scenario.id.length % 2 === 0;
    const left = swap ? enhancedForJudge : baseline;
    const right = swap ? baseline : enhancedForJudge;
    process.stdout.write(`[${scenario.id}] blind-judge\n`);
    const judgeRaw = await ask(
      config, judgePrompt(scenario, left, right), `${scenario.id}-judge`, 2, JUDGE_SYSTEM,
    );
    const judge = extractObject(judgeRaw);
    const winner = judge?.winner === '甲'
      ? (swap ? 'enhanced' : 'baseline')
      : judge?.winner === '乙'
        ? (swap ? 'baseline' : 'enhanced') : 'tie';
    const row = {
      scenario: { id: scenario.id, name: scenario.name },
      baseline: {
        plan: planProjection(baseline), assessment: deterministicAssessment(baseline),
      },
      enhanced: {
        narrativeDesign,
        plan: planProjection(enhancedForJudge),
        assessment: deterministicAssessment(enhancedForJudge, { strictParsed: Boolean(enhanced) }),
        parserDiagnostics: parserDiagnostics(enhancedObject),
        processedDiagnostics: enhanced ? parserDiagnostics(enhanced) : null,
      },
      blindJudge: { rawWinner: judge?.winner ?? null, normalizedWinner: winner, result: judge },
    };
    rows.push(row);
    await fs.writeFile(path.join(runDir, `${scenario.id}.json`), `${JSON.stringify(row, null, 2)}\n`);
  }
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: config.model,
    scenarios: rows.length,
    enhancedParsed: rows.filter((row) => row.enhanced.assessment.strictParsed).length,
    enhancedDesignValid: rows.filter((row) => row.enhanced.assessment.designValid).length,
    baselineDesignValid: rows.filter((row) => row.baseline.assessment.designValid).length,
    judgeWins: {
      enhanced: rows.filter((row) => row.blindJudge.normalizedWinner === 'enhanced').length,
      baseline: rows.filter((row) => row.blindJudge.normalizedWinner === 'baseline').length,
      tie: rows.filter((row) => row.blindJudge.normalizedWinner === 'tie').length,
    },
    rows,
  };
  const relationshipRows = rows.filter((row) => row.scenario.id === 'relationship');
  summary.acceptance = {
    allEnhancedParsed: summary.enhancedParsed === rows.length,
    allEnhancedDesignValid: summary.enhancedDesignValid === rows.length,
    blindWinThreshold: Math.max(1, Math.ceil(rows.length * 2 / 3)),
    blindWinThresholdMet: summary.judgeWins.enhanced
      >= Math.max(1, Math.ceil(rows.length * 2 / 3)),
    relationshipUsesNoKnowledgeTask: relationshipRows.every((row) =>
      row.enhanced.assessment.knowledgeMode === 'none'),
  };
  summary.acceptance.passed = Object.entries(summary.acceptance)
    .filter(([key]) => !['blindWinThreshold', 'passed'].includes(key))
    .every(([, value]) => value === true);
  await fs.writeFile(path.join(runDir, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(OUTPUT_ROOT, 'latest.json'), `${JSON.stringify({ runId, report: path.join(runDir, 'report.json') }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, runId, report: path.join(runDir, 'report.json'), summary: {
    enhancedParsed: summary.enhancedParsed,
    enhancedDesignValid: summary.enhancedDesignValid,
    baselineDesignValid: summary.baselineDesignValid,
    judgeWins: summary.judgeWins,
    acceptance: summary.acceptance,
  } })}\n`);
  if (process.env.NARRATIVE_VALIDATION_REQUIRE_PASS === '1'
    && !summary.acceptance.passed) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

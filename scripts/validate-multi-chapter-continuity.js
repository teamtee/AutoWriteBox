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
import { chapterRevisionStyleMetrics } from '../server/chapter-revision-schema.js';
import { assertChapterOutputClean } from '../server/chapter-output-guard.js';
import {
  chapterPlanContinuityDiagnostics, chapterPlanDesignDiagnostics,
} from '../server/chapter-plan-quality.js';

const DATA_ROOT = path.resolve(process.cwd(), 'data');
const PLAN_ROOT = path.join(DATA_ROOT, '.generation-runs', 'narrative-capability-validation');
const PROSE_ROOT = path.join(DATA_ROOT, '.generation-runs', 'narrative-prose-validation');
const OUTPUT_ROOT = path.join(DATA_ROOT, '.generation-runs', 'narrative-continuity-validation');
const IDS = Object.freeze(['suspense', 'relationship', 'action']);
const BASE_CHAPTER_INDEX = Object.freeze({ suspense: 6, relationship: 18, action: 27 });
const CONTEXT = Object.freeze({
  suspense: [
    '都市调查悬疑：港口理货员沈砚调查哥哥坠亡旧案，只能使用既有理货流程、纸质单据和同事关系。沈砚没有直接查询系统日志或车牌数据库的权限；不得让他擅自调取系统日志、借账号、猜密码、黑入系统或直接查车牌，电子信息只能由有权限者按既有流程提供纸质或当面可见结果。',
    '连续三章阶段目标：从“死亡记录与提货记录冲突”推进到“确认至少有一份记录被有权限的人事后改写”，但不能确认罗荃是凶手、哥哥仍活着或唯一幕后者。',
    '第二章必须消费第一章暴露调查和权限收窄的后果；第三章的反制必须针对第二章的新策略，且主角要付出持续到后文的职业或关系代价。',
  ].join('\n'),
  relationship: [
    '家庭关系余波：程雁已经确认弟弟程野私卖祖屋产权，连续章节只消费姐弟共同照顾患病母亲的关系后果。',
    '不得新增遗嘱、神秘物件、隐瞒疾病、第三方裁决或新债主。第二章必须执行上一章形成的照护规则，第三章必须消费执行中的违约或让步。',
    '人物关系不能复位为最初争吵；每章都要改写具体责任、信任或决策权限。',
  ].join('\n'),
  action: [
    '灾难行动：暴雨灌入地铁施工隧道，周渡只能使用既有绳索、排水图和工人经验。',
    '第二章必须消费上一章人员分离、通讯中断、路线封锁和资源损耗；第三章允许阶段性救援，但不能恢复已经消耗的绳索、时间或信任。',
    '魏成的后续反制必须根据前章失败调整策略，章末压力不得来自无关爆炸、新装备或突然援军。',
  ].join('\n'),
});
const PLAN_SYSTEM = '你是严谨的长篇小说策划编辑。只输出用户要求的严格 JSON，不要 Markdown、代码围栏或解释。';
const CHAPTER_TARGETS = Object.freeze({
  suspense: Object.freeze({
    2: '前章结尾已经出现平板车、车牌后三位“三七几”和“戴工牌的人眼睛小”，这些只能作为已知前提，不得再次获取为新线索。本章主兑现只确认造成记录矛盾的流程环节与可接触该环节的岗位类别；不得引入手机号、货运公司或新幕后人物。章末必须因前章暴露而失去一项真实权限。',
    3: '本章用不同于前章的独立纸质来源交叉验证，阶段兑现仅为“死亡记录或提货记录中至少一份被有权限者事后改写”；不得确认具体改写者、罗荃罪责或哥哥存活。主角必须付出持续职业代价。',
  }),
  relationship: Object.freeze({
    2: '本章执行第一次每周照护费用核对，只允许出现既有护理、药费或交通支出的对账差额，不得新增秘密债务或隐藏用途。差额不能靠当场补现金轻易和解；姐弟必须各让出一项控制，并共同签下可执行的修正规则。第三方只能作为背景服务者，不能提供关键事实或裁决。',
    3: '本章把上一章修订后的规则用于一次已经建立的复查或照护排班冲突；一方因既有工作或时间限制违约，另一方必须选择代班并获得临时决定权，或拒绝并让合作破裂。不得回到卖房争论，不得撕毁账本、引入泥渍/神秘物件或让护工替姐弟解决冲突。',
  }),
  action: Object.freeze({
    2: '本章消费人员分离、通讯中断与资源损耗，最多恢复一项联络或路线信息，不能完成全部救援。',
    3: '本章允许阶段性救出部分人员，但必须保留已消耗资源和信任代价；魏成根据前章失败改变反制。',
  }),
});
const PROSE_SYSTEM = [
  '你是成熟的中文类型小说作者。只输出小说正文，不要标题、提纲、解释、Markdown或策划标签。',
  '必须继承前文已经发生的状态、资源损耗、关系变化和知识边界，不得让人物或局势复位。',
].join('');
const JUDGE_SYSTEM = [
  '你是独立长篇小说总编。只比较连续章节的实际阅读效果，不奖励字段、篇幅或格式。',
  '重点检查前章后果是否被消费、人物和资源是否复位、对手是否调整反制、信息是否越界、节拍是否重复、每章是否有独立兑现。',
  '只输出严格 JSON。',
].join('');

async function ask(config, prompt, system, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await nonStreamChat({
        config: { ...config, requestTimeoutMs: Math.max(config.requestTimeoutMs ?? 0, 300_000) },
        system, messages: [{ role: 'user', content: prompt }],
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError;
}

function extractObject(value) {
  const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '').trim();
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function directoriesDescending(root) {
  return (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
}

async function loadSource(id) {
  for (const runId of await directoriesDescending(PROSE_ROOT)) {
    let report;
    try { report = JSON.parse(await fs.readFile(path.join(PROSE_ROOT, runId, 'report.json'), 'utf8')); }
    catch { continue; }
    const row = report.rows?.find((item) => item?.scenario?.id === id
      && item?.blindJudge?.normalizedWinner === 'enhanced');
    if (!row?.sourceRunId) continue;
    let planReport;
    try {
      planReport = JSON.parse(await fs.readFile(
        path.join(PLAN_ROOT, row.sourceRunId, 'report.json'), 'utf8',
      ));
    } catch { continue; }
    const planRow = planReport.rows?.find((item) => item?.scenario?.id === id
      && item?.enhanced?.assessment?.strictParsed && item?.enhanced?.assessment?.designValid);
    if (!planRow?.enhanced?.plan) continue;
    const body = await fs.readFile(path.join(PROSE_ROOT, runId, `${id}-enhanced.txt`), 'utf8');
    return { proseRunId: runId, planRunId: row.sourceRunId, plan: planRow.enhanced.plan, body };
  }
  throw new Error(`NARRATIVE_CONTINUITY_SOURCE_MISSING:${id}`);
}

function boundedHistory(bodies) {
  return bodies.map((body, index) => `【连续样章第${index + 1}章】\n${body}`).join('\n\n');
}

async function fitBodyLength(config, id, chapterNumber, body) {
  const originalLength = Array.from(body).length;
  if (originalLength >= 2_000 && originalLength <= 2_500) {
    return { body, revised: false, rawChars: originalLength, revisionAttemptChars: [] };
  }
  const candidates = [{ body, chars: originalLength, original: true }];
  let current = body;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentLength = Array.from(current).length;
    const instruction = currentLength > 2_700
      ? '在不删除关键行动、反制、选择、代价和章末状态变化的前提下压缩正文'
      : '在不新增人物、线索、秘密或转折的前提下补足现场动作、对话和物理反应';
    current = await ask(config, [
      `当前正文${currentLength}字。${instruction}，改写为2200字左右，合格范围2000—2500字，绝对不得少于1800字或超过2700字。`,
      CONTEXT[id], `这是连续样章第${chapterNumber}章。`,
      '保留原有事件顺序、人物知识边界和结尾事实，不要标题、解释或Markdown。',
      current, '只输出改写后的正文。',
    ].join('\n\n'), PROSE_SYSTEM);
    const chars = Array.from(current).length;
    candidates.push({ body: current, chars, original: false });
    if (chars >= 2_000 && chars <= 2_500) break;
  }
  const targetEligible = candidates.filter((candidate) =>
    candidate.chars >= 2_000 && candidate.chars <= 2_500);
  const hardEligible = candidates.filter((candidate) =>
    candidate.chars >= 1_800 && candidate.chars <= 2_700);
  const pool = targetEligible.length ? targetEligible
    : hardEligible.length ? hardEligible : candidates;
  const selected = [...pool].sort((left, right) =>
    Math.abs(left.chars - 2_250) - Math.abs(right.chars - 2_250))[0];
  return {
    body: selected.body,
    revised: !selected.original,
    rawChars: originalLength,
    revisionAttemptChars: candidates.slice(1).map((candidate) => candidate.chars),
  };
}

function boundaryViolations(id, body) {
  const patterns = id === 'suspense'
    ? [/黑入|破解(?:系统|密码)|猜(?:中|出)?密码|盗用账号|擅自调取系统|直接查询车牌数据库/gu]
    : id === 'relationship'
      ? [/遗嘱|神秘(?:钥匙|物件)|私生子|神秘债主|第三方调解|叔父作证/gu]
      : [/突然获得(?:新装备|援军)|军方支援|超能力|无关爆炸/gu];
  return patterns.flatMap((pattern) => body.match(pattern) ?? []);
}

function baselinePrompt(id, chapterNumber, bodies) {
  return [
    `续写连续样章第${chapterNumber}章，正文2000—2500个汉字，绝对不得超过2700字。`, CONTEXT[id],
    `【本章阶段目标】${CHAPTER_TARGETS[id][chapterNumber]}`,
    '延续前文人物、事实和语气，让本章有推进、冲突和章末牵引。不要复述前情，不要写策划说明。',
    boundedHistory(bodies), '只输出正文。',
  ].join('\n\n');
}

function enhancedContext(id, chapterNumber, bodies, previousPlan) {
  return [
    CONTEXT[id], `【本章阶段目标】${CHAPTER_TARGETS[id][chapterNumber]}`,
    `现在设计连续样章第${chapterNumber}章。上一章策划中的章末状态、代价和后续索债必须在本章开场即生效。`,
    `【上一章策划】\n${JSON.stringify(previousPlan)}`,
    boundedHistory(bodies),
    '不得重复上一章的主要破局手段、谈判杠杆、调查载体或章末钩子；对手必须基于上一章发生的行动调整反制。',
  ].join('\n\n');
}

async function generateEnhancedPlan(config, id, chapterNumber, bodies, previousPlan) {
  const context = enhancedContext(id, chapterNumber, bodies, previousPlan);
  let design = null;
  let designRaw = '';
  for (let attempt = 0; attempt < 2 && !design; attempt += 1) {
    designRaw = await ask(config, buildNarrativeDesignDraftInstruction({
      chapterIndex: BASE_CHAPTER_INDEX[id] + chapterNumber - 1,
      bookChapterIndex: BASE_CHAPTER_INDEX[id] + chapterNumber - 1,
      context, seedPlan: {}, currentContent: '', previousPlan,
      previousChapter: { content: bodies.at(-1), handoff: {} },
    }), PLAN_SYSTEM);
    design = extractNarrativeDesignDraft(designRaw);
  }
  if (!design) throw new Error(`CONTINUITY_DESIGN_FAILED:${id}:${chapterNumber}`);
  let plan = null;
  let planRaw = '';
  for (let attempt = 0; attempt < 3 && !plan; attempt += 1) {
    planRaw = await ask(config, buildChapterPlanDraftInstruction({
      chapterIndex: BASE_CHAPTER_INDEX[id] + chapterNumber - 1,
      bookChapterIndex: BASE_CHAPTER_INDEX[id] + chapterNumber - 1,
      context, seedPlan: {}, currentContent: '', recentReviewSignals: [],
      fixedNarrativeDesign: design, previousPlan,
      previousChapter: { content: bodies.at(-1), handoff: {} },
    }), PLAN_SYSTEM);
    plan = extractChapterPlanDraft(planRaw, { narrativeDesign: design });
  }
  if (!plan || !chapterPlanDesignDiagnostics(plan).valid) {
    const error = new Error(`CONTINUITY_PLAN_FAILED:${id}:${chapterNumber}`);
    error.validationArtifacts = { design, designRaw, planRaw };
    throw error;
  }
  return { design, designRaw, plan, planRaw };
}

function enhancedProsePrompt(id, chapterNumber, bodies, plan) {
  return [
    `写连续样章第${chapterNumber}章正文，目标2000—2500个汉字，绝对不得超过2700字。`, CONTEXT[id],
    `【本章阶段目标】${CHAPTER_TARGETS[id][chapterNumber]}`,
    '必须把上一章造成的限制在开场落实，并将策划中的初次行动、针对性反制、反制后选择和状态改写演成连续场景。',
    '关键选择必须在场，不得事后概述；不得恢复已损失的资源、权限或信任，不得越过允许结论。',
    boundedHistory(bodies), `【本章已验证策划】\n${JSON.stringify(plan)}`, '只输出正文。',
  ].join('\n\n');
}

function judgePrompt(id, commonBody, leftBodies, rightBodies) {
  const render = (label, bodies) => bodies.map((body, index) =>
    `【${label}续章${index + 2}】\n${body}`).join('\n\n');
  return [
    `题材与阶段边界：${CONTEXT[id]}`,
    `【双方共同的第一章】\n${commonBody}`,
    render('候选甲', leftBodies), render('候选乙', rightBodies),
    '比较两组第2—3章。按0—10分评价consequenceConsumption前章后果消费、stateContinuity状态连续、resourceContinuity资源守恒、opponentAdaptation对手适应、causalRelay因果接力、knowledgeBoundary信息边界、authorBoundary作者限制遵守、beatVariation节拍变化、chapterPayoffs逐章兑现、proseHumanity正文自然度、longPull长线牵引、overall综合。不得因某组更长而加分。',
    'reason必须指出具体连续性差异；evidence必须分别引用每组至少两处短原句。',
    '返回严格JSON：{"winner":"甲|乙|平局","reason":"400字内",',
    '"甲":{"consequenceConsumption":0,"stateContinuity":0,"resourceContinuity":0,"opponentAdaptation":0,"causalRelay":0,"knowledgeBoundary":0,"authorBoundary":0,"beatVariation":0,"chapterPayoffs":0,"proseHumanity":0,"longPull":0,"overall":0,"evidence":["原句1","原句2"]},',
    '"乙":{"consequenceConsumption":0,"stateContinuity":0,"resourceContinuity":0,"opponentAdaptation":0,"causalRelay":0,"knowledgeBoundary":0,"authorBoundary":0,"beatVariation":0,"chapterPayoffs":0,"proseHumanity":0,"longPull":0,"overall":0,"evidence":["原句1","原句2"]}}',
  ].join('\n\n');
}

async function main() {
  store.setDataRoot(DATA_ROOT);
  const requested = String(process.env.NARRATIVE_CONTINUITY_SCENARIOS ?? 'suspense')
    .split(',').map((value) => value.trim()).filter(Boolean);
  if (!requested.length || requested.some((id) => !IDS.includes(id))) {
    throw new Error('BAD_NARRATIVE_CONTINUITY_SCENARIOS');
  }
  const configured = await store.readConfigForTask('outline');
  const config = configured.model === 'deepseek-v4-flash'
    ? { ...configured, model: 'deepseek-chat' } : configured;
  const runId = new Date().toISOString().replace(/[:.]/gu, '-');
  const runDir = path.join(OUTPUT_ROOT, runId);
  await fs.mkdir(runDir, { recursive: true });
  const rows = [];
  for (const id of requested) {
    const source = await loadSource(id);
    const baselineBodies = [source.body];
    const enhancedBodies = [source.body];
    const enhancedPlans = [source.plan];
    const generated = [];
    for (let chapterNumber = 2; chapterNumber <= 3; chapterNumber += 1) {
      process.stdout.write(`[${id}] baseline-chapter-${chapterNumber}\n`);
      const baselineRawBody = await ask(
        config, baselinePrompt(id, chapterNumber, baselineBodies), PROSE_SYSTEM,
      );
      const baselineFitted = await fitBodyLength(
        config, id, chapterNumber, baselineRawBody,
      );
      const baselineBody = baselineFitted.body;
      assertChapterOutputClean(baselineBody);
      baselineBodies.push(baselineBody);
      if (baselineFitted.revised) {
        await fs.writeFile(
          path.join(runDir, `${id}-baseline-${chapterNumber}.raw.txt`), baselineRawBody,
        );
      }
      await fs.writeFile(path.join(runDir, `${id}-baseline-${chapterNumber}.txt`), baselineBody);
      process.stdout.write(`[${id}] enhanced-plan-${chapterNumber}\n`);
      let planned;
      try {
        planned = await generateEnhancedPlan(
          config, id, chapterNumber, enhancedBodies, enhancedPlans.at(-1),
        );
      } catch (error) {
        const artifacts = error?.validationArtifacts;
        if (artifacts) {
          await fs.writeFile(
            path.join(runDir, `${id}-enhanced-${chapterNumber}-failed-design.raw.txt`),
            artifacts.designRaw ?? '',
          );
          await fs.writeFile(
            path.join(runDir, `${id}-enhanced-${chapterNumber}-failed-plan.raw.txt`),
            artifacts.planRaw ?? '',
          );
          await fs.writeFile(
            path.join(runDir, `${id}-enhanced-${chapterNumber}-failure.json`),
            `${JSON.stringify({ error: error.message, design: artifacts.design }, null, 2)}\n`,
          );
        }
        throw error;
      }
      const continuityDiagnostics = chapterPlanContinuityDiagnostics(
        enhancedPlans.at(-1), planned.plan,
      );
      if (!continuityDiagnostics.valid) {
        throw new Error(`CONTINUITY_HARD_REPEAT:${id}:${chapterNumber}`);
      }
      enhancedPlans.push(planned.plan);
      await fs.writeFile(path.join(runDir, `${id}-enhanced-${chapterNumber}-design.raw.txt`), planned.designRaw);
      await fs.writeFile(path.join(runDir, `${id}-enhanced-${chapterNumber}-plan.raw.txt`), planned.planRaw);
      process.stdout.write(`[${id}] enhanced-chapter-${chapterNumber}\n`);
      const enhancedRawBody = await ask(
        config, enhancedProsePrompt(id, chapterNumber, enhancedBodies, planned.plan),
        PROSE_SYSTEM,
      );
      const enhancedFitted = await fitBodyLength(
        config, id, chapterNumber, enhancedRawBody,
      );
      const enhancedBody = enhancedFitted.body;
      assertChapterOutputClean(enhancedBody);
      enhancedBodies.push(enhancedBody);
      if (enhancedFitted.revised) {
        await fs.writeFile(
          path.join(runDir, `${id}-enhanced-${chapterNumber}.raw.txt`), enhancedRawBody,
        );
      }
      await fs.writeFile(path.join(runDir, `${id}-enhanced-${chapterNumber}.txt`), enhancedBody);
      generated.push({
        chapterNumber, design: planned.design, plan: planned.plan,
        continuityDiagnostics,
        baseline: {
          chars: Array.from(baselineBody).length,
          rawChars: baselineFitted.rawChars,
          lengthRevised: baselineFitted.revised,
          revisionAttemptChars: baselineFitted.revisionAttemptChars,
          boundaryViolations: boundaryViolations(id, baselineBody),
          metrics: chapterRevisionStyleMetrics(baselineBody),
        },
        enhanced: {
          chars: Array.from(enhancedBody).length,
          rawChars: enhancedFitted.rawChars,
          lengthRevised: enhancedFitted.revised,
          revisionAttemptChars: enhancedFitted.revisionAttemptChars,
          boundaryViolations: boundaryViolations(id, enhancedBody),
          metrics: chapterRevisionStyleMetrics(enhancedBody),
        },
      });
    }
    const swap = id.length % 2 === 0;
    process.stdout.write(`[${id}] continuity-judge\n`);
    const judge = extractObject(await ask(
      config,
      judgePrompt(
        id, source.body,
        swap ? enhancedBodies.slice(1) : baselineBodies.slice(1),
        swap ? baselineBodies.slice(1) : enhancedBodies.slice(1),
      ),
      JUDGE_SYSTEM,
    ));
    const winner = judge?.winner === '甲'
      ? (swap ? 'enhanced' : 'baseline')
      : judge?.winner === '乙' ? (swap ? 'baseline' : 'enhanced') : 'tie';
    const row = {
      scenario: id,
      source: { proseRunId: source.proseRunId, planRunId: source.planRunId },
      generated,
      blindJudge: { normalizedWinner: winner, result: judge },
    };
    rows.push(row);
    await fs.writeFile(path.join(runDir, `${id}.json`), `${JSON.stringify(row, null, 2)}\n`);
  }
  const summary = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), model: config.model, rows,
    judgeWins: {
      enhanced: rows.filter((row) => row.blindJudge.normalizedWinner === 'enhanced').length,
      baseline: rows.filter((row) => row.blindJudge.normalizedWinner === 'baseline').length,
      tie: rows.filter((row) => row.blindJudge.normalizedWinner === 'tie').length,
    },
  };
  summary.acceptance = {
    allPlansValid: rows.every((row) => row.generated.every((item) =>
      chapterPlanDesignDiagnostics(item.plan).valid
      && item.continuityDiagnostics?.valid)),
    allBodiesSubstantial: rows.every((row) => row.generated.every((item) =>
      item.baseline.chars >= 1_800 && item.enhanced.chars >= 1_800
      && item.baseline.chars <= 2_700 && item.enhanced.chars <= 2_700)),
    comparableLengths: rows.every((row) => row.generated.every((item) => {
      const ratio = item.enhanced.chars / item.baseline.chars;
      return ratio >= 0.8 && ratio <= 1.25;
    })),
    enhancedHonorsAuthorBoundary: rows.every((row) => row.generated.every((item) =>
      item.enhanced.boundaryViolations.length === 0)),
    enhancedJudgeAuthorBoundary: rows.every((row) => {
      const judge = row.blindJudge.result;
      if (!judge) return false;
      const enhancedKey = row.scenario.length % 2 === 0 ? '甲' : '乙';
      return Number(judge[enhancedKey]?.authorBoundary) >= 8;
    }),
    allScenariosEnhancedWin: summary.judgeWins.enhanced === rows.length,
  };
  summary.acceptance.passed = Object.values(summary.acceptance).every(Boolean);
  await fs.writeFile(path.join(runDir, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(OUTPUT_ROOT, 'latest.json'), `${JSON.stringify({
    runId, report: path.join(runDir, 'report.json'),
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: summary.acceptance.passed, runId, report: path.join(runDir, 'report.json'),
    judgeWins: summary.judgeWins, acceptance: summary.acceptance,
  })}\n`);
  if (!summary.acceptance.passed) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

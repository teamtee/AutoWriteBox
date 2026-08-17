#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as store from '../server/store.js';
import { nonStreamChat } from '../server/llm.js';
import { chapterRevisionStyleMetrics } from '../server/chapter-revision-schema.js';

const DATA_ROOT = path.resolve(process.cwd(), 'data');
const PLAN_ROOT = path.join(DATA_ROOT, '.generation-runs', 'narrative-capability-validation');
const OUTPUT_ROOT = path.join(DATA_ROOT, '.generation-runs', 'narrative-prose-validation');
const SCENARIO_CONTEXT = Object.freeze({
  suspense: '都市调查悬疑：港口理货员沈砚调查哥哥坠亡旧案。本章只能使用既有理货流程、纸质单据和同事关系，不能收到匿名答案；最多证明死亡记录与提货记录不能同时为真。',
  relationship: '家庭关系余波：程雁已经确认弟弟程野私卖祖屋产权。本章只处理姐弟是否继续共同照顾患病母亲，不新增遗嘱、神秘物件、第三方裁决或新秘密。',
  action: '灾难行动：暴雨灌入地铁施工隧道，周渡必须用既有绳索、排水图和工人经验救援。章末压力必须来自人物本章行动，不能突然获得装备、援军或投放无关爆炸。',
});
const IDS = Object.freeze(Object.keys(SCENARIO_CONTEXT));
const PROSE_SYSTEM = [
  '你是成熟的中文类型小说作者。只输出小说正文，不要标题、提纲、解释、Markdown或策划标签。',
  '用人物动作、对话、物理环境和具体反应呈现冲突，不让旁白替读者总结人物已经明白什么。',
].join('');
const JUDGE_SYSTEM = [
  '你是独立小说总编。你不知道候选来自哪种策划协议，只评价正文的实际阅读效果。',
  '不奖励篇幅、术语或结构标签；必须惩罚巧合转折、作者代判、解释腔、同声同气、概述关键场景和廉价章尾钩子。',
  '只返回严格 JSON。',
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

async function loadPlanRows() {
  const entries = (await fs.readdir(PLAN_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  const selected = new Map();
  for (const entry of entries) {
    let report;
    try { report = JSON.parse(await fs.readFile(path.join(PLAN_ROOT, entry, 'report.json'), 'utf8')); }
    catch { continue; }
    for (const row of report.rows ?? []) {
      const id = row?.scenario?.id;
      if (!IDS.includes(id) || selected.has(id)
        || !row?.baseline?.plan || !row?.enhanced?.plan
        || !row?.enhanced?.assessment?.strictParsed
        || !row?.enhanced?.assessment?.designValid) continue;
      selected.set(id, { ...row, sourceRunId: entry });
    }
    if (selected.size === IDS.length) break;
  }
  if (selected.size !== IDS.length) throw new Error('NARRATIVE_PROSE_SOURCE_PLANS_INCOMPLETE');
  return IDS.map((id) => selected.get(id));
}

function prosePrompt(id, plan) {
  return [
    `请写一章完整小说正文，目标1800—2600个汉字。题材边界：${SCENARIO_CONTEXT[id]}`,
    '必须把策划中的行动、反制、反制后的再次选择及章末状态变化演成连续场景；关键选择必须在场而非事后概述。',
    '允许自然对话短段，但不要连续金句短段、作者代判、成片明喻或破折号腔。不得把策划字段名写入正文。',
    '策划：', JSON.stringify(plan),
    '只输出正文。',
  ].join('\n');
}

function judgePrompt(id, left, right) {
  return [
    `题材边界：${SCENARIO_CONTEXT[id]}`,
    '候选甲正文：', left,
    '候选乙正文：', right,
    '按0到10分评价opening开篇牵引、agency人物主动性、sceneCausality场景因果、opposition针对性阻力、voice人物声音、staging现场可见性、rhythm张弛、informationBoundary信息边界、proseHumanity自然度、endingPull章末牵引、overall综合。',
    '返回严格JSON：{"winner":"甲|乙|平局","reason":"300字内，引用或描述双方具体正文差异",',
    '"甲":{"opening":0,"agency":0,"sceneCausality":0,"opposition":0,"voice":0,"staging":0,"rhythm":0,"informationBoundary":0,"proseHumanity":0,"endingPull":0,"overall":0},',
    '"乙":{"opening":0,"agency":0,"sceneCausality":0,"opposition":0,"voice":0,"staging":0,"rhythm":0,"informationBoundary":0,"proseHumanity":0,"endingPull":0,"overall":0}}',
  ].join('\n');
}

async function main() {
  store.setDataRoot(DATA_ROOT);
  const configured = await store.readConfigForTask('outline');
  const config = configured.model === 'deepseek-v4-flash'
    ? { ...configured, model: 'deepseek-chat' } : configured;
  const sources = await loadPlanRows();
  const runId = new Date().toISOString().replace(/[:.]/gu, '-');
  const runDir = path.join(OUTPUT_ROOT, runId);
  await fs.mkdir(runDir, { recursive: true });
  const rows = [];
  for (const source of sources) {
    const id = source.scenario.id;
    process.stdout.write(`[${id}] baseline-prose\n`);
    const baseline = await ask(config, prosePrompt(id, source.baseline.plan), PROSE_SYSTEM);
    await fs.writeFile(path.join(runDir, `${id}-baseline.txt`), baseline);
    process.stdout.write(`[${id}] enhanced-prose\n`);
    const enhanced = await ask(config, prosePrompt(id, source.enhanced.plan), PROSE_SYSTEM);
    await fs.writeFile(path.join(runDir, `${id}-enhanced.txt`), enhanced);
    const swap = id.length % 2 === 0;
    process.stdout.write(`[${id}] blind-judge\n`);
    const judge = extractObject(await ask(
      config, judgePrompt(id, swap ? enhanced : baseline, swap ? baseline : enhanced),
      JUDGE_SYSTEM,
    ));
    const winner = judge?.winner === '甲'
      ? (swap ? 'enhanced' : 'baseline')
      : judge?.winner === '乙' ? (swap ? 'baseline' : 'enhanced') : 'tie';
    const row = {
      scenario: { id, name: source.scenario.name }, sourceRunId: source.sourceRunId,
      baseline: { chars: Array.from(baseline).length, metrics: chapterRevisionStyleMetrics(baseline) },
      enhanced: { chars: Array.from(enhanced).length, metrics: chapterRevisionStyleMetrics(enhanced) },
      blindJudge: { normalizedWinner: winner, result: judge },
    };
    rows.push(row);
    await fs.writeFile(path.join(runDir, `${id}.json`), `${JSON.stringify(row, null, 2)}\n`);
  }
  const summary = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), model: config.model,
    rows,
    judgeWins: {
      enhanced: rows.filter((row) => row.blindJudge.normalizedWinner === 'enhanced').length,
      baseline: rows.filter((row) => row.blindJudge.normalizedWinner === 'baseline').length,
      tie: rows.filter((row) => row.blindJudge.normalizedWinner === 'tie').length,
    },
  };
  summary.acceptance = {
    allBodiesSubstantial: rows.every((row) => row.baseline.chars >= 1_200 && row.enhanced.chars >= 1_200),
    blindWinThreshold: 2,
    blindWinThresholdMet: summary.judgeWins.enhanced >= 2,
  };
  summary.acceptance.passed = summary.acceptance.allBodiesSubstantial
    && summary.acceptance.blindWinThresholdMet;
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

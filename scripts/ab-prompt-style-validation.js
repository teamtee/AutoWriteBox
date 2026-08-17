#!/usr/bin/env node
// 对同一章、同一上下文只替换提示词措辞，比较“禁令式”与“背景式”两种写法的
// 实际产出。它不修改 data/ 下的真实作品：全部在私有临时数据根中进行。
//
//   node scripts/ab-prompt-style-validation.js [--runs 2] [--source <bookId>]
//
// A 组在当前 system 之外重复加入旧式逐条禁令，B 组使用当前分层提示词。
// 输出另含随机打乱的 blind-packet，读者无需知道候选来自哪一组。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import * as store from '../server/store.js';
import { nonStreamChat } from '../server/llm.js';
import {
  buildChapterInstruction, buildContext, buildSystemPrompt,
} from '../server/prompts.js';
import {
  analyzeChapterProseTrend, measureChapterProse,
} from '../server/chapter-prose-metrics.js';

const REAL_DATA_ROOT = path.resolve(process.cwd(), 'data');
const DOCS_ROOT = path.resolve(process.cwd(), 'docs');
const CHAPTER_FILE = /^笼中火种-第(\d+)章(.*)-正文候选\.txt$/u;

// 改造前实际发送的两段。用于 A 组对照，不再参与生产提示词。
const LEGACY_EXECUTION_CHECKLIST = [
  '【本章执行清单】\n',
  '- 尽快进入当前人物目标、异常或冲突，不以无目的背景介绍开场。\n',
  '- 让“目标 → 阻碍 → 选择 → 后果/变化”在本章形成可感知的推进。\n',
  '- 至少安排一次有效兑现和一次后续牵引；二者必须服务本章与主线，不能机械拼装。\n',
  '- 执行策划中的张力曲线：让希望、受阻、反转、选择、兑现或余波由前一步触发；避免全章同一强度，也不要机械照搬固定五段式。\n',
  '- 场景之间不能复位：第一场承接上一章结果或本章直接诱因，后一场必须消费前一场造成的新资源、关系、认知、风险或目标；删掉前场后后场仍可原样发生，就是断链。\n',
  '- 下一章开场必须先消费上一章末态：视角、时间地点、正在进行的动作、伤势/关系/物品状态和人物已知不得静默重置；需要跳时、转场或切换视角时，要在正文中给出可感知的过渡与因果。\n',
  '- 用场景和人物反应承载信息，删掉重复解释、空泛感叹及只为显得深刻的修辞。\n',
  '- 保留必要的呼吸感，但不能让主要人物长时间被动旁观或让剧情原地踏步。\n',
  '- 复核上一章明确承诺的门槛与目标：若本章跨过它，必须写清人物如何做到以及付出什么。\n',
  '- 让主角至少一次凭自身能力或关系改变局面；不能把关键路线、答案和工具连续交给向导角色。\n',
  '- 若策划要求埋点，让线索先作为物件、动作、矛盾或错误判断参与当前场景；写出它如何改变人物行动，禁止旁白标注意义。\n',
  '- 若策划要求扩大世界边界，必须从世界圣经已有规则、势力利益或历史后果取材，只展示本章能被人物触碰或验证的一层；',
  '让证据改变人物选择并产生代价，同时保留清楚的信息缺口。不要密集抛专有名词，也不要临时发明更高层级。\n',
  '- 若上下文提供“本部当前世界执行合同”，它定义本部最高可用层级与保留未知。',
  '本章不得越过它，也不得因世界圣经已写出长线真相就提前写进正文。\n',
  '- 输出前静默删除替读者总结的主题句、同构短段、密集排比和重复比喻；保留人物会说的话与场景真正需要的停顿。\n',
].join('');

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {
    runs: 2,
    source: 'book_8d9180a777eb60664f14bc8c4dd40e2c',
    planPath: 'docs/笼中火种-第三阶段第21至30章策划候选.json',
    group: 'both',
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--runs') out.runs = Number(argv[index + 1]);
    if (argv[index] === '--source') out.source = argv[index + 1];
    if (argv[index] === '--plan') out.planPath = argv[index + 1];
    if (argv[index] === '--group') out.group = argv[index + 1];
  }
  if (!['both', 'legacy', 'current'].includes(out.group)) {
    throw new Error('--group 只能是 both、legacy 或 current');
  }
  return out;
}

async function loadDocChapters() {
  const names = (await fs.readdir(DOCS_ROOT)).filter((name) => CHAPTER_FILE.test(name)).sort();
  return Promise.all(names.map(async (name) => {
    const [, index, title] = name.match(CHAPTER_FILE);
    return {
      index: Number(index),
      title: `第${Number(index)}章 ${title}`,
      content: (await fs.readFile(path.join(DOCS_ROOT, name), 'utf8')).trim(),
    };
  }));
}

async function seedWorkspace(sourceBookId) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novelbox-ab-'));
  await fs.copyFile(
    path.join(REAL_DATA_ROOT, 'config.json'), path.join(tmpRoot, 'config.json'),
  );
  const sourceBook = JSON.parse(await fs.readFile(
    path.join(REAL_DATA_ROOT, 'books', sourceBookId, 'book.json'), 'utf8',
  ));
  store.setDataRoot(tmpRoot);

  const book = await store.createBook({ premise: sourceBook.premise ?? '', title: '笼中火种（A/B）' });
  // 直接沿用真实作品的大纲与核心设定，保证两组收到的世界、文风与循环完全一致。
  const seeded = await store.readBook(book.id);
  seeded.outline = sourceBook.outline ?? seeded.outline;
  seeded.settings = { ...seeded.settings, ...sourceBook.settings };
  seeded.characters = sourceBook.characters ?? seeded.characters;
  await fs.writeFile(
    path.join(tmpRoot, 'books', book.id, 'book.json'),
    JSON.stringify(seeded), 'utf8',
  );

  const section = await store.addSection(book.id, { title: '第一部' });
  const chapters = await loadDocChapters();
  for (const entry of chapters) {
    const created = await store.addChapter(book.id, section.id, { title: entry.title });
    await store.versionSet(
      book.id, `section:${section.id}:chapter:${created.id}`, entry.content,
    );
  }
  const target = await store.addChapter(book.id, section.id, { title: '第21章 未命名' });
  return { tmpRoot, bookId: book.id, sectionId: section.id, targetId: target.id, chapters };
}

function legacyVariant(instruction) {
  const taskStart = instruction.lastIndexOf('请写第');
  if (taskStart < 0) throw new Error('无法定位当前任务句');
  // 当前硬约束与判断依据已经在 system 中。A 组再重复一份旧式逐条清单，
  // 专门验证“重复控制”是否导致篇幅收缩、密度均匀和安全文本。
  return instruction.slice(0, taskStart)
    + LEGACY_EXECUTION_CHECKLIST + '\n'
    + instruction.slice(taskStart).replace(/目标体量约 (\d+) 字/u, '约 $1 字');
}

async function generateWithRetry({ config, system, instruction, label, run, attempts = 2 }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      process.stdout.write(`\n生成 ${label} 第 ${run} 次（尝试 ${attempt}/${attempts}）…`);
      const text = await nonStreamChat({
        config, system, messages: [{ role: 'user', content: instruction }],
      });
      process.stdout.write(' 完成');
      return text;
    } catch (error) {
      lastError = error;
      process.stdout.write(` 失败：${error?.message ?? error}`);
      if (!['LLM_TIMEOUT', 'LLM_NETWORK_ERROR', 'LLM_STREAM_ERROR'].some(
        (code) => String(error?.message ?? error).includes(code),
      )) break;
    }
  }
  throw lastError;
}

function report(label, texts) {
  const rows = texts.map((text, index) => ({
    bookChapterIndex: index + 1, prose: measureChapterProse(text),
  }));
  console.log(`\n== ${label} ==`);
  for (const row of rows) {
    const p = row.prose;
    console.log(`  第${row.bookChapterIndex}次：${p.chars} 字符 | 均段 ${p.avgParagraphChars}`
      + ` | 对话段 ${p.dialogueRatio}% | 感官 ${p.sensoryDensity}/千字`
      + ` | 最长叙述块 ${p.longestNarrationChars}`);
  }
  const mean = (read) => Math.round(
    rows.reduce((sum, row) => sum + read(row.prose), 0) / rows.length * 10,
  ) / 10;
  const summary = {
    chars: mean((p) => p.chars),
    avgParagraphChars: mean((p) => p.avgParagraphChars),
    dialogueRatio: mean((p) => p.dialogueRatio),
    sensoryDensity: mean((p) => p.sensoryDensity),
    longestNarrationChars: mean((p) => p.longestNarrationChars),
  };
  console.log(`  平均：${summary.chars} 字符 | 均段 ${summary.avgParagraphChars}`
    + ` | 对话段 ${summary.dialogueRatio}% | 感官 ${summary.sensoryDensity}/千字`
    + ` | 最长叙述块 ${summary.longestNarrationChars}`);
  return summary;
}

async function main() {
  const args = parseArgs();
  const workspace = await seedWorkspace(args.source);
  const planPack = JSON.parse(await fs.readFile(path.resolve(args.planPath), 'utf8'));
  const plan = planPack.chapters?.find((entry) => entry.index === 21);
  if (!plan) throw new Error('A/B 策划包缺少第 21 章');
  console.log(`临时数据根：${workspace.tmpRoot}`);
  console.log(`已载入 ${workspace.chapters.length} 章真实正文作为上下文与趋势来源。`);

  const storedConfig = await store.readConfig();
  // A/B 是离线候选任务，允许比交互页面更长的单次等待；网络/超时仍只有限重试。
  const config = { ...storedConfig, requestTimeoutMs: Math.max(storedConfig.requestTimeoutMs, 600_000) };
  const generationContext = await store.readChapterGenerationContext(
    workspace.bookId, workspace.sectionId, workspace.targetId,
  );
  const {
    book, section, chapter, previousChapter, bookChapterIndex,
    recentReviewSignals, writingAssetContext,
  } = generationContext;

  const trend = analyzeChapterProseTrend(recentReviewSignals);
  console.log(`\n退化雷达读到 ${trend.measuredCount} 章统计，${trend.risks.length} 项趋势：`);
  for (const risk of trend.risks) console.log(`  - ${risk.message}`);

  const system = buildSystemPrompt(
    book.settings.core, writingAssetContext?.text ?? '', book.settings.storyEngine,
  );
  const context = buildContext({
    book, section, prevChapter: previousChapter, bookChapterIndex,
    chapterPlan: plan, currentContent: '',
  });
  const fresh = buildChapterInstruction({
    chapterIndex: chapter.index, bookChapterIndex,
    wordTarget: config.chapterWordTarget, mode: 'next',
    recentReviewSignals, chapterPlan: plan,
  });
  const allVariants = {
    A_禁令式: `${context}\n\n${legacyVariant(fresh)}`,
    B_背景式: `${context}\n\n${fresh}`,
  };
  const variants = args.group === 'legacy'
    ? { A_禁令式: allVariants.A_禁令式 }
    : args.group === 'current'
      ? { B_背景式: allVariants.B_背景式 }
      : allVariants;
  for (const [label, instruction] of Object.entries(variants)) {
    console.log(`${label} 指令 ${instruction.length} 字符`);
  }

  const outDir = path.join(REAL_DATA_ROOT, '.generation-runs', 'ab-prompt-style');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = Object.fromEntries(
    Object.keys(variants).map((label) => [label, { texts: [], summary: null }]),
  );
  // 按轮次交错 A/B，避免服务状态或时间漂移只影响其中一组。每篇成功后
  // 立即保存内部检查点；后续调用失败也不会丢掉已经付费生成的正文。
  for (let run = 1; run <= args.runs; run += 1) {
    for (const [label, instruction] of Object.entries(variants)) {
      const text = await generateWithRetry({ config, system, instruction, label, run });
      results[label].texts.push(text);
      await fs.writeFile(
        path.join(outDir, `${stamp}-checkpoint-${label}-${run}.txt`), text, 'utf8',
      );
    }
  }
  for (const [label, value] of Object.entries(results)) {
    value.summary = report(label, value.texts);
  }
  const candidates = Object.entries(results).flatMap(([label, value]) =>
    value.texts.map((text, index) => ({ label, run: index + 1, text })));
  // Fisher-Yates 随机打乱；映射只进 summary JSON，盲读正文文件不泄漏组别。
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
  }
  const blindRows = [];
  const blindMapping = {};
  for (const [index, candidate] of candidates.entries()) {
    const id = `候选${String.fromCharCode(65 + index)}`;
    blindMapping[id] = { group: candidate.label, run: candidate.run };
    const fileName = `${stamp}-${id}.txt`;
    await fs.writeFile(path.join(outDir, fileName), candidate.text, 'utf8');
    blindRows.push(`========== ${id} ==========\n\n${candidate.text}`);
  }
  const blindPacketPath = path.join(outDir, `${stamp}-blind-packet.txt`);
  await fs.writeFile(blindPacketPath, blindRows.join('\n\n'), 'utf8');
  const summaryPath = path.join(outDir, `${stamp}-summary.json`);
  await fs.writeFile(summaryPath, JSON.stringify({
    model: config.model, wordTarget: config.chapterWordTarget, runs: args.runs,
    planPath: args.planPath,
    trend: trend.risks.map((risk) => risk.message), blindMapping,
    summaries: Object.fromEntries(
      Object.entries(results).map(([label, value]) => [label, value.summary]),
    ),
  }, null, 2), 'utf8');
  console.log(`\n\n盲读包：${blindPacketPath}`);
  console.log(`组别映射与确定性汇总：${summaryPath}`);
  await fs.rm(workspace.tmpRoot, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { nonStreamChat } from '../server/llm.js';
import { buildSystemPrompt } from '../server/prompts.js';
import { normalizeChapterPlan } from '../server/chapter-plan-schema.js';
import * as store from '../server/store.js';
import {
  apiEditorialDraftMetrics as draftMetrics,
  apiEditorialFingerprint as fingerprint,
  buildApiEditorialReviewerInstruction as reviewerInstruction,
  buildApiEditorialRewriteInstruction as rewriteInstruction,
  buildApiEditorialWriterInstruction as writerInstruction,
  apiEditorialCandidatePasses as candidatePasses,
  extractApiEditorialJson as extractJson,
  selectBestApiEditorialCandidate as selectBestCandidate,
  validateApiEditorialReview as validateReview,
} from '../server/api-editorial-loop.js';

function parseArgs(argv) {
  const result = { ackSend: false, dryRun: false, force: false, specPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--ack-send') result.ackSend = true;
    else if (value === '--dry-run') result.dryRun = true;
    else if (value === '--force') result.force = true;
    else if (value === '--spec') result.specPath = argv[index += 1] ?? '';
    else throw new Error(`未知参数：${value}`);
  }
  if (!result.specPath) throw new Error('缺少 --spec <任务书.json>');
  return result;
}

function resolveWorkspacePath(workspace, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('任务书包含空路径');
  }
  const resolved = path.resolve(workspace, relativePath);
  const prefix = `${workspace}${path.sep}`;
  if (resolved !== workspace && !resolved.startsWith(prefix)) {
    throw new Error(`路径越出工作区：${relativePath}`);
  }
  return resolved;
}

async function readText(workspace, relativePath) {
  return fs.readFile(resolveWorkspacePath(workspace, relativePath), 'utf8');
}

async function writeExclusive(filePath, value, force) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (!force) {
    try {
      await fs.access(filePath);
      throw new Error(`输出已存在，拒绝覆盖：${filePath}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await fs.writeFile(filePath, value, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = process.cwd();
  const specText = await readText(workspace, args.specPath);
  const spec = JSON.parse(specText);
  const requiredNumbers = [
    'chapterIndex', 'minCharacters', 'maxCharacters',
    'minimumReviewScore', 'maxIterations',
  ];
  for (const key of requiredNumbers) {
    if (!Number.isFinite(spec[key])) throw new Error(`任务书缺少数值字段：${key}`);
  }
  if (!Number.isFinite(spec.maxShortParagraphRatio)
    || spec.maxShortParagraphRatio <= 0 || spec.maxShortParagraphRatio >= 1) {
    throw new Error('maxShortParagraphRatio 必须在 0 与 1 之间');
  }
  if (!Number.isInteger(spec.maxIterations)
    || spec.maxIterations < 1 || spec.maxIterations > 10) {
    throw new Error('maxIterations 必须是 1—10 的整数');
  }
  if (spec.minimumReviewScore < 0 || spec.minimumReviewScore > 100) {
    throw new Error('minimumReviewScore 必须在 0 与 100 之间');
  }
  if (spec.minCharacters < 1 || spec.maxCharacters < spec.minCharacters) {
    throw new Error('正文字符范围无效');
  }
  const bookPath = `data/books/${spec.bookId}/book.json`;
  const [bookText, brief, planPackText, previousChapter, ...contexts] = await Promise.all([
    readText(workspace, bookPath),
    readText(workspace, spec.briefPath),
    readText(workspace, spec.planPath),
    readText(workspace, spec.previousChapterPath),
    ...(spec.contextPaths ?? []).map((filePath) => readText(workspace, filePath)),
  ]);
  const book = JSON.parse(bookText);
  const planPack = JSON.parse(planPackText);
  const rawPlan = planPack.chapters?.find((row) => row.index === spec.chapterIndex);
  if (!rawPlan) throw new Error(`策划包没有第 ${spec.chapterIndex} 章`);
  const plan = normalizeChapterPlan(rawPlan);
  for (const field of ['tensionArc', 'foreshadowing', 'worldExpansion']) {
    if (!plan[field]) throw new Error(`第 ${spec.chapterIndex} 章策划缺少 ${field}`);
  }
  store.setDataRoot(path.join(workspace, 'data'));
  const [writerConfig, reviewerConfig] = await Promise.all([
    store.readConfigForTask('chapter', { bookId: spec.bookId }),
    store.readConfigForTask('review', { bookId: spec.bookId }),
  ]);
  const contextEntries = (spec.contextPaths ?? []).map((contextPath, index) => ({
    path: contextPath, text: contexts[index],
  }));
  const system = [
    buildSystemPrompt(book.settings?.core, '', book.settings?.storyEngine),
    '你负责创作，主编只提供边界、审稿和返修要求。把结构转化为有现场感的小说，禁止照表复述。',
  ].join('\n\n');
  const firstInstruction = writerInstruction({
    spec, brief, plan, previousChapter, contextEntries,
  });
  const transferFiles = [
    bookPath, spec.briefPath, spec.planPath, spec.previousChapterPath, ...(spec.contextPaths ?? []),
  ];
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({
      dryRun: true,
      writerModel: writerConfig.model,
      reviewerModel: reviewerConfig.model,
      transferFiles,
      systemCharacters: system.length,
      instructionCharacters: firstInstruction.length,
      maxIterations: spec.maxIterations,
      outputBasePath: spec.outputBasePath,
    }, null, 2)}\n`);
    return;
  }
  if (!args.ackSend) {
    throw new Error('本任务会把任务书列出的作品内容发送到当前外部模型服务；确认授权后必须显式添加 --ack-send');
  }
  const outputBase = resolveWorkspacePath(workspace, spec.outputBasePath);
  const records = [];
  const evaluatedCandidates = [];
  let draft = await nonStreamChat({
    config: writerConfig, system, messages: [{ role: 'user', content: firstInstruction }],
  });
  for (let iteration = 1; iteration <= spec.maxIterations; iteration += 1) {
    const metrics = draftMetrics(draft, spec);
    const reviewRaw = await nonStreamChat({
      config: reviewerConfig,
      system: '你是严格的长篇网文主编。只依据提供的正文证据审稿，返回用户要求的严格 JSON。',
      messages: [{
        role: 'user',
        content: reviewerInstruction({
          spec, brief, plan, previousChapter, draft, metrics,
        }),
      }],
    });
    const review = validateReview(extractJson(reviewRaw));
    const suffix = `-v${iteration}`;
    const draftPath = `${outputBase}${suffix}.txt`;
    const reviewPath = `${outputBase}${suffix}-review.json`;
    await writeExclusive(draftPath, draft, args.force);
    await writeExclusive(reviewPath, `${JSON.stringify({ metrics, review }, null, 2)}\n`, args.force);
    const record = { iteration, draftPath, reviewPath, metrics, review };
    records.push(record);
    evaluatedCandidates.push({ ...record, draft });
    const bestCandidate = selectBestCandidate(evaluatedCandidates);
    const passes = candidatePasses(bestCandidate, spec);
    if (passes || iteration === spec.maxIterations) break;
    draft = await nonStreamChat({
      config: writerConfig, system, messages: [{
        role: 'user',
        content: rewriteInstruction({
          spec, brief, plan, previousChapter,
          draft: bestCandidate.draft,
          review: bestCandidate.review,
          metrics: bestCandidate.metrics,
        }),
      }],
    });
  }
  const selected = selectBestCandidate(evaluatedCandidates);
  const manifestPath = `${outputBase}-manifest.json`;
  await writeExclusive(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'api-editorial-candidate-run',
    status: 'candidate-only',
    generatedAt: new Date().toISOString(),
    writerModel: writerConfig.model,
    reviewerModel: reviewerConfig.model,
    selectedIteration: selected.iteration,
    selectedDraftPath: selected.draftPath,
    selectedReviewPath: selected.reviewPath,
    selectedStatus: candidatePasses(selected, spec) ? 'accepted' : 'needs-author-review',
    selectionBasis: {
      deterministicGatePassed: selected.metrics.deterministicGatePassed,
      failedCheckIds: selected.review.failedCheckIds,
      score: selected.review.score,
    },
    inputFingerprints: {
      spec: fingerprint(specText),
      brief: fingerprint(brief),
      planPack: fingerprint(planPackText),
      previousChapter: fingerprint(previousChapter),
      contexts: contexts.map((value) => fingerprint(value)),
    },
    records,
  }, null, 2)}\n`, args.force);
  process.stdout.write(`${JSON.stringify({ ok: true, manifestPath, records }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
});

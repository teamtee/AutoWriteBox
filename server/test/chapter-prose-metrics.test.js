import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeChapterProseTrend, chapterProseObservations, chapterProseReferenceRows,
  formatChapterProseContext, formatChapterProseTrend, measureChapterProse,
} from '../chapter-prose-metrics.js';
import {
  MIN_CHAPTER_BODY_CHARS, MIN_CHAPTER_SENSORY_DENSITY_PER_1K,
  MIN_CHAPTER_SLOW_PASSAGE_CHARS,
} from '../limits.js';

function narration(chars) {
  return '他沿着渠沿一步一步走过去，冻土在靴底裂开细缝。'.repeat(
    Math.ceil(chars / 23),
  ).slice(0, chars);
}

function chapter({ chars = 3_200, sensory = 20, dialogueLines = 4 } = {}) {
  const lines = [narration(chars)];
  for (let index = 0; index < sensory; index += 1) lines.push('他掌心发烫，喉咙发干。');
  for (let index = 0; index < dialogueLines; index += 1) lines.push('“再等七天。”');
  return lines.join('\n\n');
}

test('度量只依赖正文本身且区分对话段与连续叙述块', () => {
  const metrics = measureChapterProse([
    '第一段叙述。', '第二段叙述。', '“一句对话。”', '第三段叙述。',
  ].join('\n'));
  assert.equal(metrics.paragraphs, 4);
  assert.equal(metrics.dialogueRatio, 25);
  // 对话段会打断叙述块，前两段合并计入最长块，第三段单独重新计数。
  assert.equal(metrics.longestNarrationChars, 12);
  assert.equal(metrics.chars, 25);
});

test('空正文返回零值而不是抛错', () => {
  const metrics = measureChapterProse(undefined);
  assert.deepEqual(metrics, {
    chars: 0, paragraphs: 0, avgParagraphChars: 0, dialogueRatio: 0,
    sensoryHits: 0, sensoryDensity: 0, longestNarrationChars: 0,
  });
});

test('感官锚点按千字归一，长章不会因为总量大自动通过', () => {
  const dense = measureChapterProse('他掌心发烫，喉咙发干。');
  const sparse = measureChapterProse(
    `他掌心发烫。\n${'议事继续进行，各方陈述理由。'.repeat(100)}`,
  );
  assert.ok(dense.sensoryDensity > sparse.sensoryDensity);
  assert.ok(sparse.sensoryHits > 0);
});

test('达到参考值的章节不产生任何观察语句', () => {
  const rows = chapterProseReferenceRows(measureChapterProse(chapter()));
  assert.equal(rows.length, 3);
  assert.equal(rows.every((row) => !row.belowReference), true);
  assert.deepEqual(chapterProseObservations(measureChapterProse(chapter())), []);
});

test('低于参考值只描述事实和原因，不给出合格判定', () => {
  const short = measureChapterProse(chapter({ chars: 400 }));
  const body = chapterProseReferenceRows(short).find((row) => row.id === 'body-length');
  assert.equal(body.belowReference, true);
  assert.equal(body.reference, MIN_CHAPTER_BODY_CHARS);
  const observations = chapterProseObservations(short).join('');
  assert.match(observations, /低于 3000 字的连载参考体量/);
  assert.match(observations, /直接影响按千字计算的订阅收入/);
  // 不出现合格线式判定用语。
  assert.equal(/不合格|未达标|违反|必须改/.test(observations), false);

  // 体量足够、但全章只有短对话行：只剩另外两项低于参考值。
  const staccato = measureChapterProse(
    Array.from({ length: 600 }, () => '“再等七天。”').join('\n'),
  );
  const rows = chapterProseReferenceRows(staccato);
  assert.equal(rows.find((row) => row.id === 'body-length').belowReference, false);
  assert.equal(rows.find((row) => row.id === 'slow-passage').reference,
    MIN_CHAPTER_SLOW_PASSAGE_CHARS);
  assert.equal(rows.find((row) => row.id === 'sensory-anchor').reference,
    MIN_CHAPTER_SENSORY_DENSITY_PER_1K);
  assert.equal(chapterProseObservations(staccato).length, 2);
});

function row(bookChapterIndex, options) {
  return { bookChapterIndex, prose: measureChapterProse(chapter(options)) };
}

test('连续两章低于下限判为持续缩水而不是单章波动', () => {
  const single = analyzeChapterProseTrend([
    row(1), row(2), row(3, { chars: 600 }),
  ]);
  assert.equal(single.risks.some((risk) => risk.id === 'body-length-below-quota-streak'), false);

  const streak = analyzeChapterProseTrend([
    row(1), row(2, { chars: 900 }), row(3, { chars: 600 }),
  ]);
  const risk = streak.risks.find((entry) => entry.id === 'body-length-below-quota-streak');
  assert.equal(risk.severity, 'risk');
  assert.deepEqual(risk.bookChapterIndexes, [2, 3]);
});

test('连续三章字数下滑即使全部达标也会报警', () => {
  const trend = analyzeChapterProseTrend([
    row(1, { chars: 6_000 }), row(2, { chars: 5_000 }), row(3, { chars: 4_000 }),
  ]);
  const risk = trend.risks.find((entry) => entry.id === 'body-length-decline');
  assert.equal(risk.severity, 'risk');
  assert.deepEqual(risk.bookChapterIndexes, [1, 2, 3]);
  assert.equal(trend.risks.some((entry) => entry.id === 'body-length-below-quota-streak'), false);
});

test('基线下移在单章比较看不出来时仍被识别', () => {
  const trend = analyzeChapterProseTrend([
    row(1, { chars: 6_000 }), row(2, { chars: 6_400 }), row(3, { chars: 6_200 }),
    row(4, { chars: 3_400 }), row(5, { chars: 3_600 }), row(6, { chars: 3_200 }),
  ]);
  const risk = trend.risks.find((entry) => entry.id === 'body-length-baseline-drift');
  assert.equal(risk.severity, 'risk');
  assert.deepEqual(risk.bookChapterIndexes, [4, 5, 6]);
  // 后三章互有涨跌，逐章下滑规则不应该同时触发。
  assert.equal(trend.risks.some((entry) => entry.id === 'body-length-decline'), false);
});

test('感官密度与段长连续下降作为建议级退化信号', () => {
  const trend = analyzeChapterProseTrend([
    row(1, { sensory: 40 }), row(2, { sensory: 20 }), row(3, { sensory: 4 }),
  ]);
  const risk = trend.risks.find((entry) => entry.id === 'sensory-density-decline');
  assert.equal(risk.severity, 'advisory');
  assert.match(risk.message, /正文正在变干/);
});

test('稳定的章节不产生任何退化风险', () => {
  const trend = analyzeChapterProseTrend([row(1), row(2), row(3), row(4)]);
  assert.deepEqual(trend.risks, []);
  assert.equal(trend.measuredCount, 4);
});

test('空正文章节不参与趋势比较', () => {
  const trend = analyzeChapterProseTrend([
    { bookChapterIndex: 1, prose: measureChapterProse('') },
    { bookChapterIndex: 2, signals: null },
    row(3),
  ]);
  assert.equal(trend.measuredCount, 1);
  assert.deepEqual(trend.rows.map((entry) => entry.bookChapterIndex), [3]);
});

test('趋势上下文只输出统计事实，不包含正文原文，也不下命令', () => {
  const body = chapter({ chars: 900 });
  const text = formatChapterProseTrend(analyzeChapterProseTrend([
    { bookChapterIndex: 7, prose: measureChapterProse(body) },
    { bookChapterIndex: 8, prose: measureChapterProse(body) },
  ]));
  assert.match(text, /全书第 7 章/);
  assert.match(text, /连续低于 3000 字/);
  assert.match(text, /是诊断信息，不是指标任务/);
  assert.match(text, /可以偏离它们/);
  assert.equal(text.includes('冻土在靴底裂开细缝'), false);
  assert.equal(formatChapterProseTrend(analyzeChapterProseTrend([])), '');
});

test('写前背景给出目标、原因和判断依据，而不是逐条禁令', () => {
  const low = formatChapterProseContext(1_200);
  assert.match(low, new RegExp(`单章目标体量约 ${MIN_CHAPTER_BODY_CHARS} 字`));
  assert.equal(low.includes('1200'), false);
  assert.match(formatChapterProseContext(6_000), /单章目标体量约 6000 字/);
  // 解释原因而不是下达指标。
  assert.match(low, /按千字获得订阅收入/);
  assert.match(low, /这是商业背景，不是字数任务/);
  assert.match(low, /供你自查的信号，不是需要打勾的指标/);
  assert.match(low, /本章哪一场值得放慢，由你根据剧情判断/);
  assert.equal(/不得|禁止|必须/.test(low), false);
});

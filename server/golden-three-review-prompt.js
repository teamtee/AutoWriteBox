import { boundedJoin } from './prompt-join.js';
import { GOLDEN_THREE_CHECK_IDS } from './golden-three-review-schema.js';

const CHECK_LABELS = Object.freeze({
  premisePromise: '题材与包装承诺', protagonistAttachment: '人物依恋',
  protagonistDrive: '主角驱动力', coreLoop: '核心循环', centralConflict: '主要矛盾',
  differentiation: '差异化卖点', firstPayoff: '第一次有效兑现',
  threeChapterEscalation: '三章递进', continuationPull: '第三章后追读力',
});

export const GOLDEN_THREE_REVIEW_SYSTEM_PROMPT = [
  '你是负责商业网文开篇的总审编辑。只判断给出的全书前三章合起来是否形成可持续阅读体验，',
  '不能把三张单章评分相加，也不能用题材刻板模板代替文本证据。',
  '所有证据必须来自正文，并标出章号；书名、简介、大纲和核心循环只用于判断作品承诺，不能冒充正文已兑现。',
  '输出严格 JSON，不要 Markdown、代码围栏或额外说明。',
].join('');

export function buildGoldenThreeReviewInstruction(context) {
  const checks = GOLDEN_THREE_CHECK_IDS.map(
    (id) => `- ${id}（${CHECK_LABELS[id]}）`,
  ).join('\n');
  const chapterText = context.chapters.map((chapter) =>
    `【全书第 ${chapter.bookChapterIndex} 章${chapter.title ? ` · ${chapter.title}` : ''}】\n${chapter.content}`
  ).join('\n\n');
  return boundedJoin([
    '请联合审阅以下全书前三章。先判断三章是否完成“承诺建立 → 冲突/机制展开 → 首次有效兑现与新牵引”的整体链条。\n',
    '评分是整体编辑判断，不得对单章分数求和或平均。安静开篇不因没有打斗直接扣分，但人物必须有欲望、选择或关系/认知变化。\n\n',
    `【书名】${context.title || '（未命名）'}\n`,
    `【故事设想 / 包装承诺】${context.premise || '（未填写）'}\n`,
    `【全书大纲】${context.outline || '（未填写）'}\n`,
    `【核心设定】${JSON.stringify(context.core)}\n`,
    `【作品核心循环】${JSON.stringify(context.storyEngine)}\n\n`,
    chapterText, '\n\n【必须逐项检查，顺序和 id 不得改变】\n', checks,
    '\n\n每项 status 只能是 pass 或 risk；summary 给整体结论；evidence 为 1–3 条正文证据，chapter 只能是 1、2、3，同一项不得重复章号。每条 evidence 必须把 quote 与 analysis 分开：quote 逐字复制该章当前正文中的一段连续短句，analysis 再解释它如何支持本项判断；不得引用其它章、书名、简介、大纲或自行概括冒充原文。',
    '\nfixes 必须给 1–5 条最有杠杆的修复方案，target 只能是 chapter-1、chapter-2、chapter-3 或 all；instruction 要能直接用于定向改稿，并要求保留无关的已成功内容。',
    '\n返回格式：',
    '{"score":0,"verdict":"120字内总体判断","checks":[',
    '{"id":"premisePromise","status":"pass|risk","summary":"200字内结论","evidence":[{"chapter":1,"quote":"160字内正文连续原文","analysis":"160字内证据解释"}]}',
    ',...其余八项],"fixes":[{"target":"chapter-1|chapter-2|chapter-3|all","label":"30字内标签","problem":"200字内问题","instruction":"1000字内定向改稿指令"}]}',
  ]);
}

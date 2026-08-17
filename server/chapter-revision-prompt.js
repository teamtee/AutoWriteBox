import { boundedJoin } from './prompt-join.js';
import { chapterRevisionStage } from './chapter-revision-schema.js';

export const CHAPTER_REVISION_SYSTEM_APPENDIX = [
  '\n你现在执行的是“单项修订候选”，不是续写、重写剧情或自由润色。',
  '只处理本次指定问题，保持其它成功内容稳定；候选不会自动保存，将由作者逐段核对。',
  '任何 promise_ 开头的债务 ID、策划合同标签、qualityProtocolVersion、designProtocolVersion、审稿 JSON 字段都属于编辑后台信息，绝不能写进正文候选。',
].join('');

export function buildChapterRevisionInstruction({
  stageId, chapterIndex, bookChapterIndex = chapterIndex, context, content,
}) {
  const stage = chapterRevisionStage(stageId);
  if (!stage) throw new Error('BAD_CHAPTER_REVISION_STAGE');
  return boundedJoin([
    `请对全书第 ${bookChapterIndex} 章（当前分部第 ${chapterIndex} 章）执行一次单项修订。\n`,
    `【本次阶段】${stage.label}\n【只处理】${stage.focus}\n【本阶段护栏】${stage.guard}\n\n`,
    '【全程事实保护】\n',
    '1. 保留原文事件顺序、事件结果、人物决定、关系状态、姓名身份、数量、时间、地点、能力边界、物品归属、知识边界、伏笔和章末因果。\n',
    '2. 不新增或删除主要事件，不偷换人物动机，不提前揭密，不改变视角，不另造爽点、反转或钩子。\n',
    '3. 只改确有本阶段问题的段落；没有问题的段落尽量原样保留。不能顺手执行其它五类修订。\n',
    '4. 输出完整章节正文，不能只输出修改片段、摘要或修改说明。不要标题、Markdown、代码围栏、前后解释。若本阶段没有值得修改的问题，原样输出全文。\n\n',
    '【作品与连续性上下文】\n', context || '（无额外上下文）', '\n\n',
    '【当前完整正文】\n', content,
  ]);
}

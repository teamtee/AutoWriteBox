import { boundedJoin } from './prompt-join.js';
import { STORY_ENGINE_FIELDS } from './story-engine-schema.js';

const OUTLINE_WINDOW = 5_000;
const FIELD_WINDOW = 2_500;
const PREMISE_WINDOW = 1_200;
const STYLE_WINDOW = 800;
const STORY_ENGINE_FIELD_WINDOW = 300;
const EXISTING_NAMES_WINDOW = 1_200;

function windowText(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '（暂无）';
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  const keep = Math.floor(maxLength / 2) - 8;
  return `${chars.slice(0, keep).join('')}…（中间省略）…${chars.slice(-keep).join('')}`;
}

function bookContext({
  premise = '', outline = '', world = '', style = '', storyEngine = {},
}) {
  return boundedJoin([
    '【故事设想】\n', windowText(premise, PREMISE_WINDOW), '\n\n',
    '【全书大纲】\n', windowText(outline, OUTLINE_WINDOW), '\n\n',
    '【世界观摘要】\n', windowText(world, FIELD_WINDOW), '\n\n',
    '【文风摘要】\n', windowText(style, STYLE_WINDOW), '\n\n',
    '【已有核心循环】\n',
    STORY_ENGINE_FIELDS.map((field) =>
      `- ${field}：${windowText(storyEngine?.[field], STORY_ENGINE_FIELD_WINDOW)}`).join('\n'),
    '\n',
  ]);
}

export function buildStoryEngineDraftInstruction(input) {
  return boundedJoin([
    '根据下面的故事材料，填写作品级“核心循环”。这是读者为什么连续追读的合同，不是单章提纲。\n',
    '只输出一个 JSON 对象，不要代码围栏或说明，字段必须恰好为：\n',
    'readerExperience, protagonistAction, progression, cost, escalation。\n',
    '每项 40–180 字，写具体动作和代价，禁止空话、口号和“待定”。',
    '允许单章蓄力或变奏，但五项必须能长期循环升级。\n\n',
    bookContext(input),
  ]);
}

export function buildCharacterCraftDraftInstruction(input) {
  const existing = Array.isArray(input.existingNames) && input.existingNames.length
    ? windowText(input.existingNames.join('、'), EXISTING_NAMES_WINDOW)
    : '（尚无导演卡）';
  return boundedJoin([
    '根据故事材料，起草“人物导演卡”和“关系温度卡”。\n',
    '导演卡只写此刻欲望、恐惧、作者掌握的秘密、受压反应和说话习惯，不写已经发生的履历。',
    '秘密是作者信息，不能写成角色已知事实。\n',
    '只输出 JSON：{"characters":[...],"relationships":[...]}\n',
    'characters 2–6 人，必须含 name、importance(1-5)、currentDesire、fear、secret、',
    'pressureResponse、speechPattern、speechAvoid；可含 notes。\n',
    'relationships 0–6 组，from/to 必须是本次 characters 的 name，',
    '并含 importance、temperature(-5到5)、surfaceState、privateTension、desiredDirection。\n',
    `不要重复已有人物：${existing}\n`,
    '不要代码围栏或解释。\n\n',
    bookContext(input),
  ]);
}

export function buildPromiseLedgerDraftInstruction(input) {
  const start = Number.isInteger(input.startChapter) ? input.startChapter : 1;
  return boundedJoin([
    '根据故事材料，列出作者计划向读者建立的承诺。这些是计划，不是正文已经兑现的事实。\n',
    '只输出 JSON：{"entries":[...]}\n',
    'entries 3–8 条。每条含 kind(main|character|mystery|relationship|growth|world|other)、',
    'importance(1-5)、promise、expectedStartChapter、expectedEndChapter、notes。\n',
    `章序是全书章序，expectedStartChapter 不小于 ${start}。\n`,
    'promise 写读者将等待什么，不要写成已发生事件。不要债务编号。不要代码围栏。\n\n',
    bookContext(input),
  ]);
}

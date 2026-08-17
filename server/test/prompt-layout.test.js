import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChapterInstruction, buildContext } from '../prompts.js';
import { validChapterPlanFixture } from './chapter-plan-fixture.js';

// 提示词的块序本身就是一种指令：越靠近任务句的材料越容易被执行。
// 本文件只断言块标题的顺序与存在性，不断言任何正文措辞，因此改写
// 单块内容不会误伤，而调整装配顺序必须显式更新期望。
// 重排计划见 docs/上下文组织审视与修正计划.md 阶段 4。

const PROMISE_ID = `promise_${'a'.repeat(32)}`;
const CRAFT_CHARACTER_ID = `charcraft_${'a'.repeat(32)}`;
const CRAFT_RELATIONSHIP_ID = `relcraft_${'b'.repeat(32)}`;
const CRAFT_CHANGE_ID = `relchange_${'c'.repeat(32)}`;

function fullyPopulatedInput() {
  const book = {
    title: '排布基线',
    premise: '一个被封锁的城市里，主角要带走唯一的证人。',
    outline: { versions: ['全书大纲正文'], cursor: 0 },
    sections: ['section-01', 'section-02'],
    sectionSummaries: {
      'section-01': { index: 1, title: '封锁', summary: '第1章：主角失去旧身份。' },
    },
    characters: [{ name: '沈砚', role: '主角', desc: '前证物管理员' }],
    memory: {
      facts: [{
        id: 'fact-1', status: 'active', kind: 'item',
        subject: '旧凭证', predicate: '当前持有人为', object: '沈砚',
        importance: 5, updatedAt: '2026-08-01T00:00:00.000Z',
        source: { chapterIndex: 3 },
      }],
    },
    settings: {
      promiseLedger: {
        entries: [{
          id: PROMISE_ID, kind: 'main', status: 'open', importance: 5,
          promise: '主角必须查清师父为何隐瞒灭门真相',
          introducedChapter: 2, expectedStartChapter: 8, expectedEndChapter: 10,
          progress: [], resolution: '', resolvedChapter: null, nextPromise: '',
          notes: '不能用失忆解释',
          createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
        }],
      },
      characterCraft: {
        characters: [{
          id: CRAFT_CHARACTER_ID, name: '沈砚', importance: 5, asOfChapter: 8,
          currentDesire: '在妹妹发现真相前拿回密信',
          fear: '被妹妹看见自己曾参与旧案',
          secret: '当年是他亲手调换了证物',
          pressureResponse: '先冷嘲拖延，退路被堵死后会主动承担最危险的部分',
          speechPattern: '句子短，不直接解释关心，总用行动替代道歉',
          speechAvoid: '不讲大道理，不主动说“我是为你好”',
          notes: '',
          createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
        }],
        relationships: [{
          id: CRAFT_RELATIONSHIP_ID, from: '沈砚', to: '沈青',
          importance: 5, asOfChapter: 8, temperature: 1,
          surfaceState: '互相讥讽但仍共同查案',
          privateTension: '沈砚因愧疚过度保护，沈青把保护误解为不信任',
          desiredDirection: '密信曝光后先决裂，再由沈砚承担后果重建信任',
          changes: [{
            id: CRAFT_CHANGE_ID, chapter: 7, temperature: 1, reason: '沈砚替沈青挡下追杀',
          }],
          notes: '',
          createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
        }],
      },
    },
  };
  const section = {
    id: 'section-02',
    outline: { content: '本部大纲正文' },
    summary: '第1章：主角在闸机前被拦下。',
    characters: [{ name: '沈青', role: '本部关键人物', desc: '被封锁的证人' }],
  };
  const prevChapter = {
    content: '上一章结尾：闸机放行之后，追踪警报同时亮起。',
    characters: [{ name: '巡逻队长', role: '本章对手', desc: '负责闸机审计' }],
    progress: '下一步建议：让主角带证人离开旧城。',
    handoff: {
      viewpoint: '沈砚', time: '同一夜凌晨', location: '旧城北闸机',
      ongoingAction: '带着证人穿过闸机',
    },
  };
  return { book, section, prevChapter, chapterPlan: validChapterPlanFixture() };
}

function blockTitles(text) {
  return text.split('\n')
    .filter((row) => row.startsWith('【'))
    .map((row) => row.slice(1, row.indexOf('】')));
}

// 当前实际块序。阶段 4 重排后必须显式更新本常量，并同步
// docs/上下文组织审视与修正计划.md 中的目标块序。
const CHAPTER_REWRITE_BLOCK_ORDER = Object.freeze([
  '上下文分层：材料的性质不同，可信度也不同',
  'A. 已发生事实与当前连续性',
  '此前分部剧情',
  '本部前情',
  '主要人物',
  '本部人物',
  '已确认长期记忆',
  '上一章登场人物',
  'B. 作品方向与未来计划（不是已发生事实）',
  '书名',
  '作品简介 / 初始设想',
  '全书大纲',
  '本部大纲',
  'C. 阅读债务与作者导演信息（不是公开事实）',
  '上一章摘要 API 给出的后续走向建议（不是事实或已确认计划）',
  '承诺—推进—兑现账本（作者记录）',
  '人物驱动力与声音（作者导演卡）',
  '上一章结尾',
  '上一章场景交接快照（摘要 API 从正文提取）',
  '本章策划卡（作者意图）',
  '场景链（作者规划的发生顺序）',
  '策划卡各字段想解决的问题',
  '当前章原文',
  '体量与质感的写前背景',
]);

function buildRewritePrompt() {
  const { book, section, prevChapter, chapterPlan } = fullyPopulatedInput();
  const context = buildContext({
    book, section, prevChapter, bookChapterIndex: 9, chapterPlan, currentContent: '当前稿',
  });
  const instruction = buildChapterInstruction({
    chapterIndex: 9, bookChapterIndex: 9, wordTarget: 3_000, mode: 'rewrite',
    currentContent: '当前章原文正文。', chapterPlan, recentReviewSignals: [],
  });
  return `${context}\n\n${instruction}`;
}

test('章节重写提示词的块序保持稳定，装配顺序变化必须显式更新期望', () => {
  assert.deepEqual(blockTitles(buildRewritePrompt()), CHAPTER_REWRITE_BLOCK_ORDER);
});

test('任务句只出现一次，避免指导语被夹在两句任务描述之间', () => {
  const matches = buildRewritePrompt().match(/请写第 9 章正文|重写第 9 章/gu) ?? [];
  assert.equal(matches.length, 1, `任务描述出现 ${matches.length} 次：${matches.join(' / ')}`);
});

test('本章策划卡排在上一章结尾之后、当前章原文不再把两者隔开', () => {
  const order = blockTitles(buildRewritePrompt());
  const ending = order.indexOf('上一章结尾');
  const plan = order.indexOf('本章策划卡（作者意图）');
  const current = order.indexOf('当前章原文');
  assert.ok(ending >= 0 && plan >= 0 && current >= 0);
  assert.ok(
    current > plan,
    '当前章原文（最多 20 万字符）横在上一章结尾与本章策划卡之间，'
    + '把最需要并置阅读的两块隔开。',
  );
});

test('已发生事实层排在作者计划层之前，与分层说明的优先级一致', () => {
  const order = blockTitles(buildRewritePrompt());
  const facts = order.findIndex((title) => title.includes('已发生事实与当前连续性'));
  const plans = order.findIndex((title) => title.includes('作品方向与未来计划'));
  assert.ok(facts >= 0 && plans >= 0);
  assert.ok(
    facts < plans,
    '代码里 A=作者计划、B=已发生事实，与 docs/好看正文-Prompt与上下文组织.md §二 '
    + '定义的 A=已发生事实、B=作者计划相反。',
  );
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildCharacterProfiles, buildForeshadowingReminders, buildMemoryContinuityWarnings,
  characterProfileField, filterMemoryFacts, MemoryLibraryPanel,
} from './MemoryLibraryPanel';
import type { MemoryFact } from '../types';

const fact = (overrides: Partial<MemoryFact> = {}): MemoryFact => ({
  id: `memory_${'a'.repeat(32)}`,
  kind: 'ability', subject: '林越', predicate: '回溯上限', object: '每天两次',
  evidence: '人物明确说明', importance: 5, status: 'active',
  source: {
    sectionId: 'section-01', chapterId: 'chapter-01', chapterIndex: 1,
    bodyFingerprint: 'F'.repeat(43),
  },
  confirmedAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  ...overrides,
});

describe('MemoryLibraryPanel', () => {
  it('默认只筛选活动事实，并支持类型、状态与关键词组合', () => {
    const facts = [
      fact(),
      fact({ id: `memory_${'b'.repeat(32)}`, status: 'stale', kind: 'location', object: '北港' }),
    ];
    expect(filterMemoryFacts(facts)).toHaveLength(1);
    expect(filterMemoryFacts(facts, { status: 'all', kind: 'location', query: '北港' }))
      .toEqual([facts[1]]);
    expect(filterMemoryFacts(facts, { status: 'all', query: '不存在' })).toEqual([]);
  });

  it('首屏明确区分已确认事实与 AI 候选，并提供加载状态', () => {
    const html = renderToStaticMarkup(
      <MemoryLibraryPanel bookId="book-1" canOpenSource={() => true} />,
    );
    expect(html).toContain('长期记忆库');
    expect(html).toContain('这里只展示作者确认过的事实');
    expect(html).toContain('正在读取长期记忆');
  });

  it('只用活动且已确认的人物事实建立分栏档案，并附加同主体能力和阵营', () => {
    const facts = [
      fact({ id: `memory_${'1'.repeat(32)}`, kind: 'character', predicate: '身份', object: '巡夜人' }),
      fact({ id: `memory_${'2'.repeat(32)}`, kind: 'character', predicate: '目标', object: '找到失踪的妹妹' }),
      fact({ id: `memory_${'3'.repeat(32)}`, kind: 'ability', predicate: '回溯能力', object: '回到十秒前' }),
      fact({ id: `memory_${'4'.repeat(32)}`, kind: 'ability', predicate: '使用上限', object: '每天两次' }),
      fact({ id: `memory_${'5'.repeat(32)}`, kind: 'faction', predicate: '所属组织', object: '北港巡夜司' }),
      fact({ id: `memory_${'6'.repeat(32)}`, kind: 'character', predicate: '当前状态', object: '负伤', status: 'stale' }),
      fact({ id: `memory_${'7'.repeat(32)}`, kind: 'ability', subject: '无人物事实的主体', predicate: '能力', object: '未知' }),
    ];
    const profiles = buildCharacterProfiles(facts);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('林越');
    expect(profiles[0].fields.identity[0].object).toBe('巡夜人');
    expect(profiles[0].fields.goal[0].object).toBe('找到失踪的妹妹');
    expect(profiles[0].fields.ability[0].object).toBe('回到十秒前');
    expect(profiles[0].fields.limitations[0].object).toBe('每天两次');
    expect(profiles[0].fields.faction[0].object).toBe('北港巡夜司');
    expect(profiles[0].fields.currentStatus).toEqual([]);
    expect(characterProfileField(fact({ kind: 'location' }))).toBeNull();
  });

  it('只对活动关键字段的不同值给出连续性风险，不自动判定普通历史事件冲突', () => {
    const warnings = buildMemoryContinuityWarnings([
      fact({ id: `memory_${'8'.repeat(32)}`, kind: 'location', predicate: '当前位置', object: '北港' }),
      fact({ id: `memory_${'9'.repeat(32)}`, kind: 'location', predicate: '所在地', object: '南城' }),
      fact({ id: `memory_${'a'.repeat(32)}`, kind: 'location', predicate: '移动事件', object: '从北港启程' }),
      fact({ id: `memory_${'b'.repeat(32)}`, kind: 'item', predicate: '持有人', object: '林越' }),
      fact({ id: `memory_${'c'.repeat(32)}`, kind: 'item', predicate: '拥有者', object: '林越' }),
      fact({ id: `memory_${'d'.repeat(32)}`, kind: 'character', predicate: '生死状态', object: '死亡', status: 'stale' }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].label).toBe('当前位置');
    expect(warnings[0].facts.map((item) => item.object)).toEqual(['北港', '南城']);
  });

  it('只提醒已到期且尚未回收的活动伏笔', () => {
    const reminders = buildForeshadowingReminders([
      fact({
        id: `memory_${'e'.repeat(32)}`, kind: 'foreshadowing', subject: '断剑来历',
        details: { foreshadowStatus: 'planted', dueChapter: '第8章', plannedPayoff: '揭示师父身份' },
      }),
      fact({
        id: `memory_${'f'.repeat(32)}`, kind: 'foreshadowing', subject: '黑猫身份',
        details: { foreshadowStatus: 'planted', dueChapter: '12' },
      }),
      fact({
        id: `memory_${'0'.repeat(32)}`, kind: 'foreshadowing', subject: '旧信',
        details: { foreshadowStatus: 'resolved', dueChapter: '5', actualPayoff: '已揭晓' },
      }),
    ], 10);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].fact.subject).toBe('断剑来历');
    expect(reminders[0].dueChapter).toBe(8);
    expect(reminders[0].overdueBy).toBe(2);
  });
});

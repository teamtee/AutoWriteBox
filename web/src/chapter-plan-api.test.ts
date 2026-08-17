import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateChapterPlanDraft, saveChapterPlan } from './api';
import { saveChapterPlanWithReconciliation } from './app-workflows';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('chapter plan API', () => {
  it('sends chapter intent and scene chain with an optimistic revision anchor', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      qualityProtocolVersion: 0, designProtocolVersion: 0,
      goal: '目标', obstacle: '', choice: '', payoff: '', hook: '',
      rhythmIntentVersion: 0, rhythmIntent: {
        pressurePattern: '', resolutionMethod: '', payoffScale: '', hookMechanism: '', costType: '',
      },
      tensionArc: '', foreshadowing: '', worldExpansion: '',
      decisionChain: '', knowledgeDesign: '', notes: '',
      scenes: [],
      revision: 'N'.repeat(43), isEmpty: false,
    }))) as unknown as typeof fetch;
    const plan = {
      qualityProtocolVersion: 0 as const,
      designProtocolVersion: 0 as const,
      rhythmIntentVersion: 0 as const, rhythmIntent: {
        pressurePattern: '' as const, resolutionMethod: '' as const,
        payoffScale: '' as const, hookMechanism: '' as const, costType: '' as const,
      },
      goal: '目标', obstacle: '', choice: '', payoff: '', hook: '',
      tensionArc: '', foreshadowing: '', worldExpansion: '',
      decisionChain: '', knowledgeDesign: '', notes: '',
      scenes: [{
        title: '相遇', desire: '找到证人', obstacle: '追兵', action: '破门',
        turn: '证人不在', cost: '惊动守卫',
      }],
    };
    await expect(saveChapterPlan(
      'book 1', 'section/1', 'chapter#1', plan, 'R'.repeat(43),
    )).resolves.toMatchObject({ goal: '目标' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/books/book%201/sections/section%2F1/chapters/chapter%231/plan',
      expect.objectContaining({
        method: 'POST', body: JSON.stringify({ plan, expectedRevision: 'R'.repeat(43) }),
      }),
    );
  });

  it('requests a cancellable AI candidate without saving it', async () => {
    const plan = {
      qualityProtocolVersion: 0 as const,
      designProtocolVersion: 0 as const,
      rhythmIntentVersion: 0 as const, rhythmIntent: {
        pressurePattern: '' as const, resolutionMethod: '' as const,
        payoffScale: '' as const, hookMechanism: '' as const, costType: '' as const,
      },
      goal: '目标', obstacle: '', choice: '', payoff: '', hook: '',
      tensionArc: '', foreshadowing: '', worldExpansion: '',
      decisionChain: '', knowledgeDesign: '', notes: '', scenes: [],
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      plan, basePlanRevision: 'R'.repeat(43),
    }))) as unknown as typeof fetch;
    const controller = new AbortController();
    await expect(generateChapterPlanDraft(
      'book 1', 'section/1', 'chapter#1', plan, 'R'.repeat(43), controller.signal,
    )).resolves.toMatchObject({ basePlanRevision: 'R'.repeat(43) });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/gen/chapter-plan-draft',
      expect.objectContaining({
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({
          bookId: 'book 1', sectionId: 'section/1', chapterId: 'chapter#1',
          seedPlan: plan, expectedPlanRevision: 'R'.repeat(43),
        }),
      }),
    );
  });

  it('updates the local snapshot before refreshing the derived context', async () => {
    const events: string[] = [];
    await expect(saveChapterPlanWithReconciliation({
      save: async () => ({ revision: 'next' }),
      refresh: async () => { events.push('refresh'); },
      isConflict: () => false,
      onConflict: vi.fn(), onConflictRefreshFailure: vi.fn(),
      onAmbiguous: vi.fn(), onAmbiguousRefreshFailure: vi.fn(),
      onSaved: () => { events.push('saved'); },
      onRefreshFailure: vi.fn(),
      onSuccess: () => { events.push('success'); },
    })).resolves.toEqual({ revision: 'next' });
    expect(events).toEqual(['saved', 'refresh', 'success']);
  });

  it('refreshes a plan conflict, reports it and keeps the rejected error', async () => {
    const conflict = new Error('CHAPTER_PLAN_CONFLICT');
    const onConflict = vi.fn();
    await expect(saveChapterPlanWithReconciliation({
      save: async () => { throw conflict; },
      refresh: async () => {},
      isConflict: (error) => error === conflict,
      onConflict, onConflictRefreshFailure: vi.fn(),
      onAmbiguous: vi.fn(), onAmbiguousRefreshFailure: vi.fn(),
      onSaved: vi.fn(), onRefreshFailure: vi.fn(), onSuccess: vi.fn(),
    })).rejects.toBe(conflict);
    expect(onConflict).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it } from 'vitest';
import {
  characterCraftPairKey, characterGuideDraft, plannedPromiseEntry,
  relationshipGuideDraft,
} from './ai-fill-apply';

describe('ai fill draft conversion', () => {
  it('converts character and relationship candidates without persisting them', () => {
    const character = characterGuideDraft('charcraft_new', {
      name: '沈青', importance: 4, asOfChapter: 3, currentDesire: '问清真相', fear: '',
      secret: '', pressureResponse: '追问到底', speechPattern: '连珠问句',
      speechAvoid: '求饶', notes: '',
    });
    const relationship = relationshipGuideDraft('relcraft_new', {
      from: '沈青', to: '沈砚', importance: 5, asOfChapter: 3, temperature: 1,
      surfaceState: '互相讥讽', privateTension: '保护被误解',
      desiredDirection: '第一次坦白', notes: '',
    });
    expect(character).toMatchObject({ id: 'charcraft_new', name: '沈青' });
    expect(relationship).toMatchObject({
      id: 'relcraft_new', from: '沈青', to: '沈砚', changes: [],
    });
    expect(characterCraftPairKey('沈青', '沈砚'))
      .toBe(characterCraftPairKey('沈砚', '沈青'));
  });

  it('converts a promise candidate to an unsaved planned entry', () => {
    expect(plannedPromiseEntry('promise_x', {
      kind: 'world', importance: 2, promise: '边界', expectedStartChapter: 3,
      expectedEndChapter: 4, notes: '',
    })).toMatchObject({
      id: 'promise_x', status: 'planned', promise: '边界', introducedChapter: null,
      progress: [], resolution: '',
    });
  });
});

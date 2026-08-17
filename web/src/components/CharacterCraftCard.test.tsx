import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CharacterGuide, RelationshipGuide } from '../types';
import {
  CharacterList, emptyCharacterGuide, emptyRelationshipGuide,
  RelationshipList, relationshipTemperatureLabel,
} from './CharacterCraftCard';

const character: CharacterGuide = {
  id: `charcraft_${'a'.repeat(32)}`, name: '沈砚', importance: 5, asOfChapter: 8,
  currentDesire: '在妹妹发现真相前拿回密信', fear: '妹妹看见自己的旧罪',
  secret: '当年亲手调换证物', pressureResponse: '先冷嘲拖延，退路断绝后主动担险',
  speechPattern: '短句，用行动替代道歉', speechAvoid: '不讲大道理', notes: '',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
};
const relationship: RelationshipGuide = {
  id: `relcraft_${'b'.repeat(32)}`, from: '沈砚', to: '沈青', importance: 5,
  asOfChapter: 8, temperature: 1, surfaceState: '互相讥讽但共同查案',
  privateTension: '愧疚式保护被误解为不信任', desiredDirection: '真相曝光后决裂',
  changes: [{
    id: `relchange_${'c'.repeat(32)}`, chapter: 7, temperature: 1,
    reason: '沈砚替沈青挡下追杀',
  }], notes: '', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
};

describe('CharacterCraftCard lists and helpers', () => {
  it('renders motive, pressure behavior and author-only secret separately', () => {
    const html = renderToStaticMarkup(<CharacterList entries={[character]} disabled={false}
      deletingId={null} confirmDeleteId={null} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(html).toContain('当前欲望');
    expect(html).toContain('受压反应');
    expect(html).toContain('作者掌握的秘密');
    expect(html).toContain('用行动替代道歉');
  });

  it('renders relationship temperature changes as causal events, not a bare score', () => {
    expect(relationshipTemperatureLabel(-5)).toBe('强烈敌对');
    expect(relationshipTemperatureLabel(4)).toBe('高度依恋 / 同盟');
    const html = renderToStaticMarkup(<RelationshipList entries={[relationship]} disabled={false}
      deletingId={null} confirmDeleteId={null} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(html).toContain('轻微靠近');
    expect(html).toContain('私下张力');
    expect(html).toContain('沈砚替沈青挡下追杀');
  });

  it('new drafts anchor to the current chapter without inventing character facts', () => {
    const characterDraft = emptyCharacterGuide(`charcraft_${'d'.repeat(32)}`, 12);
    const relationDraft = emptyRelationshipGuide(`relcraft_${'e'.repeat(32)}`, 12);
    expect(characterDraft.asOfChapter).toBe(12);
    expect(characterDraft.currentDesire).toBe('');
    expect(relationDraft.asOfChapter).toBe(12);
    expect(relationDraft.temperature).toBe(0);
    expect(relationDraft.changes).toEqual([]);
  });
});

import type { Chapter, ChapterHandoff, Character } from '../types';

const HANDOFF_FIELDS: Array<{ key: keyof ChapterHandoff; label: string }> = [
  { key: 'viewpoint', label: '章末视角' },
  { key: 'time', label: '章末时间' },
  { key: 'location', label: '章末地点' },
  { key: 'ongoingAction', label: '正在进行的动作' },
  { key: 'immediatePressure', label: '即时压力' },
  { key: 'characterState', label: '人物末态' },
  { key: 'resourceState', label: '资源末态' },
  { key: 'knowledgeBoundary', label: '知识边界' },
  { key: 'unresolvedCausality', label: '未完因果' },
];

const TITLE_SOURCE = {
  default: '默认章名',
  ai: '由正文摘要生成',
  manual: '已手工确认',
} as const;

export function chapterContinuityHasContent(chapter: Pick<Chapter, 'summary' | 'progress' | 'characters' | 'handoff'>) {
  return Boolean(chapter.summary?.trim() || chapter.progress?.trim()
    || chapter.characters?.length
    || HANDOFF_FIELDS.some(({ key }) => chapter.handoff?.[key]?.trim()));
}

export function ChapterContinuityCard({ chapter }: { chapter: Chapter }) {
  const characters = Array.isArray(chapter.characters) ? chapter.characters : [];
  const hasDigest = chapterContinuityHasContent(chapter);
  return (
    <section className="chapter-continuity-card sketch-alt" aria-label="本章摘要与交接">
      <header>
        <div>
          <h3>本章摘要与交接</h3>
          <p>章名、人物快照和章末状态来自已保存正文的摘要，不是策划卡。空章会在生成正文后自动补齐。</p>
        </div>
        <span>{chapter.titleSource ? TITLE_SOURCE[chapter.titleSource] : TITLE_SOURCE.default}</span>
      </header>
      <dl>
        <div>
          <dt>章名</dt>
          <dd>{chapter.title.trim() || '尚未命名；生成正文后会尝试自动取名。'}</dd>
        </div>
        <div>
          <dt>本章摘要</dt>
          <dd>{chapter.summary?.trim() || '正文保存后才会提取。'}</dd>
        </div>
        <div>
          <dt>剧情路标</dt>
          <dd>{chapter.progress?.trim() || '这是摘要模型的后续建议，不是必须执行的计划。'}</dd>
        </div>
      </dl>
      <div className="chapter-continuity-characters">
        <h4>本章人物快照</h4>
        {characters.length
          ? <ul>{characters.map((person: Character, index) => (
            <li key={`${person.name}-${index}`}>
              <strong>{person.name}</strong>
              {person.role ? ` · ${person.role}` : ''}
              {person.desc ? ` — ${person.desc}` : ''}
            </li>
          ))}</ul>
          : <p>还没有从正文提取到登场人物。</p>}
      </div>
      <div className="chapter-continuity-handoff">
        <h4>章末交接快照</h4>
        {hasDigest && chapter.handoff
          ? <dl>{HANDOFF_FIELDS.map(({ key, label }) => chapter.handoff?.[key]?.trim()
            ? <div key={key}><dt>{label}</dt><dd>{chapter.handoff[key]}</dd></div>
            : null)}</dl>
          : <p>生成或重算记忆后，会从正文最后时刻提取视角、时空、压力和未完因果。</p>}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deactivateMemoryFact, getBookMemory, isAmbiguousApiFailure, isApiErrorCode,
} from '../api';
import type {
  BookMemoryLibrary, BookSection, MemoryFact, MemoryFactStatus, MemoryKind,
} from '../types';
import { memoryDetailEntries } from '../memoryDetails';
import { StageSummaryPanel } from './StageSummaryPanel';

const KIND_LABELS: Record<MemoryKind, string> = {
  character: '人物', relationship: '关系', ability: '能力', item: '物品',
  location: '地点', timeline: '时间线', faction: '势力',
  foreshadowing: '伏笔', knowledge: '知识边界', other: '其它',
};
const STATUS_LABELS: Record<MemoryFactStatus, string> = {
  active: '活动', stale: '失效', superseded: '已被替换',
};
export const MEMORY_LIBRARY_RENDER_LIMIT = 200;
export const MEMORY_PROFILE_RENDER_LIMIT = 100;

export type CharacterProfileField = 'aliases' | 'identity' | 'faction' | 'personality'
  | 'goal' | 'ability' | 'limitations' | 'currentStatus' | 'lifeStatus' | 'other';

const CHARACTER_FIELD_ORDER: CharacterProfileField[] = [
  'aliases', 'identity', 'faction', 'personality', 'goal', 'ability',
  'limitations', 'currentStatus', 'lifeStatus', 'other',
];
const CHARACTER_FIELD_LABELS: Record<CharacterProfileField, string> = {
  aliases: '别名 / 称号', identity: '身份', faction: '阵营', personality: '性格',
  goal: '目标', ability: '能力', limitations: '限制 / 代价',
  currentStatus: '当前状态', lifeStatus: '生死状态', other: '其它已确认事实',
};

export interface CharacterProfile {
  name: string;
  fields: Record<CharacterProfileField, MemoryFact[]>;
  latestUpdatedAt: string;
  highestImportance: number;
}

const predicateContains = (predicate: string, words: string[]) =>
  words.some((word) => predicate.includes(word));

export interface MemoryContinuityWarning {
  key: string;
  label: string;
  subject: string;
  facts: MemoryFact[];
}

export interface ForeshadowingReminder {
  fact: MemoryFact;
  dueChapter: number;
  overdueBy: number;
}

export function buildForeshadowingReminders(
  facts: MemoryFact[], completedChapterCount: number,
): ForeshadowingReminder[] {
  if (!Number.isSafeInteger(completedChapterCount) || completedChapterCount < 1) return [];
  return facts.flatMap((fact) => {
    if (fact.status !== 'active' || fact.kind !== 'foreshadowing'
      || fact.details?.actualPayoff
      || ['resolved', 'abandoned'].includes(fact.details?.foreshadowStatus ?? '')) return [];
    const match = fact.details?.dueChapter?.trim().match(/^(?:第)?([1-9]\d{0,5})(?:章)?$/);
    if (!match) return [];
    const dueChapter = Number(match[1]);
    if (completedChapterCount < dueChapter) return [];
    return [{ fact, dueChapter, overdueBy: completedChapterCount - dueChapter }];
  }).sort((a, b) => b.overdueBy - a.overdueBy
    || b.fact.importance - a.fact.importance
    || a.dueChapter - b.dueChapter);
}

const CONTINUITY_SLOTS: Array<{
  kind: MemoryKind;
  slot: string;
  label: string;
  matches: (predicate: string) => boolean;
}> = [
  {
    kind: 'character', slot: 'life-status', label: '生死状态',
    matches: (predicate) => predicateContains(predicate, ['生死', '存活', '死亡', '存亡']),
  },
  {
    kind: 'location', slot: 'current-location', label: '当前位置',
    matches: (predicate) => predicateContains(predicate, ['当前位置', '所在地', '身处', '所在位置']),
  },
  {
    kind: 'item', slot: 'holder', label: '物品持有人',
    matches: (predicate) => predicateContains(predicate, ['持有人', '持有者', '拥有者', '归属', '主人']),
  },
  {
    kind: 'item', slot: 'quantity', label: '物品数量',
    matches: (predicate) => predicateContains(predicate, ['数量', '库存', '剩余']),
  },
  {
    kind: 'ability', slot: 'level', label: '能力 / 境界等级',
    matches: (predicate) => predicateContains(predicate, ['境界', '修为', '等级', '阶段']),
  },
];

export function buildMemoryContinuityWarnings(facts: MemoryFact[]): MemoryContinuityWarning[] {
  const grouped = new Map<string, MemoryContinuityWarning>();
  for (const fact of facts) {
    if (fact.status !== 'active') continue;
    const predicate = fact.predicate.replace(/\s+/g, '');
    const slot = CONTINUITY_SLOTS.find((item) =>
      item.kind === fact.kind && item.matches(predicate));
    if (!slot) continue;
    const key = `${slot.kind}\0${slot.slot}\0${fact.subject}`;
    const group = grouped.get(key) ?? {
      key, label: slot.label, subject: fact.subject, facts: [],
    };
    group.facts.push(fact);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .filter((group) => new Set(group.facts.map((fact) => fact.object.trim())).size > 1)
    .sort((a, b) =>
      Math.max(...b.facts.map((fact) => fact.importance))
      - Math.max(...a.facts.map((fact) => fact.importance))
      || a.subject.localeCompare(b.subject, 'zh-CN'));
}

const WORLD_STATE_KINDS: MemoryKind[] = [
  'ability', 'item', 'location', 'timeline', 'faction', 'foreshadowing', 'knowledge',
];

function groupMemoryFactsBySubject(facts: MemoryFact[]) {
  const groups = new Map<string, MemoryFact[]>();
  for (const fact of facts) {
    const group = groups.get(fact.subject) ?? [];
    group.push(fact);
    groups.set(fact.subject, group);
  }
  return [...groups.entries()].map(([subject, entries]) => ({
    subject,
    facts: entries.sort((a, b) =>
      b.importance - a.importance || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
  })).sort((a, b) => a.subject.localeCompare(b.subject, 'zh-CN'));
}

export function characterProfileField(fact: MemoryFact): CharacterProfileField | null {
  const predicate = fact.predicate.replace(/\s+/g, '');
  if (fact.kind === 'ability') {
    return predicateContains(predicate, ['限制', '代价', '弱点', '副作用', '冷却', '上限'])
      ? 'limitations' : 'ability';
  }
  if (fact.kind === 'faction') return 'faction';
  if (fact.kind !== 'character') return null;
  if (predicateContains(predicate, ['别名', '昵称', '称号', '化名', '代号'])) return 'aliases';
  if (predicateContains(predicate, ['生死', '存活', '死亡', '存亡'])) return 'lifeStatus';
  if (predicateContains(predicate, ['身份', '职业', '职位', '种族', '年龄'])) return 'identity';
  if (predicateContains(predicate, ['阵营', '势力', '组织', '所属'])) return 'faction';
  if (predicateContains(predicate, ['性格', '个性', '习惯', '特质'])) return 'personality';
  if (predicateContains(predicate, ['目标', '动机', '欲望', '目的', '愿望'])) return 'goal';
  if (predicateContains(predicate, ['能力', '境界', '修为', '技能', '天赋'])) return 'ability';
  if (predicateContains(predicate, ['限制', '代价', '弱点', '缺陷', '副作用'])) return 'limitations';
  if (predicateContains(predicate, ['状态', '伤势', '处境', '下落'])) return 'currentStatus';
  return 'other';
}

export function buildCharacterProfiles(facts: MemoryFact[]): CharacterProfile[] {
  const activeFacts = facts.filter((fact) => fact.status === 'active');
  // 能力或势力事实的主体未必是人物；只有已经存在人物事实的主体才进入档案。
  const characterNames = new Set(activeFacts
    .filter((fact) => fact.kind === 'character')
    .map((fact) => fact.subject));
  const profiles = new Map<string, CharacterProfile>();
  for (const fact of activeFacts) {
    if (!characterNames.has(fact.subject)) continue;
    const field = characterProfileField(fact);
    if (!field) continue;
    let profile = profiles.get(fact.subject);
    if (!profile) {
      profile = {
        name: fact.subject,
        fields: {
          aliases: [], identity: [], faction: [], personality: [], goal: [],
          ability: [], limitations: [], currentStatus: [], lifeStatus: [], other: [],
        },
        latestUpdatedAt: fact.updatedAt,
        highestImportance: fact.importance,
      };
      profiles.set(fact.subject, profile);
    }
    profile.fields[field].push(fact);
    if (Date.parse(fact.updatedAt) > Date.parse(profile.latestUpdatedAt)) {
      profile.latestUpdatedAt = fact.updatedAt;
    }
    profile.highestImportance = Math.max(profile.highestImportance, fact.importance);
  }
  for (const profile of profiles.values()) {
    for (const field of CHARACTER_FIELD_ORDER) {
      profile.fields[field].sort((a, b) =>
        b.importance - a.importance || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    }
  }
  return [...profiles.values()].sort((a, b) =>
    b.highestImportance - a.highestImportance
    || Date.parse(b.latestUpdatedAt) - Date.parse(a.latestUpdatedAt)
    || a.name.localeCompare(b.name, 'zh-CN'));
}

export function filterMemoryFacts(
  facts: MemoryFact[], {
    kind = 'all', status = 'active', query = '',
  }: {
    kind?: MemoryKind | 'all';
    status?: MemoryFactStatus | 'all';
    query?: string;
  } = {},
) {
  const needle = query.trim().toLocaleLowerCase();
  return facts.filter((fact) =>
    (kind === 'all' || fact.kind === kind)
    && (status === 'all' || fact.status === status)
    && (!needle || [fact.subject, fact.predicate, fact.object, fact.evidence]
      .some((value) => value.toLocaleLowerCase().includes(needle))));
}

export function MemoryLibraryPanel({
  bookId, sections = [], completedChapterCount = 0,
  canOpenSource, sourceLabel, onOpenSource,
}: {
  bookId: string;
  sections?: BookSection[];
  completedChapterCount?: number;
  canOpenSource: (sectionId: string, chapterId: string) => boolean;
  sourceLabel?: (sectionId: string, chapterId: string, chapterIndex: number) => string;
  onOpenSource?: (sectionId: string, chapterId: string) => void;
}) {
  const [library, setLibrary] = useState<BookMemoryLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<MemoryKind | 'all'>('all');
  const [status, setStatus] = useState<MemoryFactStatus | 'all'>('active');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'characters' | 'relationships' | 'world' | 'facts'>('characters');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const loadToken = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const token = ++loadToken.current;
    setLoading(true);
    setError(null);
    try {
      const next = await getBookMemory(bookId, signal);
      if (token !== loadToken.current) return false;
      setLibrary(next);
      return true;
    } catch (reason) {
      if (token !== loadToken.current || (reason instanceof DOMException
        && reason.name === 'AbortError')) return false;
      setError(String(reason instanceof Error ? reason.message : reason));
      return false;
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    const controller = new AbortController();
    setLibrary(null);
    setNotice(null);
    setConfirmId(null);
    void load(controller.signal);
    return () => {
      controller.abort();
      loadToken.current += 1;
    };
  }, [load]);

  const filtered = useMemo(() => filterMemoryFacts(
    library?.facts ?? [], { kind, status, query },
  ), [kind, library?.facts, query, status]);
  const visible = filtered.slice(0, MEMORY_LIBRARY_RENDER_LIMIT);
  const characterProfiles = useMemo(
    () => buildCharacterProfiles(library?.facts ?? []), [library?.facts],
  );
  const profileNeedle = query.trim().toLocaleLowerCase();
  const filteredProfiles = useMemo(() => characterProfiles.filter((profile) =>
    !profileNeedle || profile.name.toLocaleLowerCase().includes(profileNeedle)
    || CHARACTER_FIELD_ORDER.some((field) => profile.fields[field].some((fact) =>
      [fact.predicate, fact.object, fact.evidence]
        .some((value) => value.toLocaleLowerCase().includes(profileNeedle))))),
  [characterProfiles, profileNeedle]);
  const visibleProfiles = filteredProfiles.slice(0, MEMORY_PROFILE_RENDER_LIMIT);
  const activeRelationships = useMemo(() => (library?.facts ?? []).filter((fact) =>
    fact.status === 'active' && fact.kind === 'relationship'), [library?.facts]);
  const filteredRelationships = useMemo(() => activeRelationships.filter((fact) =>
    !profileNeedle || [fact.subject, fact.predicate, fact.object, fact.evidence]
      .some((value) => value.toLocaleLowerCase().includes(profileNeedle))),
  [activeRelationships, profileNeedle]);
  const activeWorldFacts = useMemo(() => (library?.facts ?? []).filter((fact) =>
    fact.status === 'active' && WORLD_STATE_KINDS.includes(fact.kind)), [library?.facts]);
  const filteredWorldFacts = useMemo(() => activeWorldFacts.filter((fact) =>
    !profileNeedle || [fact.subject, fact.predicate, fact.object, fact.evidence]
      .some((value) => value.toLocaleLowerCase().includes(profileNeedle))),
  [activeWorldFacts, profileNeedle]);
  const visibleRelationships = filteredRelationships.slice(0, MEMORY_LIBRARY_RENDER_LIMIT);
  const visibleWorldFacts = filteredWorldFacts.slice(0, MEMORY_LIBRARY_RENDER_LIMIT);
  const worldGroups = useMemo(() => WORLD_STATE_KINDS.map((worldKind) => ({
    kind: worldKind,
    groups: groupMemoryFactsBySubject(
      visibleWorldFacts.filter((fact) => fact.kind === worldKind),
    ),
  })).filter((group) => group.groups.length), [visibleWorldFacts]);
  const continuityWarnings = useMemo(
    () => buildMemoryContinuityWarnings(library?.facts ?? []), [library?.facts],
  );
  const foreshadowingReminders = useMemo(() => buildForeshadowingReminders(
    library?.facts ?? [], completedChapterCount,
  ), [completedChapterCount, library?.facts]);
  const activeCount = library?.facts.filter((fact) => fact.status === 'active').length ?? 0;

  const revoke = async (fact: MemoryFact) => {
    if (!library || busyId) return;
    if (confirmId !== fact.id) {
      setConfirmId(fact.id);
      setNotice('再次点击同一按钮才会撤销确认；历史记录与来源仍会保留。');
      return;
    }
    setBusyId(fact.id);
    setError(null);
    setNotice(null);
    try {
      const result = await deactivateMemoryFact(bookId, fact.id, library.memoryRevision);
      setLibrary((current) => current ? {
        ...current,
        memoryRevision: result.memoryRevision,
        facts: current.facts.map((item) => item.id === result.fact.id ? result.fact : item),
      } : current);
      setConfirmId(null);
      setNotice('已撤销确认：该事实保留为失效历史，不再进入生成或审稿上下文。');
    } catch (reason) {
      const shouldReload = isApiErrorCode(reason, 'MEMORY_REVISION_CONFLICT')
        || isAmbiguousApiFailure(reason);
      if (shouldReload) await load();
      setError(String(reason instanceof Error ? reason.message : reason));
      setConfirmId(null);
    } finally {
      setBusyId(null);
    }
  };

  const renderFactFooter = (fact: MemoryFact) => {
    const sourceAvailable = canOpenSource(fact.source.sectionId, fact.source.chapterId);
    return <footer>
      <span>来源：{sourceLabel?.(
        fact.source.sectionId, fact.source.chapterId, fact.source.chapterIndex,
      ) ?? `第 ${fact.source.chapterIndex} 章`} · 重要度 {fact.importance}</span>
      <div>
        <button className="hbtn" disabled={!sourceAvailable || !onOpenSource}
          title={sourceAvailable ? '打开来源章节' : '来源章节已删除'}
          onClick={() => onOpenSource?.(fact.source.sectionId, fact.source.chapterId)}>查看来源</button>
        {fact.status === 'active' && <button className="hbtn" disabled={!!busyId}
          onClick={() => { void revoke(fact); }}>
          {busyId === fact.id ? '撤销中…' : confirmId === fact.id ? '再次点击确认撤销' : '撤销确认'}
        </button>}
      </div>
    </footer>;
  };

  return (
    <details className="memory-library sketch">
      <summary><strong>长期记忆库</strong><span>{activeCount} 条活动事实 · {library?.facts.length ?? 0} 条历史</span></summary>
      <p className="memory-library-hint">这里只展示作者确认过的事实；AI 候选仍需回到来源章节确认。</p>
      {error && <div className="memory-message error" role="alert">{error} <button className="hbtn" onClick={() => { void load(); }}>重试</button></div>}
      {notice && <div className="memory-message" role="status">{notice}</div>}
      {library?.plotSummary && <details className="memory-plot-summary">
        <summary>查看跨分部剧情窗口（{library.sectionSummaryCount} 个分部已有摘要）</summary>
        <div>{library.plotSummary}</div>
      </details>}
      {library && <StageSummaryPanel
        bookId={bookId}
        sections={sections}
        items={library.stageSummaries ?? []}
        revision={library.stageSummaryRevision ?? ''}
        onReload={() => load()} />}
      {!!foreshadowingReminders.length && <details className="memory-foreshadow-reminders" open>
        <summary>{foreshadowingReminders.length} 条伏笔已到计划回收章</summary>
        <p>按当前 {completedChapterCount} 个已完成章节核对；这里只提醒，不会自动写回收剧情。</p>
        {foreshadowingReminders.slice(0, 50).map(({ fact, dueChapter, overdueBy }) =>
          <article key={fact.id}>
            <strong>{fact.subject}</strong>
            <span>计划最迟第 {dueChapter} 章回收{overdueBy ? ` · 已超过 ${overdueBy} 章` : ' · 本章到期'}</span>
            <p>{fact.details?.plannedPayoff ?? fact.object}</p>
            {renderFactFooter(fact)}
          </article>)}
      </details>}
      {!!continuityWarnings.length && <details className="memory-continuity-warnings" open>
        <summary>发现 {continuityWarnings.length} 组待核对的连续性风险</summary>
        <p>以下活动事实落在同一关键字段却有不同值。系统只告警，不会替作者自动覆盖。</p>
        {continuityWarnings.slice(0, 50).map((warning) => <article key={warning.key}>
          <strong>{warning.subject} · {warning.label}</strong>
          <ul>{warning.facts.map((fact) => <li key={fact.id}>
            {fact.predicate}：{fact.object}（第 {fact.source.chapterIndex} 章）
          </li>)}</ul>
        </article>)}
        {continuityWarnings.length > 50 && <p>仅展示前 50 组，请先处理高重要度风险。</p>}
      </details>}
      <div className="memory-view-switch" role="group" aria-label="长期记忆视图">
        <button className="hbtn" aria-pressed={view === 'characters'}
          onClick={() => setView('characters')}>人物档案 {characterProfiles.length}</button>
        <button className="hbtn" aria-pressed={view === 'relationships'}
          onClick={() => setView('relationships')}>人物关系 {activeRelationships.length}</button>
        <button className="hbtn" aria-pressed={view === 'world'}
          onClick={() => setView('world')}>状态台账 {activeWorldFacts.length}</button>
        <button className="hbtn" aria-pressed={view === 'facts'}
          onClick={() => setView('facts')}>事实列表 {library?.facts.length ?? 0}</button>
      </div>
      {view === 'facts' ? <div className="memory-filters">
          <label>状态<select value={status} onChange={(event) => setStatus(event.target.value as MemoryFactStatus | 'all')}>
            <option value="active">活动</option><option value="stale">失效</option>
            <option value="superseded">已被替换</option><option value="all">全部</option>
          </select></label>
          <label>类型<select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind | 'all')}>
            <option value="all">全部</option>
            {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label className="memory-search">搜索<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="人物、物品、地点或事实" /></label>
        </div>
        : <div className="memory-profile-tools">
          <label>{view === 'characters' ? '搜索人物档案' : view === 'relationships' ? '搜索人物关系' : '搜索状态台账'}
            <input value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder={view === 'characters' ? '姓名、身份、目标、能力或状态'
                : view === 'relationships' ? '人物、关系类型或另一方'
                  : '能力、物品、地点、事件、势力或伏笔'} />
          </label>
          <span>{view === 'characters'
            ? '档案只聚合作者已确认且仍活动的人物事实；每一项仍可回到来源章节。'
            : view === 'relationships'
              ? '关系图只使用已确认的活动事实，箭头方向为“主体—关系→对象”。'
              : '台账按主体归集能力、物品、所在地、时间线、势力、伏笔和知识边界。'}</span>
        </div>}
      {loading && !library
        ? <p className="empty-hint">正在读取长期记忆…</p>
        : view === 'characters'
          ? !filteredProfiles.length
            ? <p className="empty-hint">还没有匹配的已确认人物档案。请先在来源章节确认人物事实。</p>
            : <div className="memory-profile-list">{visibleProfiles.map((profile) =>
              <article className="memory-profile" key={profile.name}>
                <header><strong>{profile.name}</strong><span>最高重要度 {profile.highestImportance}</span></header>
                <div className="memory-profile-fields">{CHARACTER_FIELD_ORDER.flatMap((field) =>
                  profile.fields[field].length ? [<section key={field}>
                    <h4>{CHARACTER_FIELD_LABELS[field]}</h4>
                    {profile.fields[field].map((fact) =>
                      <div className="memory-profile-entry" key={fact.id}>
                        <p><b>{fact.predicate}：</b>{fact.object}</p>
                        {fact.evidence && <small>依据：{fact.evidence}</small>}
                        {renderFactFooter(fact)}
                      </div>)}
                  </section>] : [])}</div>
              </article>)}</div>
          : view === 'relationships'
            ? !filteredRelationships.length
              ? <p className="empty-hint">还没有匹配的已确认人物关系。</p>
              : <div className="memory-relation-list">{visibleRelationships.map((fact) =>
                <article className="memory-relation" key={fact.id}>
                  <div className="memory-relation-edge">
                    <strong>{fact.subject}</strong>
                    <span>— {fact.details?.relationType ?? fact.predicate} →</span>
                    <strong>{fact.details?.target ?? fact.object}</strong>
                  </div>
                  <div className="memory-relation-meta">
                    {memoryDetailEntries(fact.details)
                      .filter((detail) => ['strength', 'visibility'].includes(detail.field))
                      .map((detail) => <span key={detail.field}>{detail.label}：{detail.value}</span>)}
                  </div>
                  {(fact.details?.changeReason || fact.evidence) && <small>
                    变化依据：{fact.details?.changeReason ?? fact.evidence}
                  </small>}
                  {renderFactFooter(fact)}
                </article>)}</div>
          : view === 'world'
            ? !filteredWorldFacts.length
              ? <p className="empty-hint">还没有匹配的已确认状态记录。</p>
              : <div className="memory-world-ledger">{worldGroups.map((worldGroup) =>
                <section key={worldGroup.kind}>
                  <header><h3>{KIND_LABELS[worldGroup.kind]}</h3><span>{worldGroup.groups.reduce((sum, group) => sum + group.facts.length, 0)} 条</span></header>
                  <div>{worldGroup.groups.map((group) => <article key={group.subject}>
                    <header><strong>{group.subject}</strong><span>{group.facts.length} 项</span></header>
                    {group.facts.map((fact) => <div className="memory-ledger-entry" key={fact.id}>
                      <p><b>{fact.predicate}：</b>{fact.object}</p>
                      {fact.evidence && <small>依据：{fact.evidence}</small>}
                      {!!fact.details && <dl className="memory-detail-grid">
                        {memoryDetailEntries(fact.details).map((detail) => <div key={detail.field}>
                          <dt>{detail.label}</dt><dd>{detail.value}</dd>
                        </div>)}
                      </dl>}
                      {renderFactFooter(fact)}
                    </div>)}
                  </article>)}</div>
                </section>)}</div>
          : !filtered.length
            ? <p className="empty-hint">当前筛选下没有长期记忆。</p>
            : <div className="memory-library-list">{visible.map((fact) =>
            <article className={`memory-fact memory-${fact.status}`} key={fact.id}>
              <div className="memory-row-head">
                <span className="memory-kind">{KIND_LABELS[fact.kind]}</span>
                <strong>{fact.subject}</strong><span>{fact.predicate}</span>
                <span className="memory-status">{STATUS_LABELS[fact.status]}</span>
              </div>
              <p>{fact.object}</p>
              {fact.evidence && <small>依据：{fact.evidence}</small>}
              {renderFactFooter(fact)}
            </article>)}</div>}
      {view === 'facts' && filtered.length > visible.length && <p className="memory-library-hint">当前匹配 {filtered.length} 条，仅渲染前 {MEMORY_LIBRARY_RENDER_LIMIT} 条；请继续缩小筛选。</p>}
      {view === 'characters' && filteredProfiles.length > visibleProfiles.length && <p className="memory-library-hint">当前匹配 {filteredProfiles.length} 个人物，仅渲染前 {MEMORY_PROFILE_RENDER_LIMIT} 个；请继续缩小筛选。</p>}
      {view === 'relationships' && filteredRelationships.length > visibleRelationships.length && <p className="memory-library-hint">当前匹配 {filteredRelationships.length} 条关系，仅渲染前 {MEMORY_LIBRARY_RENDER_LIMIT} 条；请继续缩小筛选。</p>}
      {view === 'world' && filteredWorldFacts.length > visibleWorldFacts.length && <p className="memory-library-hint">当前匹配 {filteredWorldFacts.length} 条状态，仅渲染前 {MEMORY_LIBRARY_RENDER_LIMIT} 条；请继续缩小筛选。</p>}
    </details>
  );
}

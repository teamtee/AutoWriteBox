import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api';
import {
  characterCraftPairKey, characterGuideDraft, relationshipGuideDraft,
} from '../ai-fill-apply';
import type {
  CharacterCraft, CharacterCraftDraftResult, CharacterGuide, CharacterGuideInput,
  RelationshipGuide, RelationshipGuideInput, RelationshipTemperatureChange,
} from '../types';
import { useDirtyReporter } from '../useDirtyReporter';

type CraftKind = 'character' | 'relationship';
type CraftInput = CharacterGuideInput | RelationshipGuideInput;
type CraftEntry = CharacterGuide | RelationshipGuide;
type Editing = {
  kind: CraftKind;
  draft: CraftInput;
  baseline: CraftInput;
  conflicted: boolean;
};

const clone = <T extends CraftInput>(input: T): T => structuredClone(input);
const equal = (left: CraftInput, right: CraftInput) =>
  JSON.stringify(left) === JSON.stringify(right);
const withoutTimestamps = <T extends CraftEntry>(entry: T): CraftInput => {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = entry;
  return clone(input as unknown as CraftInput);
};
const optionalChapter = (value: string) => {
  const number = Number(value);
  return value && Number.isInteger(number) ? number : null;
};
const integer = (value: string, fallback: number) => {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
};

export function emptyCharacterGuide(id: string, chapter: number): CharacterGuideInput {
  return {
    id, name: '', importance: 5, asOfChapter: Math.max(1, chapter),
    currentDesire: '', fear: '', secret: '', pressureResponse: '',
    speechPattern: '', speechAvoid: '', notes: '',
  };
}

export function emptyRelationshipGuide(id: string, chapter: number): RelationshipGuideInput {
  return {
    id, from: '', to: '', importance: 4, asOfChapter: Math.max(1, chapter),
    temperature: 0, surfaceState: '', privateTension: '', desiredDirection: '',
    changes: [], notes: '',
  };
}

export function relationshipTemperatureLabel(value: number) {
  if (value <= -4) return '强烈敌对';
  if (value <= -2) return '排斥 / 不信任';
  if (value === -1) return '轻微疏离';
  if (value === 0) return '中性 / 未定';
  if (value === 1) return '轻微靠近';
  if (value <= 3) return '信任 / 亲近';
  return '高度依恋 / 同盟';
}

export function CharacterList({ entries, disabled, deletingId, confirmDeleteId, onEdit, onDelete }: {
  entries: CharacterGuide[];
  disabled: boolean;
  deletingId: string | null;
  confirmDeleteId: string | null;
  onEdit: (entry: CharacterGuide) => void;
  onDelete: (entry: CharacterGuide) => void;
}) {
  if (!entries.length) return <p className="character-craft-empty">还没有人物导演卡。先为真正推动当前主线的人物建立，不必给每个龙套填表。</p>;
  return <div className="character-craft-list">{entries.map((entry) => <article
    className="character-craft-entry" key={entry.id}>
    <header><div><h4>{entry.name}</h4><span>重要度 {entry.importance}
      {entry.asOfChapter ? ` · 截至第 ${entry.asOfChapter} 章` : ''}</span></div></header>
    <dl>
      {entry.currentDesire && <div><dt>当前欲望</dt><dd>{entry.currentDesire}</dd></div>}
      {entry.fear && <div><dt>恐惧</dt><dd>{entry.fear}</dd></div>}
      {entry.secret && <div className="secret"><dt>作者掌握的秘密</dt><dd>{entry.secret}</dd></div>}
      {entry.pressureResponse && <div><dt>受压反应</dt><dd>{entry.pressureResponse}</dd></div>}
      {entry.speechPattern && <div><dt>说话习惯</dt><dd>{entry.speechPattern}</dd></div>}
      {entry.speechAvoid && <div><dt>避免的说话方式</dt><dd>{entry.speechAvoid}</dd></div>}
      {entry.notes && <div><dt>导演备注</dt><dd>{entry.notes}</dd></div>}
    </dl>
    <footer><button className="hbtn" type="button" disabled={disabled}
      onClick={() => onEdit(entry)}>编辑</button>
      <button className="hbtn" type="button" disabled={disabled || deletingId === entry.id}
        onClick={() => onDelete(entry)}>{deletingId === entry.id ? '删除中…'
          : confirmDeleteId === entry.id ? '确认永久删除？' : '删除'}</button></footer>
  </article>)}</div>;
}

export function RelationshipList({
  entries, disabled, deletingId, confirmDeleteId, onEdit, onDelete,
}: {
  entries: RelationshipGuide[];
  disabled: boolean;
  deletingId: string | null;
  confirmDeleteId: string | null;
  onEdit: (entry: RelationshipGuide) => void;
  onDelete: (entry: RelationshipGuide) => void;
}) {
  if (!entries.length) return <p className="character-craft-empty">还没有关系温度记录。只记录会影响选择、潜台词或冲突走向的关系。</p>;
  return <div className="character-craft-list">{entries.map((entry) => <article
    className="character-craft-entry relationship" key={entry.id}>
    <header><div><h4>{entry.from} ↔ {entry.to}</h4><span>重要度 {entry.importance}
      {entry.asOfChapter ? ` · 截至第 ${entry.asOfChapter} 章` : ''}</span></div>
      <strong>{entry.temperature} · {relationshipTemperatureLabel(entry.temperature)}</strong></header>
    <dl>
      {entry.surfaceState && <div><dt>表面关系</dt><dd>{entry.surfaceState}</dd></div>}
      {entry.privateTension && <div className="secret"><dt>私下张力</dt><dd>{entry.privateTension}</dd></div>}
      {entry.desiredDirection && <div><dt>下一步关系方向</dt><dd>{entry.desiredDirection}</dd></div>}
      {entry.notes && <div><dt>导演备注</dt><dd>{entry.notes}</dd></div>}
    </dl>
    {!!entry.changes.length && <details><summary>{entry.changes.length} 次温度变化</summary><ol>
      {entry.changes.map((change) => <li key={change.id}>第 {change.chapter} 章：
        {change.temperature}（{relationshipTemperatureLabel(change.temperature)}）— {change.reason}</li>)}
    </ol></details>}
    <footer><button className="hbtn" type="button" disabled={disabled}
      onClick={() => onEdit(entry)}>编辑 / 记录变化</button>
      <button className="hbtn" type="button" disabled={disabled || deletingId === entry.id}
        onClick={() => onDelete(entry)}>{deletingId === entry.id ? '删除中…'
          : confirmDeleteId === entry.id ? '确认永久删除？' : '删除'}</button></footer>
  </article>)}</div>;
}

export function CharacterCraftAiCandidate({
  result, existingNames, existingPairs, disabled,
  onUseCharacter, onUseRelationship, onDiscard,
}: {
  result: CharacterCraftDraftResult;
  existingNames: string[];
  existingPairs: string[];
  disabled: boolean;
  onUseCharacter: (entry: CharacterCraftDraftResult['characters'][number]) => void;
  onUseRelationship: (entry: CharacterCraftDraftResult['relationships'][number]) => void;
  onDiscard: () => void;
}) {
  const names = new Set(existingNames);
  const pairs = new Set(existingPairs);
  return <section className="ai-card-candidate" aria-label="AI 人物与关系候选">
    <header><div><h4>AI 人物与关系候选</h4>
      <p>候选尚未写盘。每次只载入一项到编辑器，核对并手动保存后才生效。</p>
    </div><button className="hbtn" type="button" disabled={disabled}
      onClick={onDiscard}>丢弃全部候选</button></header>
    <div className="ai-card-candidate-grid">
      {result.characters.map((entry) => {
        const exists = names.has(entry.name);
        return <article key={`character:${entry.name}`}><strong>{entry.name}</strong>
          <p>{entry.currentDesire || entry.pressureResponse || entry.speechPattern}</p>
          <button className="hbtn" type="button" disabled={disabled || exists}
            onClick={() => onUseCharacter(entry)}>{exists ? '已有同名人物' : '载入人物编辑器'}</button>
        </article>;
      })}
      {result.relationships.map((entry) => {
        const exists = pairs.has(characterCraftPairKey(entry.from, entry.to));
        return <article key={`relationship:${characterCraftPairKey(entry.from, entry.to)}`}>
          <strong>{entry.from} ↔ {entry.to}</strong>
          <p>{entry.surfaceState || entry.privateTension || entry.desiredDirection}</p>
          <button className="hbtn" type="button" disabled={disabled || exists}
            onClick={() => onUseRelationship(entry)}>{exists ? '已有这组关系' : '载入关系编辑器'}</button>
        </article>;
      })}
    </div>
  </section>;
}

function SharedFields({ value, busy, onChange }: {
  value: CraftInput;
  busy: boolean;
  onChange: (next: CraftInput) => void;
}) {
  return <>
    <label>重要度<select disabled={busy} value={value.importance}
      onChange={(event) => onChange({ ...value, importance: Number(event.target.value) })}>
      {[1, 2, 3, 4, 5].map((item) => <option key={item}>{item}</option>)}
    </select></label>
    <label>状态截至全书第几章（可空）<input type="number" min="1" max="50000"
      disabled={busy} value={value.asOfChapter ?? ''}
      onChange={(event) => onChange({ ...value, asOfChapter: optionalChapter(event.target.value) })} /></label>
  </>;
}

function CharacterForm({ draft, busy, onChange }: {
  draft: CharacterGuideInput;
  busy: boolean;
  onChange: (next: CharacterGuideInput) => void;
}) {
  const field = (key: keyof CharacterGuideInput, value: string) =>
    onChange({ ...draft, [key]: value });
  return <div className="character-craft-fields">
    <label>人物姓名<input required maxLength={100} disabled={busy} value={draft.name}
      onChange={(event) => field('name', event.target.value)} /></label>
    <SharedFields value={draft} busy={busy}
      onChange={(next) => onChange(next as CharacterGuideInput)} />
    <label className="wide">当前欲望<textarea maxLength={500} disabled={busy}
      placeholder="此刻最想得到什么；应能直接驱动行动"
      value={draft.currentDesire} onChange={(event) => field('currentDesire', event.target.value)} /></label>
    <label className="wide">恐惧<textarea maxLength={500} disabled={busy}
      placeholder="最怕失去、暴露或被迫面对什么"
      value={draft.fear} onChange={(event) => field('fear', event.target.value)} /></label>
    <label className="wide secret-field">作者掌握的秘密<textarea maxLength={500} disabled={busy}
      placeholder="只用于潜台词；不代表读者或其他人物已经知道"
      value={draft.secret} onChange={(event) => field('secret', event.target.value)} /></label>
    <label className="wide">受压反应<textarea maxLength={500} disabled={busy}
      placeholder="被逼到角落时，是攻击、讨好、沉默、转移还是冒险"
      value={draft.pressureResponse} onChange={(event) => field('pressureResponse', event.target.value)} /></label>
    <label className="wide">说话习惯<textarea maxLength={500} disabled={busy}
      placeholder="句长、措辞、回避方式、潜台词和即时目的"
      value={draft.speechPattern} onChange={(event) => field('speechPattern', event.target.value)} /></label>
    <label className="wide">避免的说话方式<textarea maxLength={500} disabled={busy}
      placeholder="例如：不讲大道理、不直接承认关心、不用现代网络词"
      value={draft.speechAvoid} onChange={(event) => field('speechAvoid', event.target.value)} /></label>
    <label className="wide">导演备注<textarea maxLength={1000} disabled={busy}
      value={draft.notes} onChange={(event) => field('notes', event.target.value)} /></label>
  </div>;
}

function RelationshipForm({ draft, busy, completedChapterCount, onChange }: {
  draft: RelationshipGuideInput;
  busy: boolean;
  completedChapterCount: number;
  onChange: (next: RelationshipGuideInput) => void;
}) {
  const field = <K extends keyof RelationshipGuideInput>(
    key: K, value: RelationshipGuideInput[K],
  ) => onChange({ ...draft, [key]: value });
  const updateChange = (index: number, patch: Partial<RelationshipTemperatureChange>) => {
    const changes = draft.changes.map((change, itemIndex) =>
      itemIndex === index ? { ...change, ...patch } : change);
    onChange({
      ...draft, changes,
      temperature: index === changes.length - 1 && patch.temperature !== undefined
        ? patch.temperature : draft.temperature,
      asOfChapter: patch.chapter !== undefined
        && (draft.asOfChapter === null || patch.chapter > draft.asOfChapter)
        ? patch.chapter : draft.asOfChapter,
    });
  };
  return <>
    <div className="character-craft-fields">
      <label>人物 A<input required maxLength={100} disabled={busy} value={draft.from}
        onChange={(event) => field('from', event.target.value)} /></label>
      <label>人物 B<input required maxLength={100} disabled={busy} value={draft.to}
        onChange={(event) => field('to', event.target.value)} /></label>
      <SharedFields value={draft} busy={busy}
        onChange={(next) => onChange(next as RelationshipGuideInput)} />
      <label>当前关系温度{draft.changes.length ? '（由最后一次变化确定）' : ''}<select
        disabled={busy || draft.changes.length > 0} value={draft.temperature}
        onChange={(event) => field('temperature', Number(event.target.value))}>
        {[-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((value) =>
          <option key={value} value={value}>{value} · {relationshipTemperatureLabel(value)}</option>)}
      </select></label>
      <label className="wide">表面关系<textarea maxLength={500} disabled={busy}
        placeholder="两人公开表现成什么关系"
        value={draft.surfaceState} onChange={(event) => field('surfaceState', event.target.value)} /></label>
      <label className="wide secret-field">私下张力<textarea maxLength={500} disabled={busy}
        placeholder="未说出口的依赖、嫉妒、戒备、亏欠或吸引"
        value={draft.privateTension} onChange={(event) => field('privateTension', event.target.value)} /></label>
      <label className="wide">下一步关系方向<textarea maxLength={500} disabled={busy}
        placeholder="下一次关键互动希望因什么选择而靠近或撕裂"
        value={draft.desiredDirection} onChange={(event) => field('desiredDirection', event.target.value)} /></label>
      <label className="wide">导演备注<textarea maxLength={1000} disabled={busy}
        value={draft.notes} onChange={(event) => field('notes', event.target.value)} /></label>
    </div>
    <section className="temperature-editor"><header><div><h5>关系温度变化</h5>
      <p>只记录改变后续选择或潜台词的节点，不逐章打分。</p></div>
      <button className="hbtn" type="button" disabled={busy || draft.changes.length >= 50}
        onClick={() => field('changes', [...draft.changes, {
          id: api.createClientTemperatureChangeId(),
          chapter: Math.max(1, completedChapterCount),
          temperature: draft.temperature,
          reason: '',
        }])}>＋ 记录变化</button></header>
      {draft.changes.map((change, index) => <div className="temperature-row" key={change.id}>
        <label>全书章序<input required type="number" min="1" max="50000" disabled={busy}
          value={change.chapter} onChange={(event) => updateChange(index, {
            chapter: integer(event.target.value, 1),
          })} /></label>
        <label>温度<select disabled={busy} value={change.temperature}
          onChange={(event) => updateChange(index, { temperature: Number(event.target.value) })}>
          {[-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((value) =>
            <option key={value} value={value}>{value}</option>)}</select></label>
        <label>变化原因<input required maxLength={300} disabled={busy} value={change.reason}
          onChange={(event) => updateChange(index, { reason: event.target.value })} /></label>
        <button className="hbtn" type="button" disabled={busy}
          onClick={() => {
            const changes = draft.changes.filter((_, item) => item !== index);
            onChange({
              ...draft, changes,
              temperature: index === draft.changes.length - 1 && changes.length
                ? changes[changes.length - 1].temperature : draft.temperature,
            });
          }}>删除</button>
      </div>)}
    </section>
  </>;
}

export function CharacterCraftCard({
  bookId, completedChapterCount, disabled = false, onDirtyChange,
}: {
  bookId: string;
  completedChapterCount: number;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [library, setLibrary] = useState<CharacterCraft | null>(null);
  const [view, setView] = useState<CraftKind>('character');
  const [editing, setEditing] = useState<Editing>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [generating, setGenerating] = useState(false);
  const [candidate, setCandidate] = useState<CharacterCraftDraftResult>();
  const generationAbort = useRef<AbortController | null>(null);
  const lastAutoSaveSignature = useRef('');
  const dirty = Boolean(editing && !equal(editing.draft, editing.baseline));
  const busy = disabled || saving || generating || Boolean(deletingId);
  const reload = async (signal?: AbortSignal) => {
    const next = await api.getCharacterCraft(bookId, signal);
    setLibrary(next);
    return next;
  };

  useEffect(() => {
    generationAbort.current?.abort();
    generationAbort.current = null;
    const controller = new AbortController();
    setGenerating(false);
    setCandidate(undefined);
    setEditing(undefined);
    setLibrary(null);
    setDeletingId(null);
    setConfirmDeleteId(null);
    setMessage('');
    setLoading(true);
    reload(controller.signal).then(() => setMessage('')).catch((reason) => {
      if (!controller.signal.aborted) setMessage(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [bookId]);
  useDirtyReporter(
    dirty || generating || Boolean(candidate) || saving || Boolean(deletingId),
    onDirtyChange,
  );
  useEffect(() => () => generationAbort.current?.abort(), []);

  const entries = useMemo(() => library
    ? [...(view === 'character' ? library.characters : library.relationships)]
      .sort((left, right) => right.importance - left.importance
        || right.updatedAt.localeCompare(left.updatedAt))
    : [], [library, view]);
  const findServer = (next: CharacterCraft, current: Editing) =>
    (current.kind === 'character' ? next.characters : next.relationships)
      .find((entry) => entry.id === current.draft.id);

  const recover = async (reason: unknown, mayBeSaved: boolean) => {
    try {
      const latest = await reload();
      if (editing) {
        const serverEntry = findServer(latest, editing);
        if (serverEntry && equal(withoutTimestamps(serverEntry), editing.draft)) {
          if (mayBeSaved) setEditing(undefined);
          else setEditing({ ...editing, baseline: clone(editing.draft), conflicted: false });
          setMessage(mayBeSaved ? '响应未确认，但磁盘内容已与本地目标一致。'
            : '操作结果未确认；已刷新，当前编辑内容与服务器一致。');
          return;
        }
        setEditing({ ...editing, conflicted: true });
      }
      setMessage(api.isApiErrorCode(reason, 'CHARACTER_CRAFT_CONFLICT')
        ? '另一页面已修改人物导演卡；已刷新列表，本地草稿仍保留且不会自动覆盖。'
        : '操作结果未确认；已刷新磁盘状态，本地草稿仍保留。');
    } catch (refreshError) {
      setMessage(`操作结果未确认且刷新失败，请保留页面：${String(refreshError)}`);
    }
  };

  const save = async () => {
    if (!library || !editing || busy || editing.conflicted || !dirty) return;
    setSaving(true);
    setMessage('');
    try {
      const result = editing.kind === 'character'
        ? await api.saveCharacterGuide(
          bookId, editing.draft as CharacterGuideInput, library.revision,
        )
        : await api.saveRelationshipGuide(
          bookId, editing.draft as RelationshipGuideInput, library.revision,
        );
      setLibrary((current) => {
        if (!current) return current;
        if (editing.kind === 'character') return {
          ...current, revision: result.revision,
          characters: current.characters.some((item) => item.id === result.entry.id)
            ? current.characters.map((item) => item.id === result.entry.id
              ? result.entry as CharacterGuide : item)
            : [...current.characters, result.entry as CharacterGuide],
        };
        return {
          ...current, revision: result.revision,
          relationships: current.relationships.some((item) => item.id === result.entry.id)
            ? current.relationships.map((item) => item.id === result.entry.id
              ? result.entry as RelationshipGuide : item)
            : [...current.relationships, result.entry as RelationshipGuide],
        };
      });
      setEditing(undefined);
    } catch (reason) {
      if (api.isApiErrorCode(reason, 'CHARACTER_CRAFT_CONFLICT')
        || api.isAmbiguousApiFailure(reason)) await recover(reason, true);
      else setMessage(reason instanceof Error ? reason.message : '人物导演卡保存失败');
    } finally { setSaving(false); }
  };

  useEffect(() => {
    if (!editing || !dirty || busy || editing.conflicted) return;
    const signature = JSON.stringify(editing.draft);
    if (signature === lastAutoSaveSignature.current) return;
    const timer = window.setTimeout(() => {
      lastAutoSaveSignature.current = signature;
      void save();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [busy, dirty, editing]);

  const remove = async (entry: CraftEntry) => {
    if (!library || busy) return;
    if (confirmDeleteId !== entry.id) { setConfirmDeleteId(entry.id); return; }
    setDeletingId(entry.id);
    setMessage('');
    try {
      const result = await api.deleteCharacterCraftEntry(bookId, entry.id, library.revision);
      setLibrary((current) => current ? {
        ...current, revision: result.revision,
        characters: current.characters.filter((item) => item.id !== result.deletedId),
        relationships: current.relationships.filter((item) => item.id !== result.deletedId),
      } : current);
      if (editing?.draft.id === entry.id) setEditing(undefined);
      setConfirmDeleteId(null);
    } catch (reason) {
      if (api.isApiErrorCode(reason, 'CHARACTER_CRAFT_CONFLICT')
        || api.isAmbiguousApiFailure(reason)) await recover(reason, false);
      else setMessage(reason instanceof Error ? reason.message : '人物导演卡删除失败');
    } finally { setDeletingId(null); }
  };

  const edit = (kind: CraftKind, entry: CraftEntry) => {
    const draft = withoutTimestamps(entry);
    setEditing({ kind, draft, baseline: clone(draft), conflicted: false });
    setView(kind);
    setMessage('');
  };
  const generate = async () => {
    if (!library || busy) return;
    const controller = new AbortController();
    generationAbort.current = controller;
    setGenerating(true);
    setMessage('');
    try {
      const result = await api.generateCharacterCraftDraft(
        bookId, library.revision, controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.baseRevision !== library.revision) {
        setMessage('人物导演卡在生成期间已变化，草稿未写入；请刷新后重试。');
        return;
      }
      let next = library;
      for (const entry of result.characters) {
        if (next.characters.some((item) => item.name === entry.name)) continue;
        const saved = await api.saveCharacterGuide(
          bookId,
          characterGuideDraft(api.createClientCharacterGuideId(), entry),
          next.revision,
        );
        next = { ...next, revision: saved.revision,
          characters: [...next.characters, saved.entry as CharacterGuide] };
      }
      for (const entry of result.relationships) {
        const pair = characterCraftPairKey(entry.from, entry.to);
        if (next.relationships.some((item) => characterCraftPairKey(item.from, item.to) === pair)) continue;
        const saved = await api.saveRelationshipGuide(
          bookId,
          relationshipGuideDraft(api.createClientRelationshipGuideId(), entry),
          next.revision,
        );
        next = { ...next, revision: saved.revision,
          relationships: [...next.relationships, saved.entry as RelationshipGuide] };
      }
      setLibrary(next);
      setCandidate(undefined);
      setMessage(`AI 已自动保存 ${result.characters.length} 个人物和 ${result.relationships.length} 组关系；不需要的可直接删除。`);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setMessage(reason instanceof Error ? reason.message : '人物导演卡生成失败');
      }
    } finally {
      if (generationAbort.current === controller) {
        generationAbort.current = null;
        setGenerating(false);
      }
    }
  };

  const create = (kind: CraftKind) => {
    const chapter = completedChapterCount || 1;
    const draft = kind === 'character'
      ? emptyCharacterGuide(api.createClientCharacterGuideId(), chapter)
      : emptyRelationshipGuide(api.createClientRelationshipGuideId(), chapter);
    setEditing({ kind, draft, baseline: clone(draft), conflicted: false });
    setView(kind);
    setMessage('');
  };

  if (loading) return <section className="character-craft-card sketch-alt"><p>正在读取人物导演卡…</p></section>;
  if (!library) return <section className="character-craft-card sketch-alt">
    <p className="character-craft-message" role="alert">{message || '人物导演卡读取失败'}</p>
    <button className="hbtn" type="button" onClick={() => {
      setLoading(true); reload().then(() => setMessage('')).catch((reason) => setMessage(String(reason)))
        .finally(() => setLoading(false));
    }}>重试</button></section>;

  const serverEntry = editing ? findServer(library, editing) : undefined;
  return <section className="character-craft-card sketch-alt"><header><div>
    <h3>人物驱动力与声音</h3><p>事实档案回答“发生过什么”；导演卡回答“此刻为何行动、受压时如何暴露自己”。</p>
  </div><span>{library.characters.length} 人 · {library.relationships.length} 组关系</span></header>
    <div className="character-craft-toolbar"><div>
      <button className={`hbtn${view === 'character' ? ' active' : ''}`} type="button"
        onClick={() => setView('character')}>人物导演卡</button>
      <button className={`hbtn${view === 'relationship' ? ' active' : ''}`} type="button"
        onClick={() => setView('relationship')}>关系温度</button></div>
      {generating
        ? <button className="hbtn" type="button" onClick={() => generationAbort.current?.abort()}>
            停止 AI 生成</button>
        : <button className="hbtn accent" type="button" disabled={busy || Boolean(candidate)}
            onClick={() => void generate()}>✨ AI 自动生成人物与关系</button>}
      <button className="hbtn" type="button" disabled={busy}
        onClick={() => create(view)}>＋ 新建{view === 'character' ? '人物' : '关系'}卡</button></div>
    {message && <p className="character-craft-message" role="status">{message}</p>}
    {candidate && <CharacterCraftAiCandidate
      result={candidate}
      existingNames={library.characters.map((entry) => entry.name)}
      existingPairs={library.relationships.map((entry) =>
        characterCraftPairKey(entry.from, entry.to))}
      disabled={busy || Boolean(editing)}
      onUseCharacter={(entry) => {
        const draft = characterGuideDraft(api.createClientCharacterGuideId(), entry);
        const baseline = emptyCharacterGuide(
          draft.id, draft.asOfChapter ?? (completedChapterCount || 1),
        );
        setEditing({ kind: 'character', draft, baseline, conflicted: false });
        setView('character');
        setMessage('人物候选已载入编辑器；核对并点击保存后才会写盘。');
      }}
      onUseRelationship={(entry) => {
        const draft = relationshipGuideDraft(api.createClientRelationshipGuideId(), entry);
        const baseline = emptyRelationshipGuide(
          draft.id, draft.asOfChapter ?? (completedChapterCount || 1),
        );
        setEditing({ kind: 'relationship', draft, baseline, conflicted: false });
        setView('relationship');
        setMessage('关系候选已载入编辑器；核对并点击保存后才会写盘。');
      }}
      onDiscard={() => {
        setCandidate(undefined);
        setMessage('已丢弃 AI 人物与关系候选，未写入任何内容。');
      }} />}
    {editing && <form className="character-craft-form" onSubmit={(event) => {
      event.preventDefault(); void save();
    }}><header><div><h4>{editing.kind === 'character' ? '编辑人物导演卡' : '编辑关系温度'}</h4>
      <p>秘密与私下张力是作者信息，不会被标成角色已知事实。</p></div>
      <button className="hbtn" type="button" disabled={busy} onClick={() => setEditing(undefined)}>关闭</button></header>
      {editing.conflicted && <section className="character-craft-conflict" role="alert"><strong>服务器版本已经变化，本地草稿尚未覆盖它。</strong>
        <div>{serverEntry && <button className="hbtn" type="button" onClick={() => {
          const draft = withoutTimestamps(serverEntry);
          setEditing({ ...editing, draft, baseline: clone(draft), conflicted: false });
          setMessage('');
        }}>载入服务器版本</button>}
          {serverEntry && <button className="hbtn accent" type="button"
            onClick={() => setEditing({ ...editing, conflicted: false })}>保留本地并允许覆盖</button>}
          {!serverEntry && <button className="hbtn accent" type="button" onClick={() => {
            const draft = editing.kind === 'character'
              ? { ...editing.draft, id: api.createClientCharacterGuideId() }
              : { ...editing.draft, id: api.createClientRelationshipGuideId() };
            const baseline = editing.kind === 'character'
              ? emptyCharacterGuide(draft.id, completedChapterCount || 1)
              : emptyRelationshipGuide(draft.id, completedChapterCount || 1);
            setEditing({ ...editing, draft, baseline, conflicted: false });
          }}>另存为新卡</button>}</div></section>}
      {editing.kind === 'character'
        ? <CharacterForm draft={editing.draft as CharacterGuideInput} busy={busy}
          onChange={(draft) => setEditing({ ...editing, draft })} />
        : <RelationshipForm draft={editing.draft as RelationshipGuideInput} busy={busy}
          completedChapterCount={completedChapterCount}
          onChange={(draft) => setEditing({ ...editing, draft })} />}
      <footer><span className="character-craft-autosave">{saving ? '自动保存中…'
        : dirty ? '停笔约 1 秒后自动保存' : '已自动保存'}</span>
        <span>至少填写一项真正会改变行动、潜台词或关系走向的内容。</span></footer>
    </form>}
    {view === 'character'
      ? <CharacterList entries={entries as CharacterGuide[]} disabled={busy}
        deletingId={deletingId} confirmDeleteId={confirmDeleteId}
        onEdit={(entry) => edit('character', entry)} onDelete={(entry) => void remove(entry)} />
      : <RelationshipList entries={entries as RelationshipGuide[]} disabled={busy}
        deletingId={deletingId} confirmDeleteId={confirmDeleteId}
        onEdit={(entry) => edit('relationship', entry)} onDelete={(entry) => void remove(entry)} />}
  </section>;
}

import { useEffect, useMemo, useState } from 'react';
import * as api from '../api';
import type {
  PromiseKind, PromiseLedger, PromiseLedgerEntry, PromiseLedgerEntryInput,
  PromiseProgressEvent, PromiseStatus,
} from '../types';

const KIND_LABELS: Record<PromiseKind, string> = {
  main: '主线承诺', character: '人物线', mystery: '谜团/伏笔',
  relationship: '关系线', growth: '成长/能力', world: '世界线', other: '其它',
};
const STATUS_LABELS: Record<PromiseStatus, string> = {
  planned: '计划中·尚未建立', open: '已建立·待兑现',
  paid: '已兑现', abandoned: '已放弃',
};
const BEAT_LABELS = {
  plant: '植入', pressure: '加压', misdirect: '公平误导',
  reinterpret: '变义', collide: '线索碰撞', payoff: '回收',
} as const;
type LedgerFilter = 'active' | 'overdue' | PromiseStatus | 'all';
const FILTERS: Array<[LedgerFilter, string]> = [
  ['active', '当前债务'], ['overdue', '已逾期'], ['planned', '计划中'],
  ['paid', '已兑现'], ['abandoned', '已放弃'], ['all', '全部'],
];

const cloneInput = (input: PromiseLedgerEntryInput): PromiseLedgerEntryInput => ({
  ...input,
  progress: input.progress.map((event) => ({ ...event })),
});

export function emptyPromiseEntryInput(
  id: string, nextChapter: number,
): PromiseLedgerEntryInput {
  const chapter = Math.max(1, Math.trunc(nextChapter) || 1);
  return {
    id, kind: 'main', status: 'planned', importance: 3, promise: '',
    introducedChapter: null,
    expectedStartChapter: chapter,
    expectedEndChapter: chapter,
    progress: [], resolution: '', resolvedChapter: null, nextPromise: '', notes: '',
  };
}

export function promiseEntryInput(entry: PromiseLedgerEntry): PromiseLedgerEntryInput {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = entry;
  return cloneInput(input);
}

export const promiseEntryIsOverdue = (
  entry: Pick<PromiseLedgerEntryInput, 'status' | 'expectedEndChapter'>,
  completedChapterCount: number,
) => entry.status === 'open' && completedChapterCount >= entry.expectedEndChapter;

export const promiseEntryInputEquals = (
  left: PromiseLedgerEntryInput, right: PromiseLedgerEntryInput,
) => JSON.stringify(left) === JSON.stringify(right);

function inputNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function optionalInputNumber(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function entryMatchesFilter(
  entry: PromiseLedgerEntry, filter: LedgerFilter, completedChapterCount: number,
) {
  if (filter === 'all') return true;
  if (filter === 'active') return entry.status === 'planned' || entry.status === 'open';
  if (filter === 'overdue') return promiseEntryIsOverdue(entry, completedChapterCount);
  return entry.status === filter;
}

function statusTiming(entry: PromiseLedgerEntry, completedChapterCount: number) {
  if (promiseEntryIsOverdue(entry, completedChapterCount)) {
    return `已逾期 ${completedChapterCount - entry.expectedEndChapter + 1} 章`;
  }
  if (entry.status === 'open' && completedChapterCount + 1 >= entry.expectedStartChapter) {
    return completedChapterCount + 1 > entry.expectedEndChapter
      ? '下一章必须处理' : '已进入兑现窗口';
  }
  return `预计第 ${entry.expectedStartChapter}–${entry.expectedEndChapter} 章`;
}

export function PromiseLedgerList({
  entries, completedChapterCount, disabled, deletingId, confirmDeleteId,
  onEdit, onDelete,
}: {
  entries: PromiseLedgerEntry[];
  completedChapterCount: number;
  disabled: boolean;
  deletingId: string | null;
  confirmDeleteId: string | null;
  onEdit: (entry: PromiseLedgerEntry) => void;
  onDelete: (entry: PromiseLedgerEntry) => void;
}) {
  if (!entries.length) {
    return <p className="promise-ledger-empty">当前筛选下没有承诺。计划中的想法不算读者债务；正文真正建立后再改为“已建立”。</p>;
  }
  return <div className="promise-ledger-list">{entries.map((entry) => (
    <article className={`promise-ledger-entry promise-${entry.status}`} key={entry.id}>
      <header>
        <div className="promise-ledger-tags">
          <span>{KIND_LABELS[entry.kind]}</span>
          <span>{STATUS_LABELS[entry.status]}</span>
          <span>重要度 {entry.importance}</span>
          {promiseEntryIsOverdue(entry, completedChapterCount) && <span className="overdue">逾期</span>}
        </div>
        <strong>{statusTiming(entry, completedChapterCount)}</strong>
      </header>
      <h4>{entry.promise}</h4>
      <p className="promise-ledger-window">
        {entry.introducedChapter ? `全书第 ${entry.introducedChapter} 章建立；` : '尚未登记建立章；'}
        预计第 {entry.expectedStartChapter}–{entry.expectedEndChapter} 章兑现
      </p>
      {!!entry.progress.length && <details>
        <summary>{entry.progress.length} 次有效推进</summary>
        <ol>{entry.progress.map((event) => (
          <li key={event.id} className={event.status === 'stale' ? 'stale' : ''}>
            <strong>第 {event.chapter} 章{event.beat ? ` · ${BEAT_LABELS[event.beat]}` : ''}</strong>
            {event.status === 'stale' ? '（证据已失效）' : ''}：{event.note}
            {event.readerBefore && event.readerAfter && <small>
              读者认知：{event.readerBefore} → {event.readerAfter}
            </small>}
            {event.actionConsequence && <small>行动后果：{event.actionConsequence}</small>}
            {event.worldEffect && <small>世界线：{event.worldEffect}</small>}
            {event.evidence && <blockquote>正文证据：{event.evidence}</blockquote>}
          </li>
        ))}</ol>
      </details>}
      {entry.resolution && <p className="promise-ledger-resolution">
        <strong>{entry.status === 'paid' ? '实际兑现' : '放弃原因'}</strong>
        {entry.resolvedChapter ? `（第 ${entry.resolvedChapter} 章）` : ''}：{entry.resolution}
      </p>}
      {entry.nextPromise && <p><strong>由此产生的新承诺：</strong>{entry.nextPromise}</p>}
      {entry.notes && <p><strong>作者备注：</strong>{entry.notes}</p>}
      <div className="promise-ledger-actions">
        <button className="hbtn" type="button" disabled={disabled}
          onClick={() => onEdit(entry)}>编辑 / 记录推进</button>
        <button className="hbtn" type="button"
          disabled={disabled || deletingId === entry.id
            || entry.progress.some((event) => Boolean(event.source))}
          title={entry.progress.some((event) => Boolean(event.source))
            ? '已有正文证据的承诺保留审计链；可改为已放弃，不可删除' : undefined}
          onClick={() => onDelete(entry)}>
          {entry.progress.some((event) => Boolean(event.source)) ? '正文证据不可删'
            : deletingId === entry.id ? '删除中…'
            : confirmDeleteId === entry.id ? '确认永久删除？' : '删除'}
        </button>
      </div>
    </article>
  ))}</div>;
}

function PromiseLedgerForm({
  draft, busy, completedChapterCount, conflicted, serverEntry,
  onChange, onSave, onCancel, onUseServer, onAllowOverwrite, onSaveAsNew,
}: {
  draft: PromiseLedgerEntryInput;
  busy: boolean;
  completedChapterCount: number;
  conflicted: boolean;
  serverEntry?: PromiseLedgerEntry;
  onChange: (draft: PromiseLedgerEntryInput) => void;
  onSave: () => void;
  onCancel: () => void;
  onUseServer: () => void;
  onAllowOverwrite: () => void;
  onSaveAsNew: () => void;
}) {
  const set = <K extends keyof PromiseLedgerEntryInput>(
    key: K, value: PromiseLedgerEntryInput[K],
  ) => onChange({ ...draft, [key]: value });
  const updateProgress = (index: number, patch: Partial<PromiseProgressEvent>) =>
    set('progress', draft.progress.map((event, eventIndex) =>
      eventIndex === index ? { ...event, ...patch } : event));
  const statusChange = (status: PromiseStatus) => {
    const unresolved = status === 'planned' || status === 'open';
    onChange({
      ...draft, status,
      resolution: unresolved ? '' : draft.resolution,
      resolvedChapter: unresolved ? null : draft.resolvedChapter,
    });
  };
  return <form className="promise-ledger-form" onSubmit={(event) => {
    event.preventDefault();
    onSave();
  }}>
    <header>
      <div><h4>编辑承诺</h4><p>“计划中”不会被当作读者已知；正文真正建立后再改为“已建立”。</p></div>
      <button className="hbtn" type="button" disabled={busy} onClick={onCancel}>关闭</button>
    </header>
    {conflicted && <section className="promise-ledger-conflict" role="alert">
      <strong>服务器账本已变化，本地草稿尚未覆盖它。</strong>
      <p>{serverEntry ? '请选择载入服务器版本，或明确用当前本地草稿覆盖。'
        : '该条目已不存在；可以把本地内容另存为一条新承诺。'}</p>
      <div className="promise-ledger-actions">
        {serverEntry && <button className="hbtn" type="button" onClick={onUseServer}>载入服务器版本</button>}
        {serverEntry && <button className="hbtn accent" type="button" onClick={onAllowOverwrite}>保留本地并允许覆盖</button>}
        {!serverEntry && <button className="hbtn accent" type="button" onClick={onSaveAsNew}>另存为新承诺</button>}
      </div>
    </section>}
    <div className="promise-ledger-form-grid">
      <label>承诺类型<select disabled={busy} value={draft.kind}
        onChange={(event) => set('kind', event.target.value as PromiseKind)}>
        {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>当前状态<select disabled={busy} value={draft.status}
        onChange={(event) => statusChange(event.target.value as PromiseStatus)}>
        {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>重要度<select disabled={busy} value={draft.importance}
        onChange={(event) => set('importance', Number(event.target.value))}>
        {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <label>向读者建立于全书第几章（可空）<input type="number" min="1" max="50000"
        disabled={busy} value={draft.introducedChapter ?? ''}
        onChange={(event) => set('introducedChapter', optionalInputNumber(event.target.value))} /></label>
      <label className="wide">读者正在等待什么<textarea required maxLength={500} disabled={busy}
        value={draft.promise} placeholder="例如：主角何时发现师父才是灭门案的知情者"
        onChange={(event) => set('promise', event.target.value)} /></label>
      <label>预计兑现起始章<input required type="number" min="1" max="50000"
        disabled={busy} value={draft.expectedStartChapter}
        onChange={(event) => set('expectedStartChapter', inputNumber(event.target.value, 1))} /></label>
      <label>预计兑现最迟章<input required type="number" min="1" max="50000"
        disabled={busy} value={draft.expectedEndChapter}
        onChange={(event) => set('expectedEndChapter', inputNumber(event.target.value, 1))} /></label>
      {(draft.status === 'paid' || draft.status === 'abandoned') && <>
        <label>{draft.status === 'paid' ? '实际兑现章' : '结束章（可空）'}<input
          required={draft.status === 'paid'} type="number" min="1" max="50000"
          disabled={busy} value={draft.resolvedChapter ?? ''}
          onChange={(event) => set('resolvedChapter', optionalInputNumber(event.target.value))} /></label>
        <label className="wide">{draft.status === 'paid' ? '实际如何兑现' : '为何放弃或转化'}
          <textarea required maxLength={500} disabled={busy} value={draft.resolution}
            onChange={(event) => set('resolution', event.target.value)} /></label>
      </>}
      <label className="wide">由此产生的新承诺<textarea maxLength={500} disabled={busy}
        value={draft.nextPromise} placeholder="兑现不是终点时，记录自然产生的下一层期待"
        onChange={(event) => set('nextPromise', event.target.value)} /></label>
      <label className="wide">作者备注<textarea maxLength={1000} disabled={busy}
        value={draft.notes} placeholder="必须保留的伏笔边界、不能使用的解法等"
        onChange={(event) => set('notes', event.target.value)} /></label>
    </div>
    <section className="promise-progress-editor">
      <header><div><h5>阶段推进</h5><p>手工记录可补充作者判断；带正文证据的节拍只能从章节审稿候选确认。</p></div>
        <button className="hbtn" type="button" disabled={busy || draft.progress.length >= 50}
          onClick={() => set('progress', [...draft.progress, {
            id: api.createClientPromiseProgressId(),
            chapter: Math.max(1, completedChapterCount || 1), note: '',
          }])}>＋ 记录推进</button></header>
      {draft.progress.map((event, index) => event.source
        ? <div className="promise-progress-evidence-readonly" key={event.id}>
          <strong>第 {event.chapter} 章 · {event.beat ? BEAT_LABELS[event.beat] : '证据节拍'}</strong>
          <span>{event.note}</span><small>由正文审稿确认，不可在此编辑</small>
        </div>
        : <div className="promise-progress-row" key={event.id}>
        <label>全书章序<input required type="number" min="1" max="50000" disabled={busy}
          value={event.chapter}
          onChange={(change) => updateProgress(index, {
            chapter: inputNumber(change.target.value, 1),
          })} /></label>
        <label>推进发生了什么<input required maxLength={300} disabled={busy}
          value={event.note} onChange={(change) => updateProgress(index, { note: change.target.value })} /></label>
        <button className="hbtn" type="button" disabled={busy}
          aria-label={`删除推进 ${index + 1}`}
          onClick={() => set('progress', draft.progress.filter((_, eventIndex) => eventIndex !== index))}>删除</button>
      </div>)}
    </section>
    <div className="promise-ledger-actions">
      <button className="hbtn primary" type="submit" disabled={busy || conflicted}>
        {busy ? '保存中…' : '保存承诺'}
      </button>
      <span>当前已完成 {completedChapterCount} 章；章序均指全书章序。</span>
    </div>
  </form>;
}

type EditingState = {
  draft: PromiseLedgerEntryInput;
  baseline: PromiseLedgerEntryInput;
  conflicted: boolean;
};

export function PromiseLedgerCard({
  bookId, completedChapterCount, disabled = false, onDirtyChange,
}: {
  bookId: string;
  completedChapterCount: number;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [library, setLibrary] = useState<PromiseLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<LedgerFilter>('active');
  const [editing, setEditing] = useState<EditingState>();
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const dirty = Boolean(editing && !promiseEntryInputEquals(editing.draft, editing.baseline));
  const busy = disabled || saving || Boolean(deletingId);

  const reload = async (signal?: AbortSignal) => {
    const next = await api.getPromiseLedger(bookId, signal);
    setLibrary(next);
    return next;
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    reload(controller.signal)
      .then(() => setError(''))
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [bookId]);
  useEffect(() => onDirtyChange?.(dirty || saving || Boolean(deletingId)), [
    dirty, saving, deletingId, onDirtyChange,
  ]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const visible = useMemo(() => (library?.entries ?? [])
    .filter((entry) => entryMatchesFilter(entry, filter, completedChapterCount))
    .sort((left, right) => {
      const overdue = Number(promiseEntryIsOverdue(right, completedChapterCount))
        - Number(promiseEntryIsOverdue(left, completedChapterCount));
      return overdue || right.importance - left.importance
        || left.expectedEndChapter - right.expectedEndChapter
        || right.updatedAt.localeCompare(left.updatedAt);
    }), [library, filter, completedChapterCount]);

  const recoverMutation = async (
    reason: unknown, draft?: PromiseLedgerEntryInput, draftMayHaveBeenSaved = true,
  ) => {
    try {
      const latest = await reload();
      const serverEntry = draft && latest.entries.find((entry) => entry.id === draft.id);
      if (draft && serverEntry && promiseEntryInputEquals(promiseEntryInput(serverEntry), draft)) {
        if (draftMayHaveBeenSaved) {
          setEditing(undefined);
          setError('保存响应虽未确认，但磁盘中的承诺已经与本地目标一致。');
        } else {
          setEditing((current) => current ? {
            ...current, baseline: cloneInput(draft), conflicted: false,
          } : current);
          setError('删除结果未确认；已重新读取磁盘状态，当前编辑内容与服务器一致。');
        }
        return;
      }
      if (draft) setEditing((current) => current ? { ...current, conflicted: true } : current);
      setError(api.isApiErrorCode(reason, 'PROMISE_LEDGER_CONFLICT')
        ? '另一页面已修改账本；已载入最新列表，本地编辑草稿仍保留且不会自动覆盖。'
        : '操作结果未确认；已重新读取磁盘状态，本地编辑草稿仍保留。');
    } catch (refreshError) {
      setError('账本操作结果未确认且刷新失败；请保留当前页面并稍后重试：'
        + (refreshError instanceof Error ? refreshError.message : String(refreshError)));
    }
  };

  const save = async () => {
    if (!library || !editing || busy || editing.conflicted || !dirty) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.savePromiseLedgerEntry(
        bookId, editing.draft, library.revision,
      );
      setLibrary((current) => current ? {
        revision: result.revision,
        entries: current.entries.some((entry) => entry.id === result.entry.id)
          ? current.entries.map((entry) => entry.id === result.entry.id ? result.entry : entry)
          : [...current.entries, result.entry],
      } : current);
      setEditing(undefined);
    } catch (reason) {
      if (api.isApiErrorCode(reason, 'PROMISE_LEDGER_CONFLICT')
        || api.isAmbiguousApiFailure(reason)) await recoverMutation(reason, editing.draft);
      else setError(reason instanceof Error ? reason.message : '承诺保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: PromiseLedgerEntry) => {
    if (!library || busy) return;
    if (confirmDeleteId !== entry.id) {
      setConfirmDeleteId(entry.id);
      return;
    }
    setDeletingId(entry.id);
    setError('');
    try {
      const result = await api.deletePromiseLedgerEntry(bookId, entry.id, library.revision);
      setLibrary((current) => current ? {
        revision: result.revision,
        entries: current.entries.filter((item) => item.id !== result.deletedId),
      } : current);
      if (editing?.draft.id === entry.id) setEditing(undefined);
      setConfirmDeleteId(null);
    } catch (reason) {
      if (api.isApiErrorCode(reason, 'PROMISE_LEDGER_CONFLICT')
        || api.isAmbiguousApiFailure(reason)) {
        await recoverMutation(reason, editing?.draft, false);
      }
      else setError(reason instanceof Error ? reason.message : '承诺删除失败');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) return <section className="promise-ledger-card sketch-alt"><p>正在读取承诺账本…</p></section>;
  if (!library) return <section className="promise-ledger-card sketch-alt">
    <p className="promise-ledger-error" role="alert">{error || '承诺账本读取失败'}</p>
    <button className="hbtn" type="button" onClick={() => {
      setLoading(true);
      reload().then(() => setError('')).catch((reason) => setError(String(reason)))
        .finally(() => setLoading(false));
    }}>重试</button>
  </section>;

  const serverEntry = editing
    ? library.entries.find((entry) => entry.id === editing.draft.id) : undefined;
  return <section className="promise-ledger-card sketch-alt">
    <header><div><h3>承诺—推进—兑现账本</h3>
      <p>只把正文真正建立的期待算作阅读债务；临期和逾期承诺会优先进入生成与审稿。</p></div>
      <span>{library.entries.filter((entry) => entry.status === 'open').length} 条待兑现</span></header>
    <div className="promise-ledger-toolbar">
      <div>{FILTERS.map(([value, label]) => <button key={value} className={`hbtn${filter === value ? ' active' : ''}`}
        type="button" onClick={() => setFilter(value)}>{label}</button>)}</div>
      <button className="hbtn accent" type="button" disabled={busy}
        onClick={() => {
          const draft = emptyPromiseEntryInput(
            api.createClientPromiseId(), completedChapterCount + 1,
          );
          setEditing({ draft, baseline: cloneInput(draft), conflicted: false });
          setError('');
        }}>＋ 新建承诺</button>
    </div>
    {error && <p className="promise-ledger-error" role="alert">{error}</p>}
    {editing && <PromiseLedgerForm
      draft={editing.draft} busy={busy} completedChapterCount={completedChapterCount}
      conflicted={editing.conflicted} serverEntry={serverEntry}
      onChange={(draft) => setEditing((current) => current ? { ...current, draft } : current)}
      onSave={() => void save()} onCancel={() => setEditing(undefined)}
      onUseServer={() => {
        if (!serverEntry) return;
        const draft = promiseEntryInput(serverEntry);
        setEditing({ draft, baseline: cloneInput(draft), conflicted: false });
        setError('');
      }}
      onAllowOverwrite={() => setEditing((current) => current
        ? { ...current, conflicted: false } : current)}
      onSaveAsNew={() => setEditing((current) => {
        if (!current) return current;
        const draft = { ...current.draft, id: api.createClientPromiseId() };
        const baseline = emptyPromiseEntryInput(draft.id, completedChapterCount + 1);
        return { draft, baseline, conflicted: false };
      })} />}
    <PromiseLedgerList entries={visible} completedChapterCount={completedChapterCount}
      disabled={busy} deletingId={deletingId} confirmDeleteId={confirmDeleteId}
      onEdit={(entry) => {
        const draft = promiseEntryInput(entry);
        setEditing({ draft, baseline: cloneInput(draft), conflicted: false });
        setError('');
      }} onDelete={(entry) => void remove(entry)} />
  </section>;
}

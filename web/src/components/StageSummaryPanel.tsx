import { useEffect, useMemo, useState } from 'react';
import {
  deleteStageSummary, isAmbiguousApiFailure, isApiErrorCode,
  recomputeStageSummary, saveStageSummary,
} from '../api';
import type {
  BookSection, StageSummary, StageSummaryInput, StageSummaryStatus,
} from '../types';

const MAX_STAGE_SECTIONS = 20;

type Editor = StageSummaryInput & { status: StageSummaryStatus };

function createStageSummaryId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `stage_${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function newEditor(sections: BookSection[], sequence: number): Editor | null {
  if (!sections.length) return null;
  return {
    id: createStageSummaryId(),
    title: `阶段 ${sequence}`,
    startSectionId: sections[0].id,
    endSectionId: sections[Math.min(sections.length, 5) - 1].id,
    summary: '',
    status: 'draft',
  };
}

function editorFromStage(item: StageSummary): Editor {
  return {
    id: item.id,
    title: item.title,
    startSectionId: item.startSectionId,
    endSectionId: item.endSectionId,
    summary: item.summary,
    status: item.status,
  };
}

export function StageSummaryPanel({
  bookId, sections, items, revision, onReload,
}: {
  bookId: string;
  sections: BookSection[];
  items: StageSummary[];
  revision: string;
  onReload: () => Promise<boolean>;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState<'save' | 'recompute' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  useEffect(() => {
    setEditor(null);
    setError(null);
    setNotice(null);
    setDeleteConfirm(false);
  }, [bookId]);

  const positions = useMemo(
    () => new Map(sections.map((section, index) => [section.id, index])), [sections],
  );
  const startIndex = editor ? positions.get(editor.startSectionId) ?? -1 : -1;
  const endIndex = editor ? positions.get(editor.endSectionId) ?? -1 : -1;
  const rangeValid = startIndex >= 0 && endIndex >= startIndex
    && endIndex - startIndex + 1 <= MAX_STAGE_SECTIONS;
  const selected = editor ? items.find((item) => item.id === editor.id) : undefined;
  const hasStaleFrozen = items.some((item) => item.status === 'frozen' && item.stale);

  const run = async (kind: 'save' | 'recompute', status: StageSummaryStatus = 'draft') => {
    if (!editor || busy || !rangeValid) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const input = { ...editor, status };
      const result = kind === 'recompute'
        ? await recomputeStageSummary(bookId, input, revision)
        : await saveStageSummary(bookId, input, revision);
      setEditor(editorFromStage(result.item));
      await onReload();
      setNotice(kind === 'recompute'
        ? '已根据当前分部摘要重算为草稿，请校对后再冻结。'
        : status === 'frozen'
          ? '已保存并冻结；后续自动流程不会覆盖这份摘要。'
          : '阶段摘要草稿已保存。');
    } catch (reason) {
      if (isApiErrorCode(reason, 'STAGE_SUMMARY_CONFLICT')
        || isApiErrorCode(reason, 'STAGE_SUMMARY_SOURCE_STALE')
        || isAmbiguousApiFailure(reason)) await onReload();
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!editor || busy) return;
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      setNotice('再次点击“确认删除”才会删除这条阶段摘要。');
      return;
    }
    setBusy('delete');
    setError(null);
    try {
      await deleteStageSummary(bookId, editor.id, revision);
      setEditor(null);
      setDeleteConfirm(false);
      await onReload();
      setNotice('已删除阶段摘要；来源分部和章摘要没有变化。');
    } catch (reason) {
      if (isApiErrorCode(reason, 'STAGE_SUMMARY_CONFLICT')
        || isAmbiguousApiFailure(reason)) await onReload();
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(null);
    }
  };

  return <section className="stage-summary-panel">
    <header>
      <div><h3>全书阶段摘要</h3>
        <p>把连续分部压缩成长程路标；草稿过期后自动退出上下文，冻结版由作者锁定。</p></div>
      <button className="hbtn" disabled={!sections.length || !!busy}
        onClick={() => {
          setEditor(newEditor(sections, items.length + 1));
          setDeleteConfirm(false); setError(null); setNotice(null);
        }}>+新建阶段</button>
    </header>
    {!!items.length && <div className="stage-summary-list">
      {items.map((item) => <button key={item.id} className="stage-summary-chip"
        aria-pressed={editor?.id === item.id}
        onClick={() => {
          setEditor(editorFromStage(item));
          setDeleteConfirm(false); setError(null); setNotice(null);
        }}>
        <strong>{item.title}</strong>
        <span>第 {item.startSectionIndex}–{item.endSectionIndex} 部 · {item.status === 'frozen' ? '已冻结' : '草稿'}{item.stale ? ' · 来源已变化' : ''}</span>
      </button>)}
    </div>}
    {hasStaleFrozen && !selected?.stale && <div className="memory-message" role="status">
      有冻结阶段摘要的来源已经变化。生成时会同时携带当前分部摘要；两者冲突时以当前正文派生事实为准。请打开该阶段，按需解冻并重算。
    </div>}
    {!items.length && !editor && <p className="empty-hint">尚无阶段摘要。建议每 3–5 个分部建立一份，校对后冻结。</p>}
    {editor && <div className="stage-summary-editor">
      <div className="stage-summary-fields">
        <label>阶段名称<input maxLength={80} value={editor.title}
          onChange={(event) => setEditor({ ...editor, title: event.target.value })} /></label>
        <label>起始分部<select value={editor.startSectionId}
          onChange={(event) => setEditor({ ...editor, startSectionId: event.target.value })}>
          {sections.map((section) => <option key={section.id} value={section.id}>第 {section.index} 部{section.title ? ` · ${section.title}` : ''}</option>)}
        </select></label>
        <label>结束分部<select value={editor.endSectionId}
          onChange={(event) => setEditor({ ...editor, endSectionId: event.target.value })}>
          {sections.map((section) => <option key={section.id} value={section.id}>第 {section.index} 部{section.title ? ` · ${section.title}` : ''}</option>)}
        </select></label>
      </div>
      {!rangeValid && <div className="memory-message error" role="alert">请选择不超过 20 个的连续分部，且结束不能早于起始。</div>}
      {selected?.stale && <div className="memory-message" role="status">
        来源分部摘要已变化。{selected.status === 'frozen'
          ? '冻结版仍保留作者意图，但生成时会同时携带当前分部摘要；两者冲突时以当前正文派生事实为准。若要消除冲突，请先解冻再重算。'
          : '该草稿已退出生成上下文，请重算或人工修订。'}
      </div>}
      <label className="stage-summary-text">摘要正文<textarea maxLength={4000}
        value={editor.summary ?? ''}
        onChange={(event) => setEditor({ ...editor, summary: event.target.value })}
        placeholder="保留主线转折、关系变化、关键状态、未收伏笔和阶段结尾局面。" /></label>
      <div className="stage-summary-actions">
        <button className="hbtn" disabled={!!busy || !rangeValid
          || !editor.title.trim() || editor.status === 'frozen'}
          onClick={() => { void run('recompute'); }}>
          {busy === 'recompute' ? '模型正在压缩…' : '一键重算草稿'}
        </button>
        <button className="hbtn" disabled={!!busy || !rangeValid
          || !editor.title.trim() || !editor.summary?.trim()}
          onClick={() => { void run('save', 'draft'); }}>
          {editor.status === 'frozen' ? '解冻为草稿' : '保存草稿'}
        </button>
        <button className="primary" disabled={!!busy || !rangeValid
          || !editor.title.trim() || !editor.summary?.trim()}
          onClick={() => { void run('save', 'frozen'); }}>
          {editor.status === 'frozen' ? '保存冻结版' : '保存并冻结'}
        </button>
        {selected && <button className="hbtn danger" disabled={!!busy}
          onClick={() => { void remove(); }}>
          {busy === 'delete' ? '删除中…' : deleteConfirm ? '确认删除' : '删除'}
        </button>}
      </div>
    </div>}
    {error && <div className="memory-message error" role="alert">{error}</div>}
    {notice && <div className="memory-message" role="status">{notice}</div>}
  </section>;
}

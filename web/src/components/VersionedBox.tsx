import { useEffect, useRef, useState } from 'react';
import type { Versioned } from '../types';
import { currentText, canPrev, canNext, versionLabel } from '../versioned';

export function warnBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = '';
}

export const createBeforeUnloadListener = () =>
  (event: BeforeUnloadEvent) => warnBeforeUnload(event);

export function useBeforeUnloadWarning(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    // 每个调用点都使用独立包装函数。EventTarget 会合并相同的
    // type/callback/capture 监听器；共用同一回调时，一个组件的清理会
    // 误删另一个仍活跃的离开警告。
    const listener = createBeforeUnloadListener();
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, [enabled]);
}

export type DraftState = {
  draft: string;
  base: string;
  conflict: boolean;
};

// 服务端版本刷新时，只有仍等于旧基线的“干净草稿”才可自动跟随。
// 本地已编辑的内容必须保留；若服务端也发生变化，则显式标记冲突，避免
// 失焦自动保存把另一标签页刚提交的版本静默盖过去。
export function syncDraftState(state: DraftState, nextCurrent: string): DraftState {
  if (state.base === nextCurrent) return state;
  if (state.draft === state.base || state.draft === nextCurrent) {
    return { draft: nextCurrent, base: nextCurrent, conflict: false };
  }
  return { ...state, base: nextCurrent, conflict: true };
}

export function hasDraftConflict(state: DraftState, current: string) {
  return state.conflict || (
    state.base !== current
    && state.draft !== state.base
    && state.draft !== current
  );
}

export function shouldSaveDraft({
  disabled, dirty, conflict, explicit,
}: {
  disabled: boolean;
  dirty: boolean;
  conflict: boolean;
  explicit: boolean;
}) {
  return !disabled && dirty && (explicit || !conflict);
}

export function shouldDisableDraftReplacingAction({
  disabled, dirty,
}: {
  disabled: boolean;
  dirty: boolean;
}) {
  return disabled || dirty;
}

export function adoptIncomingDraft(
  state: DraftState, current: string, incomingText: string,
): DraftState {
  if (state.draft !== current) return state;
  return { draft: incomingText, base: current, conflict: false };
}

// 通用「版本化框」：标题 + 行内工具条（上一版/重写(或停止)/下一版/删除）+ 主体（流式 pre / 可编辑 textarea）+ 版本徽标
// size 控制主体高度与字号：sm=紧凑（核心设定子框）/ md=中等 / lg=大（全书大纲、章节正文）
export type IncomingVersionedDraft = { token: number; text: string };

export function VersionedBox({ title, versioned, streaming, busy = false, streamingText, size = 'md', rewriteLabel = '🔄 重写', incomingDraft, onMove, onRewrite, onClear, onSave, onStop, onDirtyChange }: {
  title: string;
  versioned: Versioned;
  streaming: boolean;
  busy?: boolean;
  streamingText: string;
  size?: 'sm' | 'md' | 'lg';
  rewriteLabel?: string;
  incomingDraft?: IncomingVersionedDraft;
  onMove: (delta: number) => void;
  onRewrite: () => void;
  onClear: () => void;
  onSave: (text: string) => void;
  onStop: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const cur = currentText(versioned);
  const disabled = streaming || busy;
  // 本地草稿：记录它所基于的服务端文本，避免外部刷新覆盖未保存编辑。
  const [draftState, setDraftState] = useState<DraftState>({
    draft: cur,
    base: cur,
    conflict: false,
  });
  const { draft } = draftState;
  // 同步 effect 落地前也直接由 props 推导冲突，封住服务器刷新与 textarea
  // 失焦发生在相邻事件循环时的短暂自动保存窗口。
  const conflict = hasDraftConflict(draftState, cur);
  const dirty = draft !== cur;
  // 内联二次确认（不使用系统 alert）
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirtyChangeRef = useRef(onDirtyChange);
  const incomingDraftTokenRef = useRef(incomingDraft?.token);
  const reportedDirtyRef = useRef(false);
  dirtyChangeRef.current = onDirtyChange;
  const reportDirty = (nextDirty: boolean) => {
    if (reportedDirtyRef.current === nextDirty) return;
    reportedDirtyRef.current = nextDirty;
    dirtyChangeRef.current?.(nextDirty);
  };
  useEffect(() => {
    setDraftState((state) => syncDraftState(state, cur));
    setConfirmClear(false);
    setConfirmDiscard(false);
  }, [cur]);
  useEffect(() => {
    if (!incomingDraft || incomingDraftTokenRef.current === incomingDraft.token) return;
    incomingDraftTokenRef.current = incomingDraft.token;
    setDraftState((state) => {
      // 调用方会在已知 dirty 时禁用“应用”，这里仍做最后一道保护，避免
      // 相邻事件循环或其它复用调用覆盖尚未上报的本地编辑。
      return adoptIncomingDraft(state, cur, incomingDraft.text);
    });
  }, [cur, incomingDraft]);
  useEffect(() => { reportDirty(dirty); }, [dirty]);
  useEffect(() => {
    if (dirty) setConfirmClear(false);
    else setConfirmDiscard(false);
  }, [dirty]);
  useEffect(() => () => {
    if (reportedDirtyRef.current) dirtyChangeRef.current?.(false);
  }, []);
  useBeforeUnloadWarning(dirty);

  const saveDraft = (explicit = false) => {
    if (shouldSaveDraft({ disabled, dirty, conflict, explicit })) onSave(draft);
  };
  const discardDraft = () => {
    reportDirty(false);
    setDraftState({ draft: cur, base: cur, conflict: false });
    setConfirmDiscard(false);
  };
  const draftReplacingDisabled = shouldDisableDraftReplacingAction({ disabled, dirty });

  return (
    <section className={`vbox vbox-${size} sketch`}>
      <div className="vbox-head">
        <h2 className="vbox-title">{title}</h2>
        <div className="vbox-tools">
          <button className="hbtn mini" title="切换到上一版（会立即设为当前版本）"
            disabled={draftReplacingDisabled || !canPrev(versioned)} onClick={() => onMove(-1)}>◀ 上一版</button>
          {streaming
            ? <button className="hbtn mini stop" onClick={onStop}>⏹ 停止</button>
            : <button className="hbtn mini" disabled={busy || dirty} onClick={onRewrite}>{rewriteLabel}</button>}
          <button className="hbtn mini" title="切换到下一版（会立即设为当前版本）"
            disabled={draftReplacingDisabled || !canNext(versioned)} onClick={() => onMove(1)}>下一版 ▶</button>
          {!streaming && <button className="hbtn mini" title="保存（Ctrl/⌘+S）"
            disabled={disabled || !dirty}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => saveDraft(true)}>💾 {busy && dirty ? '保存中…' : '保存'}</button>}
          {!streaming && dirty && (confirmDiscard
            ? <button className="hbtn mini accent" disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={discardDraft}>确认放弃？</button>
            : <button className="hbtn mini" disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setConfirmDiscard(true)}>↺ 放弃修改</button>)}
          {confirmClear
            ? <button className="hbtn mini accent" disabled={draftReplacingDisabled} onClick={() => { setConfirmClear(false); onClear(); }}>确认清空？</button>
            : <button className="hbtn mini" disabled={draftReplacingDisabled} onClick={() => setConfirmClear(true)}>🗑 删除</button>}
        </div>
      </div>
      {streaming
        ? <pre className="vbox-body">{streamingText}<span className="cursor">▎</span></pre>
        : <textarea className="vbox-body editor" aria-label={`${title}内容`}
            maxLength={200000} value={draft}
            disabled={busy}
            onChange={(e) => {
              const nextDraft = e.target.value;
              reportDirty(nextDraft !== cur);
              setDraftState((state) => ({
                ...state,
                draft: nextDraft,
                conflict: state.conflict && nextDraft !== cur,
              }));
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                saveDraft(true);
              }
            }}
            onBlur={() => saveDraft(false)} />}
      <div className="vbox-foot">
        <span className={dirty ? 'draft-dirty' : ''} role={conflict && dirty ? 'alert' : undefined}>
          {conflict && dirty
            ? '服务器内容已变化，草稿已保留；请检查后手动保存'
            : dirty ? (busy ? '正在保存…' : '有未保存修改') : '已保存'}
        </span>
        <span>{versionLabel(versioned)}{versioned.versions.length > 1 ? ' · 切换后立即生效' : ''}</span>
      </div>
    </section>
  );
}

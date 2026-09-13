import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { saveChapterPlanWithReconciliation } from '../app-workflows';
import type { StoryEngine, StoryEngineInput } from '../types';
import { useDirtyReporter } from '../useDirtyReporter';

const FIELDS: Array<{
  key: keyof StoryEngineInput;
  label: string;
  placeholder: string;
}> = [
  {
    key: 'readerExperience', label: '读者反复期待什么',
    placeholder: '例如：看一粒文明火种在绝境中产生意外进化，并改变现实。',
  },
  {
    key: 'protagonistAction', label: '主角反复做什么',
    placeholder: '例如：在有限资源下观察、推演并选择是否干预文明。',
  },
  {
    key: 'progression', label: '每轮获得什么进展',
    placeholder: '可见的能力、资源、权限、关系或认知提升。',
  },
  {
    key: 'cost', label: '每轮付出什么代价',
    placeholder: '行动造成的损失、风险、道德债务或现实反噬。',
  },
  {
    key: 'escalation', label: '循环如何持续升级',
    placeholder: '下一轮怎样改变条件、扩大选择难度，而不是重复同一桥段。',
  },
];

export const storyEngineInput = (engine: StoryEngine): StoryEngineInput => ({
  readerExperience: engine.readerExperience,
  protagonistAction: engine.protagonistAction,
  progression: engine.progression,
  cost: engine.cost,
  escalation: engine.escalation,
});

export const storyEngineDraftIsDirty = (
  draft: StoryEngineInput, engine: StoryEngine,
) => FIELDS.some(({ key }) => draft[key].trim() !== engine[key]);

export function adoptIncomingStoryEngineDraft(
  current: StoryEngineInput, engine: StoryEngine, incoming: StoryEngineInput,
) {
  return storyEngineDraftIsDirty(current, engine)
    ? { draft: current, applied: false }
    : { draft: incoming, applied: true };
}

export function StoryEngineCard({
  bookId, engine, disabled = false, incomingFill, onRefresh, onSaved, onDirtyChange,
}: {
  bookId: string;
  engine: StoryEngine;
  disabled?: boolean;
  incomingFill?: { token: number; storyEngine: StoryEngineInput };
  onRefresh: () => Promise<void>;
  onSaved?: (saved: StoryEngine) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => storyEngineInput(engine));
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [autoSaveNonce, setAutoSaveNonce] = useState(0);
  const previousEngine = useRef(engine);
  const lastAutoSaveNonce = useRef(0);
  const draftRef = useRef(draft);
  const incomingToken = useRef(incomingFill?.token);
  const generationAbort = useRef<AbortController | null>(null);
  const dirty = storyEngineDraftIsDirty(draft, engine);
  draftRef.current = draft;
  const busy = disabled || saving || generating;

  useEffect(() => {
    setDraft((current) => storyEngineDraftIsDirty(current, previousEngine.current)
      ? current : storyEngineInput(engine));
    previousEngine.current = engine;
  }, [engine]);
  useEffect(() => {
    if (!incomingFill || incomingToken.current === incomingFill.token) return;
    incomingToken.current = incomingFill.token;
    const adopted = adoptIncomingStoryEngineDraft(
      draftRef.current, engine, incomingFill.storyEngine,
    );
    if (!adopted.applied) {
      setError('AI 核心循环候选已返回，但当前表单已有人工修改；已保留人工草稿，未自动覆盖。');
      return;
    }
    setDraft(adopted.draft);
    setAutoSaveNonce((value) => value + 1);
    setError('');
  }, [engine, incomingFill]);
  useDirtyReporter(dirty, onDirtyChange);
  useEffect(() => () => generationAbort.current?.abort(), []);

  const generate = async () => {
    if (busy || !onRefresh) return;
    const controller = new AbortController();
    generationAbort.current = controller;
    setGenerating(true);
    setError('');
    try {
      const result = await api.generateStoryEngineDraft(
        bookId, engine.revision, controller.signal,
      );
      if (controller.signal.aborted) return;
      if (result.baseRevision !== engine.revision) {
        setError('核心循环在生成期间已变化，草稿未覆盖；请刷新后重试。');
        return;
      }
      setDraft(result.storyEngine);
      setAutoSaveNonce((value) => value + 1);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '核心循环生成失败');
      }
    } finally {
      if (generationAbort.current === controller) {
        generationAbort.current = null;
        setGenerating(false);
      }
    }
  };

  const save = async () => {
    if (!dirty || busy) return;
    lastAutoSaveNonce.current = autoSaveNonce;
    setSaving(true);
    setError('');
    try {
      await saveChapterPlanWithReconciliation({
        save: () => api.saveStoryEngine(bookId, draft, engine.revision),
        refresh: onRefresh,
        isConflict: (saveError) => api.isApiErrorCode(saveError, 'STORY_ENGINE_CONFLICT'),
        onConflict: () => setError('另一页面已经修改核心循环；已刷新服务器版本，本地草稿仍保留。'),
        onConflictRefreshFailure: () => setError('核心循环已冲突且刷新失败；本地草稿仍保留。'),
        onAmbiguous: () => setError('保存结果未确认，已刷新磁盘状态；请核对后再操作。'),
        onAmbiguousRefreshFailure: () => setError('保存结果未确认且刷新失败；请返回书架核对。'),
        onSaved: (saved) => {
          setDraft(storyEngineInput(saved));
          previousEngine.current = saved;
          onSaved?.(saved);
        },
        onRefreshFailure: () => setError('核心循环已保存，但页面刷新失败；请重新打开本书。'),
        onSuccess: () => setError(''),
        // 保存接口已经返回完整的新核心循环；正常成功无需再拉取整本工作区。
        // 大型作品的全量刷新会让按钮长时间停在“保存中”，看起来像卡死。
        refreshAfterSave: false,
      });
    } catch (saveError) {
      setError((current) => current || (saveError instanceof Error
        ? saveError.message : '核心循环保存失败'));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!dirty || busy || autoSaveNonce <= lastAutoSaveNonce.current) return;
    const timer = window.setTimeout(() => {
      lastAutoSaveNonce.current = autoSaveNonce;
      void save();
    }, 900);
    return () => window.clearTimeout(timer);
  }, [autoSaveNonce, busy, dirty]);

  return (
    <section className="story-engine-card sketch-alt">
      <header>
        <div>
          <h3>作品核心循环</h3>
          <p>定义读者为什么愿意连续追读。它约束长期体验，不要求每章机械重复全部步骤。</p>
        </div>
        <span>{generating ? 'AI 填充中' : engine.isEmpty && !dirty ? '未定义' : dirty ? '未保存' : '已保存'}</span>
      </header>
      <div className="story-engine-ai">
        <p>不必先手填五项。AI 或人工修改会在停笔约 1 秒后自动保存；按钮可用于立即保存。</p>
        {generating
          ? <button className="hbtn" type="button" onClick={() => generationAbort.current?.abort()}>
              停止 AI 填充</button>
          : <button className="hbtn accent" type="button" disabled={busy}
              onClick={() => void generate()}>✨ AI 一键填充核心循环</button>}
      </div>
      <div className="story-engine-fields">
        {FIELDS.map((field) => (
          <label key={field.key}>{field.label}
            <textarea aria-label={field.label} disabled={busy}
              maxLength={500} value={draft[field.key]} placeholder={field.placeholder}
              onChange={(event) => {
                setDraft((current) => ({ ...current, [field.key]: event.target.value }));
                setAutoSaveNonce((value) => value + 1);
                setError('');
              }} />
          </label>
        ))}
      </div>
      {error && <p className="story-engine-error" role="alert">{error}</p>}
      <button className="hbtn primary" type="button"
        disabled={!dirty || busy} onClick={() => void save()}>
        {saving ? '自动保存中…' : '立即保存'}
      </button>
    </section>
  );
}

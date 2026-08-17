import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { saveChapterPlanWithReconciliation } from '../app-workflows';
import type { StoryEngine, StoryEngineInput } from '../types';

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

export function StoryEngineCard({
  bookId, engine, disabled = false, onRefresh, onDirtyChange,
}: {
  bookId: string;
  engine: StoryEngine;
  disabled?: boolean;
  onRefresh: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => storyEngineInput(engine));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const previousEngine = useRef(engine);
  const dirty = storyEngineDraftIsDirty(draft, engine);

  useEffect(() => {
    setDraft((current) => storyEngineDraftIsDirty(current, previousEngine.current)
      ? current : storyEngineInput(engine));
    previousEngine.current = engine;
  }, [engine]);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const save = async () => {
    if (!dirty || disabled || saving) return;
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
        },
        onRefreshFailure: () => setError('核心循环已保存，但页面刷新失败；请重新打开本书。'),
        onSuccess: () => setError(''),
      });
    } catch (saveError) {
      setError((current) => current || (saveError instanceof Error
        ? saveError.message : '核心循环保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="story-engine-card sketch-alt">
      <header>
        <div>
          <h3>作品核心循环</h3>
          <p>定义读者为什么愿意连续追读。它约束长期体验，不要求每章机械重复全部步骤。</p>
        </div>
        <span>{engine.isEmpty && !dirty ? '未定义' : dirty ? '未保存' : '已保存'}</span>
      </header>
      <div className="story-engine-fields">
        {FIELDS.map((field) => (
          <label key={field.key}>{field.label}
            <textarea aria-label={field.label} disabled={disabled || saving}
              maxLength={500} value={draft[field.key]} placeholder={field.placeholder}
              onChange={(event) => {
                setDraft((current) => ({ ...current, [field.key]: event.target.value }));
                setError('');
              }} />
          </label>
        ))}
      </div>
      {error && <p className="story-engine-error" role="alert">{error}</p>}
      <button className="hbtn primary" type="button"
        disabled={!dirty || disabled || saving} onClick={() => void save()}>
        {saving ? '保存中…' : '保存核心循环'}
      </button>
    </section>
  );
}

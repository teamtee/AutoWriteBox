import { useEffect, useRef, useState } from 'react';
import {
  extractBookNativeWritingAsset, getWritingAssets, isApiErrorCode,
  saveWritingAssetBookBinding,
} from '../api';
import type {
  WritingAssetBookBinding, WritingAssetLibrary, WritingAssetScene,
} from '../types';
import { createLatestAbortGate } from '../asyncAction';

const SCENE_LABELS: Record<WritingAssetScene, string> = {
  battle: '战斗', dialogue: '对话', mystery: '悬疑',
  romance: '感情', daily: '日常', climax: '高潮',
};

function emptyBinding(): WritingAssetBookBinding {
  return {
    nativeAssetId: null, primaryAssetId: null, auxiliaryAssetIds: [],
    sceneAssetIds: {}, chapterScenes: {},
  };
}

export function updateChapterSceneBinding(
  binding: WritingAssetBookBinding, chapterId: string, scene: WritingAssetScene | '',
): WritingAssetBookBinding {
  const chapterScenes = { ...binding.chapterScenes };
  if (scene) chapterScenes[chapterId] = scene;
  else delete chapterScenes[chapterId];
  return { ...binding, chapterScenes };
}

export function ChapterAssetSceneSelector({
  bookId, sectionId, chapterId, chapterIndex, chapterTitle, hasPublishedVersion,
  disabled = false, onContextChanged,
}: {
  bookId: string;
  sectionId: string;
  chapterId: string;
  chapterIndex: number;
  chapterTitle: string;
  hasPublishedVersion: boolean;
  disabled?: boolean;
  onContextChanged?: () => Promise<void>;
}) {
  const [library, setLibrary] = useState<WritingAssetLibrary | null>(null);
  const [saving, setSaving] = useState(false);
  const [extractingNative, setExtractingNative] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGate = useRef(createLatestAbortGate()).current;
  const actionGate = useRef(createLatestAbortGate()).current;
  const actionRunning = useRef(false);

  const reload = async ({ reportError = true } = {}) => {
    const { token, signal } = loadGate.begin();
    if (reportError) setError(null);
    try {
      const next = await getWritingAssets(signal);
      if (!loadGate.owns(token)) return false;
      setLibrary(next);
      setError(null);
      return true;
    } catch (reason) {
      if (!loadGate.owns(token) || signal.aborted) return false;
      if (reportError) setError(String(reason instanceof Error ? reason.message : reason));
      return false;
    }
  };

  useEffect(() => {
    actionGate.invalidate();
    actionRunning.current = false;
    setLibrary(null);
    setSaving(false);
    setExtractingNative(false);
    setError(null);
    void reload();
    return () => {
      loadGate.invalidate();
      actionGate.invalidate();
      actionRunning.current = false;
    };
  }, [bookId, sectionId, chapterId]);

  if (!library) {
    return <div className="chapter-asset-scene sketch-alt">{error ? <>
      <span className="error" role="alert">读取本章场景文风失败：{error}</span>
      <button className="hbtn" onClick={() => { void reload(); }}>重新读取</button>
    </> : '正在读取本章场景文风…'}</div>;
  }
  const binding = library.bookBindings?.[bookId] ?? emptyBinding();
  const configuredScenes = Object.keys(binding.sceneAssetIds) as WritingAssetScene[];
  const currentScene = binding.chapterScenes[chapterId] ?? '';

  const changeScene = async (scene: WritingAssetScene | '') => {
    if (actionRunning.current) return;
    actionRunning.current = true;
    const { token, signal } = actionGate.begin();
    setSaving(true);
    setError(null);
    try {
      const result = await saveWritingAssetBookBinding(
        bookId, updateChapterSceneBinding(binding, chapterId, scene), library.revision, signal,
      );
      if (!actionGate.owns(token)) return;
      setLibrary((current) => current ? {
        ...current,
        revision: result.revision,
        bookBindings: { ...(current.bookBindings ?? {}), [bookId]: result.binding },
      } : current);
      try {
        await onContextChanged?.();
      } catch {
        if (actionGate.owns(token)) {
          setError('场景文风已保存，但上下文体检刷新失败；请重新打开本章。');
        }
      }
    } catch (reason) {
      if (!actionGate.owns(token) || signal.aborted) return;
      if (isApiErrorCode(reason, 'ASSET_CONFLICT')) {
        await reload({ reportError: false });
      }
      if (actionGate.owns(token)) {
        setError(String(reason instanceof Error ? reason.message : reason));
      }
    } finally {
      if (actionGate.owns(token)) {
        actionRunning.current = false;
        setSaving(false);
      }
    }
  };

  const extractNative = async () => {
    if (actionRunning.current || !hasPublishedVersion) return;
    actionRunning.current = true;
    const { token, signal } = actionGate.begin();
    setExtractingNative(true);
    setError(null);
    try {
      const created = await extractBookNativeWritingAsset(
        bookId, sectionId, chapterId,
        `本书原生·第 ${chapterIndex} 章${chapterTitle ? `·${chapterTitle}` : ''}`,
        signal,
      );
      if (!actionGate.owns(token)) return;
      const refreshed = await getWritingAssets(signal);
      if (!actionGate.owns(token)) return;
      const latestBinding = refreshed.bookBindings?.[bookId] ?? emptyBinding();
      const bound = await saveWritingAssetBookBinding(bookId, {
        ...latestBinding, nativeAssetId: created.asset.id,
      }, refreshed.revision, signal);
      if (!actionGate.owns(token)) return;
      setLibrary({
        ...refreshed,
        revision: bound.revision,
        bookBindings: { ...(refreshed.bookBindings ?? {}), [bookId]: bound.binding },
      });
      try {
        await onContextChanged?.();
      } catch {
        if (actionGate.owns(token)) {
          setError('原生文风已绑定，但上下文体检刷新失败；请重新打开本章。');
        }
      }
    } catch (reason) {
      if (!actionGate.owns(token) || signal.aborted) return;
      const message = String(reason instanceof Error ? reason.message : reason);
      await reload({ reportError: false });
      if (actionGate.owns(token)) setError(message);
    } finally {
      if (actionGate.owns(token)) {
        actionRunning.current = false;
        setExtractingNative(false);
      }
    }
  };

  return (
    <section className="chapter-asset-scene sketch-alt">
      <div><strong>本章场景文风</strong><span>只影响已绑定的场景资产；主文风与辅助文风始终按本书绑定使用。</span></div>
      {configuredScenes.length ? <select aria-label="本章场景文风" disabled={disabled || saving || extractingNative}
        value={currentScene} onChange={(event) => { void changeScene(event.target.value as WritingAssetScene | ''); }}>
        <option value="">不使用场景资产</option>
        {configuredScenes.map((scene) => <option key={scene} value={scene}>{SCENE_LABELS[scene]}</option>)}
      </select> : <span>尚未在“核心设定 → 创作资产库”配置场景资产。</span>}
      <button className="hbtn" disabled={disabled || saving || extractingNative || !hasPublishedVersion}
        title={hasPublishedVersion ? '已发布正文会发送到当前摘要模型，提取后自动设为本书原生文风' : '请先确认发布本章正文'}
        onClick={() => { void extractNative(); }}>
        {extractingNative ? '提取原生文风中…' : '从已发布版提取原生文风'}
      </button>
      {error && <span className="error" role="alert">{error}</span>}
    </section>
  );
}

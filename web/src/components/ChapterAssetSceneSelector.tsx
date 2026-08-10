import { useEffect, useState } from 'react';
import {
  extractBookNativeWritingAsset, getWritingAssets, isApiErrorCode,
  saveWritingAssetBookBinding,
} from '../api';
import type {
  WritingAssetBookBinding, WritingAssetLibrary, WritingAssetScene,
} from '../types';

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

export function ChapterAssetSceneSelector({
  bookId, sectionId, chapterId, chapterIndex, chapterTitle, hasPublishedVersion,
  disabled = false,
}: {
  bookId: string;
  sectionId: string;
  chapterId: string;
  chapterIndex: number;
  chapterTitle: string;
  hasPublishedVersion: boolean;
  disabled?: boolean;
}) {
  const [library, setLibrary] = useState<WritingAssetLibrary | null>(null);
  const [saving, setSaving] = useState(false);
  const [extractingNative, setExtractingNative] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async (signal?: AbortSignal) => {
    const next = await getWritingAssets(signal);
    setLibrary(next);
    setError(null);
  };

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal).catch((reason) => {
      if (!controller.signal.aborted) setError(String(reason?.message ?? reason));
    });
    return () => controller.abort();
  }, [bookId, chapterId]);

  if (!library) {
    return <div className="chapter-asset-scene sketch-alt">正在读取本章场景文风…{error && ` ${error}`}</div>;
  }
  const binding = library.bookBindings?.[bookId] ?? emptyBinding();
  const configuredScenes = Object.keys(binding.sceneAssetIds) as WritingAssetScene[];
  const currentScene = binding.chapterScenes[chapterId] ?? '';

  const changeScene = async (scene: WritingAssetScene | '') => {
    if (saving) return;
    const chapterScenes = { ...binding.chapterScenes };
    if (scene) chapterScenes[chapterId] = scene;
    else delete chapterScenes[chapterId];
    setSaving(true);
    setError(null);
    try {
      const result = await saveWritingAssetBookBinding(
        bookId, { ...binding, chapterScenes }, library.revision,
      );
      setLibrary({
        ...library,
        revision: result.revision,
        bookBindings: { ...(library.bookBindings ?? {}), [bookId]: result.binding },
      });
    } catch (reason) {
      if (isApiErrorCode(reason, 'ASSET_CONFLICT')) {
        try { await reload(); } catch { /* 保留原始提示 */ }
      }
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  };

  const extractNative = async () => {
    if (extractingNative || !hasPublishedVersion) return;
    setExtractingNative(true);
    setError(null);
    try {
      const created = await extractBookNativeWritingAsset(
        bookId, sectionId, chapterId,
        `本书原生·第 ${chapterIndex} 章${chapterTitle ? `·${chapterTitle}` : ''}`,
      );
      const refreshed = await getWritingAssets();
      const latestBinding = refreshed.bookBindings?.[bookId] ?? emptyBinding();
      const bound = await saveWritingAssetBookBinding(bookId, {
        ...latestBinding, nativeAssetId: created.asset.id,
      }, refreshed.revision);
      setLibrary({
        ...refreshed,
        revision: bound.revision,
        bookBindings: { ...(refreshed.bookBindings ?? {}), [bookId]: bound.binding },
      });
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
      try { await reload(); } catch { /* 保留提取错误 */ }
    } finally {
      setExtractingNative(false);
    }
  };

  return (
    <section className="chapter-asset-scene sketch-alt">
      <div><strong>本章场景文风</strong><span>只影响已绑定的场景资产；主文风与辅助文风始终按本书绑定使用。</span></div>
      {configuredScenes.length ? <select aria-label="本章场景文风" disabled={disabled || saving}
        value={currentScene} onChange={(event) => { void changeScene(event.target.value as WritingAssetScene | ''); }}>
        <option value="">不使用场景资产</option>
        {configuredScenes.map((scene) => <option key={scene} value={scene}>{SCENE_LABELS[scene]}</option>)}
      </select> : <span>尚未在“核心设定 → 创作资产库”配置场景资产。</span>}
      <button className="hbtn" disabled={disabled || extractingNative || !hasPublishedVersion}
        title={hasPublishedVersion ? '已发布正文会发送到当前摘要模型，提取后自动设为本书原生文风' : '请先确认发布本章正文'}
        onClick={() => { void extractNative(); }}>
        {extractingNative ? '提取原生文风中…' : '从已发布版提取原生文风'}
      </button>
      {error && <span className="error" role="alert">{error}</span>}
    </section>
  );
}

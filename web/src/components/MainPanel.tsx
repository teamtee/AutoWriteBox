import { useState } from 'react';
import type { BookTree, Chapter, PlatformConfirmationInput } from '../types';
import type { Selection } from '../store';
import { formatIndexedTitle } from '../titles';
import { VersionedBox } from './VersionedBox';
import { ChapterReviewCard } from './ChapterReviewCard';
import { currentText, isChapterReviewStale } from '../versioned';
import { LoadingState } from './LoadingState';
import { WritingAssetPanel } from './WritingAssetPanel';
import { MemoryCandidateCard } from './MemoryCandidateCard';
import { MemoryLibraryPanel } from './MemoryLibraryPanel';
import { BookModelBindingPanel } from './BookModelBindingPanel';
import { ChapterPublicationCard } from './ChapterPublicationCard';
import { ChapterAssetSceneSelector } from './ChapterAssetSceneSelector';
import { MemoryRecomputeCard } from './MemoryRecomputeCard';
import { SerializationPanel } from './SerializationPanel';

// core 字段元信息
const CORE_FIELDS: { field: 'world' | 'style' | 'constraints' | 'pacing'; label: string }[] = [
  { field: 'world', label: '世界观' }, { field: 'style', label: '文风基调' },
  { field: 'constraints', label: '禁忌约束' }, { field: 'pacing', label: '篇幅节奏' },
];

// 主区域：三种视图（全书大纲 / 核心设定 / 章节）统一改用 VersionedBox
export function MainPanel({ tree, selection, chapter, chapterLoading = false, streaming, versionBusy = false, streamingText, streamingPath, onMove, onRewrite, onClear, onSave, onStop, onDraftDirtyChange, reviewing, reviewDisabled = false, onReview, onStopReview, onUseSuggestion, onOpenMemorySource, onSaveDailyWordGoal, onSavePlatformConfirmation, onDeletePlatformConfirmation, publishing = false, onPublishChapter, memoryRecomputing = false, onRecomputeMemory }: {
  tree: BookTree; selection: Selection; chapter?: Chapter | null; chapterLoading?: boolean;
  streaming: boolean; versionBusy?: boolean; streamingText: string; streamingPath: string | null;
  onMove: (path: string, delta: number) => void;
  onRewrite: (path: string) => void;
  onClear: (path: string) => void;
  onSave: (path: string, text: string) => void;
  onStop: () => void;
  onDraftDirtyChange?: (path: string, dirty: boolean) => void;
  reviewing?: boolean;
  reviewDisabled?: boolean;
  onReview?: () => void;
  onStopReview?: () => void;
  onUseSuggestion?: (instruction: string) => void;
  onOpenMemorySource?: (sectionId: string, chapterId: string) => void;
  onSaveDailyWordGoal?: (goal: number) => Promise<void>;
  onSavePlatformConfirmation?: (input: PlatformConfirmationInput) => Promise<boolean>;
  onDeletePlatformConfirmation?: (id: string) => Promise<boolean>;
  publishing?: boolean;
  onPublishChapter?: () => void;
  memoryRecomputing?: boolean;
  onRecomputeMemory?: () => void;
}) {
  const [styleDirty, setStyleDirty] = useState(false);
  const [styleDraftRequest, setStyleDraftRequest] = useState<{ token: number; text: string }>();
  // 把 path 相关的回调打包给 VersionedBox（大纲 / core 使用）
  const boxProps = (path: string) => ({
    streaming: streaming && streamingPath === path,
    busy: versionBusy,
    streamingText: streaming && streamingPath === path ? streamingText : '',
    onMove: (d: number) => onMove(path, d),
    onRewrite: () => onRewrite(path),
    onClear: () => onClear(path),
    onSave: (t: string) => onSave(path, t),
    onStop,
    onDirtyChange: (dirty: boolean) => {
      if (path === 'core:style') setStyleDirty(dirty);
      onDraftDirtyChange?.(path, dirty);
    },
  });

  if (selection.kind === 'outline') {
    return <main className="main"><VersionedBox title="全书大纲" versioned={tree.book.outline} size="lg" {...boxProps('outline')} /></main>;
  }

  if (selection.kind === 'core') {
    return (
      <main className="main">
        <BookModelBindingPanel
          bookId={tree.book.id}
          disabled={streaming || versionBusy || !!reviewing} />
        <WritingAssetPanel
          bookId={tree.book.id}
          applyDisabled={styleDirty || versionBusy || streaming}
          onApplyStyle={(asset) => {
            const stylePrompt = asset.style?.prompt;
            if (styleDirty || versionBusy || streaming || !stylePrompt) return false;
            setStyleDraftRequest((current) => ({
              token: (current?.token ?? 0) + 1,
              text: stylePrompt,
            }));
            return true;
          }} />
        <MemoryLibraryPanel
          bookId={tree.book.id}
          sections={tree.sections}
          completedChapterCount={tree.sections.reduce(
            (total, section) => total + section.chapters.filter((item) => item.hasContent).length,
            0,
          )}
          canOpenSource={(sectionId, chapterId) => tree.sections.some(
            (section) => section.id === sectionId
              && section.chapters.some((item) => item.id === chapterId),
          )}
          sourceLabel={(sectionId, chapterId, chapterIndex) => {
            const section = tree.sections.find((item) => item.id === sectionId);
            const chapterItem = section?.chapters.find((item) => item.id === chapterId);
            return section && chapterItem
              ? `${formatIndexedTitle(section.index, '部', section.title)} · ${formatIndexedTitle(chapterItem.index, '章', chapterItem.title)}`
              : `${sectionId} · 第 ${chapterIndex} 章（来源已删除）`;
          }}
          onOpenSource={onOpenMemorySource} />
        {CORE_FIELDS.map(({ field, label }) => (
          <VersionedBox key={field} title={label} versioned={tree.book.settings.core[field]}
            size="sm" incomingDraft={field === 'style' ? styleDraftRequest : undefined}
            {...boxProps(`core:${field}`)} />
        ))}
      </main>
    );
  }

  if (selection.kind === 'serialization') {
    return <SerializationPanel
      tree={tree}
      disabled={streaming || versionBusy || !!reviewing}
      onSaveDailyWordGoal={onSaveDailyWordGoal ?? (async () => {})}
      onSavePlatformConfirmation={onSavePlatformConfirmation ?? (async () => false)}
      onDeletePlatformConfirmation={onDeletePlatformConfirmation ?? (async () => false)}
      onOpenChapter={(sectionId, chapterId) => onOpenMemorySource?.(sectionId, chapterId)} />;
  }

  if (chapterLoading) {
    return <main className="main"><LoadingState label="正在加载章节" /></main>;
  }
  if (!chapter) {
    return <main className="main"><div className="empty-hint big">章节尚未加载。请在左侧重新选择；若持续失败，请返回书架查看数据完整性告警。</div></main>;
  }
  const path = `section:${selection.sectionId}:chapter:${selection.chapterId}`;
  const chapterEmpty = !currentText(chapter.body).trim();
  // 章节任意生成用 'chapter' 哨兵，与 App 中章节生成保持一致
  const chStreaming = streaming && streamingPath === 'chapter';
  return (
    <main className="main">
      <ChapterAssetSceneSelector
        bookId={tree.book.id}
        sectionId={selection.sectionId}
        chapterId={selection.chapterId}
        chapterIndex={chapter.index}
        chapterTitle={chapter.title}
        hasPublishedVersion={!!chapter.published}
        disabled={streaming || versionBusy || !!reviewing} />
      <VersionedBox key={path} title={formatIndexedTitle(chapter.index, '章', chapter.title)} versioned={chapter.body} size="lg"
        rewriteLabel={chapterEmpty ? '✍️ 生成本章' : '🔄 重写'}
        streaming={chStreaming} busy={versionBusy} streamingText={chStreaming ? streamingText : ''}
        onMove={(d) => onMove(path, d)} onRewrite={() => onRewrite(path)}
        onClear={() => onClear(path)} onSave={(t) => onSave(path, t)} onStop={onStop}
        onDirtyChange={(dirty) => onDraftDirtyChange?.(path, dirty)} />
      {onPublishChapter && <ChapterPublicationCard
        bookId={tree.book.id}
        sectionId={selection.sectionId}
        chapter={chapter}
        disabled={reviewDisabled || versionBusy || streaming}
        publishing={publishing}
        onPublish={onPublishChapter} />}
      {onRecomputeMemory && <MemoryRecomputeCard
        bodyFingerprint={chapter.bodyFingerprint}
        recomputing={memoryRecomputing}
        disabled={reviewDisabled || versionBusy || streaming || chapterEmpty}
        onRecompute={onRecomputeMemory} />}
      {!!chapter.memoryCandidates?.length && chapter.memoryRevision && (
        <MemoryCandidateCard
          bookId={tree.book.id}
          sectionId={selection.sectionId}
          chapterId={selection.chapterId}
          bodyFingerprint={chapter.bodyFingerprint}
          initialMemoryRevision={chapter.memoryRevision}
          initialCandidates={chapter.memoryCandidates}
          confirmationBlocked={Boolean(chapter.published && !chapter.published.isCurrent)} />
      )}
      {onReview && onUseSuggestion && (
        <ChapterReviewCard
          review={chapter.review}
          stale={chapter.review ? isChapterReviewStale(chapter.review, chapter) : false}
          reviewing={!!reviewing}
          empty={chapterEmpty}
          disabled={reviewDisabled}
          onReview={() => onReview()}
          onStopReview={onStopReview}
          onUseSuggestion={(inst) => onUseSuggestion(inst)} />
      )}
    </main>
  );
}

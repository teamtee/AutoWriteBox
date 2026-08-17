import { useState } from 'react';
import type {
  BookTree, Chapter, ChapterPlan, ChapterPlanInput, PlatformConfirmationInput,
} from '../types';
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
import { ChapterPlanCard } from './ChapterPlanCard';
import { StoryEngineCard } from './StoryEngineCard';
import { PromiseLedgerCard } from './PromiseLedgerCard';
import { CharacterCraftCard } from './CharacterCraftCard';
import { GoldenThreeReviewCard } from './GoldenThreeReviewCard';
import { ChapterRevisionPipelineCard } from './ChapterRevisionPipelineCard';
import { ChapterContextManifestCard } from './ChapterContextManifestCard';
import { WorldBibleDiagnosticsCard } from './WorldBibleDiagnosticsCard';
import { StyleBibleDiagnosticsCard } from './StyleBibleDiagnosticsCard';
import { ChapterReviewRevisionCard } from './ChapterReviewRevisionCard';
import { ChapterReviewPromiseCandidatesCard } from './ChapterReviewPromiseCandidatesCard';
import { ChapterReviewWorldGateCard } from './ChapterReviewWorldGateCard';
import {
  generateChapterPlanDraft, generateChapterReviewRevisionCandidate,
  generateChapterRevisionCandidate, verifyChapterReviewRevisionCandidate,
} from '../api';

// core 字段元信息
const CORE_FIELDS: { field: 'world' | 'style' | 'constraints' | 'pacing'; label: string }[] = [
  { field: 'world', label: '世界观 / 世界圣经' }, { field: 'style', label: '文风基调' },
  { field: 'constraints', label: '禁忌约束' }, { field: 'pacing', label: '篇幅节奏' },
];

// 主区域：三种视图（全书大纲 / 核心设定 / 章节）统一改用 VersionedBox
export function MainPanel({ tree, selection, chapter, chapterLoading = false, streaming, versionBusy = false, streamingText, streamingPath, onMove, onRewrite, onClear, onSave, onStop, onDraftDirtyChange, onSaveChapterPlan, onRefreshBook, reviewing, reviewKind, reviewDisabled = false, onReview, onGoldenThreeReview, onStopReview, onUseSuggestion, onOpenMemorySource, onSaveDailyWordGoal, onSavePlatformConfirmation, onDeletePlatformConfirmation, publishing = false, onPublishChapter, memoryRecomputing = false, onRecomputeMemory }: {
  tree: BookTree; selection: Selection; chapter?: Chapter | null; chapterLoading?: boolean;
  streaming: boolean; versionBusy?: boolean; streamingText: string; streamingPath: string | null;
  onMove: (path: string, delta: number) => void;
  onRewrite: (path: string) => void;
  onClear: (path: string) => void;
  onSave: (path: string, text: string) => void;
  onStop: () => void;
  onDraftDirtyChange?: (path: string, dirty: boolean) => void;
  onSaveChapterPlan?: (
    plan: ChapterPlanInput, expectedRevision: string,
  ) => Promise<ChapterPlan>;
  onRefreshBook?: () => Promise<void>;
  reviewing?: boolean;
  reviewKind?: 'chapter' | 'golden-three' | null;
  reviewDisabled?: boolean;
  onReview?: () => void;
  onGoldenThreeReview?: () => void;
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
  const [revisionDraftRequest, setRevisionDraftRequest] = useState<{
    token: number; path: string; text: string;
  }>();
  const activeReviewKind = reviewKind ?? (reviewing ? 'chapter' : null);
  const completedChapterCount = tree.sections.reduce(
    (total, section) => total + section.chapters.filter((item) => item.hasContent).length,
    0,
  );
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
        <StoryEngineCard
          bookId={tree.book.id}
          engine={tree.book.settings.storyEngine}
          disabled={streaming || versionBusy || !!reviewing}
          onRefresh={onRefreshBook ?? (async () => {})}
          onDirtyChange={(dirty) => onDraftDirtyChange?.('story-engine', dirty)} />
        <PromiseLedgerCard
          bookId={tree.book.id}
          completedChapterCount={completedChapterCount}
          disabled={streaming || versionBusy || !!reviewing}
          onDirtyChange={(dirty) => onDraftDirtyChange?.('promise-ledger', dirty)} />
        <CharacterCraftCard
          bookId={tree.book.id}
          completedChapterCount={completedChapterCount}
          disabled={streaming || versionBusy || !!reviewing}
          onDirtyChange={(dirty) => onDraftDirtyChange?.('character-craft', dirty)} />
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
          completedChapterCount={completedChapterCount}
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
        {tree.book.settings.worldBibleDiagnostics && <WorldBibleDiagnosticsCard
          diagnostics={tree.book.settings.worldBibleDiagnostics} />}
        {tree.book.settings.styleBibleDiagnostics && <StyleBibleDiagnosticsCard
          diagnostics={tree.book.settings.styleBibleDiagnostics} />}
        {CORE_FIELDS.map(({ field, label }) => (
          <VersionedBox key={field} title={label} versioned={tree.book.settings.core[field]}
            size={field === 'world' || field === 'style' ? 'lg' : 'sm'}
            rewriteLabel={field === 'world' ? '🌍 API 重构世界圣经'
              : field === 'style' ? '🖋 API 重构文风圣经' : '🔄 重写'}
            incomingDraft={field === 'style' ? styleDraftRequest : undefined}
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
  // 策划留白不禁用生成：未填栏目会作为“由你决定”的上下文交给模型。
  // 按钮只提示状态，作者自行决定是先补策划还是先看一版正文。
  const planIncompleteFirstDraft = chapterEmpty && !chapter.plan.readiness?.ready;
  // 章节任意生成用 'chapter' 哨兵，与 App 中章节生成保持一致
  const chStreaming = streaming && streamingPath === 'chapter';
  return (
    <main className="main">
      {onSaveChapterPlan && <ChapterPlanCard key={`chapter-plan:${path}`}
        plan={chapter.plan}
        incomingPlanCarryover={chapter.incomingPlanCarryover}
        promiseActions={chapter.promiseActions}
        disabled={streaming || versionBusy || !!reviewing}
        onSave={onSaveChapterPlan}
        onGenerateDraft={(seedPlan, expectedPlanRevision, signal) =>
          generateChapterPlanDraft(
            tree.book.id, selection.sectionId, selection.chapterId,
            seedPlan, expectedPlanRevision, signal,
          )}
        onDirtyChange={(dirty) => onDraftDirtyChange?.(`chapter-plan:${path}`, dirty)} />}
      {chapter.contextManifest && <ChapterContextManifestCard
        manifest={chapter.contextManifest} />}
      <ChapterAssetSceneSelector key={`asset-scene:${path}`}
        bookId={tree.book.id}
        sectionId={selection.sectionId}
        chapterId={selection.chapterId}
        chapterIndex={chapter.index}
        chapterTitle={chapter.title}
        hasPublishedVersion={!!chapter.published}
        disabled={streaming || versionBusy || !!reviewing}
        onContextChanged={onRefreshBook} />
      {!chapterEmpty && chapter.reviewContextRevision && <ChapterRevisionPipelineCard
        key={`chapter-revision:${path}`}
        bodyFingerprint={chapter.bodyFingerprint}
        contextRevision={chapter.reviewContextRevision}
        currentText={currentText(chapter.body)}
        disabled={reviewDisabled || streaming || versionBusy || !!reviewing}
        onGenerate={(stage, bodyFingerprint, contextRevision, signal) =>
          generateChapterRevisionCandidate(
            tree.book.id, selection.sectionId, selection.chapterId, stage,
            bodyFingerprint, contextRevision, signal,
          )}
        onAdopt={(text) => setRevisionDraftRequest((current) => ({
          token: (current?.token ?? 0) + 1, path, text,
        }))}
        onDirtyChange={(dirty) => onDraftDirtyChange?.(`chapter-revision:${path}`, dirty)} />}
      <VersionedBox key={path} title={formatIndexedTitle(chapter.index, '章', chapter.title)} versioned={chapter.body} size="lg"
        rewriteLabel={planIncompleteFirstDraft ? '✍️ 生成本章（策划有留白）' : chapterEmpty ? '✍️ 生成本章' : '🔄 重写'}
        streaming={chStreaming} busy={versionBusy} streamingText={chStreaming ? streamingText : ''}
        onMove={(d) => onMove(path, d)} onRewrite={() => onRewrite(path)}
        onClear={() => onClear(path)} onSave={(t) => onSave(path, t)} onStop={onStop}
        incomingDraft={revisionDraftRequest?.path === path ? revisionDraftRequest : undefined}
        onDirtyChange={(dirty) => onDraftDirtyChange?.(path, dirty)} />
      {onPublishChapter && <ChapterPublicationCard
        key={`publication:${path}:${chapter.bodyFingerprint}`}
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
      {chapter.goldenThreeReviewState && onGoldenThreeReview && (
        <GoldenThreeReviewCard state={chapter.goldenThreeReviewState}
          reviewing={!!reviewing && activeReviewKind === 'golden-three'}
          disabled={reviewDisabled || (!!reviewing && activeReviewKind !== 'golden-three')}
          onReview={onGoldenThreeReview} onStopReview={onStopReview}
          onOpenChapter={onOpenMemorySource} />
      )}
      {onReview && onUseSuggestion && (
        <ChapterReviewCard
          review={chapter.review}
          stale={chapter.review ? isChapterReviewStale(chapter.review, chapter) : false}
          reviewing={!!reviewing && activeReviewKind === 'chapter'}
          empty={chapterEmpty}
          disabled={reviewDisabled || (!!reviewing && activeReviewKind !== 'chapter')}
          onReview={() => onReview()}
          onStopReview={onStopReview}
          onUseSuggestion={(inst) => onUseSuggestion(inst)} />
      )}
      {!chapterEmpty && chapter.review?.promiseLedgerCandidates?.some((candidate) => candidate.beat)
        && chapter.reviewRevision && chapter.promiseLedgerRevision
        && !isChapterReviewStale(chapter.review, chapter) && (
        <ChapterReviewPromiseCandidatesCard
          key={`review-promise:${path}:${chapter.reviewRevision}`}
          bookId={tree.book.id}
          sectionId={selection.sectionId}
          chapterId={selection.chapterId}
          candidates={chapter.review.promiseLedgerCandidates.filter((candidate) => candidate.beat)}
          bodyFingerprint={chapter.bodyFingerprint}
          reviewRevision={chapter.reviewRevision}
          initialPromiseLedgerRevision={chapter.promiseLedgerRevision}
          disabled={reviewDisabled || streaming || versionBusy || !!reviewing} />
      )}
      {!chapterEmpty && chapter.review?.worldGateCandidates?.length
        && chapter.reviewRevision && chapter.worldProgressRevision
        && !isChapterReviewStale(chapter.review, chapter) && (
        <ChapterReviewWorldGateCard
          key={`review-world-gate:${path}:${chapter.reviewRevision}`}
          bookId={tree.book.id}
          sectionId={selection.sectionId}
          chapterId={selection.chapterId}
          candidate={chapter.review.worldGateCandidates[0]}
          bodyFingerprint={chapter.bodyFingerprint}
          reviewRevision={chapter.reviewRevision}
          initialWorldProgressRevision={chapter.worldProgressRevision}
          onConfirmed={onRefreshBook}
          disabled={reviewDisabled || streaming || versionBusy || !!reviewing} />
      )}
      {!chapterEmpty && chapter.review && chapter.reviewRevision && chapter.reviewContextRevision
        && !isChapterReviewStale(chapter.review, chapter) && <ChapterReviewRevisionCard
          key={`review-revision:${path}:${chapter.reviewRevision}`}
          review={chapter.review}
          reviewRevision={chapter.reviewRevision}
          bodyFingerprint={chapter.bodyFingerprint}
          contextRevision={chapter.reviewContextRevision}
          currentText={currentText(chapter.body)}
          disabled={reviewDisabled || streaming || versionBusy || !!reviewing}
          onGenerate={(bodyFingerprint, contextRevision, reviewRevision, signal) =>
            generateChapterReviewRevisionCandidate(
              tree.book.id, selection.sectionId, selection.chapterId,
              bodyFingerprint, contextRevision, reviewRevision, signal,
            )}
          onVerify={(candidate, bodyFingerprint, contextRevision, reviewRevision, signal) =>
            verifyChapterReviewRevisionCandidate(
              tree.book.id, selection.sectionId, selection.chapterId, candidate,
              bodyFingerprint, contextRevision, reviewRevision, signal,
            )}
          onAdopt={(text) => setRevisionDraftRequest((current) => ({
            token: (current?.token ?? 0) + 1, path, text,
          }))}
          onDirtyChange={(dirty) => onDraftDirtyChange?.(`review-revision:${path}`, dirty)} />}
    </main>
  );
}

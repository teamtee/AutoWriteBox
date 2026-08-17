import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChapterReview, ChapterReviewRevisionCandidateResult } from '../types';
import {
  chapterReviewRevisionRiskCount, ChapterReviewRevisionCard,
  reviewRevisionCandidateIsCurrent, reviewRevisionVerificationIsConsistent,
  reviewRevisionVerificationRisks,
} from './ChapterReviewRevisionCard';

const review: ChapterReview = {
  score: 70, verdict: '场景断链', issues: [], suggestions: [],
  webFictionChecks: [
    { id: 'sceneExecution', status: 'risk', detail: '后场不承接前场。' },
    { id: 'contentRisk', status: 'risk', detail: '作者核对。' },
    { id: 'chapterGoal', status: 'pass', detail: '目标明确。' },
  ],
  planComparison: {
    overall: 'partial', summary: '部分落地',
    items: [{ target: 'scene-1', outcome: 'missed', evidence: '只被概述。' }],
    carryovers: [],
  },
  sourceCursor: 0, sourceFingerprint: 'B'.repeat(43),
  sourceContextRevision: 'C'.repeat(43), updatedAt: '2026-08-12T12:00:00.000Z',
};
const candidate: ChapterReviewRevisionCandidateResult = {
  candidate: '完整精修正文', changed: true,
  sourceBodyFingerprint: 'B'.repeat(43), sourceContextRevision: 'C'.repeat(43),
  sourceReviewRevision: 'R'.repeat(43), candidateFingerprint: 'V'.repeat(43),
};

describe('ChapterReviewRevisionCard', () => {
  it('只统计可由正文模型处理的审稿风险并声明不自动覆盖', () => {
    expect(chapterReviewRevisionRiskCount(review)).toBe(2);
    const html = renderToStaticMarkup(<ChapterReviewRevisionCard
      review={review} bodyFingerprint={'B'.repeat(43)} contextRevision={'C'.repeat(43)}
      reviewRevision={'R'.repeat(43)}
      currentText="正文" onGenerate={vi.fn()} onVerify={vi.fn()} onAdopt={vi.fn()} />);
    expect(html).toContain('API 审稿 → 定向精修');
    expect(html).toContain('2 项正文风险');
    expect(html).toContain('不自动覆盖正文');
    expect(html).toContain('内容合规风险不会被模型擅自删改');
    expect(html).toContain('候选必须先通过复审');
  });

  it('复审失败依据排除人工内容风险并保留正文引文与策划缺口', () => {
    const risks = reviewRevisionVerificationRisks(review);
    expect(risks.checks.map((item) => item.id)).toEqual(['sceneExecution']);
    expect(risks.planItems.map((item) => item.target)).toEqual(['scene-1']);
  });

  it('拒绝风险汇总与复审明细漂移', () => {
    const base = {
      review, remainingRiskCount: 1, remainingPlanRiskCount: 1, verified: false,
      candidateFingerprint: 'V'.repeat(43), sourceBodyFingerprint: 'B'.repeat(43),
      sourceContextRevision: 'C'.repeat(43), sourceReviewRevision: 'R'.repeat(43),
    };
    expect(reviewRevisionVerificationIsConsistent(base, candidate)).toBe(true);
    expect(reviewRevisionVerificationIsConsistent({
      ...base, sourceContextRevision: 'X'.repeat(43),
    }, candidate)).toBe(false);
    expect(reviewRevisionVerificationIsConsistent({
      ...base, candidateFingerprint: 'X'.repeat(43),
    }, candidate)).toBe(false);
    expect(reviewRevisionVerificationIsConsistent({ ...base, remainingRiskCount: 0 })).toBe(false);
    expect(reviewRevisionVerificationIsConsistent({ ...base, verified: true })).toBe(false);
  });

  it('候选同时锚定正文、上下文和审稿版本', () => {
    expect(reviewRevisionCandidateIsCurrent(
      candidate, 'B'.repeat(43), 'C'.repeat(43), 'R'.repeat(43),
    )).toBe(true);
    expect(reviewRevisionCandidateIsCurrent(
      candidate, 'B'.repeat(43), 'C'.repeat(43), 'S'.repeat(43),
    )).toBe(false);
  });
});

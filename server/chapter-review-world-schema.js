import {
  MAX_REVIEW_CHECK_DETAIL_CHARS, MAX_SECTION_PLAN_FIELD_CHARS,
} from './limits.js';
import { sectionWorldContract } from './section-world-contract.js';
import { WORLD_REVEAL_STAGE_LABELS } from './world-bible.js';

function cleanText(value, maxLength, truncate) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length > maxLength && !truncate) return null;
  return chars.slice(0, maxLength).join('');
}

export function reviewableSectionWorldGate(sectionOutline) {
  const contract = sectionWorldContract(sectionOutline);
  if (!contract || contract.gateOutcome !== 'open-next') return null;
  const index = WORLD_REVEAL_STAGE_LABELS.indexOf(contract.layer);
  if (index < 0 || index >= WORLD_REVEAL_STAGE_LABELS.length - 1) return null;
  return { ...contract, toLayer: WORLD_REVEAL_STAGE_LABELS[index + 1] };
}

// 世界门槛仍由 API 审稿模型提出，但只能引用当前分部合同和正文连续原句。
// 它只是待作者确认的候选，不会在解析或保存审稿时直接推进世界状态。
export function normalizeChapterReviewWorldGateCandidates(value, {
  sectionOutline, chapterContent, requireForContract = false, truncate = false,
} = {}) {
  const hasSectionOutline = sectionOutline !== undefined;
  const contract = hasSectionOutline ? sectionWorldContract(sectionOutline) : null;
  const reviewable = hasSectionOutline ? reviewableSectionWorldGate(sectionOutline) : null;
  if (value === undefined) return requireForContract && contract ? null : undefined;
  if (!Array.isArray(value) || value.length > 1) return null;
  if (!value.length) return [];
  if (hasSectionOutline && !reviewable) return null;
  const item = value[0];
  if (!item || typeof item !== 'object' || Array.isArray(item)
    || !WORLD_REVEAL_STAGE_LABELS.includes(item.fromLayer)
    || !WORLD_REVEAL_STAGE_LABELS.includes(item.toLayer)
    || WORLD_REVEAL_STAGE_LABELS.indexOf(item.toLayer)
      !== WORLD_REVEAL_STAGE_LABELS.indexOf(item.fromLayer) + 1) return null;
  const gateCondition = cleanText(
    item.gateCondition, MAX_SECTION_PLAN_FIELD_CHARS, truncate,
  );
  const summary = cleanText(item.summary, MAX_SECTION_PLAN_FIELD_CHARS, truncate);
  const evidence = cleanText(item.evidence, MAX_REVIEW_CHECK_DETAIL_CHARS, truncate);
  if (!gateCondition || !summary || !evidence
    || (typeof chapterContent === 'string' && !chapterContent.includes(evidence))) return null;
  if (reviewable && (item.fromLayer !== reviewable.layer
    || item.toLayer !== reviewable.toLayer
    || gateCondition !== reviewable.gateCondition)) return null;
  return [{
    fromLayer: item.fromLayer,
    toLayer: item.toLayer,
    gateCondition,
    summary,
    evidence,
  }];
}

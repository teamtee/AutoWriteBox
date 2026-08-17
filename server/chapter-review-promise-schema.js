import { createHash } from 'node:crypto';
import {
  MAX_PROMISE_PROGRESS_CHARS, MAX_PROMISE_TEXT_CHARS,
  MAX_REVIEW_CHECK_DETAIL_CHARS,
} from './limits.js';
import {
  normalizePromiseLedger, PROMISE_LEDGER_ID_PATTERN,
  PROMISE_NARRATIVE_BEATS, PROMISE_WORLD_LINKS,
} from './promise-ledger-schema.js';
import { chapterPlanForeshadowingNarrativeContract } from './chapter-plan-quality.js';

export const CHAPTER_REVIEW_PROMISE_ACTIONS = Object.freeze([
  'establish', 'advance', 'pay',
]);

const ACTION_BY_MARKER = Object.freeze({
  建立承诺: 'establish',
  推进债务: 'advance',
  兑现债务: 'pay',
});
const REVIEWABLE_MARKER_PATTERN = /\[(建立承诺|推进债务|兑现债务):([^\]\r\n]{1,100})\]/gu;
const ACTION_SET = new Set(CHAPTER_REVIEW_PROMISE_ACTIONS);
const BEAT_SET = new Set(PROMISE_NARRATIVE_BEATS);
const WORLD_LINK_SET = new Set(PROMISE_WORLD_LINKS);
const ADVANCE_BEATS = new Set(['pressure', 'misdirect', 'reinterpret', 'collide']);

function cleanText(value, maxLength, truncate) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length > maxLength && !truncate) return null;
  return chars.slice(0, maxLength).join('');
}

export function chapterPlanReviewablePromiseActions(chapterPlan) {
  const source = typeof chapterPlan?.foreshadowing === 'string'
    ? chapterPlan.foreshadowing : '';
  const actions = [];
  const seen = new Set();
  for (const match of source.matchAll(REVIEWABLE_MARKER_PATTERN)) {
    const entryId = match[2];
    if (!PROMISE_LEDGER_ID_PATTERN.test(entryId) || seen.has(entryId)) continue;
    seen.add(entryId);
    actions.push({ entryId, action: ACTION_BY_MARKER[match[1]] });
  }
  return actions;
}

// 审稿模型只能为策划卡已经点名的稳定债务提出候选。正文证据要求是
// 连续原文片段，避免模型用自己的概括冒充“正文已经落地”。
export function normalizeChapterReviewPromiseCandidates(value, {
  chapterPlan,
  promiseLedger,
  chapterContent,
  requireForActions = false,
  allowLegacy = false,
  truncate = false,
} = {}) {
  const plannedActions = chapterPlanReviewablePromiseActions(chapterPlan);
  const narrativeContract = chapterPlanForeshadowingNarrativeContract(chapterPlan);
  if (value === undefined) {
    return requireForActions && plannedActions.length ? null : undefined;
  }
  if (!Array.isArray(value) || value.length > 4) return null;
  const actionByEntryId = new Map(plannedActions.map((item) => [item.entryId, item.action]));
  const ledger = promiseLedger === undefined ? null : normalizePromiseLedger(promiseLedger);
  const entryById = new Map(ledger?.entries.map((entry) => [entry.id, entry]) ?? []);
  const seen = new Set();
  const candidates = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.entryId !== 'string' || !PROMISE_LEDGER_ID_PATTERN.test(item.entryId)
      || !ACTION_SET.has(item.action) || seen.has(item.entryId)
      || actionByEntryId.get(item.entryId) !== item.action) return null;
    const summary = cleanText(item.summary, MAX_PROMISE_PROGRESS_CHARS, truncate);
    const evidence = cleanText(item.evidence, MAX_REVIEW_CHECK_DETAIL_CHARS, truncate);
    const readerBefore = cleanText(item.readerBefore, MAX_PROMISE_PROGRESS_CHARS, truncate);
    const readerAfter = cleanText(item.readerAfter, MAX_PROMISE_PROGRESS_CHARS, truncate);
    const actionConsequence = cleanText(
      item.actionConsequence, MAX_PROMISE_PROGRESS_CHARS, truncate,
    );
    const worldEffect = cleanText(item.worldEffect, MAX_PROMISE_PROGRESS_CHARS, truncate);
    const expectedBeat = item.action === 'establish' ? 'plant'
      : item.action === 'pay' ? 'payoff' : null;
    const newFieldKeys = [
      'beat', 'readerBefore', 'readerAfter', 'actionConsequence',
      'worldLink', 'worldEffect',
    ];
    const hasAnyNewField = newFieldKeys.some((key) =>
      Object.prototype.hasOwnProperty.call(item, key));
    const legacyCandidate = allowLegacy && !hasAnyNewField && !narrativeContract;
    if (!summary || !evidence || !readerBefore || !readerAfter
      || readerBefore === readerAfter || !actionConsequence || !worldEffect
      || !BEAT_SET.has(item.beat) || !WORLD_LINK_SET.has(item.worldLink)
      || (expectedBeat ? item.beat !== expectedBeat : !ADVANCE_BEATS.has(item.beat))
      || !narrativeContract
      || item.beat !== narrativeContract.beat
      || readerBefore !== narrativeContract.readerBefore
      || readerAfter !== narrativeContract.readerAfter
      || actionConsequence !== narrativeContract.actionConsequence
      || item.worldLink !== narrativeContract.worldLink
      || worldEffect !== narrativeContract.worldEffect
      || (typeof chapterContent === 'string' && !chapterContent.includes(evidence))) {
      if (!legacyCandidate || !summary || !evidence
        || (typeof chapterContent === 'string' && !chapterContent.includes(evidence))) return null;
    }
    const entry = ledger ? entryById.get(item.entryId) : null;
    if (ledger && (!entry
      || (item.action === 'establish' ? entry.status !== 'planned' : entry.status !== 'open'))) {
      return null;
    }
    const latestEvidenceBeat = entry?.progress
      .filter((event) => event.status === 'active' && event.beat)
      .sort((left, right) => left.chapter - right.chapter
        || (left.confirmedAt ?? '').localeCompare(right.confirmedAt ?? '')
        || left.id.localeCompare(right.id))
      .at(-1);
    if (latestEvidenceBeat && item.action !== 'establish'
      && readerBefore !== latestEvidenceBeat.readerAfter) return null;
    const promise = entry?.promise
      ?? cleanText(item.promise, MAX_PROMISE_TEXT_CHARS, truncate);
    if (!promise) return null;
    seen.add(item.entryId);
    candidates.push({
      entryId: item.entryId,
      action: item.action,
      promise,
      summary,
      evidence,
      ...(legacyCandidate ? {} : {
        beat: item.beat,
        readerBefore,
        readerAfter,
        actionConsequence,
        worldLink: item.worldLink,
        worldEffect,
      }),
    });
  }
  return candidates;
}

export function chapterReviewPromiseProgressId({
  bodyFingerprint, entryId, action,
}) {
  const digest = createHash('sha256')
    .update(`${bodyFingerprint}\0${entryId}\0${action}`)
    .digest('hex').slice(0, 32);
  return `progress_${digest}`;
}

import { createHash } from 'node:crypto';
import {
  MAX_ID_CHARS, MAX_REVIEW_CHECK_DETAIL_CHARS, MAX_SECTION_PLAN_FIELD_CHARS,
} from './limits.js';
import { WORLD_REVEAL_STAGE_LABELS, worldRevealRoute } from './world-bible.js';

const MAX_CONFIRMED_WORLD_GATES = 12;
const WORLD_GATE_ID_PATTERN = /^world_gate_[0-9a-f]{32}$/;
const SOURCE_ID_PATTERN = /^[\w-]+$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STATUS_SET = new Set(['active', 'stale']);

function fail(code) {
  throw new Error(code);
}

function text(value, maxLength, code) {
  if (typeof value !== 'string') fail(code);
  const clean = value.trim();
  if (!clean || Array.from(clean).length > maxLength) fail(code);
  return clean;
}

function sourceId(value, code) {
  const clean = text(value, MAX_ID_CHARS, code);
  if (!SOURCE_ID_PATTERN.test(clean)) fail(code);
  return clean;
}

function normalizeGate(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !WORLD_GATE_ID_PATTERN.test(value.id)
    || !WORLD_REVEAL_STAGE_LABELS.includes(value.fromLayer)
    || !WORLD_REVEAL_STAGE_LABELS.includes(value.toLayer)
    || WORLD_REVEAL_STAGE_LABELS.indexOf(value.toLayer)
      !== WORLD_REVEAL_STAGE_LABELS.indexOf(value.fromLayer) + 1
    || !STATUS_SET.has(value.status)
    || !value.source || typeof value.source !== 'object' || Array.isArray(value.source)
    || typeof value.confirmedAt !== 'string'
    || !Number.isFinite(Date.parse(value.confirmedAt))) fail(code);
  const bodyFingerprint = text(value.source.bodyFingerprint, 43, code);
  if (!FINGERPRINT_PATTERN.test(bodyFingerprint)) fail(code);
  return {
    id: value.id,
    fromLayer: value.fromLayer,
    toLayer: value.toLayer,
    gateCondition: text(value.gateCondition, MAX_SECTION_PLAN_FIELD_CHARS, code),
    summary: text(value.summary, MAX_SECTION_PLAN_FIELD_CHARS, code),
    evidence: text(value.evidence, MAX_REVIEW_CHECK_DETAIL_CHARS, code),
    source: {
      sectionId: sourceId(value.source.sectionId, code),
      chapterId: sourceId(value.source.chapterId, code),
      bodyFingerprint,
    },
    status: value.status,
    confirmedAt: value.confirmedAt,
  };
}

function activeSequenceValid(gates) {
  const active = gates.filter((gate) => gate.status === 'active');
  const byFromLayer = new Map();
  for (const gate of active) {
    const existing = byFromLayer.get(gate.fromLayer);
    if (existing && (existing.toLayer !== gate.toLayer
      || existing.gateCondition !== gate.gateCondition)) return false;
    byFromLayer.set(gate.fromLayer, gate);
  }
  const middle = WORLD_REVEAL_STAGE_LABELS[1];
  return !byFromLayer.has(middle)
    || byFromLayer.has(WORLD_REVEAL_STAGE_LABELS[0]);
}

export function emptyWorldProgressState() {
  return { gates: [] };
}

export function normalizeWorldProgressState(value, {
  errorCode = 'BAD_WORLD_PROGRESS', sizeErrorCode = 'WORLD_PROGRESS_TOO_LARGE',
} = {}) {
  if (value === undefined || value === null) return emptyWorldProgressState();
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.gates)) fail(errorCode);
  if (value.gates.length > MAX_CONFIRMED_WORLD_GATES) fail(sizeErrorCode);
  const gates = value.gates.map((gate) => normalizeGate(gate, errorCode));
  if (new Set(gates.map((gate) => gate.id)).size !== gates.length
    || !activeSequenceValid(gates)) fail(errorCode);
  return { gates };
}

export function worldProgressRevision(value) {
  const state = normalizeWorldProgressState(value);
  return createHash('sha256').update(JSON.stringify(state)).digest('base64url');
}

export function confirmedWorldGateId({ fromLayer, bodyFingerprint }) {
  const digest = createHash('sha256')
    .update(`${fromLayer}\0${bodyFingerprint}`)
    .digest('hex').slice(0, 32);
  return `world_gate_${digest}`;
}

export function worldProgressPlanningState(value, worldBible) {
  const state = normalizeWorldProgressState(value);
  const route = worldRevealRoute(worldBible);
  const activeGates = [];
  let layerIndex = 0;
  if (route.length === WORLD_REVEAL_STAGE_LABELS.length) {
    for (let index = 0; index < route.length - 1; index += 1) {
      const matching = state.gates.filter((gate) => gate.status === 'active'
        && gate.fromLayer === route[index].layer
        && gate.toLayer === route[index + 1].layer
        && gate.gateCondition === route[index].nextLayerGate)
        .sort((left, right) => right.confirmedAt.localeCompare(left.confirmedAt));
      if (!matching.length) break;
      activeGates.push(matching[0]);
      layerIndex = index + 1;
    }
  }
  return {
    startLayer: WORLD_REVEAL_STAGE_LABELS[layerIndex],
    activeGates,
    inactiveGateCount: state.gates.length - activeGates.length,
    revision: worldProgressRevision(state),
  };
}

export function worldProgressContextState(value, worldBible) {
  const progress = worldProgressPlanningState(value, worldBible);
  return {
    startLayer: progress.startLayer,
    activeGates: progress.activeGates.map((gate) => ({
      id: gate.id,
      fromLayer: gate.fromLayer,
      toLayer: gate.toLayer,
      gateCondition: gate.gateCondition,
      summary: gate.summary,
      evidence: gate.evidence,
    })),
  };
}

export function worldProgressPrompt(value, worldBible) {
  const progress = worldProgressPlanningState(value, worldBible);
  if (!progress.activeGates.length) return '';
  return [
    '【作者已确认的世界门槛事实】',
    ...progress.activeGates.map((gate) =>
      `- ${gate.fromLayer} → ${gate.toLayer}：${gate.summary}（正文证据：${gate.evidence}）`),
    `- 后续新分部允许起始层：${progress.startLayer}`,
    '这些记录已经由作者根据正文原句确认；现有分部仍服从自身世界合同，不能在同一部中越级。',
  ].join('\n');
}

export function invalidateWorldGateSources(book, {
  sectionId, chapterId, bodyFingerprint, preserveFingerprint,
}) {
  const state = normalizeWorldProgressState(book?.settings?.worldProgressState);
  let changed = false;
  let invalidatedLayerIndex = WORLD_REVEAL_STAGE_LABELS.length;
  for (const gate of state.gates) {
    if (gate.status === 'active'
      && gate.source.sectionId === sectionId
      && gate.source.chapterId === chapterId
      && (!bodyFingerprint || gate.source.bodyFingerprint === bodyFingerprint)
      && gate.source.bodyFingerprint !== preserveFingerprint) {
      gate.status = 'stale';
      changed = true;
      invalidatedLayerIndex = Math.min(
        invalidatedLayerIndex,
        WORLD_REVEAL_STAGE_LABELS.indexOf(gate.fromLayer),
      );
    }
  }
  if (changed) {
    for (const gate of state.gates) {
      if (gate.status === 'active'
        && WORLD_REVEAL_STAGE_LABELS.indexOf(gate.fromLayer) > invalidatedLayerIndex) {
        gate.status = 'stale';
      }
    }
  }
  if (book?.settings) book.settings.worldProgressState = state;
  return changed;
}

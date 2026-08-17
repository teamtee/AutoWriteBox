import {
  MAX_PLANNED_SECTIONS, MAX_SECTION_PLAN_FIELD_CHARS,
} from './limits.js';
import { WORLD_REVEAL_STAGE_LABELS } from './world-bible.js';

export const SECTION_WORLD_GATE_OUTCOMES = Object.freeze([
  'hold', 'open-next', 'complete-long',
]);

export const SECTION_WORLD_PROGRESSION_FIELDS = Object.freeze([
  'layer', 'stagePromise', 'evidence', 'characterAction', 'choiceAndCost',
  'knowledgeGain', 'protectedUnknown', 'gateOutcome', 'gateCondition', 'gateProgress',
]);

export const SECTION_PLAN_FIELDS = Object.freeze([
  'title', 'summary', 'promise', 'goal', 'obstacle', 'progress',
  'climax', 'payoff', 'stateChange',
]);

const PLACEHOLDER_TEXT = /^(?:待定|待补充|待完善|待确认|暂无|无|不知道|待进一步明确|更大世界|更大势力|更强敌人)[。！!？?]?$/u;

function cleanText(value, maxLength = MAX_SECTION_PLAN_FIELD_CHARS) {
  if (typeof value !== 'string') return '';
  return Array.from(value.trim()).slice(0, maxLength).join('');
}

function meaningful(value, minimum = 4) {
  return Array.from(value).length >= minimum && !PLACEHOLDER_TEXT.test(value);
}

function routeAnchors(worldRoute) {
  if (!Array.isArray(worldRoute) || worldRoute.length !== WORLD_REVEAL_STAGE_LABELS.length) return null;
  const anchors = new Map();
  for (const route of worldRoute) {
    const layer = cleanText(route?.layer);
    const stagePromise = cleanText(route?.readingPromise);
    const gateCondition = cleanText(route?.nextLayerGate);
    if (!WORLD_REVEAL_STAGE_LABELS.includes(layer)
      || !meaningful(stagePromise) || !meaningful(gateCondition)) return null;
    anchors.set(layer, { stagePromise, gateCondition });
  }
  return anchors.size === WORLD_REVEAL_STAGE_LABELS.length ? anchors : null;
}

function normalizeWorldProgression(value, anchors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const progression = Object.fromEntries(SECTION_WORLD_PROGRESSION_FIELDS.map(
    (field) => [field, cleanText(value[field])],
  ));
  if (!WORLD_REVEAL_STAGE_LABELS.includes(progression.layer)
    || !SECTION_WORLD_GATE_OUTCOMES.includes(progression.gateOutcome)
    || SECTION_WORLD_PROGRESSION_FIELDS.some((field) => field !== 'layer'
      && field !== 'gateOutcome' && !meaningful(progression[field]))) return null;
  const anchor = anchors?.get(progression.layer);
  if (anchor && (progression.stagePromise !== anchor.stagePromise
    || progression.gateCondition !== anchor.gateCondition)) return null;
  return progression;
}

function progressionSequenceValid(sections) {
  const indexes = sections.map((section) => WORLD_REVEAL_STAGE_LABELS.indexOf(
    section.worldProgression.layer,
  ));
  if (indexes[indexes.length - 1] !== 2
    || sections.at(-1).worldProgression.gateOutcome !== 'complete-long') return false;
  for (let index = 0; index < sections.length; index += 1) {
    const current = sections[index].worldProgression;
    const layerIndex = indexes[index];
    const nextLayerIndex = indexes[index + 1];
    if (current.gateOutcome === 'open-next' && layerIndex >= 2) return false;
    if (current.gateOutcome === 'complete-long'
      && (layerIndex !== 2 || index !== sections.length - 1)) return false;
    if (layerIndex < 2 && current.gateOutcome === 'complete-long') return false;
    if (layerIndex === 2 && current.gateOutcome === 'open-next') return false;
    if (nextLayerIndex === undefined) continue;
    const delta = nextLayerIndex - layerIndex;
    if (delta < 0 || delta > 1) return false;
    if (delta === 1 && current.gateOutcome !== 'open-next') return false;
    if (delta === 0 && current.gateOutcome === 'open-next') return false;
  }
  return true;
}

export function normalizeSectionPlans(value, {
  sanitizeTitle = (title) => title, worldRoute = [], allowAdvancedStart = false,
  startLayer,
} = {}) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const anchors = routeAnchors(worldRoute);
  if (!anchors) return null;
  const sections = value.slice(0, MAX_PLANNED_SECTIONS).map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const fields = Object.fromEntries(SECTION_PLAN_FIELDS.map((field) => [
      field, cleanText(candidate[field], field === 'title' ? 8 : MAX_SECTION_PLAN_FIELD_CHARS),
    ]));
    fields.title = sanitizeTitle(fields.title);
    if (!fields.title || SECTION_PLAN_FIELDS.some((field) => field !== 'title'
      && !meaningful(fields[field]))) return null;
    const worldProgression = normalizeWorldProgression(candidate.worldProgression, anchors);
    return worldProgression ? { ...fields, worldProgression } : null;
  });
  if (sections.some((section) => !section) || !progressionSequenceValid(sections)) return null;
  const startIndex = WORLD_REVEAL_STAGE_LABELS.indexOf(sections[0].worldProgression.layer);
  const requiredStartIndex = startLayer === undefined
    ? (allowAdvancedStart ? startIndex : 0)
    : WORLD_REVEAL_STAGE_LABELS.indexOf(startLayer);
  const layerIndexes = new Set(sections.map((section) => WORLD_REVEAL_STAGE_LABELS.indexOf(
    section.worldProgression.layer,
  )));
  if (requiredStartIndex < 0 || startIndex !== requiredStartIndex
    || WORLD_REVEAL_STAGE_LABELS.slice(startIndex).some(
      (_layer, offset) => !layerIndexes.has(startIndex + offset),
    )) return null;
  return sections;
}

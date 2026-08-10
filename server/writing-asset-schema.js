import {
  MAX_ID_CHARS,
  MAX_WRITING_ASSET_AUXILIARY_BINDINGS, MAX_WRITING_ASSET_BOOK_BINDINGS,
  MAX_WRITING_ASSET_CHAPTER_SCENE_BINDINGS,
  MAX_WRITING_ASSETS, MAX_WRITING_ASSET_FIELD_CHARS,
  MAX_WRITING_ASSET_LIST_ITEMS, MAX_WRITING_ASSET_NAME_CHARS,
  MAX_WRITING_ASSET_METADATA_TAG_CHARS, MAX_WRITING_ASSET_METADATA_TAGS,
  MAX_WRITING_ASSET_NOTE_CHARS,
  MAX_WRITING_ASSET_PROMPT_CHARS, MAX_WRITING_ASSET_SOURCE_NAME_CHARS,
  MAX_WRITING_ASSET_SOURCE_PREVIEW_CHARS, MAX_WRITING_ASSET_REFERENCE_URL_CHARS,
} from './limits.js';

export const WRITING_ASSET_SOURCE_KINDS = Object.freeze([
  'self', 'own-previous', 'authorized', 'public-domain', 'excerpt', 'link-only',
  'book-native',
]);
const SOURCE_KIND_SET = new Set(WRITING_ASSET_SOURCE_KINDS);
const ASSET_ID_PATTERN = /^asset_[0-9a-f]{32}$/;
const EVIDENCE_LEVELS = new Set(['low', 'medium', 'high']);
export const WRITING_ASSET_SCENES = Object.freeze([
  'battle', 'dialogue', 'mystery', 'romance', 'daily', 'climax',
]);
const WRITING_ASSET_SCENE_SET = new Set(WRITING_ASSET_SCENES);
const FORBIDDEN_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cleanText(value, limit) {
  return typeof value === 'string'
    ? Array.from(value.trim()).slice(0, limit).join('')
    : '';
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, MAX_WRITING_ASSET_FIELD_CHARS))
    .filter(Boolean)
    .slice(0, MAX_WRITING_ASSET_LIST_ITEMS);
}

function cleanMetadataTags(value) {
  if (!Array.isArray(value)) return [];
  const tags = value
    .map((item) => cleanText(item, MAX_WRITING_ASSET_METADATA_TAG_CHARS))
    .filter(Boolean)
    .slice(0, MAX_WRITING_ASSET_METADATA_TAGS);
  return [...new Set(tags)];
}

function cleanReferenceUrl(value) {
  const text = cleanText(value, MAX_WRITING_ASSET_REFERENCE_URL_CHARS);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function cleanStorageId(value) {
  return isSafeBindingKey(value) ? value : '';
}

// 模型输出只接收白名单字段；缺失的次要维度用空字符串表示，但一张可用
// 资产至少必须同时具备文风摘要、可执行提示词和故事结构摘要。
export function sanitizeWritingAssetAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const styleValue = value.style;
  const storyValue = value.story;
  if (!styleValue || typeof styleValue !== 'object' || Array.isArray(styleValue)
    || !storyValue || typeof storyValue !== 'object' || Array.isArray(storyValue)) return null;

  const style = {
    summary: cleanText(styleValue.summary, MAX_WRITING_ASSET_FIELD_CHARS),
    narrative: cleanText(styleValue.narrative, MAX_WRITING_ASSET_FIELD_CHARS),
    sentenceRhythm: cleanText(styleValue.sentenceRhythm, MAX_WRITING_ASSET_FIELD_CHARS),
    vocabulary: cleanText(styleValue.vocabulary, MAX_WRITING_ASSET_FIELD_CHARS),
    dialogue: cleanText(styleValue.dialogue, MAX_WRITING_ASSET_FIELD_CHARS),
    dialogueRatio: cleanText(styleValue.dialogueRatio, MAX_WRITING_ASSET_FIELD_CHARS),
    description: cleanText(styleValue.description, MAX_WRITING_ASSET_FIELD_CHARS),
    humor: cleanText(styleValue.humor, MAX_WRITING_ASSET_FIELD_CHARS),
    emotion: cleanText(styleValue.emotion, MAX_WRITING_ASSET_FIELD_CHARS),
    emotionTemperature: cleanText(
      styleValue.emotionTemperature, MAX_WRITING_ASSET_FIELD_CHARS,
    ),
    conflictFrequency: cleanText(styleValue.conflictFrequency, MAX_WRITING_ASSET_FIELD_CHARS),
    payoffType: cleanText(styleValue.payoffType, MAX_WRITING_ASSET_FIELD_CHARS),
    conflictAndPayoff: cleanText(styleValue.conflictAndPayoff, MAX_WRITING_ASSET_FIELD_CHARS),
    chapterHooks: cleanText(styleValue.chapterHooks, MAX_WRITING_ASSET_FIELD_CHARS),
    prompt: cleanText(styleValue.prompt, MAX_WRITING_ASSET_PROMPT_CHARS),
    avoid: cleanList(styleValue.avoid),
  };
  const rawLevel = cleanText(storyValue.evidenceLevel, 10);
  const story = {
    summary: cleanText(storyValue.summary, MAX_WRITING_ASSET_FIELD_CHARS),
    evidenceLevel: EVIDENCE_LEVELS.has(rawLevel) ? rawLevel : 'low',
    premisePattern: cleanText(storyValue.premisePattern, MAX_WRITING_ASSET_FIELD_CHARS),
    protagonistDrive: cleanText(storyValue.protagonistDrive, MAX_WRITING_ASSET_FIELD_CHARS),
    conflictEngine: cleanText(storyValue.conflictEngine, MAX_WRITING_ASSET_FIELD_CHARS),
    escalation: cleanText(storyValue.escalation, MAX_WRITING_ASSET_FIELD_CHARS),
    arcStructure: cleanText(storyValue.arcStructure, MAX_WRITING_ASSET_FIELD_CHARS),
    chapterPattern: cleanText(storyValue.chapterPattern, MAX_WRITING_ASSET_FIELD_CHARS),
    payoffPattern: cleanText(storyValue.payoffPattern, MAX_WRITING_ASSET_FIELD_CHARS),
    hookPattern: cleanText(storyValue.hookPattern, MAX_WRITING_ASSET_FIELD_CHARS),
    reusableTechniques: cleanList(storyValue.reusableTechniques),
    uncertainties: cleanList(storyValue.uncertainties),
  };
  if (!style.summary || !style.prompt || !story.summary) return null;
  return { style, story };
}

export function normalizeWritingAsset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = typeof value.id === 'string' && ASSET_ID_PATTERN.test(value.id) ? value.id : '';
  const name = cleanText(value.name, MAX_WRITING_ASSET_NAME_CHARS);
  const createdAt = typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : '';
  const sourceValue = value.source;
  if (!sourceValue || typeof sourceValue !== 'object' || Array.isArray(sourceValue)) return null;
  const kind = SOURCE_KIND_SET.has(sourceValue.kind) ? sourceValue.kind : '';
  const referenceUrl = cleanReferenceUrl(sourceValue.referenceUrl);
  const source = {
    kind,
    name: cleanText(sourceValue.name, MAX_WRITING_ASSET_SOURCE_NAME_CHARS),
    workNote: cleanText(sourceValue.workNote, MAX_WRITING_ASSET_NOTE_CHARS),
    rightsNote: cleanText(sourceValue.rightsNote, MAX_WRITING_ASSET_NOTE_CHARS),
    genres: cleanMetadataTags(sourceValue.genres),
    sceneTags: cleanMetadataTags(sourceValue.sceneTags),
    referenceUrl,
    bookId: cleanStorageId(sourceValue.bookId),
    sectionId: cleanStorageId(sourceValue.sectionId),
    chapterId: cleanStorageId(sourceValue.chapterId),
    length: Number.isInteger(sourceValue.length) && sourceValue.length >= 0
      ? sourceValue.length : 0,
    fingerprint: typeof sourceValue.fingerprint === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(sourceValue.fingerprint)
      ? sourceValue.fingerprint : '',
    preview: cleanText(sourceValue.preview, MAX_WRITING_ASSET_SOURCE_PREVIEW_CHARS),
  };
  const analysis = sanitizeWritingAssetAnalysis(value);
  const linkOnly = kind === 'link-only';
  const bookNative = kind === 'book-native';
  if (!id || !name || !createdAt || !kind || !source.name) return null;
  if (linkOnly) {
    if (!referenceUrl || source.length !== 0 || source.fingerprint || source.preview) return null;
    return { id, name, createdAt, source, style: null, story: null };
  }
  if (bookNative && (!source.bookId || !source.sectionId || !source.chapterId)) return null;
  if (!source.length || !source.fingerprint || !source.preview || !analysis) return null;
  return { id, name, createdAt, source, ...analysis };
}

function isSafeBindingKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
    && /^[\w-]+$/u.test(value) && !FORBIDDEN_RECORD_KEYS.has(value);
}

export function normalizeWritingAssetBookBinding(value, { usableAssetIds } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const assetIds = usableAssetIds instanceof Set ? usableAssetIds : null;
  const isAssetId = (id) => typeof id === 'string' && ASSET_ID_PATTERN.test(id)
    && (!assetIds || assetIds.has(id));
  const primaryAssetId = value.primaryAssetId === null || value.primaryAssetId === undefined
    || value.primaryAssetId === '' ? null
    : isAssetId(value.primaryAssetId) ? value.primaryAssetId : undefined;
  if (primaryAssetId === undefined) return null;
  const nativeAssetId = value.nativeAssetId === null || value.nativeAssetId === undefined
    || value.nativeAssetId === '' ? null
    : isAssetId(value.nativeAssetId) ? value.nativeAssetId : undefined;
  if (nativeAssetId === undefined) return null;
  if (!Array.isArray(value.auxiliaryAssetIds)
    || value.auxiliaryAssetIds.length > MAX_WRITING_ASSET_AUXILIARY_BINDINGS
    || value.auxiliaryAssetIds.some((id) => !isAssetId(id))) return null;
  const auxiliaryAssetIds = [...new Set(value.auxiliaryAssetIds)]
    .filter((id) => id !== primaryAssetId);

  const rawSceneAssetIds = value.sceneAssetIds ?? {};
  if (!rawSceneAssetIds || typeof rawSceneAssetIds !== 'object'
    || Array.isArray(rawSceneAssetIds)) return null;
  const sceneAssetIds = {};
  for (const [scene, assetId] of Object.entries(rawSceneAssetIds)) {
    if (!WRITING_ASSET_SCENE_SET.has(scene) || !isAssetId(assetId)) return null;
    sceneAssetIds[scene] = assetId;
  }

  const rawChapterScenes = value.chapterScenes ?? {};
  if (!rawChapterScenes || typeof rawChapterScenes !== 'object'
    || Array.isArray(rawChapterScenes)
    || Object.keys(rawChapterScenes).length > MAX_WRITING_ASSET_CHAPTER_SCENE_BINDINGS) {
    return null;
  }
  const chapterScenes = {};
  for (const [chapterId, scene] of Object.entries(rawChapterScenes)) {
    if (!isSafeBindingKey(chapterId) || !WRITING_ASSET_SCENE_SET.has(scene)) return null;
    chapterScenes[chapterId] = scene;
  }
  return { nativeAssetId, primaryAssetId, auxiliaryAssetIds, sceneAssetIds, chapterScenes };
}

export function normalizeWritingAssetLibrary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![1, 2].includes(value.version) || !Array.isArray(value.assets)
    || value.assets.length > MAX_WRITING_ASSETS) throw new Error('STORAGE_DATA_INVALID');
  const assets = value.assets.map(normalizeWritingAsset);
  if (assets.some((asset) => !asset)) throw new Error('STORAGE_DATA_INVALID');
  const ids = new Set(assets.map((asset) => asset.id));
  if (ids.size !== assets.length) throw new Error('STORAGE_DATA_INVALID');
  if (value.version === 1) return { version: 2, assets, bookBindings: {} };
  if (!value.bookBindings || typeof value.bookBindings !== 'object'
    || Array.isArray(value.bookBindings)
    || Object.keys(value.bookBindings).length > MAX_WRITING_ASSET_BOOK_BINDINGS) {
    throw new Error('STORAGE_DATA_INVALID');
  }
  const usableAssetIds = new Set(assets.filter((asset) => asset.style).map((asset) => asset.id));
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const bookBindings = {};
  for (const [bookId, rawBinding] of Object.entries(value.bookBindings)) {
    if (!isSafeBindingKey(bookId)) throw new Error('STORAGE_DATA_INVALID');
    const binding = normalizeWritingAssetBookBinding(rawBinding, { usableAssetIds });
    if (!binding) throw new Error('STORAGE_DATA_INVALID');
    const nativeAsset = binding.nativeAssetId ? assetsById.get(binding.nativeAssetId) : null;
    if (nativeAsset && (nativeAsset.source.kind !== 'book-native'
      || nativeAsset.source.bookId !== bookId)) throw new Error('STORAGE_DATA_INVALID');
    const regularIds = [
      binding.primaryAssetId, ...binding.auxiliaryAssetIds,
      ...Object.values(binding.sceneAssetIds),
    ].filter(Boolean);
    if (regularIds.some((id) => assetsById.get(id)?.source.kind === 'book-native')) {
      throw new Error('STORAGE_DATA_INVALID');
    }
    bookBindings[bookId] = binding;
  }
  return { version: 2, assets, bookBindings };
}

export function isWritingAssetSourceKind(value) {
  return SOURCE_KIND_SET.has(value);
}

export function isWritingAssetTextSourceKind(value) {
  return SOURCE_KIND_SET.has(value) && value !== 'link-only';
}

export function isWritingAssetScene(value) {
  return WRITING_ASSET_SCENE_SET.has(value);
}

import { createHash, randomUUID } from 'node:crypto';
import {
  isWritingAssetSourceKind, isWritingAssetTextSourceKind,
  normalizeWritingAssetBookBinding, normalizeWritingAssetLibrary,
  sanitizeWritingAssetAnalysis,
} from '../writing-asset-schema.js';
import {
  MAX_WRITING_ASSETS, MAX_WRITING_ASSET_BOOK_BINDINGS,
  MAX_WRITING_ASSET_CONTEXT_CHARS, MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS,
  MAX_WRITING_ASSET_METADATA_TAG_CHARS, MAX_WRITING_ASSET_METADATA_TAGS,
  MAX_WRITING_ASSET_NAME_CHARS, MAX_WRITING_ASSET_NOTE_CHARS,
  MAX_WRITING_ASSET_REFERENCE_URL_CHARS, MAX_WRITING_ASSET_SOURCE_CHARS,
  MAX_WRITING_ASSET_SOURCE_NAME_CHARS, MAX_WRITING_ASSET_SOURCE_PREVIEW_CHARS,
} from '../limits.js';

const WRITING_ASSETS_LOCK_KEY = 'writing-assets:library';
const REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ASSET_ID_PATTERN = /^asset_[0-9a-f]{32}$/;

function emptyWritingAssetLibrary() {
  return { version: 2, assets: [], bookBindings: {} };
}

function normalizeWritingAssetTags(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_WRITING_ASSET_METADATA_TAGS) {
    throw new Error('BAD_ASSET_METADATA');
  }
  const tags = value.map((item) => {
    if (typeof item !== 'string' || item.length > MAX_WRITING_ASSET_METADATA_TAG_CHARS) {
      throw new Error('BAD_ASSET_METADATA');
    }
    return item.trim();
  }).filter(Boolean);
  return [...new Set(tags)];
}

function normalizeWritingAssetReferenceUrl(value, { required = false } = {}) {
  if (value === undefined || value === '') {
    if (required) throw new Error('BAD_ASSET_REFERENCE_URL');
    return '';
  }
  if (typeof value !== 'string' || value.length > MAX_WRITING_ASSET_REFERENCE_URL_CHARS) {
    throw new Error('BAD_ASSET_REFERENCE_URL');
  }
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password) throw new Error('BAD_ASSET_REFERENCE_URL');
    return parsed.href;
  } catch {
    throw new Error('BAD_ASSET_REFERENCE_URL');
  }
}

function normalizeWritingAssetMetadata(input, { requireReferenceUrl = false } = {}) {
  const normalizeNote = (value) => {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > MAX_WRITING_ASSET_NOTE_CHARS) {
      throw new Error('BAD_ASSET_METADATA');
    }
    return value.trim();
  };
  return {
    workNote: normalizeNote(input.workNote),
    rightsNote: normalizeNote(input.rightsNote),
    genres: normalizeWritingAssetTags(input.genres),
    sceneTags: normalizeWritingAssetTags(input.sceneTags),
    referenceUrl: normalizeWritingAssetReferenceUrl(input.referenceUrl, {
      required: requireReferenceUrl,
    }),
  };
}

function validateWritingAssetRights(sourceKind, rightsNote) {
  if (['authorized', 'public-domain', 'excerpt'].includes(sourceKind) && !rightsNote) {
    throw new Error('BAD_ASSET_RIGHTS_NOTE');
  }
}

function writingAssetSourceFingerprint(sourceText) {
  return createHash('sha256').update(sourceText.trim(), 'utf8').digest('base64url');
}

function normalizeWritingAssetSourceInput(context, {
  name, sourceName, sourceKind, sourceText, analysis,
  sourceBookId, sourceSectionId, sourceChapterId, ...metadataInput
}) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('BAD_ASSET_NAME');
  if (name.length > MAX_WRITING_ASSET_NAME_CHARS) throw new Error('ASSET_NAME_TOO_LARGE');
  if (typeof sourceName !== 'string' || !sourceName.trim()) throw new Error('BAD_ASSET_SOURCE');
  if (sourceName.length > MAX_WRITING_ASSET_SOURCE_NAME_CHARS) {
    throw new Error('ASSET_SOURCE_NAME_TOO_LARGE');
  }
  if (!isWritingAssetTextSourceKind(sourceKind)) throw new Error('BAD_ASSET_SOURCE_KIND');
  if (typeof sourceText !== 'string' || !sourceText.trim()) throw new Error('BAD_ASSET_SOURCE');
  if (sourceText.length > MAX_WRITING_ASSET_SOURCE_CHARS) {
    throw new Error('ASSET_SOURCE_TOO_LARGE');
  }
  if (sourceKind === 'excerpt'
    && sourceText.length > MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS) {
    throw new Error('ASSET_EXCERPT_TOO_LARGE');
  }
  const normalizedAnalysis = sanitizeWritingAssetAnalysis(analysis);
  if (!normalizedAnalysis) throw new Error('ASSET_EXTRACTION_FAILED');
  const metadata = normalizeWritingAssetMetadata(metadataInput);
  validateWritingAssetRights(sourceKind, metadata.rightsNote);
  const origin = sourceKind === 'book-native' ? {
    bookId: context.safeId(sourceBookId),
    sectionId: context.safeId(sourceSectionId),
    chapterId: context.safeId(sourceChapterId),
  } : { bookId: '', sectionId: '', chapterId: '' };
  return {
    name: name.trim(),
    sourceName: sourceName.trim(),
    sourceKind,
    sourceText: sourceText.trim(),
    analysis: normalizedAnalysis,
    metadata,
    origin,
  };
}

function removeWritingAssetFromBinding(binding, assetId) {
  const sceneAssetIds = Object.fromEntries(Object.entries(binding.sceneAssetIds)
    .filter(([, boundAssetId]) => boundAssetId !== assetId));
  return {
    nativeAssetId: binding.nativeAssetId === assetId ? null : binding.nativeAssetId,
    primaryAssetId: binding.primaryAssetId === assetId ? null : binding.primaryAssetId,
    auxiliaryAssetIds: binding.auxiliaryAssetIds.filter((id) => id !== assetId),
    sceneAssetIds,
    chapterScenes: binding.chapterScenes,
  };
}

export function writingAssetContextForLibrary(libraryValue, bookId, chapterId) {
  const library = normalizeWritingAssetLibrary(libraryValue);
  const binding = library.bookBindings[bookId];
  if (!binding) return { text: '', scene: null, assetIds: [], revision: '' };
  const scene = chapterId ? binding.chapterScenes[chapterId] ?? null : null;
  const selected = [];
  if (binding.nativeAssetId) {
    selected.push(['本书原生文风（最高优先级）', binding.nativeAssetId]);
  }
  if (binding.primaryAssetId) {
    selected.push(['外部主文风（次于本书原生）', binding.primaryAssetId]);
  }
  for (const id of binding.auxiliaryAssetIds) selected.push(['辅助文风', id]);
  const sceneAssetId = scene ? binding.sceneAssetIds[scene] : null;
  if (sceneAssetId) selected.push([`本章${scene}场景参考`, sceneAssetId]);
  const seen = new Set();
  const assetsById = new Map(library.assets.map((asset) => [asset.id, asset]));
  const chunks = [];
  const assetIds = [];
  let remaining = MAX_WRITING_ASSET_CONTEXT_CHARS;
  const append = (value) => {
    if (remaining <= 0) return;
    const text = String(value ?? '');
    const clipped = text.slice(0, remaining);
    chunks.push(clipped);
    remaining -= clipped.length;
  };
  append('【已绑定创作资产】\n只使用以下抽象特征，不推断或复现任何来源作者、作品、角色、设定或原句。用于正文时，冲突依次遵守本书禁忌与当前剧情因果、文风圣经的稳定锚点和禁止表达、本书原生文风、外部主文风；场景参考只能细化文风圣经允许变化的本章局部表达。用于重构文风圣经时，这些资产只是风格证据，应综合成适合本书的统一规则，不能逐份拼接。\n');
  for (const [role, id] of selected) {
    if (seen.has(id)) continue;
    seen.add(id);
    const asset = assetsById.get(id);
    if (!asset?.style || !asset.story) continue;
    assetIds.push(id);
    append(`【${role}】\n${asset.style.prompt}\n`);
    if (asset.style.avoid.length) append(`避免：${asset.style.avoid.join('；')}\n`);
    if (asset.story.reusableTechniques.length) {
      append(`可用结构技法：${asset.story.reusableTechniques.join('；')}\n`);
    }
  }
  if (!assetIds.length) return { text: '', scene, assetIds: [], revision: '' };
  const text = chunks.join('').trim();
  const revision = createHash('sha256')
    .update(JSON.stringify({ text, scene, assetIds }), 'utf8').digest('base64url');
  return { text, scene, assetIds, revision };
}

export function createWritingAssetStore(context) {
  const revisionSalt = randomUUID();
  const writingAssetsPath = () => context.resolvePath('writing-assets.json');

  const writingAssetsRevision = (library) => createHash('sha256')
    .update(revisionSalt, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(normalizeWritingAssetLibrary(library)), 'utf8')
    .digest('base64url');

  const readWritingAssetLibrary = async ({ signal } = {}) => {
    try {
      return normalizeWritingAssetLibrary(await context.readStoredJson(
        writingAssetsPath(), { mode: 0o600, signal },
      ));
    } catch (error) {
      context.throwIfAborted(signal);
      if (error?.code !== 'ENOENT') throw error;
      return emptyWritingAssetLibrary();
    }
  };

  const readWritingAssets = async ({ signal } = {}) => {
    const library = await readWritingAssetLibrary({ signal });
    return {
      revision: writingAssetsRevision(library),
      assets: library.assets,
      bookBindings: library.bookBindings,
    };
  };

  const findWritingAssetDuplicate = async (sourceText, { signal } = {}) => {
    if (typeof sourceText !== 'string' || !sourceText.trim()) {
      throw new Error('BAD_ASSET_SOURCE');
    }
    const fingerprint = writingAssetSourceFingerprint(sourceText);
    const library = await readWritingAssetLibrary({ signal });
    return library.assets.find((asset) => asset.source.fingerprint === fingerprint) ?? null;
  };

  const addWritingAsset = async (input, { signal } = {}) => {
    const normalized = normalizeWritingAssetSourceInput(context, input);
    return context.withStoreLock(WRITING_ASSETS_LOCK_KEY, async () => {
      const library = await readWritingAssetLibrary({ signal });
      if (library.assets.length >= MAX_WRITING_ASSETS) throw new Error('ASSET_LIBRARY_LIMIT');
      const sourceText = normalized.sourceText;
      const fingerprint = writingAssetSourceFingerprint(sourceText);
      if (library.assets.some((asset) => asset.source.fingerprint === fingerprint)) {
        throw new Error('ASSET_DUPLICATE');
      }
      const asset = {
        id: `asset_${randomUUID().replaceAll('-', '')}`,
        name: normalized.name,
        createdAt: new Date().toISOString(),
        source: {
          kind: normalized.sourceKind,
          name: normalized.sourceName,
          ...normalized.metadata,
          ...normalized.origin,
          length: sourceText.length,
          fingerprint,
          preview: Array.from(sourceText)
            .slice(0, MAX_WRITING_ASSET_SOURCE_PREVIEW_CHARS).join(''),
        },
        ...normalized.analysis,
      };
      const next = {
        version: 2,
        assets: [asset, ...library.assets],
        bookBindings: library.bookBindings,
      };
      await context.ensureDataRoot();
      await context.atomicWriteJson(writingAssetsPath(), next, { mode: 0o600 });
      return { asset, revision: writingAssetsRevision(next) };
    }, { signal });
  };

  const addWritingAssetReference = async (input, { signal } = {}) => {
    const { name, sourceName, sourceKind, ...metadataInput } = input ?? {};
    if (typeof name !== 'string' || !name.trim()) throw new Error('BAD_ASSET_NAME');
    if (name.length > MAX_WRITING_ASSET_NAME_CHARS) throw new Error('ASSET_NAME_TOO_LARGE');
    if (typeof sourceName !== 'string' || !sourceName.trim()) {
      throw new Error('BAD_ASSET_SOURCE');
    }
    if (sourceName.length > MAX_WRITING_ASSET_SOURCE_NAME_CHARS) {
      throw new Error('ASSET_SOURCE_NAME_TOO_LARGE');
    }
    if (!isWritingAssetSourceKind(sourceKind) || sourceKind !== 'link-only') {
      throw new Error('BAD_ASSET_SOURCE_KIND');
    }
    const metadata = normalizeWritingAssetMetadata(
      metadataInput, { requireReferenceUrl: true },
    );
    return context.withStoreLock(WRITING_ASSETS_LOCK_KEY, async () => {
      const library = await readWritingAssetLibrary({ signal });
      if (library.assets.length >= MAX_WRITING_ASSETS) throw new Error('ASSET_LIBRARY_LIMIT');
      if (library.assets.some((asset) => asset.source.referenceUrl === metadata.referenceUrl)) {
        throw new Error('ASSET_DUPLICATE');
      }
      const asset = {
        id: `asset_${randomUUID().replaceAll('-', '')}`,
        name: name.trim(),
        createdAt: new Date().toISOString(),
        source: {
          kind: sourceKind,
          name: sourceName.trim(),
          ...metadata,
          bookId: '', sectionId: '', chapterId: '',
          length: 0, fingerprint: '', preview: '',
        },
        style: null,
        story: null,
      };
      const next = {
        version: 2,
        assets: [asset, ...library.assets],
        bookBindings: library.bookBindings,
      };
      await context.ensureDataRoot();
      await context.atomicWriteJson(writingAssetsPath(), next, { mode: 0o600 });
      return { asset, revision: writingAssetsRevision(next) };
    }, { signal });
  };

  const exportWritingAssets = async ({ signal } = {}) => {
    const library = await readWritingAssetLibrary({ signal });
    return {
      format: 'auto-novel-box-writing-assets',
      version: 2,
      exportedAt: new Date().toISOString(),
      assets: library.assets,
      bookBindings: library.bookBindings,
    };
  };

  const saveWritingAssetBookBinding = async (bookId, binding, {
    expectedRevision, signal,
  } = {}) => {
    const safeBookId = context.safeId(bookId);
    if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
      throw new Error('BAD_ASSET_REVISION');
    }
    await context.readBook(safeBookId, { signal });
    return context.withStoreLock(WRITING_ASSETS_LOCK_KEY, async () => {
      const library = await readWritingAssetLibrary({ signal });
      if (writingAssetsRevision(library) !== expectedRevision) {
        throw new Error('ASSET_CONFLICT');
      }
      const usableAssetIds = new Set(
        library.assets.filter((asset) => asset.style).map((asset) => asset.id),
      );
      const normalizedBinding = normalizeWritingAssetBookBinding(
        binding, { usableAssetIds },
      );
      if (!normalizedBinding) throw new Error('BAD_ASSET_BINDING');
      if (normalizedBinding.nativeAssetId) {
        const nativeAsset = library.assets.find(
          (asset) => asset.id === normalizedBinding.nativeAssetId,
        );
        if (nativeAsset?.source.kind !== 'book-native'
          || nativeAsset.source.bookId !== safeBookId) {
          throw new Error('BAD_ASSET_BINDING');
        }
      }
      const assetsById = new Map(library.assets.map((asset) => [asset.id, asset]));
      const regularIds = [
        normalizedBinding.primaryAssetId,
        ...normalizedBinding.auxiliaryAssetIds,
        ...Object.values(normalizedBinding.sceneAssetIds),
      ].filter(Boolean);
      if (regularIds.some((id) => assetsById.get(id)?.source.kind === 'book-native')) {
        throw new Error('BAD_ASSET_BINDING');
      }
      const exists = Object.prototype.hasOwnProperty.call(
        library.bookBindings, safeBookId,
      );
      if (!exists
        && Object.keys(library.bookBindings).length >= MAX_WRITING_ASSET_BOOK_BINDINGS) {
        throw new Error('ASSET_BOOK_BINDING_LIMIT');
      }
      const next = {
        version: 2,
        assets: library.assets,
        bookBindings: {
          ...library.bookBindings,
          [safeBookId]: normalizedBinding,
        },
      };
      await context.ensureDataRoot();
      await context.atomicWriteJson(writingAssetsPath(), next, { mode: 0o600 });
      return {
        binding: normalizedBinding,
        revision: writingAssetsRevision(next),
      };
    }, { signal });
  };

  const readWritingAssetContext = async (bookId, chapterId, { signal } = {}) => {
    const safeBookId = context.safeId(bookId);
    const safeChapterId = chapterId ? context.safeId(chapterId) : null;
    const library = await readWritingAssetLibrary({ signal });
    return writingAssetContextForLibrary(library, safeBookId, safeChapterId);
  };

  const deleteWritingAsset = async (id, {
    expectedRevision, signal,
  } = {}) => {
    if (typeof id !== 'string' || !ASSET_ID_PATTERN.test(id)) {
      throw new Error('BAD_ASSET_ID');
    }
    if (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision)) {
      throw new Error('BAD_ASSET_REVISION');
    }
    return context.withStoreLock(WRITING_ASSETS_LOCK_KEY, async () => {
      const library = await readWritingAssetLibrary({ signal });
      if (writingAssetsRevision(library) !== expectedRevision) {
        throw new Error('ASSET_CONFLICT');
      }
      const index = library.assets.findIndex((asset) => asset.id === id);
      if (index < 0) throw new Error('ASSET_NOT_FOUND');
      const bookBindings = Object.fromEntries(Object.entries(library.bookBindings)
        .map(([boundBookId, bound]) => [
          boundBookId, removeWritingAssetFromBinding(bound, id),
        ]));
      const next = {
        version: 2,
        assets: library.assets.filter((asset) => asset.id !== id),
        bookBindings,
      };
      await context.atomicWriteJson(writingAssetsPath(), next, { mode: 0o600 });
      return { ok: true, revision: writingAssetsRevision(next) };
    }, { signal });
  };

  return Object.freeze({
    addWritingAsset,
    addWritingAssetReference,
    deleteWritingAsset,
    exportWritingAssets,
    findWritingAssetDuplicate,
    readWritingAssetContext,
    readWritingAssets,
    saveWritingAssetBookBinding,
    writingAssetsRevision,
  });
}

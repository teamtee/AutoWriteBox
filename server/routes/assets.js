import * as store from '../store.js';
import {
  buildWritingAssetExtractionInstruction, WRITING_ASSET_ANALYST_SYSTEM_PROMPT,
} from '../prompts.js';
import { extractWritingAssetAnalysis } from '../llm.js';
import { sendJsonError } from '../http-error.js';
import { createClientAbortTracker } from '../client-abort.js';
import { sendJsonStream } from '../http-json.js';
import {
  MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS,
  MAX_WRITING_ASSET_METADATA_TAG_CHARS, MAX_WRITING_ASSET_METADATA_TAGS,
  MAX_WRITING_ASSET_NAME_CHARS, MAX_WRITING_ASSET_SOURCE_CHARS,
  MAX_WRITING_ASSET_NOTE_CHARS, MAX_WRITING_ASSET_REFERENCE_URL_CHARS,
  MAX_WRITING_ASSET_SOURCE_NAME_CHARS,
} from '../limits.js';
import {
  isWritingAssetSourceKind, isWritingAssetTextSourceKind,
} from '../writing-asset-schema.js';

function sendRouteError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) res.destroy(error);
  else sendJsonError(res, error);
}

function validateMetadataInput(body, { requireReferenceUrl = false } = {}) {
  const validateNote = (value) => {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > MAX_WRITING_ASSET_NOTE_CHARS) {
      throw new Error('BAD_ASSET_METADATA');
    }
    return value.trim();
  };
  const validateTags = (value) => {
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
  };
  let referenceUrl = '';
  if (body.referenceUrl !== undefined && body.referenceUrl !== '') {
    if (typeof body.referenceUrl !== 'string'
      || body.referenceUrl.length > MAX_WRITING_ASSET_REFERENCE_URL_CHARS) {
      throw new Error('BAD_ASSET_REFERENCE_URL');
    }
    try {
      const parsed = new URL(body.referenceUrl.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username || parsed.password) throw new Error('BAD_ASSET_REFERENCE_URL');
      referenceUrl = parsed.href;
    } catch {
      throw new Error('BAD_ASSET_REFERENCE_URL');
    }
  } else if (requireReferenceUrl) {
    throw new Error('BAD_ASSET_REFERENCE_URL');
  }
  return {
    workNote: validateNote(body.workNote),
    rightsNote: validateNote(body.rightsNote),
    genres: validateTags(body.genres),
    sceneTags: validateTags(body.sceneTags),
    referenceUrl,
  };
}

function validateAssetIdentity(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('BAD_ASSET_SOURCE');
  }
  const { name, sourceName, sourceKind } = body;
  if (typeof name !== 'string' || !name.trim()) throw new Error('BAD_ASSET_NAME');
  if (name.length > MAX_WRITING_ASSET_NAME_CHARS) throw new Error('ASSET_NAME_TOO_LARGE');
  if (typeof sourceName !== 'string' || !sourceName.trim()) {
    throw new Error('BAD_ASSET_SOURCE');
  }
  if (sourceName.length > MAX_WRITING_ASSET_SOURCE_NAME_CHARS) {
    throw new Error('ASSET_SOURCE_NAME_TOO_LARGE');
  }
  if (!isWritingAssetSourceKind(sourceKind)) throw new Error('BAD_ASSET_SOURCE_KIND');
  return { name: name.trim(), sourceName: sourceName.trim(), sourceKind };
}

function validateExtractionInput(body, { allowBookNative = false } = {}) {
  const identity = validateAssetIdentity(body);
  const { sourceText } = body;
  if (!isWritingAssetTextSourceKind(identity.sourceKind)
    || (identity.sourceKind === 'book-native' && !allowBookNative)) {
    throw new Error('BAD_ASSET_SOURCE_KIND');
  }
  if (typeof sourceText !== 'string' || !sourceText.trim()) {
    throw new Error('BAD_ASSET_SOURCE');
  }
  if (sourceText.length > MAX_WRITING_ASSET_SOURCE_CHARS) {
    throw new Error('ASSET_SOURCE_TOO_LARGE');
  }
  if (identity.sourceKind === 'excerpt'
    && sourceText.length > MAX_WRITING_ASSET_EXTERNAL_EXCERPT_CHARS) {
    throw new Error('ASSET_EXCERPT_TOO_LARGE');
  }
  const metadata = validateMetadataInput(body);
  if (['authorized', 'public-domain', 'excerpt'].includes(identity.sourceKind)
    && !metadata.rightsNote) throw new Error('BAD_ASSET_RIGHTS_NOTE');
  return { ...identity, sourceText: sourceText.trim(), ...metadata };
}

function validateReferenceInput(body) {
  const identity = validateAssetIdentity(body);
  if (identity.sourceKind !== 'link-only') throw new Error('BAD_ASSET_SOURCE_KIND');
  return { ...identity, ...validateMetadataInput(body, { requireReferenceUrl: true }) };
}

export function mountAssetRoutes(app, deps = {}) {
  const nonStreamChat = deps.nonStreamChat;
  const sendJsonResponse = deps.sendJsonResponse ?? sendJsonStream;

  app.get('/api/writing-assets', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const library = await store.readWritingAssets({ signal: client.signal });
      await client.assertAliveAfterIo();
      await sendJsonResponse(res, library, { signal: client.signal });
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.get('/api/writing-assets/export', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const exported = await store.exportWritingAssets({ signal: client.signal });
      await client.assertAliveAfterIo();
      res.attachment('auto-novel-box-writing-assets.json');
      await sendJsonResponse(res, exported, { signal: client.signal });
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/writing-assets/extract', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      if (typeof nonStreamChat !== 'function') throw new Error('INTERNAL_ERROR');
      const input = validateExtractionInput(req.body);
      const duplicate = await store.findWritingAssetDuplicate(input.sourceText, {
        signal: client.signal,
      });
      if (duplicate) throw new Error('ASSET_DUPLICATE');
      const config = await store.readConfigForTask('digest', { signal: client.signal });
      const instruction = buildWritingAssetExtractionInstruction(input);
      const raw = await nonStreamChat({
        config,
        system: WRITING_ASSET_ANALYST_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: instruction }],
        signal: client.signal,
      });
      await client.assertAliveAfterIo();
      const analysis = extractWritingAssetAnalysis(raw);
      if (!analysis) throw new Error('ASSET_EXTRACTION_FAILED');
      const saved = await store.addWritingAsset({ ...input, analysis }, { signal: client.signal });
      await client.assertAliveAfterIo();
      if (!res.destroyed && !res.writableEnded) res.json(saved);
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/writing-assets/reference', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const input = validateReferenceInput(req.body);
      const saved = await store.addWritingAssetReference(input, { signal: client.signal });
      await client.assertAliveAfterIo();
      if (!res.destroyed && !res.writableEnded) res.json(saved);
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/writing-assets/books/:bookId/sections/:sectionId/chapters/:chapterId/native', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      if (typeof nonStreamChat !== 'function') throw new Error('INTERNAL_ERROR');
      const snapshot = await store.readChapterReviewContext(
        req.params.bookId, req.params.sectionId, req.params.chapterId,
        { signal: client.signal },
      );
      const published = snapshot.chapter.published;
      if (!published?.content?.trim()) throw new Error('ASSET_NATIVE_SOURCE_UNPUBLISHED');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body : {};
      const input = validateExtractionInput({
        ...body,
        sourceName: '本书已确认发布正文',
        sourceKind: 'book-native',
        sourceText: published.content,
        workNote: `第 ${snapshot.bookChapterIndex} 章 · ${snapshot.chapter.title || '未命名章节'}`,
        rightsNote: '作者确认的本书发布版本',
        referenceUrl: '',
      }, { allowBookNative: true });
      const duplicate = await store.findWritingAssetDuplicate(input.sourceText, {
        signal: client.signal,
      });
      if (duplicate) throw new Error('ASSET_DUPLICATE');
      const config = await store.readConfigForTask('digest', {
        signal: client.signal, bookId: req.params.bookId,
      });
      const raw = await nonStreamChat({
        config,
        system: WRITING_ASSET_ANALYST_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: buildWritingAssetExtractionInstruction(input),
        }],
        signal: client.signal,
      });
      await client.assertAliveAfterIo();
      const analysis = extractWritingAssetAnalysis(raw);
      if (!analysis) throw new Error('ASSET_EXTRACTION_FAILED');
      const saved = await store.addWritingAsset({
        ...input,
        sourceBookId: req.params.bookId,
        sourceSectionId: req.params.sectionId,
        sourceChapterId: req.params.chapterId,
        analysis,
      }, { signal: client.signal });
      await client.assertAliveAfterIo();
      if (!res.destroyed && !res.writableEnded) res.json(saved);
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/writing-assets/books/:bookId', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body : {};
      const result = await store.saveWritingAssetBookBinding(
        req.params.bookId,
        body.binding,
        { expectedRevision: body.expectedRevision, signal: client.signal },
      );
      await client.assertAliveAfterIo();
      if (!res.destroyed && !res.writableEnded) res.json(result);
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.delete('/api/writing-assets/:id', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const result = await store.deleteWritingAsset(req.params.id, {
        expectedRevision: req.body?.expectedRevision,
        signal: client.signal,
      });
      await client.assertAliveAfterIo();
      if (!res.destroyed && !res.writableEnded) res.json(result);
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });
}

import * as store from '../store.js';
import {
  buildSystemPrompt, buildContext, buildChapterReviewInstruction,
  buildStageSummaryInstruction, DIGEST_INSTRUCTION, STAGE_SUMMARY_SYSTEM_PROMPT,
} from '../prompts.js';
import { extractChapterReview, extractDigest } from '../llm.js';
import { sendJsonError } from '../http-error.js';
import { createClientAbortTracker } from '../client-abort.js';
import { sendJsonStream } from '../http-json.js';

const VERSION_REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function expectedVersionRevision(req) {
  const revision = req.body?.expectedRevision;
  if (typeof revision !== 'string' || !VERSION_REVISION_PATTERN.test(revision)) {
    throw new Error('BAD_VERSION_REVISION');
  }
  return revision;
}

function versionedResponse(versioned) {
  return { ...versioned, revision: store.versionRevision(versioned) };
}

function treeResponse(tree) {
  const core = tree.book.settings.core;
  return {
    ...tree,
    book: {
      ...tree.book,
      outline: versionedResponse(tree.book.outline),
      settings: {
        ...tree.book.settings,
        core: {
          world: versionedResponse(core.world),
          style: versionedResponse(core.style),
          constraints: versionedResponse(core.constraints),
          pacing: versionedResponse(core.pacing),
        },
      },
    },
  };
}

function sendRouteError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) res.destroy(error);
  else sendJsonError(res, error);
}

export function mountBookRoutes(app, deps = {}) {
  const nonStreamChat = deps.nonStreamChat;
  const listBooks = deps.listBooks ?? store.listBooks;
  const readBookStructure = deps.readBookStructure ?? store.readBookStructure;
  const sendJsonResponse = deps.sendJsonResponse ?? sendJsonStream;
  const readChapterReviewContext = deps.readChapterReviewContext
    ?? store.readChapterReviewContext;
  app.get('/api/books', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const books = await listBooks({ signal: client.signal });
      await client.assertAliveAfterIo();
      await sendJsonResponse(res, books, { signal: client.signal });
    } catch (e) {
      sendRouteError(res, e);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/books', async (req, res) => {
    try {
      const { premise, title, requestedBookId } = req.body || {};
      res.json(await store.createBook({ premise, title, requestedBookId }));
    } catch (e) { sendJsonError(res, e); }
  });

  app.get('/api/books/:id/tree', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const tree = await readBookStructure(req.params.id, { signal: client.signal });
      await client.assertAliveAfterIo();
      await sendJsonResponse(res, treeResponse(tree), { signal: client.signal });
    } catch (e) {
      sendRouteError(res, e);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/books/:id/serialization/settings', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const result = await store.updateBookSerializationSettings(req.params.id, {
        dailyWordGoal: req.body?.dailyWordGoal,
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

  app.post('/api/books/:id/platform-confirmations', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const result = await store.savePlatformConfirmation(req.params.id, req.body, {
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

  app.delete('/api/books/:id/platform-confirmations/:pid', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const result = await store.deletePlatformConfirmation(
        req.params.id, req.params.pid,
        { expectedRevision: req.body?.expectedRevision, signal: client.signal },
      );
      await client.assertAliveAfterIo();
      if (!res.destroyed && !res.writableEnded) res.json(result);
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.get('/api/books/:id/sections/:sid/chapters/:cid', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const snapshot = await readChapterReviewContext(
        req.params.id, req.params.sid, req.params.cid, { signal: client.signal },
      );
      await client.assertAliveAfterIo();
      await sendJsonResponse(res, {
        ...snapshot.chapter,
        body: versionedResponse(snapshot.chapter.body),
        published: store.chapterPublicationView(snapshot.chapter),
        reviewContextRevision: snapshot.contextRevision,
        memoryCandidates: store.chapterMemoryCandidatesView(
          snapshot.book, snapshot.chapter,
        ),
        memoryRevision: store.bookMemoryRevision(snapshot.book),
      }, { signal: client.signal });
    } catch (e) {
      sendRouteError(res, e);
    } finally {
      client.dispose();
    }
  });

  app.get('/api/books/:id/memory', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const library = await store.readBookMemory(req.params.id, { signal: client.signal });
      await client.assertAliveAfterIo();
      await sendJsonResponse(res, library, { signal: client.signal });
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/books/:id/memory-facts/:fid/deactivate', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const result = await store.deactivateMemoryFact(req.params.id, req.params.fid, {
        expectedMemoryRevision: req.body?.expectedMemoryRevision,
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

  app.post('/api/books/:id/stage-summaries/recompute', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      if (typeof nonStreamChat !== 'function') throw new Error('INTERNAL_ERROR');
      const source = await store.readStageSummarySource(req.params.id, req.body, {
        expectedStageSummaryRevision: req.body?.expectedStageSummaryRevision,
        signal: client.signal,
      });
      const config = await store.readConfigForTask('digest', {
        bookId: req.params.id, signal: client.signal,
      });
      const raw = await nonStreamChat({
        config,
        system: STAGE_SUMMARY_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: buildStageSummaryInstruction({ title: source.title, rows: source.rows }),
        }],
        signal: client.signal,
      });
      await client.assertAliveAfterIo();
      const summary = typeof raw === 'string' ? raw.trim() : '';
      if (!summary) throw new Error('STAGE_SUMMARY_FAILED');
      const result = await store.saveGeneratedStageSummary(req.params.id, {
        id: source.id,
        title: source.title,
        startSectionId: source.startSectionId,
        endSectionId: source.endSectionId,
        summary,
      }, {
        expectedStageSummaryRevision: req.body?.expectedStageSummaryRevision,
        expectedSourceFingerprint: source.fingerprint,
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

  app.post('/api/books/:id/stage-summaries/save', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const result = await store.saveStageSummary(req.params.id, req.body, {
        expectedStageSummaryRevision: req.body?.expectedStageSummaryRevision,
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

  app.post('/api/books/:id/stage-summaries/:stageId/delete', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const result = await store.deleteStageSummary(req.params.id, req.params.stageId, {
        expectedStageSummaryRevision: req.body?.expectedStageSummaryRevision,
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

  app.post('/api/books/:id/sections/:sid/chapters/:cid/publish', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const result = await store.publishChapterVersion(
        req.params.id, req.params.sid, req.params.cid,
        {
          expectedBodyFingerprint: req.body?.expectedBodyFingerprint,
          expectedMemoryRevision: req.body?.expectedMemoryRevision,
          signal: client.signal,
        },
      );
      await client.assertAliveAfterIo();
      if (!res.destroyed && !res.writableEnded) res.json(result);
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/books/:id/sections/:sid/chapters/:cid/publication/preflight', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const result = await store.readChapterPublicationPreflight(
        req.params.id, req.params.sid, req.params.cid,
        {
          expectedBodyFingerprint: req.body?.expectedBodyFingerprint,
          signal: client.signal,
        },
      );
      await client.assertAliveAfterIo();
      if (!res.destroyed && !res.writableEnded) {
        await sendJsonResponse(res, result, { signal: client.signal });
      }
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/books/:id/sections/:sid/chapters/:cid/memory/recompute', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const expectedBodyFingerprint = req.body?.expectedBodyFingerprint;
      if (typeof expectedBodyFingerprint !== 'string'
        || !VERSION_REVISION_PATTERN.test(expectedBodyFingerprint)) {
        throw new Error('BAD_MEMORY_BODY_FINGERPRINT');
      }
      const snapshot = await readChapterReviewContext(
        req.params.id, req.params.sid, req.params.cid, { signal: client.signal },
      );
      if (snapshot.chapter.bodyFingerprint !== expectedBodyFingerprint) {
        throw new Error('MEMORY_SOURCE_STALE');
      }
      const content = store.currentText(snapshot.chapter.body);
      if (!content.trim()) throw new Error('CHAPTER_EMPTY');
      const config = await store.readConfigForTask('digest', {
        bookId: req.params.id, signal: client.signal,
      });
      const raw = await nonStreamChat({
        config,
        system: '你是长篇小说的连续性编辑。只从给定正文提取摘要、人物状态和可核对事实；不得把推测写成事实。',
        messages: [{ role: 'user', content: `以下是当前已保存正文：\n${content}\n\n${DIGEST_INSTRUCTION}` }],
        signal: client.signal,
      });
      await client.assertAliveAfterIo();
      const digest = extractDigest(raw);
      const complete = digest
        && digest.digestParsed !== false
        && digest.digestCharactersParsed !== false
        && typeof digest.summary === 'string' && Boolean(digest.summary.trim())
        && typeof digest.progress === 'string' && Boolean(digest.progress.trim());
      if (!complete) throw new Error('MEMORY_RECOMPUTE_FAILED');
      // 显式重算只更新连续性派生信息，不借机改动作者已经看到的章名和部名。
      digest.chapterTitle = '';
      digest.sectionTitle = '';
      const applied = await store.applyChapterDigest(
        req.params.id, req.params.sid, req.params.cid, digest,
        { expectedBodyFingerprint, signal: client.signal },
      );
      if (!applied.applied) throw new Error('MEMORY_SOURCE_STALE');
      await client.assertAliveAfterIo();
      if (!res.destroyed && !res.writableEnded) res.json({
        bodyFingerprint: applied.chapter.bodyFingerprint,
        memoryCandidates: store.chapterMemoryCandidatesView(applied.book, applied.chapter),
        memoryRevision: store.bookMemoryRevision(applied.book),
      });
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/books/:id/sections', async (req, res) => {
    try {
      const hasAnchor = Object.prototype.hasOwnProperty.call(
        req.body ?? {}, 'expectedLastSectionId',
      );
      if (!hasAnchor || (req.body.expectedLastSectionId !== null
        && typeof req.body.expectedLastSectionId !== 'string')) {
        throw new Error('BAD_NEXT_SECTION_ANCHOR');
      }
      res.json(await store.addSection(req.params.id, {
        title: req.body?.title,
        titleSource: req.body?.titleSource,
        outline: req.body?.outline,
        expectedLastSectionId: req.body?.expectedLastSectionId,
      }));
    } catch (e) { sendJsonError(res, e); }
  });

  app.post('/api/books/:id/sections/:sid/chapters', async (req, res) => {
    try {
      const hasAnchor = Object.prototype.hasOwnProperty.call(
        req.body ?? {}, 'expectedLastChapterId',
      );
      if (!hasAnchor || (req.body.expectedLastChapterId !== null
        && typeof req.body.expectedLastChapterId !== 'string')) {
        throw new Error('BAD_NEXT_CHAPTER_ANCHOR');
      }
      res.json(await store.addChapter(req.params.id, req.params.sid, {
        title: req.body?.title,
        expectedLastChapterId: req.body?.expectedLastChapterId,
      }));
    }
    catch (e) { sendJsonError(res, e); }
  });

  app.post('/api/books/:id/sections/:sid/chapters/:cid/memory-candidates/:mid/decision', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const result = await store.decideMemoryCandidate(
        req.params.id, req.params.sid, req.params.cid, req.params.mid,
        {
          action: req.body?.action,
          expectedBodyFingerprint: req.body?.expectedBodyFingerprint,
          expectedMemoryRevision: req.body?.expectedMemoryRevision,
          signal: client.signal,
        },
      );
      await client.assertAliveAfterIo();
      if (!res.destroyed && !res.writableEnded) res.json(result);
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  // ——— 统一版本操作 ———
  app.post('/api/books/:id/version/move', async (req, res) => {
    try {
      const delta = req.body?.delta;
      if (delta !== -1 && delta !== 1) throw new Error('BAD_DELTA');
      const vf = await store.versionMove(req.params.id, req.body?.path, delta, {
        expectedRevision: expectedVersionRevision(req),
      });
      await sendJsonResponse(res, versionedResponse(vf));
    } catch (e) { sendRouteError(res, e); }
  });
  app.post('/api/books/:id/version/clear', async (req, res) => {
    try {
      const vf = await store.versionSet(req.params.id, req.body?.path, '', {
        expectedRevision: expectedVersionRevision(req),
      });
      await sendJsonResponse(res, versionedResponse(vf));
    }
    catch (e) { sendRouteError(res, e); }
  });
  app.post('/api/books/:id/version/save', async (req, res) => {
    try {
      // 清空有独立端点；save 缺少 text 或传 null 不能被静默解释为
      // 空字符串，否则畸形/截断请求会意外清空正文。
      const text = req.body?.text;
      if (typeof text !== 'string') throw new Error('BAD_TEXT');
      const vf = await store.versionSet(req.params.id, req.body?.path, text, {
        expectedRevision: expectedVersionRevision(req),
      });
      await sendJsonResponse(res, versionedResponse(vf));
    }
    catch (e) { sendRouteError(res, e); }
  });

  // ——— 书架管理 ———
  app.delete('/api/books/:id', async (req, res) => {
    try {
      res.json(await store.deleteBook(req.params.id, {
        expectedUpdatedAt: req.body?.expectedUpdatedAt,
      }));
    }
    catch (e) { sendJsonError(res, e); }
  });
  app.patch('/api/books/:id', async (req, res) => {
    try {
      const hasAnchor = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'expectedTitle');
      if (!hasAnchor || typeof req.body.expectedTitle !== 'string') {
        throw new Error('BAD_BOOK_TITLE_ANCHOR');
      }
      const renamed = await store.renameBook(req.params.id, req.body?.title, {
        expectedTitle: req.body?.expectedTitle,
      });
      await sendJsonResponse(res, renamed);
    }
    catch (e) { sendRouteError(res, e); }
  });

  // ——— 手动审稿 ———
  app.post('/api/books/:bookId/sections/:sid/chapters/:cid/review', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const { bookId, sid, cid } = req.params;
      const expectedBodyFingerprint = req.body?.expectedBodyFingerprint;
      const expectedContextRevision = req.body?.expectedContextRevision;
      if (typeof expectedBodyFingerprint !== 'string'
        || !VERSION_REVISION_PATTERN.test(expectedBodyFingerprint)
        || typeof expectedContextRevision !== 'string'
        || !VERSION_REVISION_PATTERN.test(expectedContextRevision)) {
        throw new Error('BAD_REVIEW_ANCHOR');
      }
      const reviewContext = await readChapterReviewContext(
        bookId, sid, cid, { signal: client.signal },
      );
      const {
        book, section, chapter, bookChapterIndex, recentReviewSignals,
        writingAssetContext, contextRevision,
      } = reviewContext;
      if (chapter.bodyFingerprint !== expectedBodyFingerprint) {
        throw new Error('REVIEW_STALE');
      }
      if (contextRevision !== expectedContextRevision) {
        throw new Error('REVIEW_CONTEXT_STALE');
      }
      const content = store.currentText(chapter.body);
      if (!content.trim()) throw new Error('CHAPTER_EMPTY');
      const config = await store.readConfigForTask('review', {
        signal: client.signal, bookId,
      });
      const system = buildSystemPrompt(book.settings?.core, writingAssetContext?.text ?? '');
      const context = buildContext({ book, section });
      const instruction = buildChapterReviewInstruction({
        chapterIndex: chapter.index, bookChapterIndex, content, context,
        recentReviewSignals,
      });
      const raw = await nonStreamChat({
        config, system, messages: [{ role: 'user', content: instruction }],
        signal: client.signal,
      });
      await client.assertAliveAfterIo();
      const review = extractChapterReview(raw);
      if (!review) throw new Error('REVIEW_FAILED');
      const saved = await store.saveChapterReview(bookId, sid, cid, review, {
        expectedBodyFingerprint: chapter.bodyFingerprint,
        expectedContextRevision: contextRevision,
        signal: client.signal,
      });
      if (!saved.applied) {
        const error = saved.reason === 'context' ? 'REVIEW_CONTEXT_STALE' : 'REVIEW_STALE';
        return res.status(409).json({ error });
      }
      if (!res.destroyed && !res.writableEnded) res.json(saved.review);
    } catch (e) {
      if (res.destroyed || res.writableEnded) return;
      sendJsonError(res, e);
    } finally {
      client.dispose();
    }
  });
}

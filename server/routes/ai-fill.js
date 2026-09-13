import * as store from '../store.js';
import {
  buildStoryEngineDraftInstruction, buildCharacterCraftDraftInstruction,
  buildPromiseLedgerDraftInstruction,
} from '../ai-fill-prompts.js';
import {
  extractStoryEngineDraft, extractCharacterCraftDraft, extractPromiseLedgerDraft,
} from '../ai-fill-extract.js';
import { sendJsonError } from '../http-error.js';
import { createClientAbortTracker } from '../client-abort.js';
import { storyEngineRevision } from '../story-engine-schema.js';
import { MAX_TOTAL_BOOK_CHAPTERS } from '../limits.js';

const REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const AI_FILL_SYSTEM_PROMPT = [
  '你是长篇小说的创作策划编辑。',
  '只根据用户给出的故事材料返回指定结构，不写正文，不把计划冒充已经发生的事实。',
].join('');

function sendRouteError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) res.destroy(error);
  else sendJsonError(res, error);
}

function requireRevision(value, errorCode) {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    throw new Error(errorCode);
  }
  return value;
}

function requireChat(nonStreamChat) {
  if (typeof nonStreamChat !== 'function') throw new Error('INTERNAL_ERROR');
  return nonStreamChat;
}

function completedChapterCount(tree) {
  return Array.isArray(tree?.sections)
    ? tree.sections.reduce((total, section) => total
      + (Array.isArray(section?.chapters)
        ? section.chapters.filter((chapter) => chapter?.hasContent).length : 0), 0)
    : 0;
}

function bookMaterials(book) {
  return {
    premise: book.premise || '',
    outline: store.currentText(book.outline),
    world: store.currentText(book.settings?.core?.world),
    style: store.currentText(book.settings?.core?.style),
    storyEngine: book.settings?.storyEngine || {},
  };
}

export function mountAiFillRoutes(app, deps = {}) {
  const nonStreamChat = deps.nonStreamChat;

  app.post('/api/gen/story-engine-draft', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const chat = requireChat(nonStreamChat);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body : {};
      const expectedRevision = requireRevision(
        body.expectedRevision, 'BAD_STORY_ENGINE_REVISION',
      );
      const book = await store.readBook(body.bookId, { signal: client.signal });
      if (storyEngineRevision(book.settings.storyEngine) !== expectedRevision) {
        throw new Error('STORY_ENGINE_CONFLICT');
      }
      const config = await store.readConfigForTask(
        'outline', { signal: client.signal, bookId: body.bookId },
      );
      const raw = await chat({
        config,
        system: AI_FILL_SYSTEM_PROMPT,
        signal: client.signal,
        messages: [{ role: 'user', content: buildStoryEngineDraftInstruction(bookMaterials(book)) }],
        task: 'story-engine-draft',
      });
      await client.assertAliveAfterIo();
      const storyEngine = extractStoryEngineDraft(raw);
      if (!storyEngine) throw new Error('STORY_ENGINE_DRAFT_FAILED');
      if (!res.destroyed && !res.writableEnded) {
        res.json({ storyEngine, baseRevision: expectedRevision });
      }
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/gen/character-craft-draft', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const chat = requireChat(nonStreamChat);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body : {};
      const expectedRevision = requireRevision(
        body.expectedRevision, 'BAD_CHARACTER_CRAFT_REVISION',
      );
      const tree = await store.readBookStructure(
        body.bookId, { signal: client.signal },
      );
      const [book, craft] = await Promise.all([
        store.readBook(body.bookId, { signal: client.signal }),
        store.readCharacterCraft(body.bookId, { signal: client.signal }),
      ]);
      const asOfChapter = Math.max(
        1, Math.min(MAX_TOTAL_BOOK_CHAPTERS, completedChapterCount(tree) || 1),
      );
      if (craft.revision !== expectedRevision) throw new Error('CHARACTER_CRAFT_CONFLICT');
      const config = await store.readConfigForTask(
        'outline', { signal: client.signal, bookId: body.bookId },
      );
      const raw = await chat({
        config,
        system: AI_FILL_SYSTEM_PROMPT,
        signal: client.signal,
        messages: [{
          role: 'user',
          content: buildCharacterCraftDraftInstruction({
            ...bookMaterials(book),
            existingNames: craft.characters.map((entry) => entry.name),
          }),
        }],
        task: 'character-craft-draft',
      });
      await client.assertAliveAfterIo();
      const draft = extractCharacterCraftDraft(raw, { asOfChapter });
      if (!draft) throw new Error('CHARACTER_CRAFT_DRAFT_FAILED');
      if (!res.destroyed && !res.writableEnded) {
        res.json({ ...draft, baseRevision: expectedRevision });
      }
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });

  app.post('/api/gen/promise-ledger-draft', async (req, res) => {
    const client = createClientAbortTracker(req, res);
    try {
      const chat = requireChat(nonStreamChat);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body : {};
      const expectedRevision = requireRevision(
        body.expectedRevision, 'BAD_PROMISE_LEDGER_REVISION',
      );
      const tree = await store.readBookStructure(
        body.bookId, { signal: client.signal },
      );
      const [book, ledger] = await Promise.all([
        store.readBook(body.bookId, { signal: client.signal }),
        store.readPromiseLedger(body.bookId, { signal: client.signal }),
      ]);
      const completed = completedChapterCount(tree);
      const startChapter = Math.min(
        MAX_TOTAL_BOOK_CHAPTERS, Math.max(1, completed + 1),
      );
      if (ledger.revision !== expectedRevision) throw new Error('PROMISE_LEDGER_CONFLICT');
      const config = await store.readConfigForTask(
        'outline', { signal: client.signal, bookId: body.bookId },
      );
      const raw = await chat({
        config,
        system: AI_FILL_SYSTEM_PROMPT,
        signal: client.signal,
        messages: [{
          role: 'user',
          content: buildPromiseLedgerDraftInstruction({
            ...bookMaterials(book), startChapter,
          }),
        }],
        task: 'promise-ledger-draft',
      });
      await client.assertAliveAfterIo();
      const entries = extractPromiseLedgerDraft(raw, { startChapter });
      if (!entries) throw new Error('PROMISE_LEDGER_DRAFT_FAILED');
      if (!res.destroyed && !res.writableEnded) {
        res.json({ entries, baseRevision: expectedRevision });
      }
    } catch (error) {
      sendRouteError(res, error);
    } finally {
      client.dispose();
    }
  });
}

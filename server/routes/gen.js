import * as store from '../store.js';
import {
  buildSystemPrompt, buildContext, buildChapterInstruction,
  buildOutlineInstruction, buildSectionsInstruction, buildCoreFieldInstruction,
  buildBookTitleInstruction, DIGEST_INSTRUCTION,
} from '../prompts.js';
import { extractDigest as defaultExtract, sanitizeGeneratedTitle } from '../llm.js';

function sseInit(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const abortController = new AbortController();
  res.locals.abortSignal = abortController.signal;
  res.locals.clientGone = false;
  const markClientGone = () => {
    res.locals.clientGone = true;
    abortController.abort();
  };
  req.on('aborted', markClientGone);
  res.on('close', () => {
    if (!res.writableEnded) markClientGone();
  });
}
const isClientGone = (req, res) => req.aborted || res.locals.clientGone || res.locals.abortSignal?.aborted || res.destroyed || res.writableEnded;
function assertClientAlive(req, res) {
  if (isClientGone(req, res)) throw new Error('CLIENT_ABORTED');
}
const send = (res, obj) => {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
};
const end = (res) => {
  if (!res.destroyed && !res.writableEnded) res.end();
};

export function mountGenRoutes(app, deps = {}) {
  const streamChat = deps.streamChat;         // 由 index.js 注入真实实现
  const nonStreamChat = deps.nonStreamChat;
  const extractDigest = deps.extractDigest || defaultExtract;

  async function streamInto(req, res, { config, system, instruction }) {
    let full = '';
    for await (const delta of streamChat({ config, system, messages: [{ role: 'user', content: instruction }], signal: res.locals.abortSignal })) {
      assertClientAlive(req, res);
      full += delta;
      send(res, { delta });
    }
    assertClientAlive(req, res);
    return full;
  }

  app.post('/api/books/:id/version/rewrite', async (req, res) => {
    sseInit(req, res);
    try {
      const { path } = req.body || {};
      const p = store.parseVersionPath(path);       // 非法 path 抛 BAD_PATH
      if (p.type === 'chapter') throw new Error('章节请用 /api/gen/chapter');
      const config = await store.readConfig();
      const book = await store.readBook(req.params.id);
      const system = buildSystemPrompt(book.settings.core);
      const instruction = p.type === 'outline'
        ? buildOutlineInstruction(book.premise)
        : buildCoreFieldInstruction(p.field, book);
      const full = await streamInto(req, res, { config, system, instruction });
      const vf = await store.versionSet(req.params.id, path, full);
      if (p.type === 'outline') {
        try {
          const freshBook = await store.readBook(req.params.id);
          if (freshBook.titleSource === 'default') {
            const rawTitle = await nonStreamChat({
              config,
              system,
              signal: res.locals.abortSignal,
              messages: [{
                role: 'user',
                content: buildBookTitleInstruction(freshBook.premise, full),
              }],
            });
            const title = sanitizeGeneratedTitle(rawTitle);
            if (title) {
              const latest = await store.readBook(req.params.id);
              if (latest.titleSource === 'default') {
                latest.title = title;
                latest.titleSource = 'ai';
                await store.writeBook(latest.id, latest);
              }
            }
          }
        } catch { /* 书名失败不影响大纲 */ }
      }
      send(res, { done: true, versions: vf.versions, cursor: vf.cursor });
    } catch (e) { send(res, { error: String(e.message || e) }); }
    end(res);
  });

  // 让 LLM 规划分部结构，SSE 流式返回文本；不自动建部，由用户参考后手动新建
  app.post('/api/gen/sections', async (req, res) => {
    sseInit(req, res);
    try {
      const config = await store.readConfig();
      const book = await store.readBook(req.body.bookId);
      const system = buildSystemPrompt(book.settings.core);
      const full = await streamInto(req, res, {
        config, system,
        // outline 迁移后是 {versions,cursor}，需通过 currentText 读当前版本；直接 .content 会得到 undefined
        instruction: buildSectionsInstruction(store.currentText(book.outline)),
      });
      send(res, { done: true, sections: full });
    } catch (e) { send(res, { error: String(e.message || e) }); }
    end(res);
  });

  app.post('/api/gen/chapter', async (req, res) => {
    sseInit(req, res);
    const { bookId, sectionId, mode, whip } = req.body;
    let createdChapterId = null;  // mode==='next' 时新建的空章，失败要回滚
    let full = '';
    try {
      const config = await store.readConfig();
      const book = await store.readBook(bookId);
      const section = await store.readSection(bookId, sectionId);

      // 定位/新建目标章
      let chapterId = req.body.chapterId;
      let chapter;
      if (mode === 'next') {
        chapter = await store.addChapter(bookId, sectionId, {});
        chapterId = chapter.id;
        createdChapterId = chapterId;
      } else {
        chapter = await store.readChapter(bookId, sectionId, chapterId);
      }

      // 上一章（用于上下文路标）：本章之前的最后一章
      const freshSection = await store.readSection(bookId, sectionId);
      const idx = freshSection.chapters.indexOf(chapterId);
      const prevId = idx > 0 ? freshSection.chapters[idx - 1] : null;
      const prevChapter = prevId ? await store.readChapter(bookId, sectionId, prevId) : null;

      const system = buildSystemPrompt(book.settings.core);
      const context = buildContext({ book, section, prevChapter });
      const currentContent = mode === 'whip' ? store.currentText(chapter.body) : '';
      const instruction = context + '\n\n' +
        buildChapterInstruction({ chapterIndex: chapter.index, wordTarget: config.chapterWordTarget, mode, whip, currentContent });

      full = await streamInto(req, res, { config, system, instruction });
      store.commitVersion(chapter.body, full);      // 写入新版；writeChapter 会同步派生 content
      await store.writeChapter(bookId, sectionId, chapterId, chapter);

      // —— 自动 digest（失败不阻塞）——
      try {
        const digestText = await nonStreamChat({
          config, system,
          signal: res.locals.abortSignal,
          messages: [{ role: 'user', content: `以下是正文：\n${full}\n\n${DIGEST_INSTRUCTION}` }],
        });
        assertClientAlive(req, res);
        const d = extractDigest(digestText);
        // 仅当 digest 解析出有效值时才更新，避免空值覆盖已有 summary/progress（断片保护）
        const latestChapter = await store.readChapter(bookId, sectionId, chapterId);
        if (d.chapterTitle && latestChapter.titleSource === 'default') {
          latestChapter.title = d.chapterTitle;
          latestChapter.titleSource = 'ai';
        }
        if (d.summary) latestChapter.summary = d.summary;
        if (d.progress) latestChapter.progress = d.progress;
        if (d.newCharacters.length) latestChapter.characters.push(...d.newCharacters);
        // 冒泡
        const sec = await store.readSection(bookId, sectionId);
        if (d.sectionTitle && sec.titleSource === 'default') {
          let hasOtherCompleted = false;
          for (const cid of sec.chapters) {
            if (cid === chapterId) continue;
            const other = await store.readChapter(bookId, sectionId, cid);
            if (store.currentText(other.body).trim()) {
              hasOtherCompleted = true;
              break;
            }
          }
          if (!hasOtherCompleted) {
            sec.title = d.sectionTitle;
            sec.titleSource = 'ai';
          }
        }
        if (d.summary) sec.summary = (sec.summary ? sec.summary + '\n' : '') + `第${latestChapter.index}章：${d.summary}`;
        if (d.progress) sec.progress = d.progress;
        await store.writeSection(bookId, sectionId, sec);
        const bk = await store.readBook(bookId);
        if (d.progress) bk.progress = d.progress;
        await store.writeBook(bookId, bk);
        await store.writeChapter(bookId, sectionId, chapterId, latestChapter);
      } catch { /* digest 失败不影响正文保存 */ }

      send(res, { done: true, chapterId });
    } catch (e) {
      // 空章回滚：mode==='next' 新建了章，但正文从未成功写入，则从 section.chapters 中移除
      if (mode === 'next' && createdChapterId && !full) {
        try {
          await store.deleteChapter(bookId, sectionId, createdChapterId);
        } catch { /* 回滚失败不再二次抛错 */ }
      }
      send(res, { error: String(e.message || e) });
    }
    end(res);
  });
}

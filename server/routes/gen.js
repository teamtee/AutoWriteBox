import * as store from '../store.js';
import {
  buildSystemPrompt, buildContext, buildChapterInstruction,
  buildOutlineInstruction, buildSectionsInstruction, DIGEST_INSTRUCTION,
} from '../prompts.js';
import { extractDigest as defaultExtract } from '../llm.js';

function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}
const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

export function mountGenRoutes(app, deps = {}) {
  const streamChat = deps.streamChat;         // 由 index.js 注入真实实现
  const nonStreamChat = deps.nonStreamChat;
  const extractDigest = deps.extractDigest || defaultExtract;

  async function streamInto(res, { config, system, instruction }) {
    let full = '';
    for await (const delta of streamChat({ config, system, messages: [{ role: 'user', content: instruction }] })) {
      full += delta;
      send(res, { delta });
    }
    return full;
  }

  app.post('/api/gen/outline', async (req, res) => {
    sseInit(res);
    try {
      const config = await store.readConfig();
      const book = await store.readBook(req.body.bookId);
      const system = buildSystemPrompt(book.settings.core);
      const full = await streamInto(res, { config, system, instruction: buildOutlineInstruction(book.premise) });
      store.pushHistory(book, 'outline');
      book.outline.content = full;
      await store.writeBook(book.id, book);
      send(res, { done: true });
    } catch (e) { send(res, { error: String(e.message || e) }); }
    res.end();
  });

  // 让 LLM 规划分部结构，SSE 流式返回文本；不自动建部，由用户参考后手动新建
  app.post('/api/gen/sections', async (req, res) => {
    sseInit(res);
    try {
      const config = await store.readConfig();
      const book = await store.readBook(req.body.bookId);
      const system = buildSystemPrompt(book.settings.core);
      const full = await streamInto(res, {
        config, system,
        instruction: buildSectionsInstruction(book.outline.content),
      });
      send(res, { done: true, sections: full });
    } catch (e) { send(res, { error: String(e.message || e) }); }
    res.end();
  });

  app.post('/api/gen/chapter', async (req, res) => {
    sseInit(res);
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
        store.pushHistory(chapter, 'content');
      }

      // 上一章（用于上下文路标）：本章之前的最后一章
      const freshSection = await store.readSection(bookId, sectionId);
      const idx = freshSection.chapters.indexOf(chapterId);
      const prevId = idx > 0 ? freshSection.chapters[idx - 1] : null;
      const prevChapter = prevId ? await store.readChapter(bookId, sectionId, prevId) : null;

      const system = buildSystemPrompt(book.settings.core);
      const context = buildContext({ book, section, prevChapter });
      const instruction = context + '\n\n' +
        buildChapterInstruction({ chapterIndex: chapter.index, wordTarget: config.chapterWordTarget, mode, whip });

      full = await streamInto(res, { config, system, instruction });
      chapter.content = full;
      await store.writeChapter(bookId, sectionId, chapterId, chapter);

      // —— 自动 digest（失败不阻塞）——
      try {
        const digestText = await nonStreamChat({
          config, system,
          messages: [{ role: 'user', content: `以下是正文：\n${full}\n\n${DIGEST_INSTRUCTION}` }],
        });
        const d = extractDigest(digestText);
        // 仅当 digest 解析出有效值时才更新，避免空值覆盖已有 summary/progress（断片保护）
        if (d.summary) chapter.summary = d.summary;
        if (d.progress) chapter.progress = d.progress;
        if (d.newCharacters.length) chapter.characters.push(...d.newCharacters);
        await store.writeChapter(bookId, sectionId, chapterId, chapter);
        // 冒泡
        const sec = await store.readSection(bookId, sectionId);
        if (d.summary) sec.summary = (sec.summary ? sec.summary + '\n' : '') + `第${chapter.index}章：${d.summary}`;
        if (d.progress) sec.progress = d.progress;
        await store.writeSection(bookId, sectionId, sec);
        const bk = await store.readBook(bookId);
        if (d.progress) bk.progress = d.progress;
        await store.writeBook(bookId, bk);
      } catch { /* digest 失败，正文已保存，跳过 */ }

      send(res, { done: true, chapterId });
    } catch (e) {
      // 空章回滚：mode==='next' 新建了章，但正文从未成功写入，则从 section.chapters 中移除
      if (mode === 'next' && createdChapterId && !full) {
        try {
          const sec = await store.readSection(bookId, sectionId);
          sec.chapters = sec.chapters.filter((cid) => cid !== createdChapterId);
          await store.writeSection(bookId, sectionId, sec);
        } catch { /* 回滚失败不再二次抛错 */ }
      }
      send(res, { error: String(e.message || e) });
    }
    res.end();
  });
}

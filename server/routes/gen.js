import * as store from '../store.js';
import { performance } from 'node:perf_hooks';
import {
  buildSystemPrompt, buildContext, buildChapterInstruction,
  buildOutlineInstruction, buildSectionsInstruction, buildCoreFieldInstruction,
  buildBookTitleInstruction, buildChapterTitlesInstruction,
  DIGEST_INSTRUCTION, buildChapterReviewInstruction,
} from '../prompts.js';
import {
  extractDigest as defaultExtract, extractGeneratedTitles,
  sanitizeGeneratedTitle, extractChapterReview, extractSectionsPlan,
} from '../llm.js';
import {
  LLM_OUTPUT_JOIN_CHUNK_CHARS, MAX_LLM_OUTPUT_CHARS, MAX_WHIP_CHARS,
} from '../limits.js';
import { publicErrorCode } from '../http-error.js';

const VERSION_REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_SSE_DRAIN_TIMEOUT_MS = 30_000;
const MAX_SSE_DELTA_BATCH_CHARS = 1_024;
const MAX_SSE_DELTA_BATCH_DELAY_MS = 50;

function requireVersionRevision(value, errorCode = 'BAD_VERSION_REVISION') {
  if (typeof value !== 'string' || !VERSION_REVISION_PATTERN.test(value)) {
    throw new Error(errorCode);
  }
  return value;
}

function sseInit(req, res, heartbeatMs) {
  res.setHeader('Content-Type', 'text/event-stream');
  // 流中含有未公开的生成正文，不能用仅要求重新验证的 no-cache。
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  // Nginx 等代理默认可能缓冲上游响应；显式关闭后，正文 delta 才会
  // 实时到达浏览器，停止按钮也能基于当前进度工作。
  res.setHeader('X-Accel-Buffering', 'no');
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
  // 在调用可能长时间没有首 token 的模型前先提交 SSE 响应头。否则浏览器
  // 的 fetch 可能一直停在“等待响应”，代理也无法及时识别流式响应策略。
  res.flushHeaders();
  // 注释帧不会进入业务事件解析，但能防止代理在模型首 token、摘要或审稿
  // 静默期按空闲连接超时断开。响应结束和客户端离开时必须回收计时器。
  const heartbeat = setInterval(() => {
    // 正文写入已触发背压时不再排队心跳；已有业务数据本身就证明连接活跃。
    if (res.destroyed || res.writableEnded || res.writableNeedDrain) return;
    res.write(': keepalive\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();
  const stopHeartbeat = () => clearInterval(heartbeat);
  res.once('finish', stopHeartbeat);
  res.once('close', stopHeartbeat);
}
const isClientGone = (req, res) => req.aborted || res.locals.clientGone || res.locals.abortSignal?.aborted || res.destroyed || res.writableEnded;
function assertClientAlive(req, res) {
  if (isClientGone(req, res)) throw new Error('CLIENT_ABORTED');
}
async function assertClientAliveAfterIo(req, res) {
  // 让 socket close/abort 事件在不可逆写入前先获得一次处理机会。
  await new Promise((resolve) => setImmediate(resolve));
  assertClientAlive(req, res);
}
const send = (res, obj) => {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
};

// 对正文流显式遵守 Node 可写流背压。模型可能用单字符事件快速产出，
// 若浏览器读取较慢而继续无条件 res.write，会在进程内排队大量小写操作。
// 等待期间客户端断开会触发当前请求的 AbortSignal，并立即释放上游模型流。
export async function writeSseEventWithBackpressure(res, obj, {
  drainTimeoutMs = DEFAULT_SSE_DRAIN_TIMEOUT_MS,
} = {}) {
  const signal = res.locals?.abortSignal;
  if (res.destroyed || res.writableEnded || signal?.aborted) {
    throw new Error('CLIENT_ABORTED');
  }
  if (res.write(`data: ${JSON.stringify(obj)}\n\n`)) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      res.off('drain', onDrain);
      res.off('close', onGone);
      res.off('error', onGone);
      signal?.removeEventListener?.('abort', onGone);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onGone = () => finish(new Error('CLIENT_ABORTED'));
    const onTimeout = () => {
      const error = new Error('RESPONSE_BACKPRESSURE_TIMEOUT');
      finish(error);
      res.destroy?.();
    };
    res.once('drain', onDrain);
    res.once('close', onGone);
    res.once('error', onGone);
    signal?.addEventListener?.('abort', onGone, { once: true });
    // 断连可能发生在入口检查与监听器注册之间。
    if (res.destroyed || res.writableEnded || signal?.aborted) onGone();
    else {
      const boundedTimeoutMs = Number.isSafeInteger(drainTimeoutMs) && drainTimeoutMs > 0
        ? drainTimeoutMs
        : DEFAULT_SSE_DRAIN_TIMEOUT_MS;
      timer = setTimeout(onTimeout, boundedTimeoutMs);
      timer.unref?.();
    }
  });
}
const end = (res) => {
  if (!res.destroyed && !res.writableEnded) res.end();
};

export function mountGenRoutes(app, deps = {}) {
  const streamChat = deps.streamChat;         // 由 index.js 注入真实实现
  const nonStreamChat = deps.nonStreamChat;
  const extractDigest = deps.extractDigest || defaultExtract;
  const heartbeatMs = Number.isSafeInteger(deps.sseHeartbeatMs)
    && deps.sseHeartbeatMs > 0
    ? deps.sseHeartbeatMs
    : DEFAULT_SSE_HEARTBEAT_MS;
  const drainTimeoutMs = Number.isSafeInteger(deps.sseDrainTimeoutMs)
    && deps.sseDrainTimeoutMs > 0
    ? deps.sseDrainTimeoutMs
    : DEFAULT_SSE_DRAIN_TIMEOUT_MS;

  async function streamInto(req, res, { config, system, instruction }) {
    const fullChunks = [];
    let fullPending = '';
    let fullLength = 0;
    let pendingDelta = '';
    let sentFirstDelta = false;
    let lastFlushAt = 0;
    const flushDelta = async () => {
      if (!pendingDelta) return;
      const delta = pendingDelta;
      pendingDelta = '';
      await writeSseEventWithBackpressure(res, { delta }, { drainTimeoutMs });
      sentFirstDelta = true;
      lastFlushAt = performance.now();
    };
    for await (const delta of streamChat({ config, system, messages: [{ role: 'user', content: instruction }], signal: res.locals.abortSignal })) {
      assertClientAlive(req, res);
      if (typeof delta !== 'string') {
        throw new Error('LLM_STREAM_ERROR: LLM_SSE_INVALID_EVENT');
      }
      if (fullLength + delta.length > MAX_LLM_OUTPUT_CHARS) {
        throw new Error('LLM_RESPONSE_TOO_LARGE');
      }
      fullPending += delta;
      if (fullPending.length >= LLM_OUTPUT_JOIN_CHUNK_CHARS) {
        fullChunks.push(fullPending);
        fullPending = '';
      }
      fullLength += delta.length;
      pendingDelta += delta;
      // 批量延迟属于持续时间，必须使用单调时钟；系统时间回拨不应让
      // 低频 delta 一直等到累计 1024 字符才刷新到页面。
      const now = performance.now();
      if (!sentFirstDelta || pendingDelta.length >= MAX_SSE_DELTA_BATCH_CHARS
        || now - lastFlushAt >= MAX_SSE_DELTA_BATCH_DELAY_MS) {
        await flushDelta();
      }
    }
    await flushDelta();
    assertClientAlive(req, res);
    const full = fullChunks.join('') + fullPending;
    if (!full.trim()) throw new Error('LLM_EMPTY_RESPONSE');
    return full;
  }

  app.post('/api/books/:id/version/rewrite', async (req, res) => {
    sseInit(req, res, heartbeatMs);
    const postprocessWarnings = new Set();
    try {
      const { path } = req.body || {};
      const p = store.parseVersionPath(path);       // 非法 path 抛 BAD_PATH
      if (p.type === 'chapter') throw new Error('BAD_VERSION_REWRITE_PATH');
      const requestedRevision = requireVersionRevision(req.body?.expectedRevision);
      const configSelection = await store.readConfigForTaskSelection(
        'outline', { signal: res.locals.abortSignal, bookId: req.params.id },
      );
      const config = configSelection.config;
      const book = await store.readBook(req.params.id, { signal: res.locals.abortSignal });
      const targetVersioned = p.type === 'outline'
        ? book.outline
        : book.settings.core[p.field];
      store.assertExpectedVersionRevision(targetVersioned, requestedRevision);
      const targetRevision = store.versionRevision(targetVersioned);
      const contextRevision = store.bookGenerationContextRevision(book);
      const system = buildSystemPrompt(book.settings.core);
      const instruction = p.type === 'outline'
        ? buildOutlineInstruction(book.premise)
        : buildCoreFieldInstruction(p.field, book);
      const full = await streamInto(req, res, { config, system, instruction });
      await assertClientAliveAfterIo(req, res);
      await store.commitGeneratedBookVersion(req.params.id, path, full, {
        expectedRevision: targetRevision,
        expectedContextRevision: contextRevision,
        signal: res.locals.abortSignal,
      });
      send(res, { saved: true });
      if (p.type === 'outline') {
        try {
          const freshBook = await store.readBook(
            req.params.id, { signal: res.locals.abortSignal },
          );
          if (freshBook.titleSource === 'default') {
            const expectedOutlineRevision = store.versionRevision(freshBook.outline);
            const expectedTitleContextRevision = store.bookGenerationContextRevision(freshBook);
            const titleConfig = configSelection.source === 'book'
              ? config
              : await store.readConfigForTask(
                'title', { signal: res.locals.abortSignal, bookId: req.params.id },
              );
            const rawTitle = await nonStreamChat({
              config: titleConfig,
              system,
              signal: res.locals.abortSignal,
              messages: [{
                role: 'user',
                content: buildBookTitleInstruction(freshBook.premise, full),
              }],
            });
            assertClientAlive(req, res);
            const title = sanitizeGeneratedTitle(rawTitle);
            if (title) {
              // 最终写入前再做一次异步读，也让客户端断开事件得以被观测。
              await store.readBook(req.params.id, { signal: res.locals.abortSignal });
              assertClientAlive(req, res);
              const titleResult = await store.setGeneratedBookTitle(req.params.id, title, {
                expectedOutlineRevision,
                expectedContextRevision: expectedTitleContextRevision,
                signal: res.locals.abortSignal,
              });
              // 并发人工改名代表用户已经给出更权威的名称，无需告警；若
              // 存储层因其它上下文变化拒绝且作品仍为默认名，则明确降级。
              if (!titleResult.applied && titleResult.book.titleSource === 'default') {
                postprocessWarnings.add('title');
              }
            } else {
              postprocessWarnings.add('title');
            }
          }
        } catch (error) {
          // 大纲已经保存，书名失败不能回滚正文；但必须让仍在线的页面知道
          // 这是降级完成。客户端离开则直接结束，不能把取消伪装成正常 done。
          if (isClientGone(req, res)) throw new Error('CLIENT_ABORTED');
          postprocessWarnings.add('title');
        }
      }
      // saved 已确认内容落盘，客户端会重新读取权威状态。不在终止帧
      // 重复传输整份版本历史，否则最坏会额外携带数百万字符。
      send(res, {
        done: true,
        ...(postprocessWarnings.size
          ? { postprocessWarnings: [...postprocessWarnings] }
          : {}),
      });
    } catch (e) { send(res, { error: publicErrorCode(e) }); }
    end(res);
  });

  // 让 LLM 规划分部结构，SSE 流式返回文本；不自动建部，由用户参考后手动新建
  app.post('/api/gen/sections', async (req, res) => {
    sseInit(req, res, heartbeatMs);
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const expectedContextRevision = requireVersionRevision(
        body.expectedContextRevision, 'BAD_GENERATION_CONTEXT_REVISION',
      );
      const config = await store.readConfigForTask(
        'outline', { signal: res.locals.abortSignal, bookId: body.bookId },
      );
      const book = await store.readBook(body.bookId, { signal: res.locals.abortSignal });
      if (store.sectionPlanContextRevision(book) !== expectedContextRevision) {
        throw new Error('GENERATION_CONTEXT_CONFLICT');
      }
      const system = buildSystemPrompt(book.settings.core);
      const full = await streamInto(req, res, {
        config, system,
        // outline 迁移后是 {versions,cursor}，需通过 currentText 读当前版本；直接 .content 会得到 undefined
        instruction: buildSectionsInstruction(store.currentText(book.outline)),
      });
      await assertClientAliveAfterIo(req, res);
      const latestBook = await store.readBook(
        body.bookId, { signal: res.locals.abortSignal },
      );
      if (store.sectionPlanContextRevision(latestBook) !== expectedContextRevision) {
        throw new Error('GENERATION_CONTEXT_CONFLICT');
      }
      const parsed = extractSectionsPlan(full);
      if (parsed) {
        send(res, {
          done: true,
          sections: full,
          parsedTitles: parsed.map((s) => s.title),
          parsedSections: parsed,
        });
      } else {
        send(res, { done: true, sections: full, parseError: true });
      }
    } catch (e) { send(res, { error: publicErrorCode(e) }); }
    end(res);
  });

  app.post('/api/gen/chapter', async (req, res) => {
    sseInit(req, res, heartbeatMs);
    // 空 POST 或非 JSON 表单请求不会经过 express.json() 填充 req.body。
    // 先归一化，确保错误进入下方 SSE 错误处理，而不是在 try 外抛 TypeError。
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { bookId, sectionId, chapterId: requestedChapterId, mode, whip } = body;
    let createdChapterId = null;  // mode==='next' 时新建的空章，失败要回滚
    let createdChapterRollback = null;
    let targetRevision = null;
    let bodySaved = false;
    let full = '';
    const postprocessWarnings = new Set();
    try {
      if (!['next', 'rewrite', 'whip'].includes(mode)) throw new Error('BAD_MODE');
      if (mode !== 'next') requireVersionRevision(body.expectedRevision);
      if (mode === 'next') {
        const hasAnchor = Object.prototype.hasOwnProperty.call(body, 'expectedLastChapterId');
        if (!hasAnchor || (body.expectedLastChapterId !== null
          && typeof body.expectedLastChapterId !== 'string')) {
          throw new Error('BAD_NEXT_CHAPTER_ANCHOR');
        }
      }
      // 即使当前模式不会消费 whip，也不能让对象/数字一路进入下面的
      // optional-call `.trim()` 并变成 INTERNAL_ERROR。所有已提供字段先按
      // 公开请求契约校验类型，whip 模式再校验非空和长度。
      if (whip !== undefined && typeof whip !== 'string') throw new Error('BAD_WHIP');
      if (mode === 'whip' && (typeof whip !== 'string' || !whip.trim())) throw new Error('BAD_WHIP');
      if (mode === 'whip' && whip.length > MAX_WHIP_CHARS) throw new Error('WHIP_TOO_LARGE');
      const chapterConfigSelection = await store.readConfigForTaskSelection(
        'chapter', { signal: res.locals.abortSignal, bookId },
      );
      const config = chapterConfigSelection.config;

      // 定位/新建目标章
      let chapterId = requestedChapterId;
      if (mode === 'next') {
        await assertClientAliveAfterIo(req, res);
        const created = await store.addChapter(bookId, sectionId, {
          expectedLastChapterId: body.expectedLastChapterId,
          includeRollbackMetadata: true,
          signal: res.locals.abortSignal,
        });
        chapterId = created.chapter.id;
        createdChapterId = chapterId;
        createdChapterRollback = created.rollback;
        // 结构事务一旦提交就必须拥有可用的回滚锚点。不能等随后读取生成
        // 上下文才赋值：客户端可能恰好在两步之间断开或排队时取消。
        targetRevision = store.versionRevision(created.chapter.body);
      }
      const generationContext = await store.readChapterGenerationContext(
        bookId, sectionId, chapterId, { signal: res.locals.abortSignal },
      );
      const {
        book, section, chapter, previousChapter: prevChapter,
        previousChapterId, previousChapterSectionId, bookChapterIndex,
        recentReviewSignals, writingAssetContext, contextRevision,
      } = generationContext;
      targetRevision = generationContext.targetRevision;
      if (mode !== 'next') {
        store.assertExpectedVersionRevision(chapter.body, body.expectedRevision);
      }

      const system = buildSystemPrompt(book.settings.core, writingAssetContext?.text ?? '');
      const context = buildContext({ book, section, prevChapter });
      const currentContent = mode === 'whip' || mode === 'rewrite'
        ? store.currentText(chapter.body)
        : '';
      if (mode === 'whip' && !currentContent.trim()) throw new Error('CHAPTER_EMPTY');
      const instruction = context + '\n\n' +
        buildChapterInstruction({ chapterIndex: chapter.index, bookChapterIndex, wordTarget: config.chapterWordTarget, mode, whip: whip?.trim(), currentContent, recentReviewSignals });

      full = await streamInto(req, res, { config, system, instruction });
      const generatedFingerprint = store.contentFingerprint(full);
      // 在同一存储锁域内同时复核目标版本和所有提示词上下文，避免长耗时
      // 生成覆盖目标新版，或把基于旧大纲/设定/前情的正文落入新上下文。
      await assertClientAliveAfterIo(req, res);
      await store.commitGeneratedChapter(bookId, sectionId, chapterId, full, {
        expectedRevision: targetRevision,
        expectedContextRevision: contextRevision,
        expectedPreviousChapterId: previousChapterId,
        expectedPreviousChapterSectionId: previousChapterSectionId,
        // “下一章”的正文只能在它仍是本部末章时提交。
        // 否则另一页面可能已基于不同前情追加了后续章。
        expectedLastChapterId: mode === 'next' ? chapterId : undefined,
        signal: res.locals.abortSignal,
      });
      bodySaved = true;
      send(res, { saved: true, chapterId });

      // —— 自动 digest（失败不阻塞）——
      try {
        assertClientAlive(req, res);
        const digestConfig = chapterConfigSelection.source === 'book'
          ? config
          : await store.readConfigForTask(
            'digest', { signal: res.locals.abortSignal, bookId },
          );
        const digestText = await nonStreamChat({
          config: digestConfig, system,
          signal: res.locals.abortSignal,
          messages: [{ role: 'user', content: `以下是正文：\n${full}\n\n${DIGEST_INSTRUCTION}` }],
        });
        assertClientAlive(req, res);
        const d = extractDigest(digestText);
        const digestComplete = d
          && d.digestParsed !== false
          && d.digestCharactersParsed !== false
          && typeof d.summary === 'string' && Boolean(d.summary.trim())
          && typeof d.progress === 'string' && Boolean(d.progress.trim());
        const titleSelection = chapterConfigSelection.source === 'book'
          ? chapterConfigSelection
          : await store.readConfigForTaskSelection(
            'title', { signal: res.locals.abortSignal, bookId },
          );
        if (titleSelection.source === 'task') {
          // 显式标题分工不能在失败时悄悄沿用 digest 模型的标题。
          // 先清空 digest 产出，只有指定标题模型返回合法 JSON 才填回。
          d.chapterTitle = '';
          d.sectionTitle = '';
          if (!digestComplete) {
            postprocessWarnings.add('title');
          } else try {
            const titleRaw = await nonStreamChat({
              config: titleSelection.config,
              system,
              signal: res.locals.abortSignal,
              messages: [{
                role: 'user',
                content: buildChapterTitlesInstruction({
                  chapterIndex: chapter.index, summary: d.summary, progress: d.progress,
                }),
              }],
            });
            assertClientAlive(req, res);
            const titles = extractGeneratedTitles(titleRaw);
            if (!titles) {
              postprocessWarnings.add('title');
            } else {
              d.chapterTitle = titles.chapterTitle;
              d.sectionTitle = titles.sectionTitle;
              if (!titles.chapterTitle || !titles.sectionTitle) {
                postprocessWarnings.add('title');
              }
            }
          } catch (error) {
            if (isClientGone(req, res)) throw new Error('CLIENT_ABORTED');
            postprocessWarnings.add('title');
          }
        }
        // 在同一组锁内局部合并；正文已变更时丢弃迟到 digest。
        await assertClientAliveAfterIo(req, res);
        const appliedDigest = await store.applyChapterDigest(bookId, sectionId, chapterId, d, {
          expectedBodyFingerprint: generatedFingerprint,
          signal: res.locals.abortSignal,
        });
        if (!digestComplete || !appliedDigest.applied) postprocessWarnings.add('digest');
      } catch (error) {
        // 摘要本身失败不影响已保存正文；但客户端已离开时必须终止整条
        // 后处理链，不能继续读盘并发起下一次自动审稿模型请求。
        if (isClientGone(req, res)) throw new Error('CLIENT_ABORTED');
        postprocessWarnings.add('digest');
      }

      // —— 自动审稿（失败不阻塞）——
      try {
        assertClientAlive(req, res);
        const reviewSnapshot = await store.readChapterReviewContext(
          bookId, sectionId, chapterId, { signal: res.locals.abortSignal },
        );
        assertClientAlive(req, res);
          const {
            book: reviewBook,
            section: reviewSection,
            chapter: reviewChapter,
            bookChapterIndex: reviewBookChapterIndex,
            recentReviewSignals: reviewRecentSignals,
            writingAssetContext: reviewWritingAssetContext,
            contextRevision: reviewContextRevision,
          } = reviewSnapshot;
        const reviewContent = store.currentText(reviewChapter.body);
        if (reviewContent.trim() && reviewChapter.bodyFingerprint === generatedFingerprint) {
          const reviewSystem = buildSystemPrompt(
            reviewBook.settings?.core, reviewWritingAssetContext?.text ?? '',
          );
          const reviewContext = buildContext({ book: reviewBook, section: reviewSection });
          const reviewInstruction = buildChapterReviewInstruction({
            chapterIndex: reviewChapter.index,
            bookChapterIndex: reviewBookChapterIndex,
            content: reviewContent,
            context: reviewContext,
            recentReviewSignals: reviewRecentSignals,
          });
          const reviewConfig = chapterConfigSelection.source === 'book'
            ? config
            : await store.readConfigForTask(
              'review', { signal: res.locals.abortSignal, bookId },
            );
          const reviewRaw = await nonStreamChat({
            config: reviewConfig, system: reviewSystem,
            signal: res.locals.abortSignal,
            messages: [{ role: 'user', content: reviewInstruction }],
          });
          assertClientAlive(req, res);
          const review = extractChapterReview(reviewRaw);
          if (review) {
            await assertClientAliveAfterIo(req, res);
            const savedReview = await store.saveChapterReview(bookId, sectionId, chapterId, review, {
              expectedBodyFingerprint: generatedFingerprint,
              expectedContextRevision: reviewContextRevision,
              signal: res.locals.abortSignal,
            });
            if (!savedReview.applied) postprocessWarnings.add('review');
          } else {
            postprocessWarnings.add('review');
          }
        } else {
          postprocessWarnings.add('review');
        }
      } catch (error) {
        // 业务上的审稿失败仍不影响正文和 done；断连则无需继续收尾响应。
        if (isClientGone(req, res)) throw new Error('CLIENT_ABORTED');
        postprocessWarnings.add('review');
      }

      send(res, {
        done: true,
        chapterId,
        ...(postprocessWarnings.size
          ? { postprocessWarnings: [...postprocessWarnings] }
          : {}),
      });
    } catch (e) {
      // 空章回滚：mode==='next' 新建了章，但正文从未成功写入，则从 section.chapters 中移除
      if (mode === 'next' && createdChapterId && !bodySaved) {
        try {
          // 只回滚仍保持本请求创建时空版本的新章；若另一标签页已经编辑，
          // 修订号冲突会阻止删除，宁可保留也不能误删用户正文。
          await store.deleteChapter(bookId, sectionId, createdChapterId, {
            expectedRevision: targetRevision,
            restoreBookUpdatedAt: createdChapterRollback,
          });
        } catch { /* 回滚失败不再二次抛错 */ }
      }
      send(res, { error: publicErrorCode(e) });
    }
    end(res);
  });
}

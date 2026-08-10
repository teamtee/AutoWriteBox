import {
  MAX_CHARACTER_DESC_CHARS, MAX_CHARACTER_NAME_CHARS, MAX_CHARACTER_ROLE_CHARS,
  MAX_CONCURRENT_LLM_REQUESTS, MAX_DIGEST_CHARACTERS, MAX_DIGEST_PROGRESS_CHARS,
  MAX_DIGEST_SUMMARY_CHARS, MAX_LLM_INPUT_CHARS, MAX_LLM_OUTPUT_CHARS,
  MAX_LLM_STREAM_BUFFER_CHARS, MAX_LLM_STREAM_BYTES, MAX_PLANNED_SECTIONS,
  MAX_SECTION_PLAN_FIELD_CHARS,
  MAX_REVIEW_INSTRUCTION_CHARS, LLM_OUTPUT_JOIN_CHUNK_CHARS,
  MAX_DISCOVERED_MODELS, MAX_DISCOVERED_MODEL_ITEMS_SCANNED,
  MAX_LLM_MODELS_RESPONSE_BYTES, MAX_LLM_MODEL_DISCOVERY_TIMEOUT_MS,
} from './limits.js';
import { normalizeLlmConfig } from './llm-config.js';
import { sanitizeWritingAssetAnalysis } from './writing-asset-schema.js';
import { sanitizeMemoryCandidates } from './memory-schema.js';
import {
  normalizeChapterReviewChecks, normalizeChapterReviewSignals,
} from './chapter-review-schema.js';

export { MAX_LLM_OUTPUT_CHARS } from './limits.js';
export { normalizeLlmConfig as validateLlmConfig } from './llm-config.js';

let activeLlmRequests = 0;

const isRecord = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value);

export function parseSSEChunk(buffer, { secrets = [] } = {}) {
  const deltas = [];
  const errors = [];
  let finished = false;
  let finishReason = null;
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop();  // 最后一段可能不完整，留待下次
  for (const part of parts) {
    // 第一个终止帧就是此次响应的协议边界。不再解析同一网络块里
    // 紧随其后的帧，避免 length/content_filter 被后续 stop 覆盖，或把
    // [DONE] 之后的异常文本拼进最终正文。
    if (finished) break;
    const dataLines = part.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (!dataLines.length) continue;
    const payload = dataLines.map((line) => line.slice(5).trimStart()).join('\n').trim();
    if (payload === '[DONE]') {
      finished = true;
      break;
    }
    if (payload === '') continue;
    try {
      const json = JSON.parse(payload);
      if (!isRecord(json)) throw new Error('LLM_SSE_INVALID_EVENT');
      if ('error' in json && json.error !== null && json.error !== undefined) {
        errors.push(cleanLlmError(
          json.error.message || json.error.code || json.error,
          300,
          secrets,
        ));
        // 首个上游错误已经决定整次生成失败。继续扫描同一块内的海量
        // 错误/正文帧既不会改变结果，还会无界放大 errors/deltas 数组。
        break;
      }
      // 本应用只消费 Chat Completions 文本流。若把对象/数组等异常 content
      // 隐式拼成字符串，既会污染正文，也会让 delta.length 变为 undefined，
      // 从而把累计输出计数变成 NaN 并绕过上限。
      if (!Array.isArray(json.choices)) throw new Error('LLM_SSE_INVALID_EVENT');
      const choice = json.choices[0];
      if (choice === undefined) continue; // 兼容 choices: [] 的 usage 尾帧
      if (!isRecord(choice)) throw new Error('LLM_SSE_INVALID_EVENT');
      if ('delta' in choice && !isRecord(choice.delta)) {
        throw new Error('LLM_SSE_INVALID_EVENT');
      }
      const delta = choice.delta?.content;
      if (delta !== undefined && delta !== null && typeof delta !== 'string') {
        throw new Error('LLM_SSE_INVALID_EVENT');
      }
      if ('finish_reason' in choice && choice.finish_reason !== null
        && typeof choice.finish_reason !== 'string') {
        throw new Error('LLM_SSE_INVALID_EVENT');
      }
      if (delta) deltas.push(delta);
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        finished = true;
        finishReason = choice.finish_reason;
      }
    } catch (error) {
      // parts 中的事件已经由空行完整分隔，解析失败不是半包，不能静默吞掉。
      errors.push(error?.message === 'LLM_SSE_INVALID_EVENT'
        ? 'LLM_SSE_INVALID_EVENT'
        : 'LLM_SSE_INVALID_JSON');
      break;
    }
  }
  return { deltas, errors, finished, finishReason, rest };
}

function cleanLlmError(value, maxLength = 300, secrets = []) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); }
    catch { text = String(value); }
  }
  let cleaned = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  for (const rawSecret of secrets) {
    const secret = typeof rawSecret === 'string' ? rawSecret.trim() : '';
    // 已知密钥即使很短也必须优先保密；最坏只会让错误详情少一些可读性。
    if (secret) cleaned = cleaned.split(secret).join('[REDACTED]');
  }
  cleaned = cleaned
    .replace(/\b(Bearer|Token)\s+[A-Za-z0-9._~+\/-]{6,}={0,2}/giu, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/giu, '[REDACTED]');
  return cleaned.slice(0, maxLength);
}

async function readResponsePrefix(response, limit = 16384) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let reachedEof = false;
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      const remaining = limit - bytes;
      const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
      bytes += chunk.length;
      text += decoder.decode(chunk, { stream: true });
      if (chunk.length < value.length) break;
    }
    text += decoder.decode();
  } finally {
    // 达到详情上限、读取失败或调用方取消时都不再消费剩余错误响应；主动
    // 取消并释放 reader，避免异常兼容服务继续占用连接与缓冲区。
    if (!reachedEof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return text;
}

function errorDetailFromBody(raw, secrets = []) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    return cleanLlmError(
      parsed?.error?.message || parsed?.error?.code || parsed?.message || parsed?.error || parsed,
      300,
      secrets,
    );
  } catch {
    return cleanLlmError(text, 300, secrets);
  }
}

function decodeSseBytes(decoder, bytes, options) {
  try {
    return decoder.decode(bytes, options);
  } catch {
    // 默认 TextDecoder 会把非法上游字节替换成 U+FFFD；若该字节位于 JSON
    // 字符串内，事件仍能解析并把损坏正文保存。流协议必须使用严格 UTF-8。
    throw new Error('LLM_STREAM_ERROR: LLM_SSE_INVALID_UTF8');
  }
}

function validateLlmInput(system, messages) {
  if (typeof system !== 'string' || !Array.isArray(messages)) throw new Error('LLM_INPUT_INVALID');
  let totalChars = system.length;
  if (totalChars > MAX_LLM_INPUT_CHARS) throw new Error('LLM_INPUT_TOO_LARGE');
  for (const message of messages) {
    if (!message || typeof message.content !== 'string') throw new Error('LLM_INPUT_INVALID');
    totalChars += message.content.length;
    if (totalChars > MAX_LLM_INPUT_CHARS) throw new Error('LLM_INPUT_TOO_LARGE');
  }
}

async function readModelListResponse(response) {
  if (!response.body) throw new Error('LLM_MODELS_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts = [];
  let bytes = 0;
  let reachedEof = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_LLM_MODELS_RESPONSE_BYTES) {
        throw new Error('LLM_MODELS_RESPONSE_TOO_LARGE');
      }
      try { parts.push(decoder.decode(value, { stream: true })); }
      catch { throw new Error('LLM_MODELS_RESPONSE_INVALID'); }
    }
    try { parts.push(decoder.decode()); }
    catch { throw new Error('LLM_MODELS_RESPONSE_INVALID'); }
  } finally {
    if (!reachedEof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let parsed;
  try { parsed = JSON.parse(parts.join(''));
  } catch { throw new Error('LLM_MODELS_RESPONSE_INVALID'); }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw new Error('LLM_MODELS_RESPONSE_INVALID');
  }
  return parsed.data;
}

export async function discoverLlmModels({ config, signal }) {
  const validatedConfig = normalizeLlmConfig(config);
  if (activeLlmRequests >= MAX_CONCURRENT_LLM_REQUESTS) throw new Error('LLM_BUSY');
  activeLlmRequests += 1;
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  const configuredTimeout = Number.isFinite(validatedConfig.requestTimeoutMs)
    ? validatedConfig.requestTimeoutMs : MAX_LLM_MODEL_DISCOVERY_TIMEOUT_MS;
  const timeoutMs = Math.min(configuredTimeout, MAX_LLM_MODEL_DISCOVERY_TIMEOUT_MS);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('LLM_TIMEOUT'));
  }, timeoutMs);
  timer.unref?.();
  try {
    const headers = { Accept: 'application/json' };
    if (validatedConfig.apiKey) headers.Authorization = `Bearer ${validatedConfig.apiKey}`;
    const response = await fetch(
      `${validatedConfig.baseUrl.replace(/\/$/u, '')}/models`, {
        method: 'GET', headers, signal: controller.signal, redirect: 'manual',
      },
    );
    if (response.status >= 300 && response.status < 400) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw new Error('LLM_REDIRECT_NOT_ALLOWED');
    }
    if (!response.ok) {
      const rawDetail = await readResponsePrefix(response);
      const detail = [401, 403].includes(response.status)
        ? '' : errorDetailFromBody(rawDetail, [validatedConfig.apiKey]);
      throw new Error(`LLM_HTTP_${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const rows = await readModelListResponse(response);
    const models = [];
    const seen = new Set();
    const scanLimit = Math.min(rows.length, MAX_DISCOVERED_MODEL_ITEMS_SCANNED);
    let truncated = rows.length > scanLimit;
    for (let index = 0; index < scanLimit; index += 1) {
      const rawId = rows[index]?.id;
      if (typeof rawId !== 'string') continue;
      let model;
      try {
        model = normalizeLlmConfig({
          baseUrl: validatedConfig.baseUrl, model: rawId, apiKey: '',
        }).model;
      } catch { continue; }
      if (seen.has(model)) continue;
      seen.add(model);
      if (models.length >= MAX_DISCOVERED_MODELS) {
        truncated = true;
        break;
      }
      models.push(model);
    }
    return { models, truncated };
  } catch (error) {
    if (timedOut) throw new Error('LLM_TIMEOUT');
    if (signal?.aborted && signal.reason instanceof Error) throw signal.reason;
    if (error?.name === 'TypeError' || error?.name === 'AbortError' || error?.cause) {
      const detail = cleanLlmError(
        error?.cause?.message || error?.message,
        300,
        [validatedConfig.apiKey],
      );
      throw new Error(`LLM_NETWORK_ERROR${detail ? `: ${detail}` : ''}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
    if (!controller.signal.aborted) controller.abort(new Error('LLM_DISCOVERY_COMPLETE'));
    activeLlmRequests -= 1;
  }
}

export async function* streamChat({ config, system, messages, signal }) {
  const validatedConfig = normalizeLlmConfig(config);
  validateLlmInput(system, messages);
  if (activeLlmRequests >= MAX_CONCURRENT_LLM_REQUESTS) throw new Error('LLM_BUSY');
  activeLlmRequests += 1;
  const body = {
    model: validatedConfig.model,
    stream: true,
    messages: [{ role: 'system', content: system }, ...messages],
  };
  const controller = new AbortController();
  let timedOut = false;
  let protocolComplete = false;
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeoutMs = Number.isFinite(validatedConfig.requestTimeoutMs) ? validatedConfig.requestTimeoutMs : 300000;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('LLM_TIMEOUT'));
  }, timeoutMs);
  timer.unref?.();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (validatedConfig.apiKey) headers.Authorization = `Bearer ${validatedConfig.apiKey}`;
    const res = await fetch(`${validatedConfig.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      // 307/308 会把包含 API Key 和作品上下文的 POST 重发到 Location。
      // 只向用户明确配置的 Base URL 发送，不跟随上游重定向。
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      if (res.body) await res.body.cancel().catch(() => {});
      throw new Error('LLM_REDIRECT_NOT_ALLOWED');
    }
    if (!res.ok) {
      const rawDetail = await readResponsePrefix(res);
      // 鉴权响应偶尔会回显密钥片段，不把详情转发到浏览器。
      const detail = [401, 403].includes(res.status)
        ? ''
        : errorDetailFromBody(rawDetail, [validatedConfig.apiKey]);
      throw new Error(`LLM_HTTP_${res.status}${detail ? `: ${detail}` : ''}`);
    }
    if (!res.body) throw new Error('LLM_EMPTY_BODY');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buf = '';
    let streamFinished = false;
    let finishReason = null;
    let outputChars = 0;
    let streamBytes = 0;
    const acceptParsed = (parsed) => {
      if (parsed.errors.length) throw new Error(`LLM_STREAM_ERROR: ${parsed.errors[0]}`);
      if (parsed.finished) streamFinished = true;
      if (parsed.finishReason) finishReason = parsed.finishReason;
      return parsed.deltas;
    };
    const acceptDelta = (delta) => {
      outputChars += delta.length;
      if (outputChars > MAX_LLM_OUTPUT_CHARS) throw new Error('LLM_RESPONSE_TOO_LARGE');
      return delta;
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        streamBytes += value.byteLength;
        if (streamBytes > MAX_LLM_STREAM_BYTES) {
          throw new Error('LLM_STREAM_TOO_LARGE');
        }
        buf += decodeSseBytes(decoder, value, { stream: true });
        if (buf.length > MAX_LLM_STREAM_BUFFER_CHARS) {
          throw new Error('LLM_STREAM_BUFFER_TOO_LARGE');
        }
        const parsed = parseSSEChunk(buf, { secrets: [validatedConfig.apiKey] });
        buf = parsed.rest;
        for (const d of acceptParsed(parsed)) yield acceptDelta(d);
        if (streamFinished) {
          // SSE 的终止标记是协议完成边界，不应继续等待兼容服务关闭 TCP。
          // 主动取消剩余响应体；取消失败发生在业务结果已完整之后，只释放资源，
          // 不能把一次实际成功的生成翻转成可重试失败。
          await reader.cancel().catch(() => {});
          break;
        }
      }
      if (!streamFinished) {
        buf += decodeSseBytes(decoder);
        if (buf.trim()) {
          const parsed = parseSSEChunk(`${buf}\n\n`, { secrets: [validatedConfig.apiKey] });
          for (const d of acceptParsed(parsed)) yield acceptDelta(d);
        }
      }
    } finally {
      // 解析、大小或协议错误也要主动终止响应体；不能只依赖 fetch 对外层
      // AbortSignal 的实现细节，否则兼容服务或测试替身可能继续产出数据。
      if (!streamFinished) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (finishReason && finishReason !== 'stop') {
      const reason = finishReason.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').slice(0, 40) || 'UNKNOWN';
      throw new Error(`LLM_FINISH_${reason}`);
    }
    if (!streamFinished) throw new Error('LLM_STREAM_INCOMPLETE');
    protocolComplete = true;
  } catch (err) {
    if (timedOut) throw new Error('LLM_TIMEOUT');
    if (signal?.aborted && signal.reason instanceof Error) throw signal.reason;
    if (err?.name === 'TypeError' || err?.name === 'AbortError' || err?.cause) {
      const detail = cleanLlmError(
        err?.cause?.message || err?.message,
        300,
        [validatedConfig.apiKey],
      );
      throw new Error(`LLM_NETWORK_ERROR${detail ? `: ${detail}` : ''}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
    if (!protocolComplete && !controller.signal.aborted) {
      controller.abort(new Error('LLM_STREAM_CANCELLED'));
    }
    activeLlmRequests -= 1;
  }
}

export async function nonStreamChat({ config, system, messages, signal }) {
  const chunks = [];
  let pending = '';
  for await (const delta of streamChat({ config, system, messages, signal })) {
    pending += delta;
    if (pending.length >= LLM_OUTPUT_JOIN_CHUNK_CHARS) {
      chunks.push(pending);
      pending = '';
    }
  }
  return chunks.join('') + pending;
}

export function sanitizeGeneratedTitle(raw, unit = '') {
  let text = String(raw ?? '').split(/\r?\n/, 1)[0].trim();
  text = text.replace(/^[《“”"'「」『』]+|[》“”"'「」『』]+$/g, '').trim();
  text = text.replace(/^(?:书名|章名|部名)\s*[:：]\s*/u, '').trim();
  for (const ordinalUnit of (unit ? [unit] : ['章', '部'])) {
    const ordinal = new RegExp(
      `^第\\s*(?:\\d+|[零一二三四五六七八九十百千两]+)\\s*${ordinalUnit}\\s*[·:：\\-—]?\\s*`, 'u');
    text = text.replace(ordinal, '');
  }
  text = text.replace(/^(?:[（(]?\s*(?:\d+|[零一二三四五六七八九十百千两]+)\s*[）)]\s*|(?:\d+|[零一二三四五六七八九十百千两]+)\s*[.．、])\s*/u, '');
  text = text.replace(/^[《“”"'「」『』]+|[》“”"'「」『』]+$/g, '').trim();
  text = text.replace(/^[·:：\-—\s]+/u, '').trim();
  return Array.from(text).slice(0, 10).join('');
}

export function sanitizeChapterReview(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const score = typeof obj.score === 'number' ? Math.max(0, Math.min(100, Math.round(obj.score))) : null;
  if (score === null) return null;

  const cleanText = (v, maxLen) => {
    if (typeof v !== 'string') return '';
    return Array.from(v.trim()).slice(0, maxLen).join('');
  };

  const verdict = cleanText(obj.verdict, 40);
  if (!verdict) return null;

  const issues = Array.isArray(obj.issues)
    ? obj.issues
        .filter(i => i && typeof i.title === 'string' && typeof i.detail === 'string')
        .map(i => ({ title: cleanText(i.title, 15), detail: cleanText(i.detail, 80) }))
        .filter(i => i.title && i.detail)
        .slice(0, 5)
    : [];

  if (issues.length < 1) return null;

  const suggestions = Array.isArray(obj.suggestions)
    ? obj.suggestions
        .filter(s => s && typeof s.label === 'string' && typeof s.instruction === 'string')
        .map(s => ({
          label: cleanText(s.label, 8),
          instruction: cleanText(s.instruction, MAX_REVIEW_INSTRUCTION_CHARS),
        }))
        .filter(s => s.label && s.instruction)
        .slice(0, 3)
    : [];

  if (suggestions.length < 1) return null;

  const webFictionChecks = normalizeChapterReviewChecks(obj.webFictionChecks, {
    truncate: true,
  });
  if (webFictionChecks === null) return null;
  const webFictionSignals = normalizeChapterReviewSignals(obj.webFictionSignals, {
    truncate: true,
  });
  if (webFictionSignals === null) return null;

  return {
    score,
    verdict,
    issues,
    suggestions,
    ...(webFictionChecks === undefined ? {} : { webFictionChecks }),
    ...(webFictionSignals === undefined ? {} : { webFictionSignals }),
  };
}

// 模型经常会在 JSON 前后追加说明、示例或 Markdown。相比贪婪正则，逐个扫描
// 配平的大括号可以避开前后的无效片段，也不会把字符串里的大括号误当成结构。
function extractFirstJsonObject(text) {
  const source = String(text ?? '');
  const tryParseObject = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = tryParseObject(source.trim());
  if (direct) return direct;

  // 模型可能返回大量未闭合的“{”。限制候选数和累计扫描量，避免逐个起点
  // 重扫余下文本造成 O(n²) CPU 占用，同时保留对前缀杂讯的容错。
  const scanBudget = source.length * 16;
  let scanned = 0;
  let attempts = 0;
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    attempts += 1;
    if (attempts > 64) break;
    let depth = 0;
    let inString = false;
    let escaping = false;
    for (let i = start; i < source.length; i += 1) {
      scanned += 1;
      if (scanned > scanBudget) return null;
      const ch = source[i];
      if (inString) {
        if (escaping) escaping = false;
        else if (ch === '\\') escaping = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParseObject(source.slice(start, i + 1));
          if (parsed) return parsed;
          break;
        }
        if (depth < 0) break;
      }
    }
  }
  return null;
}

export function extractSectionsPlan(text) {
  const obj = extractFirstJsonObject(text);
  if (!obj || !Array.isArray(obj.sections) || obj.sections.length < 2) return null;
  const cleanText = (v, maxLen) => {
    if (typeof v !== 'string') return '';
    return Array.from(v.trim()).slice(0, maxLen).join('');
  };
  const sections = obj.sections
    .filter((s) => s && typeof s.title === 'string' && s.title.trim())
    .slice(0, MAX_PLANNED_SECTIONS)
    .map((s) => {
      const summary = cleanText(s.summary, MAX_SECTION_PLAN_FIELD_CHARS);
      const fallback = summary || '待进一步明确';
      return {
        title: sanitizeGeneratedTitle(cleanText(s.title, 8)),
        summary,
        promise: cleanText(s.promise, MAX_SECTION_PLAN_FIELD_CHARS) || fallback,
        goal: cleanText(s.goal, MAX_SECTION_PLAN_FIELD_CHARS) || fallback,
        obstacle: cleanText(s.obstacle, MAX_SECTION_PLAN_FIELD_CHARS) || '待进一步明确',
        progress: cleanText(s.progress, MAX_SECTION_PLAN_FIELD_CHARS) || fallback,
        climax: cleanText(s.climax, MAX_SECTION_PLAN_FIELD_CHARS) || '待进一步明确',
        payoff: cleanText(s.payoff, MAX_SECTION_PLAN_FIELD_CHARS) || '待进一步明确',
        stateChange: cleanText(s.stateChange, MAX_SECTION_PLAN_FIELD_CHARS) || fallback,
      };
    })
    .filter((s) => s.title);
  return sections.length >= 2 ? sections : null;
}

export function extractChapterReview(text) {
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;
  return sanitizeChapterReview(obj);
}

export function extractGeneratedTitles(text) {
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;
  const chapterTitle = typeof obj.chapterTitle === 'string'
    ? sanitizeGeneratedTitle(obj.chapterTitle, '章') : '';
  const sectionTitle = typeof obj.sectionTitle === 'string'
    ? sanitizeGeneratedTitle(obj.sectionTitle, '部') : '';
  return chapterTitle || sectionTitle ? { chapterTitle, sectionTitle } : null;
}

export { sanitizeWritingAssetAnalysis } from './writing-asset-schema.js';

export function extractWritingAssetAnalysis(text) {
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;
  return sanitizeWritingAssetAnalysis(obj);
}

function markDigestParseState(digest, { digestParsed, charactersParsed, memoryCandidatesParsed }) {
  // 解析失败、字段缺失和“明确识别到 0 个人物”在可序列化结果里都可能是
  // newCharacters: []。内部沿用该旧字段名以兼容已存测试/API；新提示词使用
  // 语义准确的 characters。非枚举标记把三种状态区分开。
  Object.defineProperties(digest, {
    digestParsed: { value: digestParsed, enumerable: false },
    digestCharactersParsed: { value: charactersParsed, enumerable: false },
    digestMemoryCandidatesParsed: { value: memoryCandidatesParsed, enumerable: false },
  });
  return digest;
}

export function extractDigest(text) {
  const fallback = {
    chapterTitle: '', sectionTitle: '',
    summary: '', progress: '', newCharacters: [], memoryCandidates: [],
  };
  const cleanText = (value, maxLength) => typeof value === 'string'
    ? Array.from(value.trim()).slice(0, maxLength).join('')
    : '';
  const cleanCharacters = (value) => {
    if (!Array.isArray(value)) return [];
    return value.filter((item) =>
      item &&
      typeof item.name === 'string' &&
      typeof item.role === 'string' &&
      typeof item.desc === 'string')
      .slice(0, MAX_DIGEST_CHARACTERS)
      .map(({ name, role, desc }) => ({
        name: cleanText(name, MAX_CHARACTER_NAME_CHARS),
        role: cleanText(role, MAX_CHARACTER_ROLE_CHARS),
        desc: cleanText(desc, MAX_CHARACTER_DESC_CHARS),
      }))
      .filter(({ name, role }) => name && role);
  };
  const obj = extractFirstJsonObject(text);
  if (!obj) {
    return markDigestParseState(fallback, {
      digestParsed: false, charactersParsed: false, memoryCandidatesParsed: false,
    });
  }
  // `characters` 是当前契约：它表示本章全部登场人物的最新快照，而非仅
  // 新角色。继续接受旧模型/旧提示词返回的 `newCharacters`，避免升级后
  // 因上游缓存或兼容实现丢失人物上下文。
  const rawCharacters = Array.isArray(obj.characters)
    ? obj.characters
    : obj.newCharacters;
  return markDigestParseState({
    chapterTitle: sanitizeGeneratedTitle(obj.chapterTitle, '章'),
    sectionTitle: sanitizeGeneratedTitle(obj.sectionTitle, '部'),
    summary: cleanText(obj.summary, MAX_DIGEST_SUMMARY_CHARS),
    progress: cleanText(obj.progress, MAX_DIGEST_PROGRESS_CHARS),
    newCharacters: cleanCharacters(rawCharacters),
    memoryCandidates: sanitizeMemoryCandidates(obj.memoryCandidates),
  }, {
    digestParsed: true,
    charactersParsed: Array.isArray(rawCharacters),
    memoryCandidatesParsed: Array.isArray(obj.memoryCandidates),
  });
}

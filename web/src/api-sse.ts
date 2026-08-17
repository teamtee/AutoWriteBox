import type { SectionPlan } from './types';
import {
  MAX_SECTION_PLAN_TITLE_CODE_POINTS, MAX_SECTION_PLAN_TITLES,
} from './sections';
import { PUBLIC_ERROR_PAYLOAD } from './api-contract';

export type PostprocessWarning = 'title' | 'digest' | 'review';

export interface SSEEvent {
  delta?: string;
  saved?: boolean;
  done?: boolean;
  error?: string;
  chapterId?: string;
  sections?: string;
  parsedTitles?: string[];
  parsedSections?: SectionPlan[];
  parseError?: boolean;
  postprocessWarnings?: PostprocessWarning[];
}

const INVALID_SSE_RESPONSE = '生成中断：响应格式无效';
export const SSE_RESPONSE_TOO_LARGE = '生成中断：响应内容超过安全上限';
export const SSE_RESPONSE_INVALID_UTF8 = '生成中断：响应编码无效';
// 与服务端模型输出上限一致；单帧额外预留 JSON Unicode 转义空间。
export const MAX_STREAM_DELTA_CHARS = 200_000;
const MAX_SSE_FRAME_CHARS = 1_700_000;
// 服务端最多输出 20 万字符，并以不超过 1024 字符的 delta 批次发送；
// 分部规划终止帧还会再携带一次完整文本。16 MiB 覆盖最坏 JSON 转义和
// 小批次协议开销，同时阻止无限心跳、注释或 saved 帧长期占用连接。
export const MAX_SSE_STREAM_BYTES = 16 * 1024 * 1024;
const SAFE_SSE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SECTION_PLAN_FIELD_CODE_POINTS = 300;
const invalidSSEEvent = (): never => { throw new Error(INVALID_SSE_RESPONSE); };

function parseSSEEvent(payload: string): SSEEvent {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    // 这里拿到的 payload 已经由 SSE 空行完整分帧；真正的半包会留在
    // parseSSELines 的 rest 中。静默丢弃完整坏帧可能让后续 done 被误报成功。
    throw new Error(INVALID_SSE_RESPONSE);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidSSEEvent();
  }
  const event = value as Record<string, unknown>;
  const hasOwn = (field: string) => Object.prototype.hasOwnProperty.call(event, field);
  const primaryFields = ['delta', 'saved', 'error', 'done'] as const;
  const primary = primaryFields.filter(hasOwn);
  // 每帧只能表达一个状态。否则 error + done 会先报错再误报成功，
  // delta + saved 也会让未确认完整的文本看起来已经落盘。
  if (primary.length !== 1) return invalidSSEEvent();

  const onlyKeys = (...allowed: string[]) => {
    const accepted = new Set(allowed);
    if (Object.keys(event).some((field) => !accepted.has(field))) invalidSSEEvent();
  };
  const state = primary[0];
  if (state === 'delta') {
    onlyKeys('delta');
    if (typeof event.delta !== 'string') return invalidSSEEvent();
    return event as SSEEvent;
  }
  if (state === 'error') {
    onlyKeys('error');
    if (typeof event.error !== 'string' || !PUBLIC_ERROR_PAYLOAD.test(event.error)) {
      return invalidSSEEvent();
    }
    return event as SSEEvent;
  }
  if (state === 'saved') {
    onlyKeys('saved', 'chapterId');
    if (event.saved !== true
      || (hasOwn('chapterId')
        && (typeof event.chapterId !== 'string' || !SAFE_SSE_ID.test(event.chapterId)))) {
      return invalidSSEEvent();
    }
    return event as SSEEvent;
  }

  onlyKeys(
    'done', 'chapterId', 'sections', 'parsedTitles', 'parsedSections',
    'parseError', 'postprocessWarnings',
  );
  if (event.done !== true) return invalidSSEEvent();
  if (hasOwn('chapterId')
    && (typeof event.chapterId !== 'string' || !SAFE_SSE_ID.test(event.chapterId))) {
    return invalidSSEEvent();
  }
  if (hasOwn('sections') && (typeof event.sections !== 'string'
    || !event.sections.trim() || event.sections.length > MAX_STREAM_DELTA_CHARS)) {
    return invalidSSEEvent();
  }
  if (hasOwn('parsedTitles') && (!Array.isArray(event.parsedTitles)
    || event.parsedTitles.length < 2
    || event.parsedTitles.length > MAX_SECTION_PLAN_TITLES
    || event.parsedTitles.some((title) => typeof title !== 'string'
      || !title.trim()
      || Array.from(title).length > MAX_SECTION_PLAN_TITLE_CODE_POINTS))) {
    return invalidSSEEvent();
  }
  if (hasOwn('parsedSections')) {
    const fields = [
      'title', 'summary', 'promise', 'goal', 'obstacle', 'progress',
      'climax', 'payoff', 'stateChange', 'worldProgression',
    ];
    const worldFields = [
      'layer', 'stagePromise', 'evidence', 'characterAction', 'choiceAndCost',
      'knowledgeGain', 'protectedUnknown', 'gateOutcome', 'gateCondition', 'gateProgress',
    ];
    const worldLayers = ['当前生活圈', '中期势力与地域', '长线文明与历史'];
    const gateOutcomes = ['hold', 'open-next', 'complete-long'];
    if (!Array.isArray(event.parsedSections)
      || event.parsedSections.length < 2
      || event.parsedSections.length > MAX_SECTION_PLAN_TITLES
      || event.parsedSections.some((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
        const row = item as Record<string, unknown>;
        const world = row.worldProgression;
        return Object.keys(row).some((field) => !fields.includes(field))
          || fields.filter((field) => field !== 'worldProgression').some((field) => typeof row[field] !== 'string'
            || (field !== 'summary' && !(row[field] as string).trim())
            || Array.from(row[field] as string).length
              > (field === 'title'
                ? MAX_SECTION_PLAN_TITLE_CODE_POINTS
                : MAX_SECTION_PLAN_FIELD_CODE_POINTS))
          || !world || typeof world !== 'object' || Array.isArray(world)
          || Object.keys(world as object).some((field) => !worldFields.includes(field))
          || worldFields.some((field) => typeof (world as Record<string, unknown>)[field] !== 'string'
            || !((world as Record<string, string>)[field]).trim()
            || Array.from((world as Record<string, string>)[field]).length
              > MAX_SECTION_PLAN_FIELD_CODE_POINTS)
          || !worldLayers.includes((world as Record<string, string>).layer)
          || !gateOutcomes.includes((world as Record<string, string>).gateOutcome);
      })) {
      return invalidSSEEvent();
    }
  }
  if (hasOwn('parseError') && event.parseError !== true) return invalidSSEEvent();
  if (hasOwn('postprocessWarnings')) {
    if (!Array.isArray(event.postprocessWarnings)
      || event.postprocessWarnings.length < 1
      || event.postprocessWarnings.length > 2
      || new Set(event.postprocessWarnings).size !== event.postprocessWarnings.length
      || event.postprocessWarnings.some((warning) => warning !== 'title'
        && warning !== 'digest' && warning !== 'review')) {
      return invalidSSEEvent();
    }
    const chapterWarnings = event.postprocessWarnings.every(
      (warning) => warning === 'digest' || warning === 'review',
    );
    const outlineWarning = event.postprocessWarnings.length === 1
      && event.postprocessWarnings[0] === 'title';
    // 章节只允许摘要/审稿告警；无其它元数据的版本终止帧只允许自动书名
    // 告警。分部规划和混合告警一律拒绝，避免调用方误解终止状态。
    if ((hasOwn('chapterId') && !chapterWarnings)
      || (!hasOwn('chapterId') && !outlineWarning)
      || hasOwn('sections')) return invalidSSEEvent();
  }
  const hasParsedTitles = hasOwn('parsedTitles');
  const hasParsedSections = hasOwn('parsedSections');
  const hasParseError = hasOwn('parseError');
  if (hasParsedTitles && hasParseError) return invalidSSEEvent();
  if (hasParsedSections && (!hasParsedTitles || hasParseError)) return invalidSSEEvent();
  if (hasParsedSections && Array.isArray(event.parsedTitles)) {
    const parsedTitles = event.parsedTitles as string[];
    if ((event.parsedSections as SectionPlan[]).some(
      (item, index) => item.title !== parsedTitles[index],
    )) return invalidSSEEvent();
  }
  if ((hasParsedTitles || hasParsedSections || hasParseError) && !hasOwn('sections')) {
    return invalidSSEEvent();
  }

  const metadataGroups = [
    hasOwn('chapterId'),
    hasOwn('sections') || hasParsedTitles || hasParseError,
  ].filter(Boolean).length;
  if (metadataGroups > 1) return invalidSSEEvent();
  return event as SSEEvent;
}

export function parseSSELines(
  chunk: string, buffer: string,
): { events: SSEEvent[]; rest: string } {
  const events: SSEEvent[] = [];
  const parts = (buffer + chunk).split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  if (rest.length > MAX_SSE_FRAME_CHARS) throw new Error(SSE_RESPONSE_TOO_LARGE);
  for (const part of parts) {
    if (part.length > MAX_SSE_FRAME_CHARS) throw new Error(SSE_RESPONSE_TOO_LARGE);
    const lines = part.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    if (!lines.length) continue;
    const payload = lines.map((line) => line.slice(5).trimStart()).join('\n').trim();
    if (!payload) continue;
    const event = parseSSEEvent(payload);
    events.push(event);
    // 与服务端上游解析保持一致：首个终止帧就是协议边界。同一网络块中
    // done/error 后的代理尾帧或异常字节不能再把已完成结果翻转成失败，
    // 也不能让后续 delta 在终止后进入正文。
    if (event.done || event.error) break;
  }
  return { events, rest };
}

import { MAX_LLM_INPUT_CHARS } from './limits.js';

// 所有提示词装配共用的有界拼接。单次调用的输入不能超过模型输入硬上限；
// 越界时立即失败，而不是把超长请求发给上游再由它截断。
// 分层预算裁剪由 context-budget.js 负责，本函数只是最后一道防线。
export function boundedJoin(parts, separator = '') {
  let total = Math.max(0, parts.length - 1) * separator.length;
  for (const part of parts) {
    total += String(part ?? '').length;
    if (total > MAX_LLM_INPUT_CHARS) throw new Error('LLM_INPUT_TOO_LARGE');
  }
  return parts.join(separator);
}

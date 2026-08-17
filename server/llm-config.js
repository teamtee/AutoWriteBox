import {
  DEFAULT_MODEL_CONTEXT_CHARS, MAX_CONFIG_API_KEY_CHARS,
  MAX_CONFIG_BASE_URL_CHARS, MAX_CONFIG_MODEL_CHARS, MAX_MODEL_CONTEXT_CHARS,
  MIN_MODEL_CONTEXT_CHARS,
} from './limits.js';
import { isLoopbackHostname } from './request-security.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

// 持久化和实际请求必须使用同一套 URL 解释规则。allowIncomplete 只允许
// 尚未填完的空字段；已经填写的地址仍需是可安全调用的规范 http(s) URL。
export function normalizeLlmConfig(config, { allowIncomplete = false } = {}) {
  const rawBaseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl : '';
  const rawModel = typeof config?.model === 'string' ? config.model : '';
  const rawApiKey = typeof config?.apiKey === 'string' ? config.apiKey : '';
  const baseUrl = rawBaseUrl.trim();
  const model = rawModel.trim();
  const apiKey = rawApiKey.trim();

  if (rawBaseUrl.length > MAX_CONFIG_BASE_URL_CHARS
    || rawModel.length > MAX_CONFIG_MODEL_CHARS
    || rawApiKey.length > MAX_CONFIG_API_KEY_CHARS) {
    throw new Error('LLM_CONFIG_TOO_LARGE');
  }
  // URL 解析器可能静默剥离换行，而 API Key 最终会进入 Authorization
  // 请求头。落盘前统一拒绝不可见控制字符，避免配置保存成功、调用时才
  // 被 fetch 作为非法请求头拒绝并误报成网络故障。
  if (CONTROL_CHARACTER.test(rawBaseUrl)) throw new Error('LLM_BASE_URL_INVALID');
  if (CONTROL_CHARACTER.test(rawModel)) throw new Error('LLM_MODEL_INVALID');
  if (CONTROL_CHARACTER.test(rawApiKey)) throw new Error('LLM_API_KEY_INVALID');
  if (!baseUrl && (!allowIncomplete || rawBaseUrl.length > 0)) {
    throw new Error('LLM_BASE_URL_REQUIRED');
  }
  if (!model && (!allowIncomplete || rawModel.length > 0)) {
    throw new Error('LLM_MODEL_REQUIRED');
  }

  let parsed = null;
  if (baseUrl) {
    try {
      parsed = new URL(baseUrl);
      // URL.search/hash 对只有分隔符的 `...?` / `...#` 返回空字符串；仍需
      // 明确拒绝，否则后续端点拼接会被解释成查询或片段而不是路径。
      if (!['http:', 'https:'].includes(parsed.protocol) || baseUrl.includes('?')
        || baseUrl.includes('#') || parsed.username || parsed.password) {
        throw new Error('invalid');
      }
    } catch {
      throw new Error('LLM_BASE_URL_INVALID');
    }
    // 远程 HTTP 会以明文传输 Authorization。本机 Ollama 等回环服务
    // 仍可使用 HTTP；远程免密 HTTP 也保留，但绝不发送 API Key。
    if (apiKey && parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
      throw new Error('LLM_INSECURE_API_KEY_TRANSPORT');
    }
  }

  const modelContextChars = Number.isInteger(config?.modelContextChars)
    && config.modelContextChars >= MIN_MODEL_CONTEXT_CHARS
    && config.modelContextChars <= MAX_MODEL_CONTEXT_CHARS
    ? config.modelContextChars : DEFAULT_MODEL_CONTEXT_CHARS;

  return {
    ...config,
    modelContextChars,
    // 请求和落盘都使用同一个 WHATWG URL 规范化结果，避免反斜杠、默认端口
    // 或大小写等字符串差异在保存后和 fetch 时被重新解释。
    baseUrl: parsed ? parsed.href.replace(/\/$/u, '') : '',
    model,
    apiKey,
  };
}

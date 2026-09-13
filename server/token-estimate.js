const CJK_OR_WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u;
const ASCII_WORD = /[A-Za-z0-9_]/u;
const WHITESPACE = /\s/u;

export function createTextTokenEstimator() {
  let tokens = 0;
  let asciiRun = 0;
  let whitespaceRun = 0;
  const flushAscii = () => {
    if (asciiRun) tokens += Math.ceil(asciiRun / 4);
    asciiRun = 0;
  };
  const flushWhitespace = () => {
    if (whitespaceRun) tokens += Math.ceil(whitespaceRun / 8);
    whitespaceRun = 0;
  };
  return {
    add(value) {
      const text = typeof value === 'string' ? value : '';
      for (const character of text) {
        if (ASCII_WORD.test(character)) {
          flushWhitespace();
          asciiRun += 1;
          continue;
        }
        flushAscii();
        if (WHITESPACE.test(character)) {
          whitespaceRun += 1;
          continue;
        }
        flushWhitespace();
        // 中文、日韩文字、emoji、其它非 ASCII 字母和标点均按一个保守单位。
        tokens += CJK_OR_WIDE.test(character) ? 1 : 1;
      }
    },
    estimate() {
      return tokens + Math.ceil(asciiRun / 4) + Math.ceil(whitespaceRun / 8);
    },
  };
}

export function estimateTextTokens(value) {
  const estimator = createTextTokenEstimator();
  estimator.add(value);
  return estimator.estimate();
}

export function estimateChatInputTokens(system, messages) {
  const rows = Array.isArray(messages) ? messages : [];
  // Chat Completions 每条消息和整次请求都有少量角色/边界开销；具体值随模型变化。
  return estimateTextTokens(system)
    + rows.reduce((total, message) => total
      + estimateTextTokens(message?.content) + 4, 0)
    + 2;
}

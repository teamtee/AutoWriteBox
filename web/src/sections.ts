// 从 AI 分部建议文本里逐行解析出分部标题。
// 匹配「第 N 部」开头的行（阿拉伯数字或中文数字），标题为其后经分隔符连接的内容；
// 兼容 AI 常见的 Markdown 标题前缀，例如「## 第一部 · 标题」。
// 若 AI 输出「标题：剧情走向」，只采纳冒号前的纯标题。
// 无标题时用「第 N 部」原文兜底。
const CN_NUM = '零一二三四五六七八九十百千两';
const NUM_RE = `\\d+|[${CN_NUM}]+`;
export function parseSectionTitles(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^#{1,6}\s+/, '').trim();
    const m = line.match(new RegExp(`^第\\s*(${NUM_RE})\\s*部\\s*[·:：\\-—、.]?\\s*(.*)$`, 'u'));
    if (!m) continue;
    const num = m[1];
    const title = m[2].split(/[:：]/, 1)[0].trim();
    const fallback = /^\d+$/.test(num) ? `第 ${num} 部` : `第${num}部`;
    out.push(title || fallback);
  }
  return out;
}

// 从 AI 分部建议文本里逐行解析出分部标题。
// 匹配「第 N 部」开头的行，标题为其后经分隔符（·:：\-—、空格）连接的内容；
// 无标题时用「第 N 部」兜底。
export function parseSectionTitles(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = line.match(/^第\s*(\d+)\s*部\s*[·:：\-—、.]?\s*(.*)$/);
    if (!m) continue;
    const title = m[2].trim();
    out.push(title || `第 ${m[1]} 部`);
  }
  return out;
}

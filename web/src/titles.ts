const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const UNITS = ['', '十', '百'];

export function toChineseNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) return String(n);
  if (n === 0) return DIGITS[0];
  let out = '';
  let pendingZero = false;
  for (let pos = 2; pos >= 0; pos--) {
    const power = 10 ** pos;
    const digit = Math.floor(n / power) % 10;
    if (digit === 0) {
      if (out && n % power !== 0) pendingZero = true;
      continue;
    }
    if (pendingZero) {
      out += DIGITS[0];
      pendingZero = false;
    }
    if (!(pos === 1 && digit === 1 && out === '')) out += DIGITS[digit];
    out += UNITS[pos];
  }
  return out;
}

export function formatIndexedTitle(
  index: number,
  unit: '部' | '章',
  title = '',
): string {
  const prefix = `第${toChineseNumber(index)}${unit}`;
  const clean = title.trim();
  return clean ? `${prefix} · ${clean}` : prefix;
}

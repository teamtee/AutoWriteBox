export function parseSSEChunk(buffer) {
  const deltas = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop();  // 最后一段可能不完整，留待下次
  for (const part of parts) {
    const lineText = part.split('\n').find((l) => l.startsWith('data:'));
    if (!lineText) continue;
    const payload = lineText.slice(5).trim();
    if (payload === '[DONE]' || payload === '') continue;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) deltas.push(delta);
    } catch { /* 半包，忽略 */ }
  }
  return { deltas, rest };
}

export async function* streamChat({ config, system, messages }) {
  const body = {
    model: config.model,
    stream: true,
    messages: [{ role: 'system', content: system }, ...messages],
  };
  const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM_HTTP_${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const { deltas, rest } = parseSSEChunk(buf);
    buf = rest;
    for (const d of deltas) yield d;
  }
}

export function extractDigest(text) {
  const fallback = { summary: '', progress: '', newCharacters: [] };
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  let obj = tryParse(text.trim());
  if (!obj) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }
  if (!obj) return fallback;
  return {
    summary: obj.summary || '',
    progress: obj.progress || '',
    newCharacters: Array.isArray(obj.newCharacters) ? obj.newCharacters : [],
  };
}

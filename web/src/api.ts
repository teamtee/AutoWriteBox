import type { Book, BookTree, Config } from './types';

const json = (r: Response) => r.json();
const jpost = (p: string, b: unknown) =>
  fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json);
const jput = (p: string, b: unknown) =>
  fetch(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json);

export const getConfig = (): Promise<Config> => fetch('/api/config').then(json);
export const saveConfig = (patch: Partial<Config>): Promise<Config> => jpost('/api/config', patch);
export const listBooks = () => fetch('/api/books').then(json);
export const createBook = (premise: string, title?: string): Promise<Book> => jpost('/api/books', { premise, title });
export const getTree = (bookId: string): Promise<BookTree> => fetch(`/api/books/${bookId}/tree`).then(json);
export const addSection = (bookId: string, title?: string) => jpost(`/api/books/${bookId}/sections`, { title });
export const addChapter = (bookId: string, sid: string, title?: string) => jpost(`/api/books/${bookId}/sections/${sid}/chapters`, { title });
export const saveChapter = (bookId: string, sid: string, cid: string, content: string) =>
  jput(`/api/books/${bookId}/sections/${sid}/chapters/${cid}`, { content });
export const rollbackChapter = (bookId: string, sid: string, cid: string) =>
  jpost(`/api/books/${bookId}/sections/${sid}/chapters/${cid}/rollback`, {});
export const saveOutline = (bookId: string, content: string) => jput(`/api/books/${bookId}/outline`, { content });
export const saveCore = (bookId: string, core: unknown) => jput(`/api/books/${bookId}/core`, { core });

export interface SSEEvent { delta?: string; done?: boolean; error?: string; chapterId?: string; sections?: string; }

export function parseSSELines(chunk: string, buffer: string): { events: SSEEvent[]; rest: string } {
  const events: SSEEvent[] = [];
  const parts = (buffer + chunk).split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    const line = part.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try { events.push(JSON.parse(payload)); } catch { /* 半包 */ }
  }
  return { events, rest };
}

export function streamGen(
  path: string, body: unknown,
  cb: { onDelta?: (d: string) => void; onDone?: (e: SSEEvent) => void; onError?: (m: string) => void }
): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctrl.signal,
      });
      if (!res.body) throw new Error('无响应流');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const { events, rest } = parseSSELines(dec.decode(value, { stream: true }), buf);
        buf = rest;
        for (const e of events) {
          if (e.delta) cb.onDelta?.(e.delta);
          if (e.error) cb.onError?.(e.error);
          if (e.done) cb.onDone?.(e);
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') cb.onError?.(String((err as Error).message || err));
    }
  })();
  return () => ctrl.abort();
}

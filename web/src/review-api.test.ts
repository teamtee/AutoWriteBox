import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyChapterReviewPromiseCandidate, applyChapterReviewWorldGateCandidate,
  generateChapterReviewRevisionCandidate, generateChapterRevisionCandidate,
  reviewChapter, reviewGoldenThree, verifyChapterReviewRevisionCandidate,
} from './api';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe('review API', () => {
  it('对单章和黄金三章都发送显式版本锚点与取消信号', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ score: 80 }))) as unknown as typeof fetch;
    const controller = new AbortController();
    await reviewChapter('book one', 'section one', 'chapter one', 'B'.repeat(43),
      'C'.repeat(43), controller.signal);
    await reviewGoldenThree('book one', 'G'.repeat(43), controller.signal);
    await generateChapterRevisionCandidate(
      'book one', 'section one', 'chapter one', 'character-voice',
      'B'.repeat(43), 'C'.repeat(43), controller.signal,
    );
    await generateChapterReviewRevisionCandidate(
      'book one', 'section one', 'chapter one', 'B'.repeat(43),
      'C'.repeat(43), 'R'.repeat(43), controller.signal,
    );
    await verifyChapterReviewRevisionCandidate(
      'book one', 'section one', 'chapter one', '候选正文', 'B'.repeat(43),
      'C'.repeat(43), 'R'.repeat(43), controller.signal,
    );
    await applyChapterReviewPromiseCandidate(
      'book one', 'section one', 'chapter one', `promise_${'a'.repeat(32)}`,
      'B'.repeat(43), 'R'.repeat(43), 'L'.repeat(43), controller.signal,
    );
    await applyChapterReviewWorldGateCandidate(
      'book one', 'section one', 'chapter one',
      'B'.repeat(43), 'R'.repeat(43), 'W'.repeat(43), controller.signal,
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1,
      '/api/books/book%20one/sections/section%20one/chapters/chapter%20one/review',
      expect.objectContaining({
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({
          expectedBodyFingerprint: 'B'.repeat(43),
          expectedContextRevision: 'C'.repeat(43),
        }),
      }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2,
      '/api/books/book%20one/golden-three-review', expect.objectContaining({
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ expectedContextRevision: 'G'.repeat(43) }),
      }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(3,
      '/api/books/book%20one/sections/section%20one/chapters/chapter%20one/revision-candidate',
      expect.objectContaining({
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({
          stage: 'character-voice', expectedBodyFingerprint: 'B'.repeat(43),
          expectedContextRevision: 'C'.repeat(43),
        }),
      }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(4,
      '/api/books/book%20one/sections/section%20one/chapters/chapter%20one/review-revision-candidate',
      expect.objectContaining({
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({
          expectedBodyFingerprint: 'B'.repeat(43),
          expectedContextRevision: 'C'.repeat(43),
          expectedReviewRevision: 'R'.repeat(43),
        }),
      }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(5,
      '/api/books/book%20one/sections/section%20one/chapters/chapter%20one/'
        + 'review-revision-candidate/verify',
      expect.objectContaining({
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({
          candidate: '候选正文', expectedBodyFingerprint: 'B'.repeat(43),
          expectedContextRevision: 'C'.repeat(43), expectedReviewRevision: 'R'.repeat(43),
        }),
      }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(6,
      `/api/books/book%20one/sections/section%20one/chapters/chapter%20one/`
        + `review-promise-candidates/promise_${'a'.repeat(32)}/apply`,
      expect.objectContaining({
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({
          expectedBodyFingerprint: 'B'.repeat(43),
          expectedReviewRevision: 'R'.repeat(43),
          expectedPromiseLedgerRevision: 'L'.repeat(43),
        }),
      }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(7,
      '/api/books/book%20one/sections/section%20one/chapters/chapter%20one/'
        + 'review-world-gate-candidate/apply',
      expect.objectContaining({
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({
          expectedBodyFingerprint: 'B'.repeat(43),
          expectedReviewRevision: 'R'.repeat(43),
          expectedWorldProgressRevision: 'W'.repeat(43),
        }),
      }));
  });
});

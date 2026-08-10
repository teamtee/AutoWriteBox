import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ToastMessage } from './Toast';

describe('ToastMessage accessibility', () => {
  it('announces errors immediately and gives the dismiss action a name', () => {
    const html = renderToStaticMarkup(
      <ToastMessage
        toast={{ id: 1, type: 'error', msg: '保存失败' }}
        onClose={vi.fn()} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="关闭通知"');
  });

  it('announces non-critical feedback politely', () => {
    for (const type of ['success', 'info'] as const) {
      const html = renderToStaticMarkup(
        <ToastMessage
          toast={{ id: 1, type, msg: '操作完成' }}
          onClose={vi.fn()} />,
      );

      expect(html).toContain('role="status"');
    }
  });
});

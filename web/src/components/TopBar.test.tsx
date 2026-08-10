import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
  });
});

afterEach(() => vi.unstubAllGlobals());

const render = ({ streaming, busy, cancellable }: { streaming: boolean; busy: boolean; cancellable?: boolean }) =>
  renderToStaticMarkup(
    <TopBar
      title="测试书"
      streaming={streaming}
      busy={busy}
      cancellable={cancellable}
      statusText="处理中"
      onOpenSettings={() => {}}
      onHome={() => {}}
    />,
  );

describe('TopBar busy navigation', () => {
  it('uses the book title as the workspace page heading', () => {
    const html = render({ streaming: false, busy: false });
    expect(html).toContain('<h1 class="topbar-title">📖 测试书</h1>');
    expect(html).toContain('class="hbtn mini topbar-home"');
  });

  it('locks settings but keeps home available while streaming so App can stop the stream', () => {
    const html = render({ streaming: true, busy: true });
    expect(html).toMatch(/<button class="hbtn mini topbar-home">📚 书架<\/button>/);
    expect(html).toMatch(/<button class="hbtn" disabled="">⚙️ 设置<\/button>/);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('class="dots" aria-hidden="true"');
  });

  it('locks both navigation entries during non-cancellable writes', () => {
    const html = render({ streaming: false, busy: true });
    expect(html).toMatch(/<button class="hbtn mini topbar-home" disabled="">📚 书架<\/button>/);
    expect(html).toMatch(/<button class="hbtn" disabled="">⚙️ 设置<\/button>/);
  });

  it('keeps home available for another explicitly cancellable operation', () => {
    const html = render({ streaming: false, busy: true, cancellable: true });
    expect(html).toMatch(/<button class="hbtn mini topbar-home">📚 书架<\/button>/);
    expect(html).toMatch(/<button class="hbtn" disabled="">⚙️ 设置<\/button>/);
  });
});

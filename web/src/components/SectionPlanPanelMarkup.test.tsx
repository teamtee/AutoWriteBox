import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SectionPlanPanel } from './SectionPlanPanel';

describe('SectionPlanPanel dialog semantics', () => {
  it('announces the modal, title, content and busy state to assistive technology', () => {
    const html = renderToStaticMarkup(
      <SectionPlanPanel text="正在规划" titles={[]} streaming
        onAdopt={vi.fn()} onRetry={vi.fn()} onClose={vi.fn()} />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="section-plan-title"');
    expect(html).toContain('aria-describedby="section-plan-content"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('tabindex="-1"');
  });

  it('announces an invalid generated plan as an error', () => {
    const html = renderToStaticMarkup(
      <SectionPlanPanel text="无法识别" titles={[]} streaming={false} parseError
        onAdopt={vi.fn()} onRetry={vi.fn()} onClose={vi.fn()} />,
    );

    expect(html).toContain('class="plan-parse-error" role="alert"');
  });
});

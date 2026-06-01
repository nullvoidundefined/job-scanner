import { buildDigestHtml } from 'app/radar/digest.js';
import { describe, expect, it } from 'vitest';

describe('buildDigestHtml', () => {
  it('lists each queue row and the reject distribution', () => {
    const html = buildDigestHtml(
      [
        {
          id: 1,
          name: 'Acme AI',
          warmth_score: '20',
          live_score: '35',
          status: 'discovered',
        },
      ],
      [{ reason: 'pooled investment fund', count: 4 }],
    );
    expect(html).toContain('Acme AI');
    expect(html).toContain('35');
    expect(html).toContain('pooled investment fund');
    expect(html).toContain('4');
  });

  it('renders a friendly message when the queue is empty', () => {
    const html = buildDigestHtml([], []);
    expect(html.toLowerCase()).toContain('no companies');
  });
});

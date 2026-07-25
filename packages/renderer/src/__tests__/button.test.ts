import { describe, it, expect } from 'vitest';
import { renderButtonBlock } from '../action.js';

describe('renderButtonBlock', () => {
  it('renders recipe.run actions as read-only descriptors', () => {
    const html = renderButtonBlock([
      {
        kind: 'recipe.run',
        label: 'Review timed-out replies',
        recipe_id: 'timeout-review',
      },
      {
        kind: 'recipe.run',
        label: 'Close watch',
        recipe_id: 'close-watch',
      },
    ]);
    expect(html).toContain('button-block');
    expect(html).toContain('data-action-mode="read-only"');
    expect(html).toContain('Review timed-out replies');
    expect(html).toContain('timeout-review');
    expect(html).toContain('Close watch');
  });

  it('escapes action labels and recipe ids', () => {
    const html = renderButtonBlock({
      kind: 'recipe.run',
      label: '<script>',
      recipe_id: 'target"><img',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('target&quot;&gt;&lt;img');
  });

  it('renders invalid descriptors as a safe error', () => {
    expect(renderButtonBlock({ kind: 'url.open', label: 'Open' })).toContain('block-error');
    expect(renderButtonBlock(null)).toContain('No button data');
  });
});

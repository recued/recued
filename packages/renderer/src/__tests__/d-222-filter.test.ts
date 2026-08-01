import { describe, expect, it } from 'vitest';
import type { ResolvedFilterDescriptor } from '@recued/contracts';

import {
  FILTER_BLOCK_ATTR,
  FILTER_PAGE_ATTR,
  FILTER_SUBMIT_ATTR,
  renderFilterBlock,
  renderSection,
} from '../index.js';

const descriptor = (): ResolvedFilterDescriptor => ({
  section_index: 1,
  recipe_hash: 'stored-snapshot-hash',
  fields: ['future'],
  hidden: ['cursor', 'opaque'],
  submit: 'Search safely',
  definitions: {
    future: { label: 'Future field label', type: 'future_widget', default: 'value' } as never,
    cursor: '',
    opaque: { label: 'Hidden opaque label', type: 'future_widget', default: { exact: true } } as never,
  },
  values: {
    future: 'visible value',
    cursor: 'page-2',
    opaque: { exact: true },
  },
  paging: { prev_cursor: 'page-1', next_cursor: 'page-3' },
});

describe('D-222 resolved filter renderer', () => {
  it('renders unknown visible hint types as text with the authored label', () => {
    const html = renderFilterBlock(descriptor(), { audience: 'owner', interactive: true });
    expect(html).toContain(FILTER_BLOCK_ATTR);
    expect(html).toContain('Future field label');
    expect(html).toContain('data-var-type="text"');
    expect(html).toContain('value="visible value"');
    expect(html).toContain(FILTER_SUBMIT_ATTR);
    expect(html).toContain(`${FILTER_PAGE_ATTR}="previous"`);
    expect(html).toContain(`${FILTER_PAGE_ATTR}="next"`);
    expect(html).not.toContain('aria-disabled="true"');
  });

  it('emits no hidden carrier label, value, or control into HTML', () => {
    const html = renderFilterBlock(descriptor(), { audience: 'owner', interactive: true });
    expect(html).not.toContain('Hidden opaque label');
    expect(html).not.toContain('page-2');
    expect(html).not.toContain('exact');
    expect(html).not.toContain('data-var-key="cursor"');
    expect(html).not.toContain('type="hidden"');
  });

  it('omits the complete block for public/non-owner rendering', () => {
    expect(renderFilterBlock(descriptor(), { audience: 'public', interactive: true })).toBe('');
    expect(renderSection(
      { kind: 'filter', data: null, filter: descriptor() },
      { audience: 'public', interactive: true },
    )).toBe('');
  });

  it('keeps controls inert unless the owner host explicitly wires interaction', () => {
    const html = renderFilterBlock(descriptor(), { audience: 'owner' });
    expect(html).toContain('disabled aria-disabled="true"');
  });

  it('fails legibly on a non-host-derived descriptor shape', () => {
    expect(renderFilterBlock({ fields: ['future'] })).toContain(
      'invalid resolved filter descriptor',
    );
    expect(renderFilterBlock({
      ...descriptor(),
      paging: { next_cursor: 42 },
    })).toContain('invalid resolved filter descriptor');
  });
});

/** D-116 Phase 5 — reactive template gallery helpers. */

import { describe, it, expect } from 'vitest';
import {
  AUTHORIZED_TEMPLATE_PUBLISHERS,
  TEMPLATE_TAG_PREFIX,
  stripUnauthorizedTemplateTags,
  parseTemplateVertical,
  validateTags,
} from '../index.js';

describe('TEMPLATE_TAG_PREFIX constant', () => {
  it('is "template:" (literal colon suffix)', () => {
    expect(TEMPLATE_TAG_PREFIX).toBe('template:');
  });
});

describe('AUTHORIZED_TEMPLATE_PUBLISHERS', () => {
  it('seeds with recued-core', () => {
    expect(AUTHORIZED_TEMPLATE_PUBLISHERS.has('recued-core')).toBe(true);
  });

  it('rejects arbitrary third-party handles', () => {
    expect(AUTHORIZED_TEMPLATE_PUBLISHERS.has('acme-inc')).toBe(false);
    expect(AUTHORIZED_TEMPLATE_PUBLISHERS.has('Recued-Core')).toBe(false); // case-sensitive
  });
});

describe('validateTags — multi-segment tags', () => {
  it('accepts template:reactive:mail shape', () => {
    expect(validateTags(['template:reactive:mail'])).toEqual([]);
  });

  it('accepts mixed standard + multi-segment tags', () => {
    expect(validateTags(['reactive', 'mail', 'template:reactive:mail'])).toEqual([]);
  });

  it('still rejects bare colons or empty segments', () => {
    const issues = validateTags([':reactive:mail']);
    expect(issues.some((i) => i.code === 'tag_format')).toBe(true);
  });

  it('still rejects uppercase / whitespace', () => {
    expect(validateTags(['Template:Reactive']).some((i) => i.code === 'tag_format')).toBe(true);
    expect(validateTags(['with space']).some((i) => i.code === 'tag_format')).toBe(true);
  });
});

describe('stripUnauthorizedTemplateTags', () => {
  it('preserves template:* tags for recued-core', () => {
    const result = stripUnauthorizedTemplateTags(
      ['template:reactive:mail', 'mail', 'reactive'],
      'recued-core',
    );
    expect(result).toEqual(['template:reactive:mail', 'mail', 'reactive']);
  });

  it('strips template:* tags for third-party publishers', () => {
    const result = stripUnauthorizedTemplateTags(
      ['template:reactive:mail', 'mail', 'reactive'],
      'acme-inc',
    );
    expect(result).toEqual(['mail', 'reactive']);
  });

  it('returns an empty array for non-array input', () => {
    expect(stripUnauthorizedTemplateTags('nope', 'acme-inc')).toEqual([]);
    expect(stripUnauthorizedTemplateTags(undefined, 'acme-inc')).toEqual([]);
  });

  it('drops non-string entries while preserving shape', () => {
    const result = stripUnauthorizedTemplateTags(
      ['template:reactive:mail', 42, { nope: true }, 'mail'],
      'recued-core',
    );
    expect(result).toEqual(['template:reactive:mail', 'mail']);
  });
});

describe('parseTemplateVertical', () => {
  it('extracts the vertical segment from a full tag', () => {
    expect(parseTemplateVertical('template:reactive:mail')).toBe('mail');
    expect(parseTemplateVertical('template:reactive:files')).toBe('files');
    expect(parseTemplateVertical('template:reactive:cross-tool')).toBe('cross-tool');
  });

  it('returns null for non-template tags', () => {
    expect(parseTemplateVertical('reactive')).toBeNull();
    expect(parseTemplateVertical('mail')).toBeNull();
  });

  it('returns null for too-few-segments template tags', () => {
    expect(parseTemplateVertical('template:reactive')).toBeNull();
    expect(parseTemplateVertical('template:')).toBeNull();
  });
});

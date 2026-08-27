import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_ATTR,
  PROVENANCE_DETAIL_ATTR,
  REFERENCE_ATTR,
  REFERENCE_ID_ATTR,
  REFERENCE_PROVENANCE_STYLES,
  renderProvenance,
  renderProvenanceAttribution,
  renderReferenceIdentity,
  renderReferenceLink,
} from '../reference-provenance.js';

describe('shared reference and provenance presentation', () => {
  it('renders a canonical attribution as structured, escaped provenance', () => {
    const html = renderProvenanceAttribution({
      kind: 'agent',
      origin_actor: 'contracted_user',
      agent_id: '<agent>',
      label: 'agent <agent> asserted this',
    }, {
      attributes: { 'data-source': 'memory"row' },
    });

    expect(html).toContain(PROVENANCE_ATTR);
    expect(html).toContain('data-kind="agent"');
    expect(html).toContain('agent &lt;agent&gt; asserted this');
    expect(html).toContain('data-source="memory&quot;row"');
  });

  it('keeps the primary source separate from the derived attribution detail', () => {
    const html = renderProvenance({
      primary: 'Connected agent',
      detail: 'agent a-1, under contract c-1, asserted this',
      kind: 'agent',
    });

    expect(html).toContain('Connected agent');
    expect(html).toContain(PROVENANCE_DETAIL_ATTR);
    expect(html).toContain('under contract c-1');
  });

  it('renders nothing for the canonical first-person absence signal', () => {
    expect(renderProvenanceAttribution(undefined)).toBe('');
  });

  it('renders delegated exact-reference actions without losing the full id', () => {
    const html = renderReferenceLink({
      label: 'invoice/…',
      referenceId: 'invoice/inv-123',
      action: { attribute: 'data-action', value: 'open-reference' },
      attributes: { 'data-kind': 'invoice', 'data-id': 'inv-123' },
    });

    expect(html).toContain('<button type="button"');
    expect(html).toContain(`${REFERENCE_ATTR}="action"`);
    expect(html).toContain(`${REFERENCE_ID_ATTR}="invoice/inv-123"`);
    expect(html).toContain('data-action="open-reference"');
    expect(html).toContain('data-id="inv-123"');
  });

  it('degrades active-content hrefs to inert identity', () => {
    const html = renderReferenceLink({
      label: 'unsafe',
      href: ' javascript:alert(1)',
      action: { attribute: 'data-action', value: 'must-not-run' },
    });
    expect(html).toContain('<code');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('must-not-run');
    expect(html).not.toContain('javascript:');
  });

  it('rejects obfuscated active schemes and reserved action attributes', () => {
    const obfuscated = renderReferenceLink({
      label: 'unsafe',
      href: 'java\tscript:alert(1)',
    });
    expect(obfuscated).toContain('<code');
    expect(obfuscated).not.toContain('<a');

    const reservedAction = renderReferenceLink({
      label: 'record-1',
      referenceId: 'record-1',
      action: { attribute: REFERENCE_ID_ATTR, value: 'forged-id' },
    });
    expect(reservedAction).toContain('<code');
    expect(reservedAction).not.toContain('<button');
    expect(reservedAction).toContain(`${REFERENCE_ATTR}="identity"`);
    expect(reservedAction).toContain(`${REFERENCE_ID_ATTR}="record-1"`);
    expect(reservedAction).not.toContain('forged-id');
  });

  it('keeps shared identity authoritative and drops active host attributes', () => {
    const html = renderReferenceLink({
      label: 'safe',
      referenceId: 'record-1',
      href: '#data/record-1',
      attributes: {
        [REFERENCE_ATTR]: 'forged',
        [REFERENCE_ID_ATTR]: 'forged-id',
        href: 'javascript:alert(1)',
        style: 'background:url(https://tracker.invalid)',
        onclick: 'alert(1)',
        'data-host-hook': 'kept',
      },
    });
    expect(html).toContain(`${REFERENCE_ATTR}="link"`);
    expect(html).toContain(`${REFERENCE_ID_ATTR}="record-1"`);
    expect(html).toContain('href="#data/record-1"');
    expect(html).toContain('data-host-hook="kept"');
    expect(html).not.toContain('forged');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('javascript:');
  });

  it('renders labelled identities as copyable code and ships shared styles', () => {
    const html = renderReferenceIdentity({ label: 'Record ID', value: '<r-1>' });
    expect(html).toContain('Record ID');
    expect(html).toContain(
      `<code ${REFERENCE_ID_ATTR}="&lt;r-1&gt;">&lt;r-1&gt;</code>`,
    );
    expect(REFERENCE_PROVENANCE_STYLES).toContain(`[${PROVENANCE_ATTR}]`);
    expect(REFERENCE_PROVENANCE_STYLES).toContain(`[${REFERENCE_ATTR}]`);
  });
});

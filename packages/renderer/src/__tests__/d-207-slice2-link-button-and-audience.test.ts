/** D-207 slice 2a — `packages/renderer` owns all NINE kinds.
 *
 *  Two things are under test, and they are the two the slice exists for:
 *
 *  1. **The `link_button` block** — the one block that NAVIGATES, and therefore
 *     the one whose renderer is a security boundary. `escape` is not that
 *     boundary; the absolute-HTTPS check is.
 *
 *  2. **`audience: 'public'`** — a reception page is read by an anonymous
 *     stranger, and the chrome this renderer adds for an owner (internal ids,
 *     "open the Recipes result panel") is wrong in front of one. It must drop
 *     that chrome and NOTHING the recipe itself supplied. */

import { describe, it, expect } from 'vitest';
import { OUTPUT_TYPES } from '@recued/contracts';

import { renderSection } from '../index.js';
import { renderLinkButtonBlock } from '../link-button.js';
import { renderButtonBlock } from '../action.js';
import { renderFileArtifactBlock } from '../file-artifact.js';

const button = (over: Record<string, unknown> = {}) => ({
  label: 'Proceed to payment',
  url: 'https://checkout.stripe.com/c/pay/cs_test_123',
  ...over,
});

describe('the vocabulary is ONE closed list', () => {
  // The `door_types` drift (slice 1c) shipped because a closed const and a
  // hand-written copy of it lived in two files: the copy typechecked while
  // disagreeing. `SectionKind` derives from `OutputType` now, so the only way
  // to prove that is to assert the RENDERER can render every kind the CONTRACT
  // admits — the property, not a literal typed next to it.
  it('renders every kind the recipe contract admits — no kind falls to `unsupported`', () => {
    expect(OUTPUT_TYPES).toContain('link_button');
    for (const kind of OUTPUT_TYPES) {
      const html = renderSection({ kind, data: null });
      expect(html, `${kind} fell through renderSection's switch`)
        .not.toContain('unsupported section type');
    }
  });

  it('still refuses a kind the contract does NOT admit', () => {
    expect(renderSection({ kind: 'not_a_kind', data: null }))
      .toContain('unsupported section type');
  });
});

describe('link_button — the href fence', () => {
  it('renders an absolute-HTTPS button as a real anchor', () => {
    const html = renderLinkButtonBlock([button()]);
    expect(html).toContain('href="https://checkout.stripe.com/c/pay/cs_test_123"');
    expect(html).toContain('Proceed to payment');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  // ⛔ THE CORE ASSERTION OF THIS BLOCK. `htmlEscape('javascript:alert(1)')`
  // returns `javascript:alert(1)` — every character survives, and it stays a
  // live href. Escaping is NOT the fence; `isReceptionLinkButtonUrl` is. A
  // renderer that trusted its caller to have filtered would emit these.
  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['plain http', 'http://checkout.example.com/pay'],
    ['protocol-relative', '//checkout.example.com/pay'],
    ['relative', '/pay'],
  ])('DROPS a %s url rather than escaping it into a live href', (_name, url) => {
    const html = renderLinkButtonBlock([button({ url })]);
    expect(html).not.toContain('href=');
    expect(html).not.toContain('Proceed to payment');
  });

  it('drops ONLY the invalid row and still renders its valid siblings', () => {
    const html = renderLinkButtonBlock([
      button({ label: 'Bad', url: 'javascript:alert(1)' }),
      button({ label: 'Good', url: 'https://example.com/ok' }),
    ]);
    expect(html).not.toContain('Bad');
    expect(html).toContain('Good');
    expect(html).toContain('href="https://example.com/ok"');
  });

  it('does not throw on a corrupt row — a visitor page must not 500', () => {
    for (const corrupt of [null, undefined, 'string', 42, {}, { label: 'x' }]) {
      expect(() => renderLinkButtonBlock([corrupt])).not.toThrow();
    }
  });

  it('escapes the label and description it does render', () => {
    const html = renderLinkButtonBlock([
      button({ label: '<img src=x onerror=alert(1)>', description: '</a><script>' }),
    ]);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
  });

  it('reaches the same renderer through the dispatcher', () => {
    expect(renderSection({ kind: 'link_button', data: [button()] }))
      .toContain('href="https://checkout.stripe.com/c/pay/cs_test_123"');
  });
});

describe('audience: public — drop the OWNER chrome, keep the RECIPE content', () => {
  const action = { kind: 'recipe.run', label: 'Review this', recipe_id: 'internal-triage-recipe' };

  it("does not print the owner's internal recipe_id to a visitor", () => {
    const owner = renderButtonBlock(action);
    const publicHtml = renderButtonBlock(action, { audience: 'public' });

    // The owner's own panel is unchanged — this is context, not a leak, there.
    expect(owner).toContain('internal-triage-recipe');
    expect(owner).toContain('Recipe actions are read-only in this renderer.');

    expect(publicHtml).not.toContain('internal-triage-recipe');
    expect(publicHtml).not.toContain('Recipe actions are read-only in this renderer.');
    // …but the label the RECIPE supplied still shows. We drop OUR chrome, not
    // the author's content.
    expect(publicHtml).toContain('Review this');
  });

  const artifact = {
    record_id: 'file_rec_9f3',
    filename: 'invoice.pdf',
    mime_type: 'application/pdf',
    sha256: 'abc123',
    size_bytes: 2048,
    generated_at: 1_700_000_000_000,
    generation_mode: 'template',
    origin: { submission_id: 'sub_777' },
    payment: { status: 'paid' },
    template: { filename: 'owner-master-template.docx' },
  };

  it('withholds the substrate-injected internals from a visitor', () => {
    const publicHtml = renderFileArtifactBlock(artifact, { audience: 'public' });

    // Server-derived plumbing the recipe never chose to show:
    expect(publicHtml).not.toContain('file_rec_9f3');            // warehouse row id
    expect(publicHtml).not.toContain('data-file-artifact-ref');
    expect(publicHtml).not.toContain('owner-master-template');   // owner's template
    expect(publicHtml).not.toContain('Generation mode');
    // Copy addressed to someone with an account:
    expect(publicHtml).not.toContain('Recipes result panel');
  });

  it("still shows the visitor everything about the visitor's OWN file", () => {
    const publicHtml = renderFileArtifactBlock(artifact, { audience: 'public' });
    expect(publicHtml).toContain('invoice.pdf');
    expect(publicHtml).toContain('application/pdf');
    expect(publicHtml).toContain('abc123');     // sha256 — a buyer's integrity check
    expect(publicHtml).toContain('sub_777');    // their own submission reference
    expect(publicHtml).toContain('paid');       // their own payment status
  });

  it('leaves the owner surface byte-for-byte as it was (default audience)', () => {
    // The default MUST stay `owner`, or every existing caller silently changes.
    expect(renderFileArtifactBlock(artifact)).toBe(
      renderFileArtifactBlock(artifact, { audience: 'owner' }),
    );
    const owner = renderFileArtifactBlock(artifact);
    expect(owner).toContain('file_rec_9f3');
    expect(owner).toContain('Recipes result panel');
  });

  it('threads the audience through the dispatcher, not just the direct call', () => {
    const html = renderSection(
      { kind: 'file_artifact', data: artifact },
      { audience: 'public' },
    );
    expect(html).not.toContain('Recipes result panel');
    expect(html).toContain('invoice.pdf');
  });
});

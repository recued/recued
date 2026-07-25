/** D-207 slice 2b — `render` mode: a paired recipe's output becomes the page.
 *
 *  The substrate was already threaded end to end and ONE hop threw it away: the
 *  runner has always returned the run's output verbatim (`ReceptionRunOutcome
 *  .completed.output`, built for exactly this), and the adapter mapped it to a
 *  bare `{ kind: 'completed' }`. This is the hop, plus the visitor-facing
 *  boundary it feeds.
 *
 *  What is under test:
 *
 *   1. The blocks actually reach the visitor's page.
 *   2. They render with the PUBLIC context — the owner's chrome is not on a
 *      stranger's page, and a control the page's CSP cannot run is not either.
 *   3. The `link_button` href fence holds over RUN OUTPUT, not just over the
 *      authored reception-page config it was built for. This is the new attack
 *      surface: an authored button was typed by the owner; a run-produced one
 *      comes from whatever the recipe computed, which on a public form is
 *      reachable from what a stranger submitted.
 *   4. An UNPAIRED form — the D-149 default, and every form that exists today —
 *      is byte-for-byte unchanged. */

import { describe, it, expect, vi } from 'vitest';

import { composeReceptionRecipeRunnerAdapter } from '../reception-recipe-runner-adapter.js';
import type { ReceptionRecipeRunner } from '../reception-recipe-runner.js';
import { sealFormSubmissionField } from '../ports/reception/form-pii.js';
import { renderIntakeFormSuccessHtml } from '../ports/reception/handlers/intake-form-render.js';
import type { FormSubmissionStore } from '../storage/reception-form-store.js';
import type { IntakeFormConfig } from '@recued/contracts';

const PII_KEY = new Uint8Array(32).fill(0x6e);
const ENDPOINT_ID = 'ep_intake_1';

const formConfig = () => ({ display_name: 'Acme' } as unknown as IntakeFormConfig);

const adapterHarness = async (outcome: Awaited<ReturnType<ReceptionRecipeRunner['run']>>) => {
  const sealed = await sealFormSubmissionField({
    key: PII_KEY,
    endpoint_id: ENDPOINT_ID,
    submission_id: 'sub_1',
    field: 'submission_blob',
    plaintext: JSON.stringify({ fields: { company: 'Acme' } }),
  });
  const run = vi.fn(async () => outcome);
  const adapter = composeReceptionRecipeRunnerAdapter({
    runner: { run } as unknown as ReceptionRecipeRunner,
    submissionStore: {
      findById: () => ({
        submission_id: 'sub_1',
        endpoint_id: ENDPOINT_ID,
        submission_blob_encrypted: sealed,
      }),
    } as unknown as Pick<FormSubmissionStore, 'findById'>,
    getFormSubmissionPiiKey: () => PII_KEY,
  });
  return adapter;
};

const successPage = (render: ReadonlyArray<{ type: string; data: unknown; label?: string }> | null) =>
  renderIntakeFormSuccessHtml({
    display_name: 'Acme',
    success_message: 'Thanks — we got it.',
    receipt: null,
    render,
  });

const CHECKOUT_BUTTON = {
  label: 'Proceed to payment',
  url: 'https://checkout.stripe.com/c/pay/cs_live_abc',
};

describe('the adapter no longer drops the run output', () => {
  it('carries `output.render` through to the coordinator seam', async () => {
    const adapter = await adapterHarness({
      kind: 'completed',
      output: { render: [{ type: 'link_button', data: [CHECKOUT_BUTTON] }], sidebar: [] },
    });

    const outcome = await adapter({ submission_id: 'sub_1', form_config: formConfig() });

    expect(outcome.kind).toBe('completed');
    // Before slice 2 this was `{ kind: 'completed' }` and the blocks died here.
    expect(outcome).toMatchObject({
      render: [{ type: 'link_button', data: [CHECKOUT_BUTTON] }],
    });
  });

  it('carries an EMPTY render for a recipe that declares no output — not undefined', async () => {
    const adapter = await adapterHarness({
      kind: 'completed',
      output: { render: [], sidebar: [] },
    });
    const outcome = await adapter({ submission_id: 'sub_1', form_config: formConfig() });
    expect(outcome).toEqual({ kind: 'completed', render: [] });
  });

  it('a HELD run carries no blocks — it has produced no output to show', async () => {
    const adapter = await adapterHarness({ kind: 'held' });
    const outcome = await adapter({ submission_id: 'sub_1', form_config: formConfig() });
    // Parked at the D-157 gate. The thank-you it gets is honest; inventing a
    // page for it would not be.
    expect(outcome).toEqual({ kind: 'held' });
  });
});

describe('the blocks reach the visitor page', () => {
  it('renders a checkout link_button as a real, navigable anchor', () => {
    const html = successPage([{ type: 'link_button', data: [CHECKOUT_BUTTON] }]);
    expect(html).toContain('href="https://checkout.stripe.com/c/pay/cs_live_abc"');
    expect(html).toContain('Proceed to payment');
    // …and it is the shared block, not a second renderer.
    expect(html).toContain('class="block link-button-block"');
  });

  it('renders the other block kinds a recipe can return', () => {
    const html = successPage([
      { type: 'text', data: 'Your quote is ready.' },
      { type: 'summary', data: { fields: [{ label: 'Total', value: '£125.00' }] } },
    ]);
    expect(html).toContain('Your quote is ready.');
    expect(html).toContain('Total');
    expect(html).toContain('£125.00');
  });

  it('puts the blocks ABOVE the receipt — the thing to ACT on is not buried', () => {
    const html = renderIntakeFormSuccessHtml({
      display_name: 'Acme',
      success_message: 'Thanks',
      receipt: {
        reference_id: 'sub_1',
        submitted_at: 1_700_000_000_000,
        fields_echo: [{ label: 'Email', value: 'lead@example.com' }],
      } as never,
      render: [{ type: 'link_button', data: [CHECKOUT_BUTTON] }],
    });
    expect(html.indexOf('Proceed to payment')).toBeLessThan(html.indexOf('lead@example.com'));
  });
});

describe('the visitor page renders with the PUBLIC context', () => {
  it("does not print the owner's internal recipe_id onto a public page", () => {
    const html = successPage([{
      type: 'button',
      data: { kind: 'recipe.run', label: 'Follow up', recipe_id: 'internal-triage-recipe' },
    }]);
    expect(html).not.toContain('internal-triage-recipe');
    expect(html).not.toContain('Recipes result panel');
    // The label the recipe supplied still shows — we drop OUR chrome, not the
    // author's content.
    expect(html).toContain('Follow up');
  });

  it('does not render a Copy button the page CSP could never run', () => {
    // The reception CSP is `script-src 'none'`. An interactive control here is
    // not merely unstyled — it is DEAD.
    const html = successPage([{ type: 'copyable', data: 'ORDER-123' }]);
    expect(html).toContain('ORDER-123');
    expect(html).not.toContain('data-action="copy"');
    expect(html).not.toContain('<button');
  });

  it('withholds the substrate internals of a file artifact from the visitor', () => {
    const html = successPage([{
      type: 'file_artifact',
      data: {
        record_id: 'file_rec_9f3',
        filename: 'invoice.pdf',
        mime_type: 'application/pdf',
        sha256: 'abc123',
        origin: { submission_id: 'sub_1', task_id: 'task_internal_42' },
      },
    }]);
    expect(html).toContain('invoice.pdf');           // their own file
    expect(html).not.toContain('file_rec_9f3');      // a warehouse row id
    expect(html).not.toContain('task_internal_42');  // the owner's work item
  });
});

describe('the href fence holds over RUN OUTPUT, not just authored config', () => {
  // This is the surface slice 2 opens. An authored link button was typed by the
  // owner into their reception page; a RUN-produced one is whatever the recipe
  // computed — and on a public form the recipe's inputs are reachable from what
  // an anonymous stranger just submitted. Escaping does not help here:
  // `javascript:alert(1)` survives htmlEscape intact and stays a live href.
  it.each([
    ['javascript:', 'javascript:alert(document.domain)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['plain http', 'http://phish.example/pay'],
  ])('DROPS a %s url a recipe put in a link_button', (_name, url) => {
    const html = successPage([{
      type: 'link_button',
      data: [{ label: 'Pay now', url }],
    }]);
    expect(html).not.toContain(url);
    expect(html).not.toContain('Pay now');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
  });

  it('drops only the bad row and still hands over the good one', () => {
    const html = successPage([{
      type: 'link_button',
      data: [{ label: 'Evil', url: 'javascript:alert(1)' }, CHECKOUT_BUTTON],
    }]);
    expect(html).not.toContain('Evil');
    expect(html).toContain('Proceed to payment');
  });

  it('escapes what a recipe puts in a text block', () => {
    const html = successPage([{ type: 'text', data: '<img src=x onerror=alert(1)>' }]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

describe('an UNPAIRED form is byte-for-byte what D-149 shipped', () => {
  // Every intake form in existence today has no paired recipe. If any of them
  // moved a byte, slice 2 broke the D-149 default rather than extending it.
  it('renders identically for no blocks, empty blocks, and null', () => {
    const baseline = renderIntakeFormSuccessHtml({
      display_name: 'Acme',
      success_message: 'Thanks — we got it.',
      receipt: null,
    });
    expect(successPage(null)).toBe(baseline);
    expect(successPage([])).toBe(baseline);
  });
});

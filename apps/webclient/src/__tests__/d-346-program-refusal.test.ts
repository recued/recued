/** D-346 A — a run refused before it started because a program its steps launch
 *  is gone (`program_not_installed`) says which program and links its pack, as a
 *  run that stopped on that program does (`run-needs-offer.ts`).
 *
 *  The refusal's `details.missing_programs` is the contract; its sentence is for
 *  a model and a log. Each way the reading wrongly says yes puts a link in front
 *  of the owner that cannot help; each way it wrongly says no hides the one that
 *  would. */
import { describe, expect, it } from 'vitest';
import { RpcError, type RunProgramNeed } from '@recued/contracts';

import { runModalNextStep } from '../shell/run-modal.js';
import { RUN_NEEDS_OFFER_ATTR, programNeedsFromError, renderRunNeedList } from '../shell/run-needs-offer.js';

const RG: RunProgramNeed = { kind: 'program', step_id: 'find', problem: 'not_found', tool: 'rg', pack_slug: 'ripgrep', label: 'Ripgrep' };
const SENTENCE = 'rg is not installed on your server, or your server cannot find it, so ‘Find in files’ did not start. '
  + 'Ripgrep’s page in Packs says what to do.';
const refusal = (details: unknown, code = 'program_not_installed'): RpcError =>
  new RpcError(code, SENTENCE, 400, undefined, details as Record<string, unknown>);

describe('programNeedsFromError', () => {
  it('reads the programs the refusal names, and only those', () => {
    expect(programNeedsFromError(refusal({ missing_programs: [RG] }))).toEqual([RG]);
    // An error that lost its prototype on the way still offers.
    expect(programNeedsFromError({ code: 'program_not_installed', details: { missing_programs: [RG] } })).toEqual([RG]);
    // A row that is not a program need, or names a problem this build cannot say, is left out.
    expect(programNeedsFromError(refusal({ missing_programs: [RG, { kind: 'connection', slot: 'exa' },
      { ...RG, problem: 'gremlins' }, null, 'rg'] }))).toEqual([RG]);
  });

  it('is not an offer for any other refusal, without the list, or from the message', () => {
    expect(programNeedsFromError(refusal({ missing_programs: [RG] }, 'pack_not_installed'))).toBeNull();
    expect(programNeedsFromError(refusal({}))).toBeNull();
    expect(programNeedsFromError(refusal({ missing_programs: [] }))).toBeNull();
    expect(programNeedsFromError(refusal({ missing_programs: 'rg' }))).toBeNull();
    expect(programNeedsFromError(new RpcError('program_not_installed', SENTENCE, 400))).toBeNull();
    // ⛔ Never from the message: the details are the contract.
    expect(programNeedsFromError(new Error(SENTENCE))).toBeNull();
    expect(programNeedsFromError(null)).toBeNull();
  });
});

describe('the run dialog and the result panels', () => {
  it("the run dialog's next step names the program and opens its pack's page", () => {
    expect(runModalNextStep(refusal({ missing_programs: [RG] }))).toEqual({
      lead: 'rg is not installed on your server, or your server cannot find it. Its pack’s page shows what to do.',
      links: [{ text: 'Open Ripgrep', href: '#packs/ripgrep' }],
    });
    // Two programs: a sentence each, a link each.
    const pdf: RunProgramNeed = { kind: 'program', step_id: 'pre', problem: 'not_found', tool: 'pdftotext', pack_slug: 'poppler' };
    expect(runModalNextStep(refusal({ missing_programs: [pdf, RG] }))?.links).toEqual([
      { text: 'Open its pack', href: '#packs/poppler' },
      { text: 'Open Ripgrep', href: '#packs/ripgrep' },
    ]);
  });

  it('a result panel draws the same offer, escaped, and nothing for no needs', () => {
    const html = renderRunNeedList([{ ...RG, label: 'Rip<grep>' }]);
    expect(html).toContain(RUN_NEEDS_OFFER_ATTR);
    expect(html).toContain('href="#packs/ripgrep"');
    expect(html).toContain('Open Rip&lt;grep&gt;');
    expect(html).not.toContain('did not start');
    expect(renderRunNeedList([])).toBe('');
  });
});

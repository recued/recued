import type { PageForm } from './page-outline.js';
import { isBrowserReadState, isBrowserInteractionTargets } from '@recued/contracts';

/** Add read-only follow-up arguments. Never manufacture a cursor beyond the
 * captured source or shorten a document handle to fit a response bound. */
export const withBrowserReadContinuation = (read: Record<string, unknown>, form: PageForm,
  loading = read.loading === true, input: Record<string, unknown> = {}): Record<string, unknown> => {
  if (!['outline', 'text', 'lines'].some(key => typeof read[key] === 'string') || read.block !== undefined) return read;
  const next = typeof read.next === 'number' && Number.isSafeInteger(read.next) && read.next > 0 ? read.next : undefined;
  const complete = !loading && read.truncated === false && read.next === undefined && read.complete !== false;
  const page = typeof read.page === 'string' && read.page.length > 0 && read.page.length <= 512 ? read.page : undefined;
  const scope = isBrowserReadState(read.read_state) && read.read_state.scope.kind === 'element' ? read.read_state.scope : undefined;
  const target = scope?.ref ? { ref: scope.ref } : scope?.selector ? { selector: scope.selector } : {};
  const size = scope && typeof input.chars === 'number' && Number.isSafeInteger(input.chars) && input.chars > 0
    ? { chars: input.chars } : {};
  const usableControls = isBrowserInteractionTargets(read.interaction_targets)
    && read.interaction_targets.items.some(item => item.actions.length > 0);
  return { ...read, complete,
    ...(loading && page !== undefined ? { loading_recovery: {
      when: 'Only when evidence needed for the requested next action or answer is missing from this capture.',
      observed_controls_usable: usableControls,
      ...(usableControls ? {
        note: 'Observed controls can be used with their current document refs when sufficient for the requested action, even while resources load. This does not establish full coverage or application success. If needed content is missing, wait for an observed relevant condition or read its observed region; document readiness alone does not prove AJAX completion. No follow-up is required solely because loading is true.',
      } : {
        steps: [{ do: 'wait', page, until: 'ready', seconds: 10 }, { do: 'read', form, ...target, ...size }],
        note: `Optional only when the missing evidence requires document readiness: wait up to 10 seconds, then read ${scope ? 'the same element' : 'the current page'}. A timeout or unknown readiness fails. Ready does not prove delayed AJAX content or application success. This performs no click, submission, reload or navigation. Continue remaining read parts when needed.`,
      }),
    } } : {}),
    ...(page !== undefined && next !== undefined ? {
      // These arguments are shared by Inspect a web page and Read web text.
      next_read: scope ? { page, ...target, form, from: next, ...size } : { page, from: next, find: '' },
      // Act on web pages takes a step, not root-level from/find arguments.
      next_step: { do: 'read', page, form, ...target, from: next, ...size },
      continuation_note: scope ? 'Continue only within this element using next_read or next_step, retaining its ref/selector. Each call reads the current element again; if its content changed, restart from 0 in the standalone reader or omit from in Act.'
        : 'Use next_read as arguments to the same standalone read tool, or next_step in Act on web pages steps. Clear an earlier find or block; do not combine it with from.',
    } : {}) };
};

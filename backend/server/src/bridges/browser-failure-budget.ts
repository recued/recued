import { BROWSER_FAILURE_DETAILS_CHARS, type BrowserFailureDetails } from '@recued/contracts';
import { limitPageObservation } from './browser-page-observation.js';
import { omitBrowserViewEvidence } from './browser-post-action.js';

/** The error seam has one aggregate budget. Keep usable capture references and
 * the failing operation before historical text; never spread action inputs. */
export const limitBrowserFailureDetails = (details: BrowserFailureDetails): BrowserFailureDetails => {
  if (JSON.stringify(details).length <= BROWSER_FAILURE_DETAILS_CHARS) return details;
  const out = { ...details, ...(details.completed_reads ? { completed_reads: details.completed_reads.map(read => ({ ...read })) } : {}) };
  const fits = () => JSON.stringify(out).length <= BROWSER_FAILURE_DETAILS_CHARS;
  for (const read of out.completed_reads ?? []) {
    while (!fits() && read.content.length) {
      read.content = read.content.slice(0, Math.max(0, read.content.length - 256));
      read.truncated = true; out.completed_reads_truncated = true;
    }
  }
  while (!fits() && out.completed_reads?.length) { out.completed_reads.shift(); out.completed_reads_truncated = true; }
  if (!fits() && out.page_observation) {
    const { page_observation, ...rest } = out;
    const bounded = limitPageObservation(page_observation, BROWSER_FAILURE_DETAILS_CHARS - JSON.stringify(rest).length - 32);
    if (bounded) out.page_observation = bounded;
    else delete out.page_observation;
  }
  if (!fits() && out.post_action?.view) {
    const post = { ...out.post_action, view: { ...out.post_action.view } };
    out.post_action = post;
    for (const key of ['field_evidence', 'extraction_targets', 'control_evidence'] as const) {
      if (!fits()) omitBrowserViewEvidence(post.view, key);
    }
    while (!fits() && post.view.outline.length) {
      post.view.outline = post.view.outline.slice(0, Math.max(0, post.view.outline.length - 256));
      post.view.read_state = { ...post.view.read_state, complete: false, truncated: true };
    }
    if (!fits()) { out.post_action = { ...post, view: undefined, view_status: 'unavailable', reason: 'read_failed' }; }
  }
  if (!fits() && out.failure_observation?.view) {
    const observation = { ...out.failure_observation, view: { ...out.failure_observation.view } };
    out.failure_observation = observation;
    for (const key of ['field_evidence', 'extraction_targets', 'control_evidence'] as const) {
      if (!fits()) omitBrowserViewEvidence(observation.view, key);
    }
    while (!fits() && observation.view.outline.length) {
      observation.view.outline = observation.view.outline.slice(0, Math.max(0, observation.view.outline.length - 256));
      observation.view.read_state = { ...observation.view.read_state, complete: false, truncated: true };
    }
    if (!fits()) out.failure_observation = { ...observation, view: undefined, view_status: 'unavailable', reason: 'read_failed' };
  }
  return out;
};

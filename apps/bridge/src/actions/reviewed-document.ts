/** Chrome's document ID is the dispatch target, not a tab lookup hint.
 * Functions injected below are deliberately self-contained. They do not
 * capture extension variables across Chrome's serialization boundary. */
import { BRIDGE_REVIEW_DOCUMENT_LIMIT, isBridgeDocumentIdentity,
  type BridgeAction, type BridgeDocumentIdentity } from '@recued/contracts';
import type { ActionExecutorOutcome } from '../queue/dispatcher.js';
import { clickPageElement, fillPageField, readPageField } from './page-fields.js';
import {
  describeOutcome,
  describePageElement,
  inspectOutcome,
  inspectPage,
  PAGE_CHANGED,
  readElementRequest,
  readInspectRequest,
  settleFrames,
} from './page-inspect.js';

export interface DocumentScripting {
  executeScript(options: {
    // D-335 slice R — `allFrames` reads every frame of a tab, each answering with its own ids, and
    // `frameIds` the frames Chrome numbered so.
    target: { tabId: number; documentIds?: string[]; allFrames?: boolean; frameIds?: number[] };
    func: (...args: any[]) => unknown;
    args: readonly unknown[];
    /** Run in a document still loading as soon as it can, not once it has loaded. */
    injectImmediately?: boolean;
  }): Promise<Array<{ documentId?: string; frameId?: number; result: unknown }>>;
}

/** Only the URL and Chrome-issued identity leave the browser. A failed or
 * unpermitted injection makes that document unavailable for preparation.
 *
 *  ⛔⛔ SCOPED TO GRANTED ORIGINS, AND THE UNSCOPED VERSION WAS A LEAK. This ran
 *  `tabs.query({})` — every open tab — and injected a script into each to read
 *  `location.href`, on every tab update, close and replace. The owner's entire
 *  browsing list went to the server continuously, whether or not any
 *  pre-approval was in flight, and every tab got scripted to produce it.
 *
 *  🔑 THE FILTER COSTS NOTHING, WHICH IS WHY IT IS THE FIX RATHER THAN A
 *  TRADE-OFF. `describeDocument` — the only consumer — already refuses a request
 *  whose `target_domain_pattern` is not within this bridge's `granted_origins`,
 *  and only then matches documents against that pattern. A URL matching such a
 *  pattern is necessarily inside the granted origins itself, so no document that
 *  could ever have been selected is dropped here. In particular the ambiguity
 *  guard is preserved: filtering cannot make two matching tabs look like one.
 *
 *  ⚠ NO GRANTS ⇒ NO QUERY AND NO INJECTION. A bridge the owner has granted
 *  nothing was previously scripting every tab it could see to build an inventory
 *  that could never yield a candidate. */
export const describeOpenBridgeDocuments = async (
  tabs: { query(options: { url?: string | string[] }): Promise<Array<{ id?: number }>> },
  scripting: DocumentScripting,
  grantedOrigins: readonly string[],
): Promise<BridgeDocumentIdentity[]> => {
  if (grantedOrigins.length === 0) return [];
  let open: Array<{ id?: number }>;
  // An unusable match pattern must not widen the query back to every tab.
  try { open = await tabs.query({ url: [...grantedOrigins] }); } catch { return []; }
  // Refuse an incomplete inventory: otherwise an omitted second matching tab
  // could make an ambiguous target look unique to the server.
  if (open.length > BRIDGE_REVIEW_DOCUMENT_LIMIT) return [];
  const documents: BridgeDocumentIdentity[] = [];
  for (const tab of open) {
    if (!Number.isSafeInteger(tab.id)) continue;
    try {
      const results = await scripting.executeScript({ target: { tabId: tab.id! }, args: [],
        func: () => document.documentElement.hasAttribute('data-recued-owner-surface') ? null : location.href });
      const result = results[0];
      const identity = { tab_id: tab.id!, document_id: result?.documentId, url: result?.result };
      if (isBridgeDocumentIdentity(identity)) documents.push(identity);
    } catch { /* Closed, restricted or ungranted pages are not review targets. */ }
  }
  return documents;
};

export const executeReviewedBridgeDocument = async (
  scripting: DocumentScripting, document: BridgeDocumentIdentity, action: BridgeAction, args: Record<string, unknown>,
): Promise<ActionExecutorOutcome> => {
  const blocked = (): ActionExecutorOutcome => ({ status: 'error', error: {
    code: 'tab_navigation_blocked', message: 'The reviewed browser document is unavailable or changed.' } });
  const unconfirmed = (): ActionExecutorOutcome => ({ status: 'error', error: {
    code: action === 'fill' || action === 'click' ? 'delivery_uncertain' : 'unknown',
    message: 'The browser could not confirm the reviewed command outcome. Check the page before retrying.' } });
  const missingAcknowledgement = (): ActionExecutorOutcome =>
    action === 'fill' || action === 'click' ? unconfirmed() : blocked();
  if (!isBridgeDocumentIdentity(document)) return blocked();
  const target = { tabId: document.tab_id, documentIds: [document.document_id] };
  // D-335 — a reviewed inspect or describe reads the reviewed document and no
  // other: a page handle, if one is given, must name it.
  if (action === 'inspect' || action === 'describe') {
    const request = action === 'inspect' ? readInspectRequest(args) : readElementRequest(args);
    if ('error' in request || (request.page && (request.page.tab_id !== document.tab_id
      || request.page.document_id !== document.document_id))) return blocked();
    let inspected: Awaited<ReturnType<DocumentScripting['executeScript']>>;
    try {
      inspected = await (action === 'inspect'
        ? scripting.executeScript({ target, func: inspectPage, args: [request.scope, request.limits, document.url] })
        : scripting.executeScript({ target, func: describePageElement, args: [request.scope, document.url] }));
    } catch {
      return blocked();
    }
    if (inspected[0]?.documentId !== document.document_id) return blocked();
    // D-335 slice R — a reviewed run reads the one document it was reviewed for: a frame from
    // another site in it is a document of its own, so it is named as one this run cannot read.
    const answer = inspected[0].result as { outputs?: { html?: unknown } } | null;
    if (action === 'inspect' && typeof answer?.outputs?.html === 'string') {
      answer.outputs.html = settleFrames(answer.outputs.html, document.tab_id, null, () => true);
    }
    return (action === 'inspect' ? inspectOutcome : describeOutcome)(inspected[0].result, document,
      { blockedMessage: 'The reviewed browser document is unavailable or changed.' });
  }
  if (!['read_dom', 'fill', 'click'].includes(action) || (action === 'fill' && typeof args.value !== 'string')) return blocked();
  // D-335 slice B — fill and click may name the element by a ref from this
  // document; a page handle, if given, must name it.
  const byRef = action !== 'read_dom' && (args.page !== undefined || args.ref !== undefined);
  const element = byRef ? readElementRequest(args) : null;
  if (element && ('error' in element || (element.page && (element.page.tab_id !== document.tab_id
    || element.page.document_id !== document.document_id)))) return blocked();
  if (!byRef && typeof args.selector !== 'string') return blocked();
  const named = element && !('error' in element) ? element.scope : { selector: args.selector as string };
  // Chrome passes arguments as JSON: an undefined ref would arrive as null.
  const ref = named.ref === undefined ? [] : [named.ref];
  let results: Awaited<ReturnType<DocumentScripting['executeScript']>>;
  // Read, fill and click run the field functions the ordinary executor runs,
  // with the reviewed address checked inside the same injection (`page-fields.ts`).
  try { results = await (action === 'read_dom'
    ? scripting.executeScript({ target, func: readPageField, args: [named.selector, document.url] })
    : action === 'fill'
      ? scripting.executeScript({ target, func: fillPageField, args: [named.selector ?? '', args.value, document.url, ...ref] })
      : scripting.executeScript({ target, func: clickPageElement, args: [named.selector ?? '', document.url, ...ref] }));
  } catch {
    // An injection rejection can follow navigation or loss of acknowledgement.
    // Report uncertainty; neither endpoint may infer that the effect failed.
    return unconfirmed();
  }
  const result = results[0];
  if (result?.documentId !== document.document_id || !result.result || typeof result.result !== 'object'
    || Array.isArray(result.result)) return missingAcknowledgement();
  const value = result.result as { blocked?: boolean; missing?: boolean; stale?: boolean; protected?: boolean;
    not_applied?: unknown; outputs?: Record<string, unknown> };
  // Only one canonical branch can acknowledge the injected operation. Truthy
  // flags or conflicting success/refusal fields do not prove that it settled.
  if (Object.keys(value).length !== 1) return missingAcknowledgement();
  if (value.blocked === true) return blocked();
  if (value.missing === true) return { status: 'error', error: { code: 'selector_not_found', message: 'The reviewed selector is missing.' } };
  // The ref's element has gone: nothing was typed or clicked.
  if (byRef && value.stale === true) return { status: 'error', error: { code: 'selector_not_found', message: PAGE_CHANGED } };
  if (action === 'read_dom' && value.protected === true) return { status: 'error', error: { code: 'field_protected',
    message: 'The Browser Bridge does not read password, hidden, sign-in code or payment card fields.' } };
  // The write did not happen, and why (a value the element does not hold, a
  // click on what is disabled or covered): confirmed, not uncertain.
  if ((action === 'fill' || action === 'click') && typeof value.not_applied === 'string') {
    return { status: 'error', error: { code: 'value_not_applied', message: value.not_applied } };
  }
  if (!value.outputs || typeof value.outputs !== 'object' || Array.isArray(value.outputs)) return missingAcknowledgement();
  if (action === 'fill' || action === 'click') {
    const key = action === 'fill' ? 'filled' : 'clicked';
    if (Object.keys(value.outputs).length !== 1 || value.outputs[key] !== true) return missingAcknowledgement();
  }
  return { status: 'ok', outputs: value.outputs! };
};

import type { AIOutput } from '@recued/contracts';

const MAX_ITEMS = 10;
const MAX_QUOTE = 240;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, min = 1): value is string => typeof value === 'string' && value.trim().length >= min && value.length <= MAX_QUOTE;
const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim();
type Status = 'pending' | 'confirmed' | 'unverified';
interface Requirement { requirement: string; status: Status }
export interface BrowserTaskContext { requirements: Requirement[]; assessment: 'model_selected_source_linked' }

export const BROWSER_COMPLETION_INCOMPLETE = 'I could not verify that every requested step was completed.';
export const BROWSER_COMPLETION_REPAIR = 'The browser task completion check is unfinished or unsupported. '
  + 'Reconcile every explicit requested outcome with the current page and successful tool results. '
  + 'Keep every requirement in browser_task_context; do not drop an unfinished one. '
  + 'Continue with the next grounded action if possible. Otherwise mark it unverified. '
  + 'Do not repeat a state-changing action with an unknown outcome: read its current state first. '
  + 'Return browser_task_progress before the final response; no success claim for an unverified requirement.';

export const BROWSER_COMPLETION_GUIDANCE = `Browser task completion: extend AIOutput with "browser_task_progress", before "response".
On your first browser reply, list every explicit requested outcome, ordered action and preservation constraint from the current user request, including requested checks after an action. Separate different ordered actions; group fields of the same edit. Use short exact quotes from user_message as requirements; when the current request explicitly continues earlier work, you may quote earlier user messages in chat_tail. At most 10 items and 240 characters per quote. Do not add unrequested checks or actions. Keep this factual, with no reasoning narration.
Shape: "browser_task_progress":[{"requirement":"<exact user quote>","status":"pending|confirmed|unverified","evidence":[{"call":0,"quote":"<exact successful result excerpt>"}]}].
The server keeps declared requirements in browser_task_context across this turn; omitting an item does not remove it. While using tools, update changed items only. Before a final response, return every requirement with its current status. Confirm a requirement only from matching successful results already in prior_tool_calls; call is the zero-based array index and quote is 8-240 exact characters from that call's result, not its args, your plan or a failed/held attempt. Use at most 3 excerpts per item. A result saying a click or save succeeded does not establish a different requested action or a later verification. Reconcile the same target, requested values and required order; later contradictory evidence invalidates an earlier confirmation. A list showing a value is not evidence of a separately requested navigation or verification step.
Pending means more work is needed; unverified means you cannot currently establish completion. Do not claim overall success while either remains. A held action awaiting approval is unverified; never resubmit it. Choose any next action from the page's current controls; never guess a route or repeat a submission to satisfy the checklist. This check adds no tool or approval authority.`;

/** Source linking bounds a model assessment; it does not decide semantic task
 * satisfaction. Only the exact fitted result can support an excerpt. */
const supports = (calls: unknown[], proof: unknown): boolean => {
  if (!object(proof) || !keys(proof, ['call', 'quote']) || !Number.isSafeInteger(proof.call)
    || typeof proof.call !== 'number' || proof.call < 0 || !text(proof.quote, 8)) return false;
  const call = calls[proof.call];
  if (!object(call) || call.status !== 'ok' || !object(call.result)) return false;
  const root = call.result;
  const result = object(root.result) ? root.result : root;
  if ([root, result].some(value => value.__omitted === true || value.ok === false || value.success === false
    || value.run_held !== undefined || value.run_failed !== undefined
    || Array.isArray(value.errors) && value.errors.length > 0)) return false;
  if (JSON.stringify(root).length > 120_000) return false;
  let nodes = 0, limited = false;
  const visible = (value: unknown, depth = 0): unknown => {
    if (++nodes > 8_000 || depth > 32) { limited = true; return undefined; }
    if (Array.isArray(value)) return value.map(item => visible(item, depth + 1));
    if (!object(value)) return value;
    // Read-context references and omission previews are not the source itself.
    if (value.__omitted === true || value.duplicate_read !== undefined) return undefined;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visible(child, depth + 1)]));
  };
  const shown = visible(root);
  if (limited || shown === undefined) return false;
  if (JSON.stringify(shown).includes(proof.quote)) return true;
  const pending: unknown[] = [shown];
  for (let visited = 0; pending.length && visited < 8_000; visited++) {
    const value = pending.pop();
    if (typeof value === 'string' && value.includes(proof.quote)) return true;
    if (Array.isArray(value)) pending.push(...value);
    else if (object(value)) pending.push(...Object.values(value));
  }
  return false;
};

export const createBrowserTaskCompletion = (request: string, earlierUserMessages: readonly string[] = []) => {
  const sources = [request, ...earlierUserMessages].map(normalized);
  const requirements = new Map<string, Requirement>();
  let repairUsed = false;
  return {
    context: (): BrowserTaskContext => ({ requirements: [...requirements.values()].map(item => ({ ...item })),
      assessment: 'model_selected_source_linked' }),
    counts: () => ({ requirements: requirements.size,
      pending: [...requirements.values()].filter(item => item.status === 'pending').length,
      confirmed: [...requirements.values()].filter(item => item.status === 'confirmed').length,
      unverified: [...requirements.values()].filter(item => item.status === 'unverified').length }),
    check(output: AIOutput, packet: string): 'continue' | 'complete' | 'repair' | 'unverified' {
      const value = output.browser_task_progress;
      let calls: unknown[] = [];
      try {
        const parsed: unknown = JSON.parse(packet);
        if (object(parsed) && Array.isArray(parsed.prior_tool_calls)) calls = parsed.prior_tool_calls;
      } catch { /* An unreadable packet cannot establish a completion claim. */ }
      const items: unknown[] | undefined = Array.isArray(value) && value.length > 0 && value.length <= MAX_ITEMS ? value : undefined;
      let valid = items !== undefined;
      const returned = new Set<string>();
      if (items) for (const item of items) {
        if (!object(item) || !keys(item, ['requirement', 'status', 'evidence']) || !text(item.requirement, 2)
          || !['pending', 'confirmed', 'unverified'].includes(String(item.status))) { valid = false; continue; }
        const requirement = normalized(item.requirement);
        if (!sources.some(source => source.includes(requirement)) || returned.has(requirement)
          || !requirements.has(requirement) && requirements.size >= MAX_ITEMS) { valid = false; continue; }
        returned.add(requirement);
        const evidence = item.evidence;
        const confirmed = item.status === 'confirmed' && Array.isArray(evidence) && evidence.length > 0
          && evidence.length <= 3 && evidence.every(proof => supports(calls, proof));
        const nonconfirmation = item.status !== 'confirmed' && (evidence === undefined || Array.isArray(evidence) && evidence.length === 0);
        if (!confirmed && !nonconfirmation) valid = false;
        requirements.set(requirement, { requirement,
          status: confirmed ? 'confirmed' : nonconfirmation && item.status === 'unverified' ? 'unverified' : 'pending' });
      }
      if (output.tool_calls.length > 0) return 'continue';
      const covered = valid && requirements.size > 0 && [...requirements.keys()].every(quote => returned.has(quote));
      if (covered && [...requirements.values()].every(item => item.status === 'confirmed')) return 'complete';
      if (covered && [...requirements.values()].every(item => item.status !== 'pending')) return 'unverified';
      if (repairUsed) return 'unverified';
      repairUsed = true;
      return 'repair';
    },
  };
};

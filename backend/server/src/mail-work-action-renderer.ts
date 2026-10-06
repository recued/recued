import { RpcError } from '@recued/contracts';
import { displayMailWorkSourceText } from './mail-work-source-recap.js';

export const MAIL_WORK_ACTION_FORMAT = 'scoped_actions_v1';
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => {
  throw new RpcError('bad_request', 'The AI returned an action with incomplete permission or scope. The previous review is unchanged.', 400);
};
const text = (value: unknown, limit: number): string =>
  typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : fail();

/** Legacy declarations retain their presentation and source checks. Matching
 * owner prose cannot certify consent here either; execution keeps its normal
 * controls. Existing saved review text is not rewritten by this renderer. */
export const renderMailWorkAction = (
  value: unknown, proposal: string, ownerNotes: string, knownSources: ReadonlySet<string>,
): { text: string; sources: string[] } => {
  if (!object(value)) return fail();
  const scope = text(value.scope, 160);
  if (typeof value.mode !== 'string' || !['private_preparation', 'contact', 'wait', 'decision'].includes(value.mode)) return fail();
  if (!Array.isArray(value.conditions) || value.conditions.length > 6) return fail();
  const sources = new Set<string>();
  const conditions = value.conditions.map((condition: unknown) => {
    if (!object(condition) || text(condition.scope, 160) !== scope) return fail();
    const wording = text(condition.text, 300);
    if (!Array.isArray(condition.sources) || condition.sources.length > 12
      || condition.sources.some(source => typeof source !== 'string' || !knownSources.has(source))) return fail();
    const quote = condition.owner_quote;
    if (quote !== null && (typeof quote !== 'string' || !quote.trim() || !ownerNotes.includes(quote))) return fail();
    for (const source of condition.sources) sources.add(String(source));
    // The v3 decoder copies a source quotation, not model-authored prose. Keep
    // its wording literal so source text cannot manufacture additional links.
    const display = condition.source_quote === true ? displayMailWorkSourceText : (text: string) => text;
    return { wording: `${display(wording)}${quote === null ? '' : ` (owner notes: ${display(quote)})`}`,
      established: condition.sources.length > 0 || quote !== null };
  });
  let prefix: string;
  if (value.mode === 'contact' || (value.mode === 'wait' && value.permission === 'requires_owner_approval')) {
    if (value.permission === 'requires_owner_approval' && value.permission_quote === null) {
      prefix = value.mode === 'wait' ? 'Waiting for your approval' : 'After your approval';
    } else return fail();
  } else {
    if (value.permission !== 'not_contact' || value.permission_quote !== null) return fail();
    prefix = value.mode === 'private_preparation' ? 'Private preparation' : 'Proposed next step';
  }
  const established = conditions.filter(condition => condition.established).map(condition => condition.wording);
  const inferred = conditions.filter(condition => !condition.established).map(condition => condition.wording);
  const rendered = `${prefix}: ${proposal}${established.length ? ` Conditions for ${scope}: ${established.join('; ')}` : ''}`
    + `${inferred.length ? ` Possible prerequisites for ${scope} (AI inference, not established): ${inferred.join('; ')}` : ''}`;
  if (rendered.length > 1200) return fail();
  return { text: rendered, sources: [...sources] };
};

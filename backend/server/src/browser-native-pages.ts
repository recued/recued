import { createHmac, randomBytes } from 'node:crypto';
import type { ToolEntry } from '@recued/contracts';
import type { ChatMainTurnTool } from './chat-orchestrator.js';
import { describeBrowserData } from './bridges/browser-data-pipeline.js';

type ObjectValue = Record<string, any>;
const object = (v: unknown): v is ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v);
const pageToken = /^p-[A-Za-z0-9_-]{12}$/;
const recipes = new Set(['list-browser-bridges', 'list-browser-tabs', 'open-web-page', 'inspect-web-page', 'read-web-text',
  'read-web-element', 'wait-for-web-element', 'read-web-table', 'save-web-file', 'screenshot-web-page', 'ask-web-page',
  'scroll-web-page', 'type-into-web-page', 'click-web-element', 'press-on-web-page', 'act-on-web-page']);
const browserTool = (name: string) => /^(recued-core|kitchen)\//.test(name) && recipes.has(name.split('/')[1]!);
export const nativeBrowserPageKey = (tools?: readonly ChatMainTurnTool[]) => tools && !tools.some(tool => browserTool(tool.recipe_slug))
  ? undefined : randomBytes(16).toString('hex');

/** Native presentation only. Element refs, required starting pages and the
 * canonical registry/MCP grammar remain unchanged. */
export const nativeBrowserPageContext = (context: ObjectValue | undefined, key: string): ObjectValue | undefined => {
  if (!context || !/^[a-f0-9]{32}$/.test(key)) return context;
  const copy = JSON.parse(JSON.stringify(context));
  const pages = new Map<string, string>();
  for (const page of copy.pages ?? []) {
    const full = page.page;
    if (typeof full !== 'string' || !full.length || full.length > 512 || /^https?:/i.test(full)) continue;
    const token = 'p-' + createHmac('sha256', key).update(full).digest('base64url').slice(0, 12);
    pages.set(full, token); page.document_handle = full; page.page = token;
  }
  if (!pages.size) return context;
  for (const page of copy.pages) for (const item of page.interaction_targets?.items ?? []) {
    if (object(item.target) && pages.has(item.target.page)) item.target.page = pages.get(item.target.page);
    const args = item.call_example?.args;
    if (object(args) && pages.has(args.page)) args.page = pages.get(args.page);
  }
  copy.reference_format = 'native_document_refs_v1';
  if (copy.call_examples_note) copy.call_examples_note = 'Examples are alternatives, not a sequence. Include the owning page and ordinary element refs. Combine requested steps; obtain fresh evidence after a new document. Existing checks apply.';
  copy.note = 'Every browser batch needs its owning page on the call or first step; data-only calls are exempt. Copy page and the ordinary eN element ref together. A p- page token names its exact captured document; document_handle is the full fallback. A view whose read_state says settled: true was read after the page stopped changing, so a fixed wait before that read was not needed; wait only for something a view showed. Tokens remain stable for that document within this turn, and only tokens in this packet are usable. These are retained observations, not live-state or permission guarantees. Existing document, approval and verification checks apply.';
  return JSON.stringify(copy).length <= 6_000 ? copy : context;
};

/** Expose the actual registered parameter sets for the commonly confused
 * row-map, one-object project and count operations. No query is rewritten. */
const dataOperationVariants = (base: ObjectValue): ObjectValue => {
  const described = describeBrowserData(['map', 'project', 'count']).schemas;
  if (!object(described) || !['map', 'project', 'count'].every(name => object(described[name]) && object(described[name].parameters))) return base;
  const variant = (name: string, expression?: boolean) => {
    const registered = described[name], params = registered.parameters;
    const properties: ObjectValue = { transform: { const: name }, id: base.properties.id };
    for (const [key, definition] of Object.entries(params) as [string, ObjectValue][]) {
      properties[key] = base.properties[key] ?? { ...(definition.type && definition.type !== 'any' ? { type: definition.type } : {}),
        ...(definition.enum ? { enum: definition.enum } : {}) };
    }
    const required = ['transform', ...Object.entries(params).filter(([key, def]) => object(def) && def.required && key !== registered.automatic_input).map(([key]) => key)];
    if (expression) required.push('expression');
    return { type: 'object', properties, required, additionalProperties: false,
      ...(expression ? { not: { required: ['apply'] } } : {}),
      description: name === 'project' ? 'One object only. For array rows use map; after count retain a named earlier value or return rows/count directly.'
        : name === 'map' ? 'Reshape array rows; expression is the per-row JSON result. array optionally selects an earlier $id.'
          : 'Count rows or items. input optionally selects an earlier $id. Keep selected rows under an id and return both ids when sufficient.' };
  };
  return { type: 'object', oneOf: [variant('map', true), variant('project'), variant('count'),
    { ...base, properties: { ...base.properties, transform: { const: 'map' } }, required: ['transform', 'apply', 'output_field'], not: { required: ['expression'] } },
    { ...base, properties: { ...base.properties, transform: { ...base.properties.transform, enum: base.properties.transform.enum.filter((name: string) => !['map', 'project', 'count'].includes(name)) } } },
  ] };
};

export const nativeBrowserPageSchemas = (tools: readonly ChatMainTurnTool[]): readonly ChatMainTurnTool[] => tools.map(tool => {
  if (!browserTool(tool.recipe_slug) || !object(tool.args_schema)) return tool;
  const copy = JSON.parse(JSON.stringify(tool.args_schema));
  if (object(copy.properties?.page)) copy.properties.page.description = 'Copy the owning page from browser_context: its short p- token or complete document_handle. A browser batch requires page on the call or first step; only data-only batches are exempt. Never guess or shorten either form. Existing checks apply.';
  const steps = copy.properties?.steps;
  if (steps?.['x-recued-browser-act-direct'] === true && object(steps.items?.properties)) {
    if (object(steps.items.properties.page)) steps.items.properties.page.description = 'Explicit owning page for this step, copied from browser_context.page or its full document_handle. Overrides the call page.';
    const pipeline = steps.items.properties.pipeline;
    if (object(pipeline?.items?.properties?.transform) && Array.isArray(pipeline.items.properties.transform.enum)) pipeline.items = dataOperationVariants(pipeline.items);
  }
  return { ...tool, args_schema: copy };
});

/** Resolve only host-issued bindings present in this fitted packet. Expand
 * even a subsequently invalid plan so refusal identity uses canonical pages.
 * Unknown/trimmed/foreign tokens never rebind to a live document. */
export const resolveNativeBrowserPages = (tool: ToolEntry | null | undefined, input: unknown, packet: string): { args: unknown; resolved: number; error?: string } => {
  if (tool?.tier !== 2 || !browserTool(tool.name) || !object(input)) return { args: input, resolved: 0 };
  let context: ObjectValue | undefined;
  try { context = JSON.parse(packet).browser_context; } catch { /* No issued bindings. */ }
  const bindings = new Map<string, string>();
  if (context?.reference_format === 'native_document_refs_v1' && Array.isArray(context.pages)) for (const page of context.pages.slice(0, 3)) {
    if (pageToken.test(page.page) && typeof page.document_handle === 'string' && page.document_handle.length > 0 && page.document_handle.length <= 512 && !/^https?:/i.test(page.document_handle)) bindings.set(page.page, page.document_handle);
  }
  let resolved = 0, error: string | undefined;
  const expand = (value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith('p-')) return value;
    const full = bindings.get(value);
    if (full) { resolved++; return full; }
    error = 'The page token is not in this request. Copy its current browser_context page or obtain the full owning document handle. No batch steps ran.';
    return value;
  };
  const args = { ...input };
  if (Object.hasOwn(args, 'page')) args.page = expand(args.page);
  if (tool.name.endsWith('/act-on-web-page')) {
    let steps = args.steps;
    if (typeof steps === 'string' && steps.length <= 20_000) { try { steps = JSON.parse(steps); } catch { /* Ordinary parser diagnoses it. */ } }
    if (Array.isArray(steps) && steps.length <= 20) args.steps = steps.map(step => object(step) && Object.hasOwn(step, 'page') ? { ...step, page: expand(step.page) } : step);
  }
  return { args: resolved ? args : input, resolved, ...(error ? { error } : {}) };
};

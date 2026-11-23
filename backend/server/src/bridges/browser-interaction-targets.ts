import { BROWSER_INTERACTION_TARGETS_CHARS, BRIDGE_INSPECT_CEILING_CHARS, type BrowserInteractionTarget, type BrowserInteractionTargets, type BrowserInteractionContext } from '@recued/contracts';
import { parseInspectHtml, type OutlineElement, type OutlineNode } from './page-outline.js';
import { browserControlScope } from './browser-control-scope.js';
import { browserRecordContexts } from './browser-record-context.js';

const attr = (node: OutlineElement, key: string) => typeof node.attrs[key] === 'string' ? node.attrs[key] as string
  : node.attrs[key] === true ? '' : undefined;
const text = (node: OutlineElement): string => {
  const stack: OutlineNode[] = [...node.children].reverse(); let value = '', visited = 0;
  while (stack.length && ++visited <= 15_000 && value.length <= 160) {
    const part = stack.pop()!;
    if (part.kind === 'text') value += part.text;
    else if (!part.structuralOnly && !['input', 'textarea', 'select', 'script', 'style'].includes(part.tag)
      && !Object.hasOwn(part.attrs, 'hidden') && part.attrs['aria-hidden'] !== 'true') stack.push(...[...part.children].reverse());
  }
  return value.replace(/\s+/g, ' ').trim();
};

/** Positive targets from this capture, even while resources load. Zero counts
 * concern this capture/scope only; source_complete never upgrades a loading read. */
export const browserInteractionTargets = (html: string, input: { whole: boolean; truncated: boolean; loading?: boolean }): BrowserInteractionTargets => {
  const result: BrowserInteractionTargets = { source: 'captured_dom', scope: input.whole ? 'page' : 'region',
    source_complete: !input.truncated && input.loading !== true, items_complete: true,
    captured_editable_fields: 0, captured_clickable_controls: 0, items: [] };
  if (html.length > BRIDGE_INSPECT_CEILING_CHARS) return { ...result, source_complete: false, items_complete: false };
  const scope = browserControlScope(parseInspectHtml(html));
  if (!scope.complete) return { ...result, source_complete: false, items_complete: false };
  if (scope.modal_open) result.scope = 'dialog';
  const records = browserRecordContexts(scope);
  const labels = new Map<string, string[]>();
  for (const node of scope.nodes) if (node.tag === 'label' && attr(node, 'for')) {
    const id = attr(node, 'for')!; labels.set(id, [...(labels.get(id) ?? []), text(node)]);
  }
  const candidates: Array<{ item: BrowserInteractionTarget; priority: number; field: boolean; labelTarget: boolean; context?: BrowserInteractionContext }> = [];
  for (const node of scope.nodes) {
    if (!scope.allowed.has(node)) continue;
    const ref = attr(node, 'ref');
    const type = attr(node, 'type'), role = attr(node, 'role'), editable = attr(node, 'contenteditable');
    const nativeType = (type ?? 'text').toLowerCase();
    const upload = node.tag === 'input' && nativeType === 'file';
    const field = !upload && (node.tag === 'textarea' || node.tag === 'select' || node.tag === 'input'
      && !['hidden', 'button', 'submit', 'reset', 'image', 'file'].includes(nativeType)
      || editable !== undefined && ['true', '', 'plaintext-only'].includes(editable.toLowerCase()));
    const clickable = node.tag === 'button' || node.tag === 'a' || node.tag === 'input'
      && ['button', 'submit', 'reset', 'image'].includes(nativeType)
      || ['button', 'link', 'checkbox', 'radio', 'combobox', 'switch', 'option'].includes(role ?? '');
    if (!field && !clickable && !upload) continue;
    let disabled = false;
    for (let at: OutlineElement | undefined = node; at; at = scope.parents.get(at)) {
      if (attr(at, 'aria-disabled') === 'true' || ['input', 'textarea', 'select', 'button', 'optgroup'].includes(at.tag)
        && Object.hasOwn(at.attrs, 'disabled')) disabled = true;
      if (at.tag === 'fieldset' && Object.hasOwn(at.attrs, 'disabled')) {
        const legend = at.children.find((child): child is OutlineElement => child.kind === 'element' && child.tag === 'legend');
        if (!legend || !scope.inside(node, legend)) disabled = true;
      }
    }
    const readonly = Object.hasOwn(node.attrs, 'readonly') && (node.tag === 'textarea' || node.tag === 'input'
      && !['hidden', 'checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'image', 'file'].includes(nativeType))
      || attr(node, 'aria-readonly') === 'true';
    const actions: BrowserInteractionTarget['actions'] = disabled ? [] : [
      ...(field && !readonly ? ['type' as const] : []), ...(clickable ? ['click' as const] : []),
      ...(upload && !readonly ? ['upload' as const] : []),
    ];
    if (actions.includes('type')) result.captured_editable_fields++;
    if (actions.includes('click')) result.captured_clickable_controls++;
    if (actions.includes('upload')) result.captured_upload_fields = (result.captured_upload_fields ?? 0) + 1;
    if (!ref || !/^e[1-9]\d{0,8}$/.test(ref)) { result.items_complete = false; continue; }
    let label = attr(node, 'aria-label');
    if (!label && attr(node, 'aria-labelledby')) {
      const parts = attr(node, 'aria-labelledby')!.split(/\s+/).map(id => scope.ids.get(id));
      if (parts.every(part => part)) label = parts.map(part => text(part!)).join(' ');
    }
    label ||= (attr(node, 'id') ? labels.get(attr(node, 'id')!)?.join(' ') : undefined);
    if (!label) for (let at = scope.parents.get(node); at; at = scope.parents.get(at)) {
      if (at.tag === 'label') { label = text(at); break; }
    }
    label ||= attr(node, 'placeholder') || attr(node, 'title') || (field || upload ? attr(node, 'name') || attr(node, 'id')
      : node.tag === 'input' ? attr(node, 'value') : text(node)) || '';
    const item: BrowserInteractionTarget = { ref, tag: node.tag, label: label.slice(0, 160),
      ...(label.length > 160 ? { label_truncated: true } : {}), actions,
      ...(type !== undefined && ['input', 'button'].includes(node.tag) && type.length <= 64 ? { type } : {}),
      ...(role !== undefined && role.length <= 64 ? { role } : {}),
      ...(editable !== undefined && editable.length <= 64 ? { contenteditable: editable } : {}),
      ...(disabled ? { disabled: true } : {}), ...(readonly ? { readonly: true } : {}) };
    let primary = false, navigation = false;
    for (let at: OutlineElement | undefined = node; at; at = scope.parents.get(at)) {
      if (['main', 'form', 'dialog'].includes(at.tag) || ['main', 'dialog'].includes(attr(at, 'role') ?? '')) primary = true;
      if (['nav', 'header', 'footer'].includes(at.tag) || ['navigation', 'banner', 'contentinfo'].includes(attr(at, 'role') ?? '')) navigation = true;
    }
    candidates.push({ item, field, labelTarget: records.isLabelTarget(node), context: records.forNode(node),
      priority: field ? 0 : primary && !navigation ? 1 : node.tag === 'button' || role === 'button' ? 2 : 3 });
  }
  const fits = (value: BrowserInteractionTargets) => JSON.stringify(value).length <= BROWSER_INTERACTION_TARGETS_CHARS - 8;
  const add = (candidate: typeof candidates[number], withContext: boolean) => {
    const context = withContext ? candidate.context : undefined;
    const item = { ...candidate.item, ...(context ? { context: context.id } : {}) };
    const contexts = context && !result.contexts?.some(value => value.id === context.id) ? [...(result.contexts ?? []), context] : result.contexts;
    const next = { ...result, items: [...result.items, item], ...(contexts?.length ? { contexts } : {}) };
    if (result.items.length === 12 || !fits(next)) { result.items_complete = false; return; }
    Object.assign(result, next);
  };
  // Base field facts retain priority over optional context. Then distribute
  // action slots across records, interleaving page-level navigation controls.
  const fields = candidates.filter(candidate => candidate.field);
  for (const candidate of fields) add(candidate, false);
  for (const candidate of fields) {
    const context = candidate.context, at = result.items.findIndex(item => item.ref === candidate.item.ref);
    if (!context || at < 0) continue;
    const contexts = result.contexts?.some(value => value.id === context.id) ? result.contexts : [...(result.contexts ?? []), context];
    const next = { ...result, contexts, items: result.items.map((item, index) => index === at ? { ...item, context: context.id } : item) };
    if (fits(next)) Object.assign(result, next);
  }
  const grouped = new Map<string, typeof candidates>();
  const general = candidates.filter(candidate => !candidate.field && !candidate.context && candidate.item.label)
    .sort((a, b) => a.priority - b.priority || Number(b.item.type === 'submit') - Number(a.item.type === 'submit'));
  for (const candidate of candidates) if (!candidate.field && candidate.context && candidate.item.label)
    grouped.set(candidate.context.id, [...(grouped.get(candidate.context.id) ?? []), candidate]);
  for (const group of grouped.values()) group.sort((a, b) => {
    const rank = (candidate: typeof candidates[number]) => candidate.labelTarget ? 0
      : candidate.item.tag === 'button' || candidate.item.role === 'button' ? 1 : 2;
    return rank(a) - rank(b);
  });
  const ordered: typeof candidates = []; let remaining = true;
  while (remaining) {
    remaining = false;
    for (const group of grouped.values()) if (group.length) { ordered.push(group.shift()!); remaining = true; }
  }
  for (let i = 0; i < ordered.length || general.length; i += 2) {
    for (const candidate of ordered.slice(i, i + 2)) add(candidate, true);
    if (general.length) add(general.shift()!, true);
  }
  for (const candidate of candidates) if (!candidate.field && !candidate.item.label) add(candidate, true);
  if (records.headings.length && fits({ ...result, headings: records.headings })) result.headings = records.headings;
  return result;
};

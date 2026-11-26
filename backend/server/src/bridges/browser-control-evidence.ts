import { BROWSER_CONTROL_EVIDENCE_CHARS, BRIDGE_INSPECT_CEILING_CHARS, type BrowserControlEvidence, type BrowserControlItem } from '@recued/contracts';
import { capturedAriaLabel, parseInspectHtml, type OutlineElement, type OutlineNode } from './page-outline.js';
import { browserControlScope } from './browser-control-scope.js';

const NOTE = 'Use action on this ref; value_kind describes the value to supply, not an argument. Native lists take an option value/label (multiple: one per line), checkbox true/false, radio true. Run follow_up as a separate step. Custom controls: click only when state differs; read opened options and choose their ref. Read back selected/checked state; never toggle blindly.';
const attr = (node: OutlineElement, key: string) => typeof node.attrs[key] === 'string' ? node.attrs[key] as string : undefined;
const ref = (node: OutlineElement) => /^e\d+$/.test(attr(node, 'ref') ?? '') ? attr(node, 'ref') : undefined;
const text = (node: OutlineElement): string => {
  const pending: OutlineNode[] = [...node.children].reverse(); let value = '', count = 0;
  while (pending.length && ++count <= 15_000 && value.length <= 1_000) {
    const next = pending.pop()!;
    if (next.kind === 'text') value += next.text;
    else if (!['select', 'option', 'input', 'textarea', 'script', 'style'].includes(next.tag)
      && !Object.hasOwn(next.attrs, 'hidden') && next.attrs['aria-hidden'] !== 'true') pending.push(...[...next.children].reverse());
  }
  return value.replace(/\s+/g, ' ').trim();
};

/** Exact values from the cleaned read only. No guessed values, hidden options,
 * copied text-input contents or recommendations to use background controls. */
export const browserControlEvidence = (html: string, input: { whole: boolean; truncated: boolean }): BrowserControlEvidence | undefined => {
  const incomplete = new Set<string>(input.truncated ? ['page_truncated'] : []);
  const result: BrowserControlEvidence = { scope: input.whole ? 'page' : 'region', items: [], complete: true, note: NOTE };
  const finish = () => {
    result.complete = incomplete.size === 0;
    if (incomplete.size) result.incomplete = [...incomplete];
    return result.items.length || incomplete.size ? result : undefined;
  };
  if (html.length > BRIDGE_INSPECT_CEILING_CHARS) { incomplete.add('source_limit'); return finish(); }
  const scope = browserControlScope(parseInspectHtml(html));
  if (!scope.complete) { incomplete.add('scope_limit'); return finish(); }
  if (scope.modal_open) result.scope = 'dialog';
  const disabled = (node: OutlineElement): boolean => {
    for (let at: OutlineElement | undefined = node; at; at = scope.parents.get(at)) {
      if (at.attrs['aria-disabled'] === 'true' || Object.hasOwn(at.attrs, 'disabled')
        && ['select', 'input', 'option', 'optgroup'].includes(at.tag)) return true;
    }
    return false;
  };
  for (const node of scope.nodes) {
    if (!scope.allowed.has(node)) continue;
    const native = node.tag === 'select' || node.tag === 'input' && ['checkbox', 'radio'].includes(attr(node, 'type') ?? '');
    const kind = native ? node.tag === 'select' ? 'select' : attr(node, 'type')
      : attr(node, 'role');
    if (!kind || !['select', 'checkbox', 'radio', 'combobox', 'switch', 'option'].includes(kind)) continue;
    const handle = ref(node);
    if (!handle) continue;
    let label = capturedAriaLabel(node);
    if (!label && attr(node, 'aria-labelledby')) {
      const labels = attr(node, 'aria-labelledby')!.split(/\s+/).map(id => scope.ids.get(id));
      if (labels.every(part => part !== undefined && part !== null)) label = labels.map(part => text(part!)).join(' ');
    }
    if (!label && attr(node, 'id')) label = scope.nodes.filter(candidate => candidate.tag === 'label'
      && attr(candidate, 'for') === attr(node, 'id')).map(text).join(' ');
    if (!label) {
      for (let at = scope.parents.get(node); at; at = scope.parents.get(at)) if (at.tag === 'label') { label = text(at); break; }
    }
    label = label || (native ? attr(node, 'name') : text(node)) || '';
    if (label.length > 160) { incomplete.add('value_limit'); continue; }
    const item: BrowserControlItem = { ref: handle, kind: kind as BrowserControlItem['kind'], label, native, disabled: disabled(node),
      ...(native ? { action: { do: 'type' as const }, value_kind: kind === 'select'
        ? Object.hasOwn(node.attrs, 'multiple') ? 'option_lines' as const : 'option_value_or_label' as const
        : kind === 'checkbox' ? 'true_or_false' as const : 'true' as const }
        : { action: { do: 'click' as const }, follow_up: { do: 'read' as const } }) };
    if (kind === 'checkbox' || kind === 'radio' || kind === 'switch') {
      const state = attr(node, 'aria-checked');
      if (native) item.checked = kind === 'checkbox' && state === 'mixed' ? 'mixed' : Object.hasOwn(node.attrs, 'checked');
      else if (state === 'true' || state === 'false' || state === 'mixed') item.checked = state === 'mixed' ? 'mixed' : state === 'true';
    }
    if (kind === 'radio' && attr(node, 'name')) {
      if (attr(node, 'name')!.length <= 128) item.group = attr(node, 'name'); else incomplete.add('value_limit');
    }
    const expanded = attr(node, 'aria-expanded');
    if (expanded === 'true' || expanded === 'false') item.expanded = expanded === 'true';
    const selected = attr(node, 'aria-selected');
    if (selected === 'true' || selected === 'false') item.selected = selected === 'true';
    if (kind === 'select') {
      item.options = []; item.options_complete = !input.truncated;
      for (const option of scope.nodes.filter(child => child.tag === 'option' && scope.inside(child, node))) {
        const label = text(option), value = attr(option, 'value') ?? label;
        const parent = scope.parents.get(option);
        const group = parent?.tag === 'optgroup' ? attr(parent, 'label')?.replace(/\s+/g, ' ').trim() : undefined;
        if (item.options.length === 12) { incomplete.add('option_limit'); item.options_complete = false; break; }
        if (label.length > 160 || value.length > 160 || (group?.length ?? 0) > 160) {
          incomplete.add('value_limit'); item.options_complete = false; continue;
        }
        item.options.push({ label, value, selected: Object.hasOwn(option.attrs, 'selected'), disabled: disabled(option),
          ...(group ? { group } : {}) });
      }
    }
    if (kind === 'option') {
      const owners = [...scope.lists].filter(([owner, lists]) => ref(owner) && scope.allowed.has(owner)
        && lists.some(list => scope.inside(node, list)));
      if (owners.length === 1) item.owner_ref = ref(owners[0]![0]);
    }
    if (result.items.length === 12) { incomplete.add('item_limit'); break; }
    // Reserve space for bounded incompleteness markers added at finish.
    if (JSON.stringify({ ...result, items: [...result.items, item] }).length > BROWSER_CONTROL_EVIDENCE_CHARS - 180) {
      incomplete.add('character_limit'); break;
    }
    result.items.push(item);
  }
  return finish();
};

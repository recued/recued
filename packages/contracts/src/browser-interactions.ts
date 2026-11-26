/** Capabilities observed in one cleaned DOM capture. No field values, inferred
 * selectors, application outcome or permission grants. */
export interface BrowserInteractionTarget {
  ref: string;
  tag: string;
  label: string;
  label_truncated?: true;
  type?: string;
  role?: string;
  expanded?: boolean;
  contenteditable?: string;
  draggable?: true;
  multiple?: true;
  disabled?: true;
  readonly?: true;
  context?: string;
  actions: Array<'type' | 'click' | 'upload' | 'drag'>;
}
export interface BrowserInteractionContext {
  id: string;
  kind: 'item' | 'row';
  label: string;
  label_truncated?: true;
  /** Order among captured sibling containers; not a global rank. */
  position: number;
  /** An ordinal literally displayed in a leading table cell. */
  ordinal?: string;
}
export interface BrowserInteractionTargets {
  source: 'captured_dom';
  scope: 'page' | 'region' | 'dialog';
  source_complete: boolean;
  items_complete: boolean;
  captured_editable_fields: number;
  captured_clickable_controls: number;
  captured_upload_fields?: number;
  captured_drag_sources?: number;
  /** Visible, named containers on a page with drag sources. The app decides whether a drop is accepted. */
  drag_destinations?: Array<{ label: string; selector: string }>;
  contexts?: BrowserInteractionContext[];
  headings?: string[];
  items: BrowserInteractionTarget[];
}
export const BROWSER_INTERACTION_TARGETS_CHARS = 1_800;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(key => allowed.includes(key));
const text = (v: unknown, n: number): v is string => typeof v === 'string' && v.length <= n;
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 15_000;
const supports = (item: Record<string, unknown>, action: unknown): boolean => {
  const type = typeof item.type === 'string' ? item.type.toLowerCase() : 'text';
  return action === 'upload' ? item.tag === 'input' && type === 'file'
    : action === 'drag' ? item.draggable === true
    : action === 'type' ? !(item.tag === 'input' && type === 'file') && (['textarea', 'select'].includes(String(item.tag))
    || item.tag === 'input' && !['hidden', 'button', 'submit', 'reset', 'image', 'file'].includes(type)
    || typeof item.contenteditable === 'string' && ['true', '', 'plaintext-only'].includes(item.contenteditable.toLowerCase()))
    : action === 'click' && (['button', 'a', 'area'].includes(String(item.tag))
      || item.tag === 'summary' && typeof item.expanded === 'boolean'
      || item.tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type)
      || ['button', 'link', 'checkbox', 'radio', 'combobox', 'switch', 'option'].includes(String(item.role)));
};
export const isBrowserInteractionTargets = (v: unknown): v is BrowserInteractionTargets => object(v)
  && keys(v, ['source', 'scope', 'source_complete', 'items_complete', 'captured_editable_fields', 'captured_clickable_controls', 'captured_upload_fields',
    'captured_drag_sources', 'drag_destinations', 'items', 'contexts', 'headings'])
  && v.source === 'captured_dom' && ['page', 'region', 'dialog'].includes(String(v.scope))
  && typeof v.source_complete === 'boolean' && typeof v.items_complete === 'boolean'
  && count(v.captured_editable_fields) && count(v.captured_clickable_controls)
  && (v.captured_upload_fields === undefined || count(v.captured_upload_fields))
  && (v.captured_drag_sources === undefined || count(v.captured_drag_sources))
  && (v.drag_destinations === undefined || Number(v.captured_drag_sources) > 0
    && Array.isArray(v.drag_destinations) && v.drag_destinations.length <= 6 && v.drag_destinations.every(target =>
      object(target) && keys(target, ['label', 'selector']) && text(target.label, 100) && target.label.length > 0
      && text(target.selector, 81) && /^#[A-Za-z_][A-Za-z0-9_-]*$/.test(target.selector)))
  && (v.headings === undefined || Array.isArray(v.headings) && v.headings.length <= 3 && v.headings.every(value => text(value, 120)))
  && (v.contexts === undefined || Array.isArray(v.contexts) && v.contexts.length <= 12 && v.contexts.every(value => object(value)
    && keys(value, ['id', 'kind', 'label', 'label_truncated', 'position', 'ordinal'])
    && text(value.id, 12) && /^g[1-9]\d{0,4}$/.test(value.id) && ['item', 'row'].includes(String(value.kind))
    && text(value.label, 120) && value.label.length > 0 && count(value.position) && Number(value.position) > 0
    && (value.label_truncated === undefined || value.label_truncated === true)
    && (value.ordinal === undefined || text(value.ordinal, 8) && /^\d{1,6}[.)]?$/.test(value.ordinal)))
    && new Set(v.contexts.map(value => (value as BrowserInteractionContext).id)).size === v.contexts.length)
  && Array.isArray(v.items) && v.items.length <= 12 && v.items.every(item => object(item)
    && keys(item, ['ref', 'tag', 'label', 'label_truncated', 'type', 'role', 'contenteditable', 'disabled', 'readonly', 'actions', 'context',
      'draggable', 'multiple', 'expanded'])
    && text(item.ref, 32) && /^e[1-9]\d{0,8}$/.test(item.ref) && text(item.tag, 64) && /^[a-z][\w.:-]*$/.test(item.tag)
    && text(item.label, 160) && (item.label_truncated === undefined || item.label_truncated === true)
    && (item.type === undefined || ['input', 'button'].includes(item.tag) && text(item.type, 64))
    && (item.role === undefined || text(item.role, 64)) && (item.contenteditable === undefined || text(item.contenteditable, 64))
    && (item.expanded === undefined || item.tag === 'summary' && typeof item.expanded === 'boolean')
    && (item.draggable === undefined || item.draggable === true)
    && (item.multiple === undefined || item.multiple === true && supports(item, 'upload'))
    && (item.disabled === undefined || item.disabled === true) && (item.readonly === undefined || item.readonly === true)
    && (item.context === undefined || typeof item.context === 'string' && Array.isArray(v.contexts)
      && v.contexts.some(value => object(value) && value.id === item.context))
    && Array.isArray(item.actions) && item.actions.length <= 3
    && item.actions.every((action, index, all) => all.indexOf(action) === index && supports(item, action))
    && (!(item.disabled || item.readonly) || !item.actions.some(action => action === 'type' || action === 'upload'))
    && (!item.disabled || item.actions.length === 0))
  && new Set(v.items.map(item => (item as BrowserInteractionTarget).ref)).size === v.items.length
  && v.items.filter(item => (item as BrowserInteractionTarget).actions.includes('type')).length <= Number(v.captured_editable_fields)
  && v.items.filter(item => (item as BrowserInteractionTarget).actions.includes('click')).length <= Number(v.captured_clickable_controls)
  && v.items.filter(item => (item as BrowserInteractionTarget).actions.includes('upload')).length <= Number(v.captured_upload_fields ?? 0)
  && v.items.filter(item => (item as BrowserInteractionTarget).actions.includes('drag')).length <= Number(v.captured_drag_sources ?? 0)
  && (!v.items_complete || v.items.filter(item => (item as BrowserInteractionTarget).actions.includes('type')).length === v.captured_editable_fields
    && v.items.filter(item => (item as BrowserInteractionTarget).actions.includes('click')).length === v.captured_clickable_controls
    && v.items.filter(item => (item as BrowserInteractionTarget).actions.includes('upload')).length === (v.captured_upload_fields ?? 0)
    && v.items.filter(item => (item as BrowserInteractionTarget).actions.includes('drag')).length === (v.captured_drag_sources ?? 0))
  && JSON.stringify(v).length <= BROWSER_INTERACTION_TARGETS_CHARS;

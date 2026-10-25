/** Connections → "Personal or work": a source's sphere placement, set on the
 *  lane that holds the source (D-325 §15.8 — "a mailbox or calendar on its
 *  connection"). Mail shows mailboxes, Calendar shows calendars, Files shows
 *  file sources, and Apps & APIs shows every other work source, including
 *  Recued's own lists.
 *
 *  A change is a draft until Save, because placing a source in a sphere also
 *  widens who sees its items: whatever access the owner shared for that sphere
 *  starts covering them (§4.11 — "the switch says so"). Items the owner placed
 *  one by one keep their placement; the server reports how many. */
import type { Sphere, YoursCommand, YoursCommandResult, YoursSnapshot } from '@recued/contracts';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export interface SourceSpheresOptions {
  read(): Promise<YoursSnapshot>;
  change(input: YoursCommand): Promise<YoursCommandResult>;
}

export type SourceSphereLane = 'mail' | 'calendar' | 'file' | 'others';

export interface SourceSpheresPanelOptions extends SourceSpheresOptions {
  lane: SourceSphereLane;
  document: Document;
  /** What the lane knows better than the source key: the mailbox address
   *  and provider, a cloud source's own name. */
  describe?(source: string): { title?: string; detail?: string } | undefined;
  /** After each read: whether this lane has any source to place. */
  onAvailability?(available: boolean): void;
}

export interface SourceSpheresPanel {
  /** Mounted by the caller; hidden while the lane has no sources. */
  readonly element: HTMLElement;
  /** False once the server turns out to have no sphere placement: the
   *  element has left the page and is not to be put back. */
  supported(): boolean;
  /** Re-render after `describe` learns more (the lane's account list loaded). */
  rerender(): void;
  hasDraft(): boolean;
  busy(): boolean;
  whenLoaded(): Promise<void>;
  dispose(): void;
}

type SphereChoice = Sphere | '';
type SourceRow = NonNullable<YoursSnapshot['sphere_sources']>[number];

const CHOICES: ReadonlyArray<{ value: SphereChoice; label: string }> = [
  { value: '', label: 'Not set' },
  { value: 'personal', label: 'Personal' },
  { value: 'professional', label: 'Work' },
];
const sphereLabel = (value: SphereChoice): string => CHOICES.find(choice => choice.value === value)?.label ?? 'Not set';

/** Built-in work sources are `recued.<kind>`; connection sources are
 *  `<vendor>.<connection name>.<kind>` (`CONNECTION_SOURCE_ID`). */
const workSourceParts = (id: string): { vendor: string; name: string; kind: string } | null => {
  const parts = id.split('.');
  if (parts.length < 2 || parts.some(part => !part)) return null;
  return { vendor: parts[0]!, name: parts.slice(1, -1).join('.'), kind: parts[parts.length - 1]! };
};

export const sourceSphereLane = (source: string): SourceSphereLane => {
  if (source.startsWith('mail:')) return 'mail';
  if (source.startsWith('calendar:')) return 'calendar';
  if (source.startsWith('work:')) return workSourceParts(source.slice(5))?.kind === 'file' ? 'file' : 'others';
  return 'others';
};

const KIND_TITLES: Record<string, string> = {
  task: 'Tasks', note: 'Notes', commitment: 'Commitments', project: 'Projects', booking: 'Bookings',
  asset: 'Things you own', contact: 'Contacts', file: 'Files', mail_message: 'Mail', 'calendar.event': 'Events',
  deal: 'Deals', company: 'Companies', account: 'Accounts', opportunity: 'Opportunities', lead: 'Leads',
  ticket: 'Tickets', issue: 'Issues', event: 'Events', invoice: 'Invoices', customer: 'Customers',
};
const VENDOR_TITLES: Record<string, string> = {
  hubspot: 'HubSpot', salesforce: 'Salesforce', google: 'Google', microsoft: 'Microsoft', notion: 'Notion',
  jira: 'Jira', asana: 'Asana', linear: 'Linear', github: 'GitHub', dropbox: 'Dropbox', box: 'Box', s3: 'Amazon S3',
  quickbooks: 'QuickBooks', xero: 'Xero', trello: 'Trello', todoist: 'Todoist', airtable: 'Airtable',
};
const titleCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1).replace(/[_-]+/g, ' ');

/** The owner's words for a source key the server names by its id. */
export const describeSourceSphere = (row: SourceRow): { title: string; detail: string } => {
  const { source } = row;
  if (source.startsWith('mail:')) return { title: source.slice(5), detail: 'Mailbox' };
  if (source.startsWith('calendar:')) return { title: source.slice(9), detail: 'Calendar' };
  if (source.startsWith('work:')) {
    const parts = workSourceParts(source.slice(5));
    if (parts) {
      const kind = KIND_TITLES[parts.kind] ?? titleCase(parts.kind) + ' records';
      if (parts.vendor === 'recued' && !parts.name) return { title: kind, detail: 'Added in Recued' };
      if (parts.name) return { title: parts.name, detail: kind + ' from ' + (VENDOR_TITLES[parts.vendor] ?? titleCase(parts.vendor)) };
    }
    return { title: row.name && row.name !== source ? row.name : source.slice(5), detail: 'Source' };
  }
  return { title: row.name || source, detail: '' };
};

const LANE_COPY: Record<SourceSphereLane, string> = {
  mail: 'Mark each mailbox as personal or work. What comes from it is sorted the same way, except items you placed yourself.',
  calendar: 'Mark each calendar as personal or work. Its events are sorted the same way, except ones you placed yourself.',
  file: 'Mark each file source as personal or work. Its files are sorted the same way, except ones you placed yourself.',
  others: 'Choose whether items from each app, and from Recued’s own lists, count as personal or work. Items you placed yourself keep their place.',
};

/** "Source placement updated. 3 items keep the placement you pinned." */
const savedMessage = (message: string): string => {
  const retained = /(\d+) items? keep/u.exec(message);
  if (!retained) return message ? 'Saved. ' + message : 'Saved.';
  const count = Number(retained[1]);
  if (!count) return 'Saved.';
  return 'Saved. ' + count + (count === 1 ? ' item you placed yourself keeps its place.' : ' items you placed yourself keep their place.');
};

let panelSequence = 0;

export const mountSourceSpheresPanel = (options: SourceSpheresPanelOptions): SourceSpheresPanel => {
  const doc = options.document;
  const sequence = ++panelSequence;
  const element = doc.createElement('section');
  element.className = 'source-spheres';
  element.setAttribute('data-source-spheres', options.lane);
  element.setAttribute('aria-label', 'Personal or work');
  element.hidden = true;

  let rows: SourceRow[] = [];
  const drafts = new Map<string, SphereChoice>();
  const notes = new Map<string, { text: string; error: boolean }>();
  let saving: string | null = null; let loadError = ''; let loading = true; let reading = false; let disposed = false; let unsupported = false;

  const current = (row: SourceRow): SphereChoice => row.sphere ?? '';
  const chosen = (row: SourceRow): SphereChoice => drafts.get(row.source) ?? current(row);
  const describe = (row: SourceRow): { title: string; detail: string } => {
    const base = describeSourceSphere(row);
    const known = options.describe?.(row.source);
    return { title: known?.title || base.title, detail: known?.detail || base.detail };
  };
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const button = (label: string, variant: 'primary' | 'outline', action: string, source: string): HTMLButtonElement => {
    const el = node('button', 'rx-btn rx-btn-' + variant + ' rx-btn-sm', label);
    el.type = 'button';
    el.setAttribute('data-source-sphere-action', action);
    el.setAttribute('data-source-sphere-source', source);
    el.disabled = saving !== null;
    return el;
  };
  const consequence = (title: string, target: SphereChoice): string => target
    ? 'Items from ' + title + ' will count as ' + sphereLabel(target) + ', except ones you placed yourself. Anything you have shared for '
      + sphereLabel(target) + ' items will include them.'
    : 'Items from ' + title + ' will no longer be sorted by where they came from. Ones you placed yourself keep their place.';

  const focusKey = (): string | null => {
    const active = doc.activeElement as HTMLElement | null;
    if (!active || !element.contains(active)) return null;
    return active.getAttribute('data-source-sphere-focus');
  };
  const restoreFocus = (key: string | null): void => {
    if (!key) return;
    const target = [...element.querySelectorAll<HTMLElement>('[data-source-sphere-focus]')]
      .find(candidate => candidate.getAttribute('data-source-sphere-focus') === key);
    target?.focus({ preventScroll: true });
  };

  const render = (): void => {
    if (disposed) return;
    const focus = focusKey();
    element.replaceChildren();
    element.hidden = loading || (!loadError && rows.length === 0);
    if (element.hidden) return;
    const header = node('div', 'source-spheres-header');
    header.appendChild(node('h3', 'source-spheres-title', 'Personal or work'));
    header.appendChild(node('p', 'source-spheres-desc', LANE_COPY[options.lane]));
    element.appendChild(header);
    if (loadError) {
      const alert = node('p', 'source-spheres-error', loadError);
      alert.setAttribute('role', 'alert');
      element.appendChild(alert);
      const retry = node('button', 'rx-btn rx-btn-outline rx-btn-sm', reading ? 'Reading…' : 'Try again');
      retry.type = 'button';
      retry.disabled = reading;
      retry.setAttribute('data-source-sphere-action', 'retry');
      retry.setAttribute('data-source-sphere-focus', 'retry');
      element.appendChild(retry);
      restoreFocus(focus);
      return;
    }
    const list = node('ul', 'source-sphere-list');
    rows.forEach((row, index) => {
      const { title, detail } = describe(row);
      const item = node('li', 'source-sphere-row');
      item.setAttribute('data-source-sphere-row', row.source);
      const name = node('div', 'source-sphere-name');
      name.appendChild(node('span', 'source-sphere-title', title));
      if (detail) name.appendChild(node('span', 'source-sphere-detail', detail));
      item.appendChild(name);
      const group = node('div', 'source-sphere-choice');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', title + ': personal or work');
      const selected = chosen(row);
      for (const choice of CHOICES) {
        const label = node('label');
        const input = node('input');
        input.type = 'radio';
        input.name = 'source-sphere-' + sequence + '-' + index;
        input.value = choice.value;
        input.checked = choice.value === selected;
        input.disabled = saving !== null;
        input.setAttribute('data-source-sphere-choice', choice.value || 'unset');
        input.setAttribute('data-source-sphere-source', row.source);
        input.setAttribute('data-source-sphere-focus', 'choice:' + row.source + ':' + (choice.value || 'unset'));
        label.appendChild(input);
        label.appendChild(node('span', undefined, choice.label));
        group.appendChild(label);
      }
      item.appendChild(group);
      if (drafts.has(row.source)) {
        const confirm = node('div', 'source-sphere-confirm');
        confirm.appendChild(node('p', undefined, saving === row.source ? 'Saving…' : consequence(title, selected)));
        const save = button(saving === row.source ? 'Saving…' : 'Save', 'primary', 'save', row.source);
        save.setAttribute('data-source-sphere-focus', 'save:' + row.source);
        const cancel = button('Cancel', 'outline', 'cancel', row.source);
        cancel.setAttribute('data-source-sphere-focus', 'cancel:' + row.source);
        confirm.appendChild(save);
        confirm.appendChild(cancel);
        item.appendChild(confirm);
      }
      const note = notes.get(row.source);
      if (note) {
        const status = node('p', 'source-sphere-status', note.text);
        status.setAttribute('role', note.error ? 'alert' : 'status');
        item.appendChild(status);
      }
      list.appendChild(item);
    });
    element.appendChild(list);
    restoreFocus(focus);
  };

  const load = async (): Promise<void> => {
    reading = true;
    if (!loading) render();
    try {
      const snapshot = await options.read();
      if (disposed) return;
      rows = (snapshot.sphere_sources ?? []).filter(row => sourceSphereLane(row.source) === options.lane);
      for (const source of [...drafts.keys()]) if (!rows.some(row => row.source === source)) drafts.delete(source);
      loadError = '';
    } catch (error) {
      if (disposed) return;
      // A server without sphere placement has nothing to offer here: leave the
      // page altogether rather than sit in it hidden.
      if (classifyRpcError(error).code === 'unknown_method') { rows = []; loadError = ''; unsupported = true; element.remove(); return; }
      loadError = 'Personal or work settings could not be read. ' + (error instanceof Error ? error.message : String(error));
    } finally {
      reading = false;
      if (!disposed) {
        loading = false;
        render();
        options.onAvailability?.(!!loadError || rows.length > 0);
      }
    }
  };

  const save = async (source: string): Promise<void> => {
    const row = rows.find(candidate => candidate.source === source);
    if (!row || saving !== null || disposed || !drafts.has(source)) return;
    const target = drafts.get(source)!;
    saving = source; notes.delete(source); render();
    try {
      const result = await options.change({ action: 'sphere.source', source, sphere: target ? target : null });
      if (disposed) return;
      if (target) row.sphere = target; else delete row.sphere;
      drafts.delete(source);
      notes.set(source, { text: savedMessage(result.message), error: false });
    } catch (error) {
      if (!disposed) notes.set(source, { text: 'Not saved. ' + (error instanceof Error ? error.message : String(error)), error: true });
    } finally {
      saving = null;
      if (!disposed) {
        render();
        restoreFocus('choice:' + source + ':' + (chosen(row) || 'unset'));
      }
    }
  };

  element.addEventListener('change', event => {
    const input = event.target as HTMLInputElement | null;
    const source = input?.getAttribute?.('data-source-sphere-source');
    if (!input || !source || saving !== null) return;
    const row = rows.find(candidate => candidate.source === source);
    if (!row) return;
    const value = input.value as SphereChoice;
    if (value === current(row)) drafts.delete(source); else drafts.set(source, value);
    notes.delete(source);
    render();
  });
  element.addEventListener('click', event => {
    const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-source-sphere-action]');
    if (!target || !element.contains(target)) return;
    const action = target.getAttribute('data-source-sphere-action');
    const source = target.getAttribute('data-source-sphere-source') ?? '';
    if (action === 'retry') { if (!reading) pending = load(); return; }
    if (action === 'save') { void save(source); return; }
    if (action === 'cancel' && saving === null) {
      const row = rows.find(candidate => candidate.source === source);
      drafts.delete(source); render();
      if (row) restoreFocus('choice:' + source + ':' + (current(row) || 'unset'));
    }
  });

  let pending = load();
  return {
    element,
    supported: () => !unsupported,
    rerender: render,
    hasDraft: () => drafts.size > 0,
    busy: () => saving !== null,
    whenLoaded: () => pending,
    dispose: () => { disposed = true; element.remove(); },
  };
};

export const SOURCE_SPHERES_STYLES = `
.source-spheres {
  min-width: 0; margin-top: 4px; padding: 14px 16px 6px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
}
.source-spheres[hidden] { display: none; }
.connections-tool-body .source-spheres { margin: 0; padding: 0; border: 0; background: none; }
.connections-tool-body .source-spheres-header { display: none; }
.source-spheres-header { display: grid; gap: 2px; min-width: 0; margin-bottom: 4px; }
.source-spheres-title { margin: 0; color: var(--fg-strong, var(--fg)); font-size: 14px; line-height: 1.35; font-weight: 650; }
.source-spheres-desc { margin: 0; color: var(--fg-muted); font-size: 12.5px; line-height: 1.45; }
.source-spheres-error { margin: 8px 0; color: var(--danger); font-size: 13px; }
.source-sphere-list { display: grid; min-width: 0; margin: 0; padding: 0; list-style: none; }
.source-sphere-row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 16px;
  min-width: 0; padding: 10px 0; border-top: 1px solid var(--border);
}
.source-sphere-row:first-child { border-top: 0; }
.connections-tool-body .source-sphere-row:first-child { padding-top: 0; }
.source-sphere-name { display: grid; gap: 1px; min-width: 0; }
.source-sphere-title { overflow-wrap: anywhere; color: var(--fg-strong, var(--fg)); font-size: 13.5px; font-weight: 650; }
.source-sphere-detail { overflow-wrap: anywhere; color: var(--fg-muted); font-size: 12px; }
.source-sphere-choice {
  display: inline-flex; gap: 2px; justify-self: start; padding: 2px;
  border: 1px solid var(--border-strong); border-radius: 9px; background: var(--surface-sunk);
}
.source-sphere-choice label { position: relative; display: inline-flex; }
.source-sphere-choice input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.source-sphere-choice input:disabled { cursor: default; }
.source-sphere-choice span {
  display: inline-flex; align-items: center; min-height: 30px; padding: 4px 12px; border-radius: 7px;
  color: var(--fg-muted); font-size: 12.5px; font-weight: 600; white-space: nowrap;
}
.source-sphere-choice label:hover input:not(:checked):not(:disabled) + span { color: var(--fg); }
.source-sphere-choice input:checked + span {
  background: var(--surface); color: var(--fg-strong, var(--fg));
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.14), 0 0 0 1px var(--border);
}
.source-sphere-choice input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 1px; }
.source-sphere-choice input:disabled + span { opacity: 0.6; }
.source-sphere-confirm, .source-sphere-status { grid-column: 1 / -1; }
.source-sphere-confirm {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; min-width: 0;
  padding: 10px 12px; border-radius: 8px; background: var(--accent-weak);
}
.source-sphere-confirm p { flex: 1 1 240px; min-width: 0; margin: 0; color: var(--fg); font-size: 12.5px; line-height: 1.45; }
.source-sphere-status { margin: 0; color: var(--fg-muted); font-size: 12.5px; line-height: 1.45; }
.source-sphere-status[role=alert] { color: var(--danger); }
@media (max-width: 560px) {
  .source-sphere-row { grid-template-columns: minmax(0, 1fr); }
}
`;

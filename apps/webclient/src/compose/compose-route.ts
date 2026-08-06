/** D-174 P5 - Compose local draft route.
 *
 *  Compose is now the local capture surface for the four atomic own-it
 *  kinds. It does not create Reception endpoints and it does not push
 *  drafts out to external systems; commits go through the existing
 *  pair-RPC local write paths.
 */

import type {
  CommitmentDerivation,
  CommitmentDirection,
  CommitmentExpiryPolicy,
  ContactRecord,
  ProjectState,
  TaskPriority,
  WorkEntity,
  WorkEntityUpsertRpcRequest,
  WorkEntityUpsertRpcResponse,
} from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const COMPOSE_ROUTE_STYLES_MARKER = 'data-recued-compose-styles';
export const COMPOSE_ROUTE_HOST_ATTR = 'data-recued-compose-route';
export const COMPOSE_ROUTE_HEADING_ATTR = 'data-recued-compose-heading';
export const COMPOSE_ROUTE_INTENT_ATTR = 'data-recued-compose-capture';
export const COMPOSE_ROUTE_TARGET_CHIP_ATTR = 'data-recued-compose-target';
export const COMPOSE_ROUTE_FIELD_ATTR = 'data-recued-compose-field';
export const COMPOSE_ROUTE_COMMIT_ATTR = 'data-recued-compose-commit';
export const COMPOSE_ROUTE_CONFIRMATION_ATTR =
  'data-recued-compose-confirmation';
export const COMPOSE_ROUTE_STATUS_ATTR = 'data-recued-compose-status';
export const COMPOSE_ROUTE_ERROR_ATTR = 'data-recued-compose-error';
export const COMPOSE_ROUTE_PREVIEW_ATTR = 'data-recued-compose-draft';
export const COMPOSE_ROUTE_RECEPTION_LINK_ATTR =
  'data-recued-compose-reception-link';
export const COMPOSE_ROUTE_KITCHEN_LINK_ATTR =
  'data-recued-compose-kitchen-link';

export type ComposeLocalTargetKind =
  | 'contact'
  | 'task'
  | 'note'
  | 'commitment'
  // R18 — Project added so the fast-access create (L1 menu + chat) offers the
  // same kind set as Data's full create (owner: "create consistent everywhere
  // including project"). Quick-capture depth; the full form stays in Data.
  | 'project';

export type ComposeRouteStage =
  | 'drafting'
  | 'committing'
  | 'committed'
  | 'error';

export type ComposeContactUpsertCaller = (
  args: {
    email: string;
    name?: string;
    last_interaction?: number;
    first_seen?: number;
    phone?: string;
    company?: string;
  },
) => Promise<{ contact: ContactRecord }>;

export type ComposeWorkEntityUpsertCaller = (
  args: WorkEntityUpsertRpcRequest,
) => Promise<WorkEntityUpsertRpcResponse>;

interface ComposeCommitConfirmation {
  readonly target: ComposeLocalTargetKind;
  readonly rpc: 'contact.upsert' | 'work_entity.upsert';
  readonly label: string;
  readonly entity_id?: string;
}

export interface ComposeRouteState {
  readonly stage: ComposeRouteStage;
  readonly target: ComposeLocalTargetKind;
  readonly capture_text: string;
  readonly values: Readonly<Record<string, string>>;
  readonly confirmation: ComposeCommitConfirmation | null;
  readonly error: string | null;
}

export interface BootstrapComposeRouteOptions {
  readonly root: HTMLElement;
  readonly document?: Document;
  readonly initialCaptureText?: string;
  readonly contactUpsertCaller?: ComposeContactUpsertCaller;
  readonly workEntityUpsertCaller?: ComposeWorkEntityUpsertCaller;
  /** Host chrome can mirror the authoritative commit boundary without
   *  observing or parsing the route's DOM. */
  readonly onStateChange?: (state: ComposeRouteState) => void;
}

export interface ComposeRoute {
  readonly getState: () => ComposeRouteState;
  /** True when any target still owns user-entered values, including drafts
   *  parked behind a different target chip. */
  readonly hasUnsavedChanges: () => boolean;
  readonly selectTarget: (target: ComposeLocalTargetKind) => void;
  readonly setCaptureText: (text: string) => void;
  readonly setFieldValues: (values: Readonly<Record<string, string>>) => void;
  readonly commitDraft: () => Promise<void>;
  readonly dispose: () => void;
}

export interface ComposeTargetModel {
  readonly kind: ComposeLocalTargetKind;
  readonly label: string;
  readonly rpc: 'contact.upsert' | 'work_entity.upsert';
  readonly fields: readonly ComposeFieldModel[];
}

export interface ComposeFieldModel {
  readonly key: string;
  readonly label: string;
  readonly type: 'text' | 'email' | 'textarea' | 'date' | 'select';
  readonly required?: boolean;
  readonly options?: readonly ComposeFieldOption[];
}

export interface ComposeFieldOption {
  readonly value: string;
  readonly label: string;
}

const TASK_PRIORITY_OPTIONS: readonly ComposeFieldOption[] = [
  { value: '', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const COMMITMENT_DIRECTION_OPTIONS: readonly ComposeFieldOption[] = [
  { value: 'outbound', label: 'Outbound' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'internal', label: 'Internal' },
];

const COMMITMENT_DERIVATION_OPTIONS: readonly ComposeFieldOption[] = [
  { value: 'user_declared', label: 'Entered manually' },
  { value: 'mail_extracted', label: 'From an email' },
  { value: 'meeting_extracted', label: 'From a meeting' },
  { value: 'recipe_emitted', label: 'From a recipe' },
  { value: 'peer_received', label: 'From a peer' },
];

const COMMITMENT_EXPIRY_OPTIONS: readonly ComposeFieldOption[] = [
  { value: 'escalate_overdue', label: 'Escalate overdue' },
  { value: 'strict_expire', label: 'Strict expire' },
  { value: 'indefinite', label: 'Indefinite' },
];

// R18 — PROJECT_STATES from contracts; 'active' is the new-project default.
const PROJECT_STATE_OPTIONS: readonly ComposeFieldOption[] = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
];

export const COMPOSE_LOCAL_TARGETS: readonly ComposeTargetModel[] = [
  {
    kind: 'contact',
    label: 'Contact',
    rpc: 'contact.upsert',
    fields: [
      { key: 'email', label: 'Email', type: 'email', required: true },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'company', label: 'Company', type: 'text' },
    ],
  },
  {
    kind: 'task',
    label: 'Task',
    rpc: 'work_entity.upsert',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'body', label: 'Body', type: 'textarea' },
      { key: 'due_at', label: 'Due', type: 'date' },
      {
        key: 'priority',
        label: 'Priority',
        type: 'select',
        options: TASK_PRIORITY_OPTIONS,
      },
    ],
  },
  {
    kind: 'note',
    label: 'Note',
    rpc: 'work_entity.upsert',
    fields: [
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'body', label: 'Body', type: 'textarea', required: true },
    ],
  },
  {
    kind: 'commitment',
    label: 'Commitment',
    rpc: 'work_entity.upsert',
    fields: [
      {
        key: 'statement',
        label: 'Statement',
        type: 'textarea',
        required: true,
      },
      { key: 'promised_for_at', label: 'Promised for', type: 'date' },
      {
        key: 'direction',
        label: 'Direction',
        type: 'select',
        options: COMMITMENT_DIRECTION_OPTIONS,
      },
      {
        key: 'derivation',
        label: 'Source',
        type: 'select',
        options: COMMITMENT_DERIVATION_OPTIONS,
      },
      {
        key: 'expiry_policy',
        label: 'Expiry policy',
        type: 'select',
        options: COMMITMENT_EXPIRY_OPTIONS,
      },
    ],
  },
  {
    kind: 'project',
    label: 'Project',
    rpc: 'work_entity.upsert',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'description', label: 'Description', type: 'textarea' },
      { key: 'target_completion_at', label: 'Target completion', type: 'date' },
      { key: 'state', label: 'State', type: 'select', options: PROJECT_STATE_OPTIONS },
    ],
  },
] as const;

const COMPOSE_TARGET_BY_KIND = new Map(
  COMPOSE_LOCAL_TARGETS.map((target) => [target.kind, target]),
);

const COMPOSE_ROUTE_CHROME_STYLES = `
[${COMPOSE_ROUTE_HOST_ATTR}] {
  --bg-soft: var(--surface-sunk);
  --accent-dim: var(--accent);
  --fail: var(--danger);
  --fail-soft: var(--danger-weak);
  max-width: var(--wc-content-max, 1080px);
  margin: 0 auto;
  padding: 16px;
}
[${COMPOSE_ROUTE_HOST_ATTR}] .compose-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
[${COMPOSE_ROUTE_HOST_ATTR}] .compose-title {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}
[${COMPOSE_ROUTE_HOST_ATTR}] .compose-panel {
  display: grid;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}
[${COMPOSE_ROUTE_HOST_ATTR}] .compose-label {
  display: grid;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-muted);
}
[${COMPOSE_ROUTE_HOST_ATTR}] textarea,
[${COMPOSE_ROUTE_HOST_ATTR}] input,
[${COMPOSE_ROUTE_HOST_ATTR}] select {
  width: 100%;
  box-sizing: border-box;
  min-height: 36px;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
}
[${COMPOSE_ROUTE_HOST_ATTR}] textarea {
  min-height: 96px;
  resize: vertical;
}
[${COMPOSE_ROUTE_HOST_ATTR}] .compose-targets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[${COMPOSE_ROUTE_TARGET_CHIP_ATTR}] {
  min-height: 36px;
  padding: 6px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}
[${COMPOSE_ROUTE_TARGET_CHIP_ATTR}][data-active="true"] {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--accent-dim);
}
[${COMPOSE_ROUTE_PREVIEW_ATTR}] {
  display: grid;
  gap: 12px;
}
[${COMPOSE_ROUTE_PREVIEW_ATTR}] .compose-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
[${COMPOSE_ROUTE_PREVIEW_ATTR}] .compose-field-wide {
  grid-column: 1 / -1;
}
[${COMPOSE_ROUTE_STATUS_ATTR}] {
  min-height: 18px;
  font-size: 13px;
  color: var(--fg-muted);
}
[${COMPOSE_ROUTE_ERROR_ATTR}] {
  display: none;
  padding: 8px 10px;
  border: 1px solid var(--fail);
  border-radius: 4px;
  background: var(--fail-soft);
  color: var(--fail);
  font-size: 13px;
}
[${COMPOSE_ROUTE_ERROR_ATTR}][data-active="true"] {
  display: block;
}
[${COMPOSE_ROUTE_COMMIT_ATTR}] {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--accent);
  color: var(--on-accent);
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}
[${COMPOSE_ROUTE_COMMIT_ATTR}][aria-disabled="true"] {
  cursor: not-allowed;
  opacity: 0.55;
}
[${COMPOSE_ROUTE_CONFIRMATION_ATTR}] {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
  font-size: 13px;
}
[${COMPOSE_ROUTE_CONFIRMATION_ATTR}] strong {
  color: var(--accent-dim);
}
@media (max-width: 760px) {
  [${COMPOSE_ROUTE_HOST_ATTR}] {
    padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  }
  [${COMPOSE_ROUTE_HOST_ATTR}] textarea,
  [${COMPOSE_ROUTE_HOST_ATTR}] input,
  [${COMPOSE_ROUTE_HOST_ATTR}] select {
    min-height: 44px;
    font-size: 16px;
  }
  [${COMPOSE_ROUTE_PREVIEW_ATTR}] .compose-fields {
    grid-template-columns: 1fr;
  }
}
`;

export const COMPOSE_ROUTE_STYLES = COMPOSE_ROUTE_CHROME_STYLES;

const removeChildren = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const dateValue = (value: string | undefined): number | undefined => {
  const trimmed = nonEmpty(value);
  if (trimmed === undefined) return undefined;
  const parsed = Date.parse(trimmed.includes('T') ? trimmed : `${trimmed}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const selectedOption = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T => allowed.includes(value as T) ? (value as T) : fallback;

const targetFor = (kind: ComposeLocalTargetKind): ComposeTargetModel => {
  const target = COMPOSE_TARGET_BY_KIND.get(kind);
  if (target === undefined) {
    throw new Error(`Unknown Compose target: ${kind}`);
  }
  return target;
};

const seededValues = (
  target: ComposeLocalTargetKind,
  captureText: string,
): Record<string, string> => {
  const capture = captureText.trim();
  if (target === 'task') return capture.length > 0 ? { title: capture } : {};
  if (target === 'note') return capture.length > 0 ? { body: capture } : {};
  if (target === 'project') return capture.length > 0 ? { title: capture } : {};
  if (target === 'commitment') {
    return {
      ...(capture.length > 0 ? { statement: capture } : {}),
      direction: 'outbound',
      derivation: 'user_declared',
      expiry_policy: 'escalate_overdue',
    };
  }
  return {};
};

const initialState = (
  initialCaptureText: string | undefined,
): ComposeRouteState => {
  const captureText = initialCaptureText ?? '';
  return {
    stage: 'drafting',
    target: 'contact',
    capture_text: captureText,
    values: seededValues('contact', captureText),
    confirmation: null,
    error: null,
  };
};

const contactUpsertArgs = (
  values: Readonly<Record<string, string>>,
): Parameters<ComposeContactUpsertCaller>[0] => {
  const email = nonEmpty(values.email);
  if (email === undefined) throw new Error('Email is required.');
  if (!email.includes('@')) throw new Error('Email must include @.');
  const out: Parameters<ComposeContactUpsertCaller>[0] = { email };
  const name = nonEmpty(values.name);
  const phone = nonEmpty(values.phone);
  const company = nonEmpty(values.company);
  if (name !== undefined) out.name = name;
  if (phone !== undefined) out.phone = phone;
  if (company !== undefined) out.company = company;
  return out;
};

const workEntityUpsertArgs = (
  target: Exclude<ComposeLocalTargetKind, 'contact'>,
  captureText: string,
  values: Readonly<Record<string, string>>,
): WorkEntityUpsertRpcRequest => {
  if (target === 'task') {
    const title = nonEmpty(values.title) ?? nonEmpty(captureText);
    if (title === undefined) throw new Error('Title is required.');
    const out: {
      kind: 'task';
      title: string;
      body?: string;
      due_at?: number;
      priority?: TaskPriority;
    } = { kind: 'task', title };
    const body = nonEmpty(values.body);
    const due = dateValue(values.due_at);
    const priority = selectedOption<TaskPriority>(
      values.priority,
      ['low', 'medium', 'high'],
      'medium',
    );
    if (body !== undefined) out.body = body;
    if (due !== undefined) out.due_at = due;
    if (nonEmpty(values.priority) !== undefined) out.priority = priority;
    return out;
  }
  if (target === 'note') {
    const body = nonEmpty(values.body) ?? nonEmpty(captureText);
    if (body === undefined) throw new Error('Body is required.');
    const out: { kind: 'note'; body: string; title?: string } = {
      kind: 'note',
      body,
    };
    const title = nonEmpty(values.title);
    if (title !== undefined) out.title = title;
    return out;
  }
  if (target === 'project') {
    const title = nonEmpty(values.title) ?? nonEmpty(captureText);
    if (title === undefined) throw new Error('Title is required.');
    const out: {
      kind: 'project';
      title: string;
      description?: string;
      target_completion_at?: number;
      state?: ProjectState;
    } = { kind: 'project', title };
    const description = nonEmpty(values.description);
    const targetCompletion = dateValue(values.target_completion_at);
    if (description !== undefined) out.description = description;
    if (targetCompletion !== undefined) out.target_completion_at = targetCompletion;
    if (nonEmpty(values.state) !== undefined) {
      out.state = selectedOption<ProjectState>(
        values.state,
        ['active', 'paused', 'completed', 'archived'],
        'active',
      );
    }
    return out;
  }
  const statement = nonEmpty(values.statement) ?? nonEmpty(captureText);
  if (statement === undefined) throw new Error('Statement is required.');
  const out: {
    kind: 'commitment';
    direction: CommitmentDirection;
    statement: string;
    derivation: CommitmentDerivation;
    promised_for_at?: number;
    expiry_policy?: CommitmentExpiryPolicy;
  } = {
    kind: 'commitment',
    direction: selectedOption<CommitmentDirection>(
      values.direction,
      ['outbound', 'inbound', 'internal'],
      'outbound',
    ),
    statement,
    derivation: selectedOption<CommitmentDerivation>(
      values.derivation,
      [
        'user_declared',
        'mail_extracted',
        'meeting_extracted',
        'recipe_emitted',
        'peer_received',
      ],
      'user_declared',
    ),
  };
  const promisedFor = dateValue(values.promised_for_at);
  const expiryPolicy = selectedOption<CommitmentExpiryPolicy>(
    values.expiry_policy,
    ['strict_expire', 'escalate_overdue', 'indefinite'],
    'escalate_overdue',
  );
  if (promisedFor !== undefined) out.promised_for_at = promisedFor;
  if (nonEmpty(values.expiry_policy) !== undefined) {
    out.expiry_policy = expiryPolicy;
  }
  return out;
};

const workEntityLabel = (
  target: ComposeLocalTargetKind,
  entity: WorkEntity,
): string => {
  const row = entity as unknown as Readonly<Record<string, unknown>>;
  if (target === 'task' && typeof row.title === 'string') return row.title;
  if (target === 'note' && typeof row.title === 'string') return row.title;
  if (target === 'note' && typeof row.body === 'string') return row.body;
  if (target === 'commitment' && typeof row.statement === 'string') {
    return row.statement;
  }
  if (target === 'project' && typeof row.title === 'string') return row.title;
  if (typeof row.id === 'string') return row.id;
  return targetFor(target).label;
};

const workEntityId = (entity: WorkEntity): string | undefined => {
  const row = entity as unknown as Readonly<Record<string, unknown>>;
  return typeof row.id === 'string' ? row.id : undefined;
};

const statusText = (state: ComposeRouteState): string => {
  if (state.stage === 'committing') return 'Committing draft';
  if (state.stage === 'committed') return 'Committed';
  if (state.stage === 'error') return 'Error';
  return `Drafting ${targetFor(state.target).label}`;
};

export const bootstrapComposeRoute = (
  opts: BootstrapComposeRouteOptions,
): ComposeRoute => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapComposeRoute: no document available - pass `opts.document` for non-browser environments',
    );
  }

  if (
    doc.head.querySelector(`style[${COMPOSE_ROUTE_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(COMPOSE_ROUTE_STYLES_MARKER, '');
    style.textContent = COMPOSE_ROUTE_STYLES;
    doc.head.appendChild(style);
  }

  const routeRoot = doc.createElement('div');
  routeRoot.setAttribute(COMPOSE_ROUTE_HOST_ATTR, '');

  const header = doc.createElement('header');
  header.className = 'compose-header';
  const heading = doc.createElement('h1');
  heading.className = 'compose-title';
  heading.setAttribute(COMPOSE_ROUTE_HEADING_ATTR, '');
  heading.textContent = 'Compose';
  header.appendChild(heading);
  routeRoot.appendChild(header);

  const panel = doc.createElement('section');
  panel.className = 'compose-panel';

  const captureLabel = doc.createElement('label');
  captureLabel.className = 'compose-label';
  captureLabel.textContent = 'Capture';
  const capture = doc.createElement('textarea') as HTMLTextAreaElement;
  capture.setAttribute(COMPOSE_ROUTE_INTENT_ATTR, '');
  capture.setAttribute('aria-label', 'Capture text');
  captureLabel.appendChild(capture);
  panel.appendChild(captureLabel);

  const targetGroup = doc.createElement('div');
  targetGroup.className = 'compose-targets';
  targetGroup.setAttribute('role', 'group');
  targetGroup.setAttribute('aria-label', 'Create type');
  const targetButtons = new Map<ComposeLocalTargetKind, HTMLButtonElement>();
  for (const target of COMPOSE_LOCAL_TARGETS) {
    const button = doc.createElement('button') as HTMLButtonElement;
    button.setAttribute('type', 'button');
    button.setAttribute(COMPOSE_ROUTE_TARGET_CHIP_ATTR, target.kind);
    button.textContent = target.label;
    targetButtons.set(target.kind, button);
    targetGroup.appendChild(button);
  }
  panel.appendChild(targetGroup);

  const status = doc.createElement('div');
  status.setAttribute(COMPOSE_ROUTE_STATUS_ATTR, '');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  panel.appendChild(status);

  const error = doc.createElement('div');
  error.setAttribute(COMPOSE_ROUTE_ERROR_ATTR, '');
  error.setAttribute('data-active', 'false');
  error.setAttribute('role', 'alert');
  panel.appendChild(error);

  const draftHost = doc.createElement('div');
  draftHost.setAttribute(COMPOSE_ROUTE_PREVIEW_ATTR, '');
  panel.appendChild(draftHost);
  routeRoot.appendChild(panel);
  opts.root.appendChild(routeRoot);

  let disposed = false;
  let state = initialState(opts.initialCaptureText);
  const targetDrafts = new Map<
    ComposeLocalTargetKind,
    Record<string, string>
  >([[state.target, { ...state.values }]]);
  let renderedConfirmation: HTMLElement | null = null;
  let renderedCommit: HTMLButtonElement | null = null;
  let pendingCommitFocus = false;

  const emit = (next: ComposeRouteState): void => {
    state = next;
    if (!disposed) render();
  };

  const setFieldValue = (
    key: string,
    value: string,
  ): void => {
    state = {
      ...state,
      stage: 'drafting',
      values: { ...state.values, [key]: value },
      confirmation: null,
      error: null,
    };
    targetDrafts.set(state.target, { ...state.values });
    // Field edits do not change the form's shape. Reset feedback in place so
    // native Tab/select focus is never destroyed by rebuilding every control.
    status.textContent = statusText(state);
    error.textContent = '';
    error.setAttribute('data-active', 'false');
    if (renderedConfirmation !== null) {
      try {
        draftHost.removeChild(renderedConfirmation);
      } catch {
        /* a concurrent full render already detached it */
      }
      renderedConfirmation = null;
    }
  };

  const syncValuesFromDom = (): Record<string, string> => {
    const values: Record<string, string> = { ...state.values };
    const fields = draftHost.querySelectorAll(`[${COMPOSE_ROUTE_FIELD_ATTR}]`);
    for (const field of Array.from(fields)) {
      const key = field.getAttribute(COMPOSE_ROUTE_FIELD_ATTR);
      if (key === null) continue;
      values[key] = (field as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
    }
    return values;
  };

  const hasUnsavedChanges = (): boolean => {
    const captureText = disposed ? state.capture_text : capture.value;
    if (captureText.trim().length > 0) return true;

    // Target switches deliberately retain each target's draft. Overlay chrome
    // must therefore inspect the whole draft map, not only the currently
    // rendered fields, before allowing a user dismissal to destroy the route.
    const drafts = new Map(targetDrafts);
    drafts.set(
      state.target,
      disposed ? { ...state.values } : syncValuesFromDom(),
    );
    for (const [target, values] of drafts) {
      const baseline = seededValues(target, '');
      const keys = new Set([
        ...Object.keys(baseline),
        ...Object.keys(values),
      ]);
      for (const key of keys) {
        if ((values[key] ?? '').trim() !== (baseline[key] ?? '').trim()) {
          return true;
        }
      }
    }
    return false;
  };

  const setCaptureText = (text: string): void => {
    emit({
      ...state,
      stage: 'drafting',
      capture_text: text,
      confirmation: null,
      error: null,
    });
  };

  const selectTarget = (target: ComposeLocalTargetKind): void => {
    if (state.stage === 'committing') return;
    const currentValues = syncValuesFromDom();
    targetDrafts.set(state.target, { ...currentValues });
    if (target === state.target) return;
    const nextValues = {
      ...(targetDrafts.get(target)
        ?? seededValues(target, state.capture_text)),
    };
    targetDrafts.set(target, { ...nextValues });
    emit({
      stage: 'drafting',
      target,
      capture_text: state.capture_text,
      values: nextValues,
      confirmation: null,
      error: null,
    });
  };

  const setFieldValues = (
    values: Readonly<Record<string, string>>,
  ): void => {
    const next = {
      ...state,
      stage: 'drafting',
      values: { ...state.values, ...values },
      confirmation: null,
      error: null,
    } satisfies ComposeRouteState;
    targetDrafts.set(next.target, { ...next.values });
    emit(next);
  };

  const commitDraft = async (): Promise<void> => {
    if (state.stage === 'committing') return;
    const values = syncValuesFromDom();
    const captureText = capture.value;
    const target = state.target;
    targetDrafts.set(target, { ...values });
    try {
      if (target === 'contact') {
        if (opts.contactUpsertCaller === undefined) {
          throw new Error('Saving contacts is not available on this server yet.');
        }
        const args = contactUpsertArgs(values);
        emit({
          ...state,
          stage: 'committing',
          capture_text: captureText,
          values,
          confirmation: null,
          error: null,
        });
        const result = await opts.contactUpsertCaller(args);
        if (disposed) return;
        const resetValues = seededValues(target, '');
        targetDrafts.set(target, { ...resetValues });
        emit({
          stage: 'committed',
          target,
          capture_text: '',
          values: resetValues,
          confirmation: {
            target,
            rpc: 'contact.upsert',
            label: result.contact.name ?? result.contact.email,
            entity_id: result.contact.email,
          },
          error: null,
        });
        return;
      }
      if (opts.workEntityUpsertCaller === undefined) {
        throw new Error('Saving this item is not available on this server yet.');
      }
      const args = workEntityUpsertArgs(target, captureText, values);
      emit({
        ...state,
        stage: 'committing',
        capture_text: captureText,
        values,
        confirmation: null,
        error: null,
      });
      const result = await opts.workEntityUpsertCaller(args);
      if (disposed) return;
      const resetValues = seededValues(target, '');
      targetDrafts.set(target, { ...resetValues });
      emit({
        stage: 'committed',
        target,
        capture_text: '',
        values: resetValues,
        confirmation: {
          target,
          rpc: 'work_entity.upsert',
          label: workEntityLabel(target, result.entity),
          ...(workEntityId(result.entity) !== undefined
            ? { entity_id: workEntityId(result.entity) }
            : {}),
        },
        error: null,
      });
    } catch (err) {
      if (disposed) return;
      emit({
        ...state,
        stage: 'error',
        capture_text: captureText,
        values,
        confirmation: null,
        error: errMessage(err),
      });
    }
  };

  const renderField = (
    field: ComposeFieldModel,
    values: Readonly<Record<string, string>>,
    disabled: boolean,
  ): HTMLElement => {
    const label = doc.createElement('label');
    label.className =
      field.type === 'textarea' ? 'compose-label compose-field-wide' : 'compose-label';
    label.textContent = `${field.label}${field.required === true ? ' *' : ''}`;
    let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (field.type === 'textarea') {
      control = doc.createElement('textarea') as HTMLTextAreaElement;
    } else if (field.type === 'select') {
      const select = doc.createElement('select') as HTMLSelectElement;
      for (const option of field.options ?? []) {
        const optionEl = doc.createElement('option') as HTMLOptionElement;
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        select.appendChild(optionEl);
      }
      control = select;
    } else {
      const input = doc.createElement('input') as HTMLInputElement;
      input.setAttribute('type', field.type);
      control = input;
    }
    control.setAttribute(COMPOSE_ROUTE_FIELD_ATTR, field.key);
    control.setAttribute('aria-label', field.label);
    if (field.required === true) {
      // Compose owns custom cross-field validation (Capture can seed several
      // targets), so expose the requirement to assistive technology without
      // opting the control into an unrelated native form-submit lifecycle.
      control.setAttribute('aria-required', 'true');
    }
    control.value = values[field.key] ?? '';
    control.disabled = disabled;
    control.addEventListener('input', () => {
      setFieldValue(field.key, control.value);
    });
    control.addEventListener('change', () => {
      setFieldValue(field.key, control.value);
    });
    label.appendChild(control);
    return label;
  };

  const render = (): void => {
    const activeBeforeRender = doc.activeElement as
      | HTMLElement
      | null
      | undefined;
    if (activeBeforeRender === renderedCommit) {
      pendingCommitFocus = true;
    } else if (
      activeBeforeRender !== null
      && activeBeforeRender !== undefined
      && activeBeforeRender !== doc.body
      && activeBeforeRender.isConnected
    ) {
      pendingCommitFocus = false;
    }
    const busy = state.stage === 'committing';
    capture.value = state.capture_text;
    capture.disabled = busy;
    for (const [kind, button] of targetButtons) {
      button.disabled = busy;
      button.setAttribute('data-active', kind === state.target ? 'true' : 'false');
      button.setAttribute(
        'aria-pressed',
        kind === state.target ? 'true' : 'false',
      );
    }
    status.textContent = statusText(state);
    error.textContent = state.error ?? '';
    error.setAttribute('data-active', state.error ? 'true' : 'false');

    renderedConfirmation = null;
    renderedCommit = null;
    removeChildren(draftHost);
    const target = targetFor(state.target);
    const fields = doc.createElement('div');
    fields.className = 'compose-fields';
    for (const field of target.fields) {
      fields.appendChild(renderField(field, state.values, busy));
    }
    draftHost.appendChild(fields);

    const commit = doc.createElement('button') as HTMLButtonElement;
    commit.setAttribute('type', 'button');
    commit.setAttribute(COMPOSE_ROUTE_COMMIT_ATTR, '');
    commit.textContent = busy ? 'Committing…' : `Commit ${target.label}`;
    if (busy) {
      commit.setAttribute('aria-disabled', 'true');
      commit.setAttribute('aria-busy', 'true');
    }
    commit.addEventListener('click', () => {
      void commitDraft();
    });
    renderedCommit = commit;
    draftHost.appendChild(commit);

    if (state.confirmation !== null) {
      const confirmation = doc.createElement('section');
      confirmation.setAttribute(COMPOSE_ROUTE_CONFIRMATION_ATTR, '');
      const title = doc.createElement('strong');
      title.textContent = `Committed ${targetFor(state.confirmation.target).label}`;
      confirmation.appendChild(title);
      const detail = doc.createElement('span');
      detail.textContent = state.confirmation.label;
      confirmation.appendChild(detail);
      if (state.confirmation.entity_id !== undefined) {
        const id = doc.createElement('span');
        id.textContent = state.confirmation.entity_id;
        confirmation.appendChild(id);
      }
      draftHost.appendChild(confirmation);
      renderedConfirmation = confirmation;
    }
    if (pendingCommitFocus && !commit.disabled) {
      pendingCommitFocus = false;
      commit.focus({ preventScroll: true });
    }
    opts.onStateChange?.(state);
  };

  capture.addEventListener('input', () => {
    setCaptureText(capture.value);
  });
  for (const [kind, button] of targetButtons) {
    button.addEventListener('click', () => {
      selectTarget(kind);
    });
  }

  render();

  return {
    getState: () => state,
    hasUnsavedChanges,
    selectTarget,
    setCaptureText,
    setFieldValues,
    commitDraft,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        opts.root.removeChild(routeRoot);
      } catch {
        /* detached fake roots can throw; route state is already inert */
      }
    },
  };
};

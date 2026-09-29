/**
 * D-315 §6.1, §6.2, §7.1 — Data → Received → Mail facts → Templates.
 *
 *   - **The list:** each template with its type, whose it is, whether it is on,
 *     and its health — how often its conditions held, how often it read a fact,
 *     how often it missed — shown as broken when it used to read and now
 *     misses: a sender redesigning its email is this category's best-known
 *     failure, and a rules template fails silently otherwise (§6.2).
 *   - **Read without a template:** the standards pass's switch per type
 *     (ruling 10).
 *   - **The editor:** from an email (read again from its provider) or a pasted
 *     sample. Its values are clickable; the owner says what each one is, and
 *     the editor writes the rule (`mail-fact-template-rules.ts`). The entrance
 *     is suggested from the email and editable. Preview runs the unsaved
 *     template over the email and the newest stored emails that meet its
 *     conditions before anything is saved.
 *   - **AI (§4.3), off by default:** the prompt, the slots it may fill — data
 *     fields and variables outside the entrance — and the pool. **Draft with
 *     AI** (§6.1) proposes the whole template from the email in one call; the
 *     owner checks it with Preview, which runs straight after.
 *
 * Like the Facts view it renders HTML strings; the surface forwards its
 * actions (`mail-facts-tpl-*`, `mail-facts-ed-*`), its selects and checkboxes
 * (`change`) and its text fields (`input`) by `MAIL_FACTS_FIELD_ATTR`. A text
 * field updates the draft without a repaint, so typing is never interrupted.
 */

import {
  getMailFactBuiltinType,
  mailFactEmptyAiSlots,
  mailFactOn,
  mailFactTypeVariables,
  mailTemplateNarrowsPastDomain,
  MAIL_FACT_BUILTIN_TYPES,
  MAIL_FACT_STANDARDS_TYPES,
  MAIL_TEMPLATE_CONDITION_FIELDS,
  MAIL_TEMPLATE_CONDITION_OPS_BY_FIELD,
  type MailFactBackfillJob,
  type MailFactBackfillRequest,
  type MailFactBackfillState,
  type MailFactEmailContent,
  type MailFactEmailRef,
  type MailFactPoolPolicy,
  type MailFactStandardsSetting,
  type MailFactTypeSpec,
  type MailFactValue,
  type MailTemplate,
  type MailTemplateCondition,
  type MailTemplateConditionField,
  type MailTemplateConditionOp,
  type MailTemplateCreateRequest,
  type MailTemplateDefinition,
  type MailTemplateDraftRequest,
  type MailTemplateDraftResult,
  type MailTemplatePreviewEmail,
  type MailTemplatePreviewRequest,
  type MailTemplatePreviewResult,
  type MailTemplateRepeat,
  type MailTemplateRule,
  type MailTemplateSample,
  type MailTemplateUpdateRequest,
  type ServerRecipeListEntry,
} from '@recued/contracts';
import { e } from '@recued/ui-shared';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import {
  createMailFactTypeEditor,
  MAIL_FACT_TYPE_EDITOR_STYLES,
  type MailFactTypeCallers,
} from './mail-fact-type-editor.js';
import {
  defaultEntranceVariables,
  describeRule,
  editorVariables,
  humanizeName,
  ruleFromPick,
  suggestConditions,
  textSpans,
  type PickTarget,
  type ValuePick,
} from './mail-fact-template-rules.js';

export const MAIL_FACTS_FIELD_ATTR = 'data-recued-mail-facts-field';
export const MAIL_FACTS_TEMPLATE_ROW_ATTR = 'data-recued-mail-fact-template';
const FOCUS = 'data-recued-mail-facts-focus';

/** §4.5 — the kinds of email the owner made ride the same callers. */
export interface MailFactTemplateCallers extends MailFactTypeCallers {
  readonly listTemplates?: () => Promise<{ readonly templates: readonly MailTemplate[] }>;
  readonly getTemplate?: (args: { template_id: string }) => Promise<{ readonly template: MailTemplate | null }>;
  readonly createTemplate?: (args: MailTemplateCreateRequest) => Promise<{ readonly template: MailTemplate }>;
  readonly updateTemplate?: (args: MailTemplateUpdateRequest) => Promise<{ readonly template: MailTemplate }>;
  readonly deleteTemplate?: (args: { template_id: string }) => Promise<{ readonly deleted: boolean }>;
  readonly getStandards?: () => Promise<{ readonly standards: readonly MailFactStandardsSetting[] }>;
  readonly setStandards?: (args: MailFactStandardsSetting) => Promise<MailFactStandardsSetting>;
  readonly readEmail?: (args: MailFactEmailRef) => Promise<MailFactEmailContent>;
  readonly previewTemplate?: (args: MailTemplatePreviewRequest) => Promise<MailTemplatePreviewResult>;
  /** §6.1 — Draft with AI: one call, through the chat's privacy layer. */
  readonly draftTemplate?: (args: MailTemplateDraftRequest) => Promise<MailTemplateDraftResult>;
  /** §5.1 — "Then run… [recipe]": the installed recipes, and the trigger it makes. */
  readonly listRecipes?: () => Promise<{ readonly recipes: ReadonlyArray<ServerRecipeListEntry> }>;
  readonly createTrigger?: (args: {
    recipe_id: string;
    publisher_id: string;
    on: string;
    where: Record<string, string>;
  }) => Promise<unknown>;
  readonly getBackfill?: () => Promise<MailFactBackfillState>;
  readonly startBackfill?: (args: MailFactBackfillRequest) => Promise<MailFactBackfillJob>;
  readonly cancelBackfill?: (args: { job_id: string }) => Promise<MailFactBackfillJob>;
}

export interface MailFactTemplatesDeps {
  readonly callers: MailFactTemplateCallers;
  readonly actionAttr: string;
  readonly render: () => void;
  /** The editor opened or closed: the address changed. */
  readonly onAddressChange: () => void;
  /** Ask focus to land on a key after the next repaint. */
  readonly focus: (key: string) => void;
}

// ── State ───────────────────────────────────────────────────────────────────

interface Draft {
  readonly name: string;
  readonly type: string;
  readonly conditions: readonly MailTemplateCondition[];
  /** `null` ⇒ the default: the type's required variables its rules read. */
  readonly variables: readonly string[] | null;
  readonly rules: readonly MailTemplateRule[];
  readonly repeat: MailTemplateRepeat | null;
  readonly html: boolean;
  /** Kept while switched off, so switching it on again brings it back. */
  readonly ai: DraftAi;
}

interface DraftAi {
  readonly enabled: boolean;
  readonly prompt: string;
  /** Variables, and data paths as `data.<path>`. */
  readonly slots: readonly string[];
  readonly pool: MailFactPoolPolicy;
}

const AI_OFF: DraftAi = { enabled: false, prompt: '', slots: [], pool: 'free_only' };

const POOL_WORDS: Readonly<Record<MailFactPoolPolicy, string>> = {
  free_only: 'Free models only',
  free_then_byok: 'Free models first, then your own keys',
  byok_only: 'Your own keys only',
};

type Source =
  | { readonly kind: 'email'; readonly ref: MailFactEmailRef; readonly content: MailFactEmailContent | null; readonly error: string | null }
  | { readonly kind: 'sample'; readonly sample: MailTemplateSample; readonly applied: MailTemplateSample | null };

interface Editor {
  readonly template_id: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly problems: readonly string[];
  readonly saving: boolean;
  readonly draft: Draft;
  readonly source: Source;
  readonly pick: ValuePick | null;
  readonly pickTarget: { readonly variable: string; readonly data: string; readonly means: string; readonly normalize: string };
  readonly constant: { readonly variable: string; readonly value: string };
  readonly preview: {
    readonly loading: boolean;
    readonly result: MailTemplatePreviewResult | null;
    readonly error: string | null;
    /** The draft it was asked for (`snapshotOf`): changed since, what it shows
     *  — or reads now — is another template's. */
    readonly of: string | null;
  };
  /** The owner picked the kind of email (or it is a saved template's): a
   *  draft keeps it rather than proposing one. */
  readonly typeChosen: boolean;
  /** §6.1 — Draft with AI: its call, the confirm before it replaces the owner's
   *  work, and what it left out. */
  readonly drafting: {
    readonly loading: boolean;
    readonly confirm: boolean;
    readonly error: string | null;
    readonly done: boolean;
    readonly dropped: readonly string[];
    /** A draft that came after the owner changed the template while it was
     *  made: nothing is replaced until the owner says so. */
    readonly late: MailTemplateDraftResult | null;
  };
  /** A data field the owner is adding to the AI's slots, and why it was not. */
  readonly aiData: string;
  readonly aiDataError: string | null;
  /** Which editor this is. An answer to a call an earlier editor made — a
   *  draft, a preview, a save — does nothing to this one. */
  readonly session: number;
  /** What the editor held when it opened, or when its template or email
   *  loaded: anything else is an unsaved change. */
  readonly baseline: string;
  /** The template the address named no longer exists: only that is shown. */
  readonly missing: boolean;
  /** The disclosures, kept open or shut across repaints. */
  readonly advancedOpen: boolean;
  readonly droppedOpen: boolean;
  /** A new kind of email the owner picked whose rules would not all carry
   *  over: which kind, and how many rules it would leave out. */
  readonly pendingType: { readonly type: string; readonly dropped: number } | null;
  /** Leaving with unsaved changes asks first: to the list, or to another email. */
  readonly leaving: { readonly then: 'list' } | { readonly then: 'email'; readonly email: MailFactEmailRef } | null;
  /** A save landed while the owner went on editing: what it sent is saved,
   *  and the changes since are not. */
  readonly saved: boolean;
}

interface List {
  readonly templates: readonly MailTemplate[];
  readonly standards: readonly MailFactStandardsSetting[];
  readonly loaded: boolean;
  readonly error: string | null;
  readonly confirmDelete: string | null;
  readonly busy: string | null;
  readonly rowError: { readonly id: string; readonly message: string } | null;
  /** §6.3 — the running or last backfill, and how far back mail is kept. */
  readonly backfill: MailFactBackfillState | null;
  /** The "Read past mail" form, open on one template. */
  readonly backfillForm: { readonly template_id: string; readonly days: number; readonly run_recipes: boolean } | null;
  /** §4.5 — the kinds of email the owner made, and one being deleted. */
  readonly types: readonly MailFactTypeSpec[];
  readonly typeDelete: string | null;
  readonly typeError: { readonly id: string; readonly message: string } | null;
  /** §5.1 — "Then run…", open on one template. */
  readonly thenRun: {
    readonly template_id: string;
    readonly recipes: ReadonlyArray<ServerRecipeListEntry> | null;
    /** `publisher/recipe_id`, or '' while none is chosen. */
    readonly choice: string;
    readonly saving: boolean;
    readonly error: string | null;
    readonly done: string | null;
  } | null;
}

/** The "A new kind of email…" choice in the Kind of email picker. */
const NEW_TYPE = '__new__';

/** The periods offered, cut at how far back mail is kept. */
const BACKFILL_PERIODS = [7, 30, 90, 180, 365] as const;

const EMPTY_SAMPLE: MailTemplateSample = { from: '', subject: '', body: '' };

/** `Name <address>`, or a bare address, as pasted. */
const sampleSender = (from: string): { readonly name: string; readonly address: string } => {
  const angled = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(from);
  return angled !== null
    ? { name: angled[1]!.replace(/^"|"$/g, '').trim(), address: angled[2]!.trim().toLowerCase() }
    : { name: '', address: from.trim().toLowerCase() };
};

const blankDraft = (type = 'shipment'): Draft => ({
  name: '',
  type,
  conditions: [],
  variables: null,
  rules: [],
  repeat: null,
  html: false,
  ai: AI_OFF,
});

const draftOf = (template: MailTemplate): Draft => ({
  name: template.name,
  type: template.type,
  conditions: template.entrance.conditions,
  variables: template.entrance.variables,
  rules: template.rules,
  repeat: template.repeat ?? null,
  html: template.html,
  ai: template.ai.enabled
    ? { enabled: true, prompt: template.ai.prompt, slots: template.ai.slots, pool: template.ai.pool }
    : AI_OFF,
});

/** Draft with AI, before it is asked for. */
const DRAFT_IDLE = { loading: false, confirm: false, error: null, done: false, dropped: [] as readonly string[], late: null };

/** JSON with every object's keys in order: two equal drafts compare equal. */
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : item);

/** What an editor holds that the owner could lose: the draft, and a pasted
 *  email's text. */
const snapshotOf = (draft: Draft, source: Source): string =>
  stable({ draft, sample: source.kind === 'sample' ? source.sample : null });

/** The enum values a rule writes, when it writes fixed ones. */
const ruleEnumValues = (rule: MailTemplateRule): readonly string[] =>
  rule.find.kind === 'keyword_map'
    ? rule.find.cases.map((entry) => entry.value)
    : rule.find.kind === 'constant' ? [rule.find.value] : [];

/** Whether a rule still reads something the other kind of email has: a data
 *  rule always does; a variable rule when the kind has that variable, of the
 *  same kind, and every fixed value it writes is one of its values. */
const ruleFits = (rule: MailTemplateRule, from: MailFactTypeSpec | undefined, to: MailFactTypeSpec | undefined): boolean => {
  if (!('variable' in rule.target)) return true;
  const name = rule.target.variable;
  const before = from === undefined ? undefined : mailFactTypeVariables(from).find((variable) => variable.name === name);
  const after = to === undefined ? undefined : mailFactTypeVariables(to).find((variable) => variable.name === name);
  if (after === undefined || (before !== undefined && before.kind !== after.kind)) return false;
  return after.kind !== 'enum' || ruleEnumValues(rule).every((value) => (after.values ?? []).includes(value));
};

const senderOf = (source: Source): string =>
  source.kind === 'email'
    ? source.content?.email.from ?? ''
    : source.applied !== null ? sampleSender(source.applied.from).address : '';

/** The draft's readings, over the kinds of email this server knows — the
 *  built-in ones and the owner's (§4.5). */
const draftHelpers = (specOf: (type: string) => MailFactTypeSpec | undefined) => {
  const effectiveVariables = (draft: Draft): readonly string[] => {
    if (draft.variables === null) {
      const spec = specOf(draft.type);
      return spec === undefined ? [] : defaultEntranceVariables(spec, draft.rules);
    }
    // Only what a rule reads from the email: removing a variable's last rule
    // takes it out of the entrance too, or the template could not be saved
    // (its entrance would ask for a value nothing reads). Added back, it returns.
    const read = new Set(draft.rules
      .filter((rule) => rule.find.kind !== 'constant' && 'variable' in rule.target)
      .map((rule) => ('variable' in rule.target ? rule.target.variable : '')));
    return draft.variables.filter((name) => read.has(name));
  };

  /** §4.1 — an AI-on template's entrance must be narrower than the sender's
   *  domain; the same rule the server checks on save. */
  const narrowerThanDomain = (draft: Draft): boolean =>
    mailTemplateNarrowsPastDomain({
      entrance: { conditions: draft.conditions, variables: effectiveVariables(draft) },
      rules: draft.rules,
    });

  const definitionOf = (draft: Draft, source: Source): MailTemplateDefinition => {
    const spec = specOf(draft.type);
    const sender = senderOf(source);
    const name = draft.name.trim().length > 0
      ? draft.name.trim()
      : `${spec?.name ?? humanizeName(draft.type)}${sender.length > 0 ? ` from ${sender}` : ''}`;
    return {
      name,
      type: draft.type as MailTemplateDefinition['type'],
      entrance: { conditions: draft.conditions, variables: [...effectiveVariables(draft)] },
      rules: draft.rules,
      ...(draft.repeat !== null && draft.repeat.split.trim().length > 0 ? { repeat: draft.repeat } : {}),
      html: draft.html,
      ai: draft.ai.enabled
        ? {
            enabled: true,
            prompt: draft.ai.prompt,
            // The entrance is the rules' alone (ruling 37).
            slots: draft.ai.slots.filter((slot) => !effectiveVariables(draft).includes(slot)),
            pool: draft.ai.pool,
          }
        : { enabled: false },
    };
  };
  return { effectiveVariables, narrowerThanDomain, definitionOf };
};

const problemsOf = (error: unknown): string[] => {
  const problems = (error as { details?: { problems?: unknown } } | null)?.details?.problems;
  return Array.isArray(problems) ? problems.filter((p): p is string => typeof p === 'string') : [];
};

// ── Rendering helpers ───────────────────────────────────────────────────────

const valueText = (value: MailFactValue | null | undefined): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return `${value.amount} ${value.currency}`;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
};

const dateOnly = (ms: number | undefined): string => {
  if (ms === undefined) return '';
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
};

const option = (value: string, label: string, selected: boolean): string =>
  `<option value="${e(value)}"${selected ? ' selected' : ''}>${e(label)}</option>`;

const FIELD_WORDS: Readonly<Record<MailTemplateConditionField, string>> = {
  from: 'From',
  subject: 'Subject',
  body: 'Text',
  label: 'Folder or label',
  relationship: 'Sender is',
  attachment: 'Attachment',
};

const OP_WORDS: Readonly<Record<MailTemplateConditionOp, string>> = {
  is: 'is',
  domain_is: 'domain is',
  contains: 'contains',
  matches: 'matches the pattern',
  type_is: 'type is',
  name_matches: 'name matches',
};

/** When a template used to read and now misses (§6.2). */
export const templateBroken = (template: MailTemplate): boolean => {
  const { health } = template;
  return health.entered > 0
    && health.last_not_entered_at !== undefined
    && (health.last_entered_at === undefined || health.last_not_entered_at > health.last_entered_at);
};

const STANDARDS_WORDS: Readonly<Record<string, string>> = {
  shipment: 'Parcels',
  purchase: 'Orders',
  bill: 'Bills',
  reservation: 'Bookings',
  owner_request: 'Requests you mail to your own +tag address',
};

// ── The controller ──────────────────────────────────────────────────────────

export interface MailFactTemplates {
  render(): string;
  refresh(silent?: boolean): Promise<void>;
  handleAction(action: string, target: HTMLElement): boolean;
  handleChange(target: HTMLElement): boolean;
  handleInput(target: HTMLElement): boolean;
  /** `[]` for the list; `[template_id]` or `['new']` for the editor. */
  addressSegments(): string[];
  openAddress(segments: readonly string[]): void;
  /** "Make a template from this email" (§6). A draft with unsaved changes
   *  asks before it is replaced. */
  openFromEmail(email: MailFactEmailRef): Promise<void>;
  isBusy(): boolean;
  /** A template or a kind of email being edited has changes not saved. */
  hasUnsavedChanges(): boolean;
  /** A save, a switch or a start is under way. */
  hasInFlightWork(): boolean;
  dispose(): void;
}

export const createMailFactTemplates = (deps: MailFactTemplatesDeps): MailFactTemplates => {
  const { callers, actionAttr } = deps;
  let list: List = {
    templates: [], standards: [], loaded: false, error: null, confirmDelete: null, busy: null, rowError: null,
    backfill: null, backfillForm: null, thenRun: null, types: [], typeDelete: null, typeError: null,
  };
  /** The kinds of email this server knows: the built-in ones and the owner's (§4.5). */
  const specOf = (type: string): MailFactTypeSpec | undefined =>
    getMailFactBuiltinType(type) ?? list.types.find((candidate) => candidate.id === type);
  const { effectiveVariables, narrowerThanDomain, definitionOf } = draftHelpers(specOf);
  /** Where the type editor returns to: the template being edited, or the list. */
  let typeReturn: 'template' | 'list' = 'list';
  let editor: Editor | null = null;
  /** The values the last repaint made clickable, by index. */
  let picks: ValuePick[] = [];
  let seq = 0;
  /** Editors opened so far: each is a session its calls must still be in. */
  let sessions = 0;
  /** Previews asked for: only the newest one's answer is shown. */
  let previewSeq = 0;
  /** A "Read past mail" start or a "Then run…" trigger under way. */
  let listCalls = 0;
  let disposed = false;
  /** A template the address named, loaded on the first refresh: hydrating the
   *  address happens while the route is still being built. */
  let pendingOpen: string | null = null;

  const newEditor = (template_id: string | null, draft: Draft, source: Source): Editor => ({
    template_id,
    loading: false,
    error: null,
    problems: [],
    saving: false,
    draft,
    source,
    pick: null,
    pickTarget: { variable: '', data: '', means: '', normalize: '' },
    constant: { variable: '', value: '' },
    preview: { loading: false, result: null, error: null, of: null },
    typeChosen: template_id !== null,
    drafting: { loading: false, confirm: false, error: null, done: false, dropped: [], late: null },
    aiData: '',
    aiDataError: null,
    session: ++sessions,
    baseline: snapshotOf(draft, source),
    missing: false,
    advancedOpen: false,
    droppedOpen: false,
    pendingType: null,
    leaving: null,
    saved: false,
  });

  /** Changed since it opened, or since its template or email loaded. */
  const unsaved = (ed: Editor): boolean =>
    !ed.loading && !ed.missing && snapshotOf(ed.draft, ed.source) !== ed.baseline;

  /** The editor as it now stands is what an unsaved change is measured from. */
  const settled = (ed: Editor): Editor => ({ ...ed, baseline: snapshotOf(ed.draft, ed.source) });

  /** The editor a call was made for is still the one open. */
  const stillOpen = (session: number): boolean => !disposed && editor !== null && editor.session === session;

  /** Rules and AI slots carried over to another kind of email. */
  const carriedTo = (draft: Draft, type: string): Pick<Draft, 'rules' | 'ai'> & { readonly dropped: number } => {
    const from = specOf(draft.type);
    const to = specOf(type);
    const rules = draft.rules.filter((rule) => ruleFits(rule, from, to));
    const names = new Set(to === undefined ? [] : mailFactTypeVariables(to).map((variable) => variable.name));
    return {
      rules,
      ai: { ...draft.ai, slots: draft.ai.slots.filter((slot) => slot.startsWith('data.') || names.has(slot)) },
      dropped: draft.rules.length - rules.length,
    };
  };

  /** The template takes another kind of email: the rules that fit it stay. */
  const switchType = (type: string): void => {
    if (editor === null) return;
    const carried = carriedTo(editor.draft, type);
    setDraft({ type, rules: carried.rules, variables: null, ai: carried.ai });
    setEditor({ pick: null, typeChosen: true, pendingType: null });
  };

  const setEditor = (next: Partial<Editor>): void => {
    if (editor !== null) editor = { ...editor, ...next };
  };

  const setDraft = (next: Partial<Draft>): void => {
    if (editor !== null) editor = { ...editor, draft: { ...editor.draft, ...next }, problems: [] };
  };

  const loadList = async (silent: boolean): Promise<void> => {
    const mine = ++seq;
    if (!silent) {
      list = { ...list, error: null };
      deps.render();
    }
    try {
      const [templates, standards, backfill, types] = await Promise.all([
        callers.listTemplates?.().then((r) => r.templates) ?? Promise.resolve([]),
        callers.getStandards?.().then((r) => r.standards) ?? Promise.resolve([]),
        callers.getBackfill?.().catch(() => list.backfill) ?? Promise.resolve(null),
        callers.listTypes?.().then((r) => r.types).catch(() => list.types) ?? Promise.resolve(list.types),
      ]);
      if (disposed || mine !== seq) return;
      list = { ...list, templates, standards, backfill, types, loaded: true, error: null };
      typesLoaded = callers.listTypes !== undefined;
    } catch (error) {
      if (disposed || mine !== seq) return;
      list = { ...list, loaded: true, error: humanizeRpcError(error) };
    }
    deps.render();
  };

  /** The owner's kinds of email, once: the editor may open before the list. */
  let typesLoaded = false;
  const ensureTypes = async (): Promise<void> => {
    if (typesLoaded || callers.listTypes === undefined) return;
    try {
      const { types } = await callers.listTypes();
      if (disposed) return;
      list = { ...list, types };
      typesLoaded = true;
    } catch {
      // The picker offers the built-in kinds; the list's refresh tries again.
    }
  };

  /** §4.5 — making or growing a kind of email, from the picker or the list. */
  const typeEditor = createMailFactTypeEditor({
    callers,
    actionAttr,
    fieldAttr: MAIL_FACTS_FIELD_ATTR,
    focusAttr: FOCUS,
    render: deps.render,
    focus: deps.focus,
    onSaved: (type, current) => {
      const others = list.types.filter((candidate) => candidate.id !== type.id);
      list = { ...list, types: [...others, type].sort((a, b) => a.name.localeCompare(b.name)) };
      // Saved after the form was left, or while the owner went on editing it
      // (its form stays open): the kind exists now, and nothing else moves.
      if (!current || typeEditor.isOpen()) {
        deps.render();
        return;
      }
      if (typeReturn === 'template' && editor !== null) {
        // The new kind becomes the template's; the rules that fit it stay —
        // and when some would be left out, the owner says so first.
        const { dropped } = carriedTo(editor.draft, type.id);
        if (dropped > 0) {
          setEditor({ pendingType: { type: type.id, dropped } });
          deps.focus('ed:type-confirm');
        } else {
          switchType(type.id);
          deps.focus('ed:type');
        }
      } else {
        deps.focus(`tpl:type-edit:${type.id}`);
      }
      deps.render();
    },
    onCancelled: () => {
      deps.focus(typeReturn === 'template' ? 'ed:type' : 'tpl:type-new');
      deps.render();
    },
  });

  const deleteType = async (type_id: string): Promise<void> => {
    if (callers.deleteType === undefined) return;
    list = { ...list, busy: type_id };
    deps.render();
    try {
      await callers.deleteType({ type_id });
      if (disposed) return;
      list = { ...list, busy: null, typeDelete: null, types: list.types.filter((type) => type.id !== type_id) };
      deps.focus('tpl:type-new');
    } catch (error) {
      if (disposed) return;
      list = { ...list, busy: null, typeDelete: null, typeError: { id: type_id, message: humanizeRpcError(error) } };
      deps.focus(`tpl:type-delete:${type_id}`);
    }
    deps.render();
  };

  const openEditor = async (template_id: string, fromAddress = false): Promise<void> => {
    editor = { ...newEditor(template_id, blankDraft(), { kind: 'sample', sample: EMPTY_SAMPLE, applied: null }), loading: true };
    const { session } = editor;
    if (!fromAddress) deps.onAddressChange();
    deps.render();
    try {
      const [found] = await Promise.all([
        callers.getTemplate?.({ template_id }).then((r) => r.template) ?? Promise.resolve(null),
        ensureTypes(),
      ]);
      if (!stillOpen(session)) return;
      editor = found === null
        ? { ...editor!, loading: false, missing: true, error: 'This template no longer exists.' }
        : settled({ ...editor!, loading: false, draft: draftOf(found) });
    } catch (error) {
      if (!stillOpen(session)) return;
      editor = { ...editor!, loading: false, error: humanizeRpcError(error) };
    }
    deps.render();
  };

  const openFromEmail = async (ref: MailFactEmailRef, discard = false): Promise<void> => {
    // A draft with changes is not dropped for another email without asking.
    if (!discard && editor !== null && unsaved(editor)) {
      setEditor({ leaving: { then: 'email', email: ref } });
      deps.focus('ed:leave-keep');
      deps.render();
      return;
    }
    editor = newEditor(null, blankDraft(), { kind: 'email', ref, content: null, error: null });
    const { session, draft: opened } = editor;
    deps.onAddressChange();
    deps.render();
    try {
      const [content] = await Promise.all([callers.readEmail!(ref), ensureTypes()]);
      if (!stillOpen(session)) return;
      const source: Source = { kind: 'email', ref, content, error: null };
      // The email as it opens untouched: its sender the first condition. What
      // the owner did while it loaded stays theirs, and unsaved — the sender
      // is suggested only where they wrote no condition of their own.
      const untouched: Draft = { ...opened, conditions: suggestConditions(content.email.from) };
      const edited = snapshotOf(editor!.draft, editor!.source) !== editor!.baseline;
      const draft = !edited
        ? untouched
        : editor!.draft.conditions.length === 0 ? { ...editor!.draft, conditions: untouched.conditions } : editor!.draft;
      editor = { ...editor!, source, draft, baseline: snapshotOf(untouched, source) };
    } catch (error) {
      if (!stillOpen(session)) return;
      editor = { ...editor!, source: { kind: 'email', ref, content: null, error: humanizeRpcError(error) } };
    }
    deps.render();
  };

  /** Back to the list; with unsaved changes, only once the owner says so. */
  const closeEditor = (discard: boolean): void => {
    if (editor === null) return;
    if (!discard && unsaved(editor)) {
      setEditor({ leaving: { then: 'list' } });
      deps.focus('ed:leave-keep');
      deps.render();
      return;
    }
    editor = null;
    picks = [];
    deps.onAddressChange();
    deps.focus('tpl:new');
    void loadList(true);
    deps.render();
  };

  /** §6.1 — Draft with AI: the draft replaces what the template reads and from
   *  which emails; the AI section stays as the owner set it; Preview runs next. */
  const runDraft = async (): Promise<void> => {
    if (editor === null || callers.draftTemplate === undefined) return;
    const { source } = editor;
    const from: MailTemplateDraftRequest['source'] | null = source.kind === 'email'
      ? { email: source.ref }
      : source.applied !== null ? { sample: source.applied } : null;
    if (from === null) return;
    const { session } = editor;
    // What the editor held when the draft was asked for: a change made while
    // it is drafted is the owner's, and a draft that lands after one replaces
    // nothing until the owner says so.
    const asked = snapshotOf(editor.draft, editor.source);
    setEditor({ drafting: { ...DRAFT_IDLE, loading: true }, problems: [] });
    deps.focus('ed:draft');
    deps.render();
    try {
      const result = await callers.draftTemplate({ source: from, ...(editor.typeChosen ? { type: editor.draft.type } : {}) });
      // Drafted for an editor the owner has left: this one is not its.
      if (!stillOpen(session)) return;
      if (snapshotOf(editor!.draft, editor!.source) !== asked) {
        setEditor({ drafting: { ...DRAFT_IDLE, late: result } });
        deps.focus('ed:draft-late-keep');
        deps.render();
        return;
      }
      applyDraft(result);
    } catch (error) {
      if (!stillOpen(session)) return;
      setEditor({ drafting: { ...DRAFT_IDLE, error: humanizeRpcError(error) } });
      deps.render();
    }
  };

  /** A draft taken into the editor: what the template reads and from which
   *  emails, its name kept when the owner gave one. */
  const applyDraft = (result: MailTemplateDraftResult): void => {
    if (editor === null) return;
    {
      const drafted = result.definition;
      const keep = editor.draft;
      // A slot for a variable the drafted kind of email does not have goes.
      const draftedSpec = specOf(drafted.type);
      const names = new Set(draftedSpec === undefined ? [] : mailFactTypeVariables(draftedSpec).map((variable) => variable.name));
      const slots = keep.ai.slots.filter((slot) => slot.startsWith('data.') || names.has(slot));
      setDraft({
        name: keep.name.trim().length > 0 ? keep.name : drafted.name,
        type: drafted.type,
        conditions: drafted.entrance.conditions,
        variables: drafted.entrance.variables,
        rules: drafted.rules,
        repeat: null,
        html: drafted.html,
        ai: { ...keep.ai, slots },
      });
      setEditor({ drafting: { ...DRAFT_IDLE, done: true, dropped: result.dropped }, pick: null });
      deps.render();
      void runPreview();
    }
  };

  /** The newest preview's answer wins: one asked for later (a Draft runs
   *  one) replaces one still under way, whose answer is then dropped. */
  const runPreview = async (): Promise<void> => {
    if (editor === null || callers.previewTemplate === undefined) return;
    const { draft, source, session } = editor;
    const mine = ++previewSeq;
    const asked = snapshotOf(draft, source);
    const request: MailTemplatePreviewRequest = {
      definition: definitionOf(draft, source),
      ...(source.kind === 'email'
        ? { source: { email: source.ref } }
        : source.applied !== null ? { source: { sample: source.applied } } : {}),
    };
    setEditor({ preview: { loading: true, result: null, error: null, of: asked }, problems: [] });
    deps.focus('ed:preview');
    deps.render();
    try {
      const result = await callers.previewTemplate(request);
      if (!stillOpen(session) || mine !== previewSeq) return;
      setEditor({ preview: { loading: false, result, error: null, of: asked } });
    } catch (error) {
      if (!stillOpen(session) || mine !== previewSeq) return;
      // The problems it names are the asked template's: shown only while the
      // draft is still that one.
      setEditor({
        preview: { loading: false, result: null, error: humanizeRpcError(error), of: asked },
        ...(snapshotOf(editor!.draft, editor!.source) === asked ? { problems: problemsOf(error) } : {}),
      });
    }
    deps.render();
  };

  /** What the preview shows, or reads now, is this draft's: one asked for
   *  before the owner changed the template read another template. */
  const previewCurrent = (ed: Editor): boolean =>
    ed.preview.of === null || ed.preview.of === snapshotOf(ed.draft, ed.source);

  const save = async (): Promise<void> => {
    if (editor === null || editor.saving || editor.missing) return;
    const definition = definitionOf(editor.draft, editor.source);
    const { session, template_id } = editor;
    // What this save sends: the fields stay editable while it runs.
    const sent = snapshotOf(editor.draft, editor.source);
    setEditor({ saving: true, error: null, problems: [], saved: false });
    deps.render();
    try {
      const result = template_id === null
        ? await callers.createTemplate!({ definition })
        : await callers.updateTemplate!({ template_id, definition });
      if (disposed) return;
      // Saved: its editor closes — unless the owner has since opened another,
      // which stays as it is, or went on editing this one: then it stays open
      // on the template it saved, and what changed since is not saved yet. A
      // new template's next save updates it rather than making a second one.
      if (stillOpen(session)) {
        if (snapshotOf(editor!.draft, editor!.source) === sent) {
          editor = null;
          picks = [];
          deps.onAddressChange();
          deps.focus('tpl:new');
        } else if (result.template.type === editor!.draft.type) {
          editor = { ...editor!, template_id: result.template.template_id, typeChosen: true, saving: false, baseline: sent, saved: true };
          if (template_id === null) deps.onAddressChange();
          deps.render();
        } else {
          // Its kind changed while it saved (a draft taken, a kind made): a
          // template keeps its kind, so what was saved is a template of its
          // own, and this one, of the other kind, is new and not saved yet.
          editor = { ...editor!, saving: false, saved: true };
          deps.render();
        }
      }
      await loadList(true);
    } catch (error) {
      if (!stillOpen(session)) return;
      setEditor({ saving: false, error: humanizeRpcError(error), problems: problemsOf(error) });
      deps.focus('ed:save');
      deps.render();
    }
  };

  const toggleTemplate = async (template_id: string): Promise<void> => {
    const template = list.templates.find((t) => t.template_id === template_id);
    if (template === undefined) return;
    if (list.busy !== null) {
      // The box already flipped under the click; nothing was sent, so draw it
      // as it is.
      deps.focus(`tpl:toggle:${template_id}`);
      deps.render();
      return;
    }
    list = { ...list, busy: template_id, rowError: null };
    deps.focus(`tpl:toggle:${template_id}`);
    deps.render();
    try {
      await callers.updateTemplate!({ template_id, active: !template.active });
      if (disposed) return;
      list = { ...list, busy: null };
      await loadList(true);
    } catch (error) {
      if (disposed) return;
      list = { ...list, busy: null, rowError: { id: template_id, message: humanizeRpcError(error) } };
      deps.render();
    }
  };

  const deleteTemplate = async (template_id: string): Promise<void> => {
    list = { ...list, busy: template_id, rowError: null };
    deps.render();
    try {
      await callers.deleteTemplate!({ template_id });
      if (disposed) return;
      list = { ...list, busy: null, confirmDelete: null };
      deps.focus('tpl:new');
      await loadList(true);
    } catch (error) {
      if (disposed) return;
      list = { ...list, busy: null, rowError: { id: template_id, message: humanizeRpcError(error) } };
      deps.render();
    }
  };

  const startBackfill = async (template_id: string): Promise<void> => {
    const form = list.backfillForm;
    if (form === null || form.template_id !== template_id || callers.startBackfill === undefined) return;
    list = { ...list, rowError: null };
    listCalls += 1;
    try {
      const job = await callers.startBackfill({ template_id, days: form.days, run_recipes: form.run_recipes });
      if (disposed) return;
      // Its form closes; another template's, opened meanwhile, stays.
      list = {
        ...list,
        backfillForm: list.backfillForm?.template_id === template_id ? null : list.backfillForm,
        backfill: { job, max_days: list.backfill?.max_days ?? 365 },
      };
      if (list.backfillForm === null) deps.focus(`bf:stop:${template_id}`);
    } catch (error) {
      if (disposed) return;
      list = { ...list, rowError: { id: template_id, message: humanizeRpcError(error) } };
    } finally {
      listCalls -= 1;
    }
    deps.render();
  };

  const openThenRun = async (template_id: string): Promise<void> => {
    list = { ...list, thenRun: { template_id, recipes: null, choice: '', saving: false, error: null, done: null } };
    deps.render();
    try {
      const recipes = (await callers.listRecipes!()).recipes;
      if (disposed || list.thenRun?.template_id !== template_id) return;
      list = { ...list, thenRun: { ...list.thenRun, recipes } };
      deps.focus('tr:recipe');
    } catch (error) {
      if (disposed || list.thenRun?.template_id !== template_id) return;
      list = { ...list, thenRun: { ...list.thenRun, recipes: [], error: humanizeRpcError(error) } };
    }
    deps.render();
  };

  const createThenRun = async (template_id: string): Promise<void> => {
    const form = list.thenRun;
    const template = list.templates.find((t) => t.template_id === template_id);
    if (form === null || template === undefined || form.saving) return;
    const entry = form.recipes?.find((candidate) => recipeKey(candidate) === form.choice);
    if (entry === undefined) {
      list = { ...list, thenRun: { ...form, error: 'Choose a recipe to run.' } };
      deps.focus('tr:recipe');
      deps.render();
      return;
    }
    list = { ...list, thenRun: { ...form, saving: true, error: null } };
    deps.render();
    listCalls += 1;
    // Its own form: one opened on another template meanwhile is not its.
    const ownForm = (): boolean => !disposed && list.thenRun !== null && list.thenRun.template_id === template_id;
    try {
      await callers.createTrigger!({
        recipe_id: entry.recipe_id,
        publisher_id: entry.publisher_id,
        // On the template's kind (ruling 43), so the check is exact.
        on: mailFactOn(template.type),
        where: { template: template.template_id },
      });
      if (!ownForm()) return;
      const name = entry.recipe.metadata?.name ?? entry.recipe_id;
      list = { ...list, thenRun: { ...list.thenRun!, saving: false, done: `“${name}” now runs for what “${template.name}” reads. It is listed in Automation.` } };
      deps.focus(`tr:open:${template_id}`);
    } catch (error) {
      if (!ownForm()) return;
      list = { ...list, thenRun: { ...list.thenRun!, saving: false, error: humanizeRpcError(error) } };
    } finally {
      listCalls -= 1;
    }
    deps.render();
  };

  const stopBackfill = async (job_id: string): Promise<void> => {
    if (callers.cancelBackfill === undefined) return;
    try {
      const job = await callers.cancelBackfill({ job_id });
      if (disposed) return;
      list = { ...list, backfill: { job, max_days: list.backfill?.max_days ?? 365 } };
    } catch (error) {
      if (disposed) return;
      list = { ...list, error: humanizeRpcError(error) };
    }
    deps.render();
  };

  const toggleStandards = async (type: string): Promise<void> => {
    const current = list.standards.find((s) => s.type === type);
    if (current === undefined) return;
    if (list.busy !== null) {
      // As above: nothing was sent, so the box goes back to what it is.
      deps.focus(`std:${type}`);
      deps.render();
      return;
    }
    list = { ...list, busy: `std:${type}` };
    deps.render();
    try {
      await callers.setStandards!({ type: current.type, on: !current.on });
      if (disposed) return;
      list = { ...list, busy: null };
      await loadList(true);
    } catch (error) {
      if (disposed) return;
      list = { ...list, busy: null, error: humanizeRpcError(error) };
      deps.render();
    }
  };

  // ── Render: the list ───────────────────────────────────────────────────────

  const renderStandards = (): string => {
    if (list.standards.length === 0) return '';
    return `
      <section class="mail-facts-standards" aria-labelledby="mail-facts-standards-title">
        <h3 class="mail-facts-subheading" id="mail-facts-standards-title">Read without a template</h3>
        <p class="mail-facts-subtle">Shops, carriers and booking sites often mark their mail up in a standard way. Recued reads it with no template of yours; a template of yours comes first.</p>
        <div class="mail-facts-switches">
          ${MAIL_FACT_STANDARDS_TYPES.map((type) => {
            const setting = list.standards.find((s) => s.type === type);
            if (setting === undefined) return '';
            return `
              <label class="mail-facts-switch">
                <input type="checkbox" ${actionAttr}="mail-facts-std-toggle" data-type="${e(type)}"
                  ${FOCUS}="std:${e(type)}"${setting.on ? ' checked' : ''}${list.busy === `std:${type}` ? ' aria-busy="true"' : ''}${list.busy !== null ? ' aria-disabled="true"' : ''}>
                <span>${e(STANDARDS_WORDS[type] ?? humanizeName(type))}</span>
              </label>`;
          }).join('')}
        </div>
      </section>`;
  };

  const renderHealth = (template: MailTemplate): string => {
    const { health } = template;
    const counts = health.matched === 0
      ? 'No email has met its conditions yet.'
      : `Met its conditions ${health.matched} ${health.matched === 1 ? 'time' : 'times'} · read ${health.entered} · missed ${health.not_entered}`;
    const broken = templateBroken(template)
      ? `<p class="mail-facts-broken" role="status">It stopped reading: the latest email that met its conditions${health.last_not_entered_at !== undefined ? ` (${e(dateOnly(health.last_not_entered_at))})` : ''} did not have the values it needs. The sender may have changed its email.</p>`
      : '';
    const warning = health.last_warning !== undefined
      ? `<p class="mail-facts-subtle">Last warning: ${e(health.last_warning)}</p>`
      : '';
    return `<p class="mail-facts-subtle">${e(counts)}</p>${broken}${warning}`;
  };

  const renderBackfill = (template: MailTemplate): string => {
    if (callers.startBackfill === undefined) return '';
    const job = list.backfill?.job ?? null;
    const mine = job !== null && job.template_id === template.template_id;
    const running = job !== null && job.status === 'running';
    const form = list.backfillForm?.template_id === template.template_id ? list.backfillForm : null;
    if (mine && running) {
      return `
        <div class="mail-facts-backfill" role="status">
          <span>Reading past mail: ${job.read} of ${job.total} ${job.total === 1 ? 'email' : 'emails'} · ${job.facts} ${job.facts === 1 ? 'fact' : 'facts'}</span>
          ${callers.cancelBackfill !== undefined
            ? `<button type="button" class="data-button" ${actionAttr}="mail-facts-bf-stop" data-job-id="${e(job.job_id)}"
                ${FOCUS}="bf:stop:${e(template.template_id)}">Stop</button>`
            : ''}
        </div>`;
    }
    if (form !== null) {
      const max = list.backfill?.max_days ?? 365;
      const periods = [...new Set([...BACKFILL_PERIODS.filter((days) => days <= max), max])].sort((a, b) => a - b);
      return `
        <div class="mail-facts-backfill" role="group" aria-label="Read past mail with ${e(template.name)}">
          <label>Read the mail of the last <select ${MAIL_FACTS_FIELD_ATTR}="bf:days" ${FOCUS}="bf:days">
            ${periods.map((days) => option(String(days), `${days} days`, days === form.days)).join('')}
          </select></label>
          <label><input type="checkbox" ${MAIL_FACTS_FIELD_ATTR}="bf:run" ${FOCUS}="bf:run"${form.run_recipes ? ' checked' : ''}>
            Also run the recipes these facts trigger</label>
          <p class="mail-facts-subtle">Recued keeps your mail for up to ${max} days, and a mailbox holds only the 30 days before it was added. Past mail stores facts and starts nothing unless you tick the box; runs it starts are marked as runs on past mail.</p>
          <div class="mail-facts-template-actions">
            <button type="button" class="data-button" ${actionAttr}="mail-facts-bf-start" data-template-id="${e(template.template_id)}"
              ${FOCUS}="bf:start:${e(template.template_id)}"${running ? ' aria-disabled="true"' : ''}>Start</button>
            <button type="button" class="data-button" ${actionAttr}="mail-facts-bf-close" data-template-id="${e(template.template_id)}"
              ${FOCUS}="bf:close:${e(template.template_id)}">Cancel</button>
          </div>
          ${running ? '<p class="mail-facts-subtle">Another template is reading past mail; start this one when it is done.</p>' : ''}
        </div>`;
    }
    const outcome = mine && job !== null && job.status !== 'running'
      ? `<p class="mail-facts-subtle" role="status">${job.status === 'failed'
          ? `Reading past mail failed: ${e(job.error ?? 'unknown error')}.`
          : `${job.status === 'cancelled' ? 'Stopped after reading' : 'Read'} ${job.read} of ${job.total} ${job.total === 1 ? 'email' : 'emails'} from the last ${job.days} days: ${job.facts} ${job.facts === 1 ? 'fact' : 'facts'}${job.events > 0 ? `, ${job.events} ${job.events === 1 ? 'change' : 'changes'} passed to your recipes` : ''}.${job.kept > 0
            ? ` ${job.kept} could not be read again from your mailbox and kept what Recued had read.` : ''}`}</p>`
      : '';
    return outcome;
  };

  const recipeKey = (entry: ServerRecipeListEntry): string => `${entry.publisher_id}/${entry.recipe_id}`;

  const renderThenRun = (template: MailTemplate): string => {
    const form = list.thenRun;
    if (form === null || form.template_id !== template.template_id) return '';
    const typeWords = (specOf(template.type)?.name ?? humanizeName(template.type)).toLowerCase();
    if (form.done !== null) {
      return `
        <div class="mail-facts-backfill" role="status">
          <span>${e(form.done)}</span>
          <button type="button" class="data-button" ${actionAttr}="mail-facts-tr-close" data-template-id="${e(template.template_id)}"
            ${FOCUS}="tr:close">Close</button>
        </div>`;
    }
    return `
      <div class="mail-facts-backfill" role="group" aria-label="Then run a recipe">
        ${form.recipes === null
          ? '<p class="mail-facts-subtle" aria-live="polite">Loading your recipes…</p>'
          : form.recipes.length === 0
            ? '<p class="mail-facts-subtle">No recipe is installed yet.</p>'
            : `<label>Then run <select ${MAIL_FACTS_FIELD_ATTR}="tr:recipe" ${FOCUS}="tr:recipe">
                ${option('', 'choose a recipe…', form.choice === '')}
                ${form.recipes.map((entry) => option(recipeKey(entry), entry.recipe.metadata?.name ?? entry.recipe_id, recipeKey(entry) === form.choice)).join('')}
              </select></label>
              <p class="mail-facts-subtle">It runs for each ${e(typeWords)} this template reads, starting with the next email. You can switch it off in Automation.</p>`}
        ${form.error !== null ? `<p class="mail-facts-error" role="alert">${e(form.error)}</p>` : ''}
        <div class="mail-facts-template-actions">
          ${form.recipes !== null && form.recipes.length > 0
            ? `<button type="button" class="data-button" ${actionAttr}="mail-facts-tr-create" data-template-id="${e(template.template_id)}"
                ${FOCUS}="tr:create"${form.saving ? ' aria-disabled="true" aria-busy="true"' : ''}>Create</button>`
            : ''}
          <button type="button" class="data-button" ${actionAttr}="mail-facts-tr-close" data-template-id="${e(template.template_id)}"
            ${FOCUS}="tr:close">Cancel</button>
        </div>
      </div>`;
  };

  const renderTemplateRow = (template: MailTemplate): string => {
    const spec = specOf(template.type);
    const origin = template.origin.kind === 'owner' ? 'Yours' : `From the recipe ${template.origin.recipe}`;
    const busy = list.busy === template.template_id;
    const confirming = list.confirmDelete === template.template_id;
    return `
      <li class="mail-facts-template" ${MAIL_FACTS_TEMPLATE_ROW_ATTR}="${e(template.template_id)}"${templateBroken(template) ? ' data-broken="true"' : ''}>
        <div class="mail-facts-template-head">
          <span class="mail-facts-template-name">${e(template.name)}</span>
          <span class="data-pill">${e(spec?.name ?? humanizeName(template.type))}</span>
          <span class="mail-facts-subtle">${e(origin)}</span>
        </div>
        ${renderHealth(template)}
        ${renderBackfill(template)}
        ${renderThenRun(template)}
        ${list.rowError?.id === template.template_id ? `<p class="mail-facts-error" role="alert">${e(list.rowError.message)}</p>` : ''}
        ${confirming
          ? `<div class="mail-facts-confirm" role="group" aria-label="Delete ${e(template.name)}">
              <span>Delete “${e(template.name)}”? The facts it already read stay; a trigger narrowed to it is switched off.</span>
              <button type="button" class="data-button" ${actionAttr}="mail-facts-tpl-delete-confirm" data-template-id="${e(template.template_id)}"
                ${FOCUS}="tpl:confirm:${e(template.template_id)}"${busy ? ' aria-disabled="true" aria-busy="true"' : ''}>Delete</button>
              <button type="button" class="data-button" ${actionAttr}="mail-facts-tpl-delete-cancel" data-template-id="${e(template.template_id)}"
                ${FOCUS}="tpl:cancel:${e(template.template_id)}">Keep</button>
            </div>`
          : `<div class="mail-facts-template-actions">
              <label class="mail-facts-switch">
                <input type="checkbox" ${actionAttr}="mail-facts-tpl-toggle" data-template-id="${e(template.template_id)}"
                  aria-label="Read new mail with “${e(template.name)}”"
                  ${FOCUS}="tpl:toggle:${e(template.template_id)}"${template.active ? ' checked' : ''}${busy ? ' aria-busy="true"' : ''}${list.busy !== null ? ' aria-disabled="true"' : ''}>
                <span aria-hidden="true">${template.active ? 'On' : 'Off'}</span>
              </label>
              <button type="button" class="data-button" ${actionAttr}="mail-facts-tpl-edit" data-template-id="${e(template.template_id)}"
                ${FOCUS}="tpl:edit:${e(template.template_id)}">Edit</button>
              ${template.active && callers.startBackfill !== undefined && list.backfillForm?.template_id !== template.template_id
                && !(list.backfill?.job?.status === 'running' && list.backfill.job.template_id === template.template_id)
                ? `<button type="button" class="data-button" ${actionAttr}="mail-facts-bf-open" data-template-id="${e(template.template_id)}"
                    ${FOCUS}="bf:open:${e(template.template_id)}">Read past mail</button>`
                : ''}
              ${callers.listRecipes !== undefined && callers.createTrigger !== undefined && list.thenRun?.template_id !== template.template_id
                ? `<button type="button" class="data-button" ${actionAttr}="mail-facts-tr-open" data-template-id="${e(template.template_id)}"
                    ${FOCUS}="tr:open:${e(template.template_id)}">Then run…</button>`
                : ''}
              <button type="button" class="data-button" ${actionAttr}="mail-facts-tpl-delete" data-template-id="${e(template.template_id)}"
                ${FOCUS}="tpl:delete:${e(template.template_id)}">Delete</button>
            </div>`}
      </li>`;
  };

  const renderList = (): string => `
    ${renderStandards()}
    <section class="mail-facts-templates" aria-labelledby="mail-facts-templates-title">
      <div class="mail-facts-row-head">
        <h3 class="mail-facts-subheading" id="mail-facts-templates-title">Your templates</h3>
        ${callers.createTemplate !== undefined
          ? `<button type="button" class="data-button" ${actionAttr}="mail-facts-tpl-new" ${FOCUS}="tpl:new">New template</button>`
          : ''}
      </div>
      ${list.error !== null ? `<p class="mail-facts-error" role="alert">${e(list.error)}</p>` : ''}
      ${!list.loaded
        ? '<p class="mail-facts-subtle" aria-live="polite">Loading templates…</p>'
        : list.templates.length === 0
          ? '<p class="mail-facts-empty">No templates yet. A template teaches Recued one kind of email: open an email in Data → Mail and choose “Make a template from this email”, or start from a pasted email with New template.</p>'
          : `<ul class="mail-facts-template-list" role="list">${list.templates.map(renderTemplateRow).join('')}</ul>`}
    </section>
    ${renderOwnerTypes()}`;

  /** §4.5 — the kinds of email the owner made, with their own edit and delete. */
  const renderOwnerTypes = (): string => {
    if (callers.listTypes === undefined) return '';
    const readers = (type: MailFactTypeSpec): number => list.templates.filter((template) => template.type === type.id).length;
    return `
      <section class="mail-facts-templates" aria-labelledby="mail-facts-types-title">
        <div class="mail-facts-row-head">
          <h3 class="mail-facts-subheading" id="mail-facts-types-title">Kinds of email you made</h3>
          ${callers.createType !== undefined
            ? `<button type="button" class="data-button" ${actionAttr}="mail-facts-tpl-type-new" ${FOCUS}="tpl:type-new">New kind of email</button>`
            : ''}
        </div>
        ${list.types.length === 0
          ? '<p class="mail-facts-subtle">None yet. When no built-in kind fits, make one: its name, the values a trigger tests, and data for the recipe.</p>'
          : `<ul class="mail-facts-template-list" role="list">${list.types.map((type) => {
              const confirming = list.typeDelete === type.id;
              const error = list.typeError?.id === type.id ? list.typeError.message : null;
              const count = readers(type);
              return `
                <li class="mail-facts-template" data-recued-mail-fact-type="${e(type.id)}">
                  <div class="mail-facts-template-head">
                    <span class="mail-facts-template-name">${e(type.name)}</span>
                    <code class="mail-facts-subtle">${e(type.id)}</code>
                  </div>
                  <p class="mail-facts-subtle">${e(type.variables.map((variable) => humanizeName(variable.name)).join(', '))}${count > 0 ? ` · read by ${count} template${count === 1 ? '' : 's'}` : ''}</p>
                  ${error !== null ? `<p class="mail-facts-error" role="alert">${e(error)}</p>` : ''}
                  <div class="mail-facts-template-actions">
                    ${confirming
                      ? `<span>Delete it, and every fact read as one? A trigger on it is switched off.</span>
                        <button type="button" class="data-button" ${actionAttr}="mail-facts-tpl-type-delete-confirm" data-type-id="${e(type.id)}" ${FOCUS}="tpl:type-confirm:${e(type.id)}">Delete</button>
                        <button type="button" class="data-button" ${actionAttr}="mail-facts-tpl-type-delete-cancel" data-type-id="${e(type.id)}" ${FOCUS}="tpl:type-cancel:${e(type.id)}">Keep it</button>`
                      : `${callers.updateType !== undefined
                          ? `<button type="button" class="data-button" ${actionAttr}="mail-facts-tpl-type-edit" data-type-id="${e(type.id)}" ${FOCUS}="tpl:type-edit:${e(type.id)}">Edit</button>`
                          : ''}
                        ${callers.deleteType !== undefined
                          ? `<button type="button" class="data-button" ${actionAttr}="mail-facts-tpl-type-delete" data-type-id="${e(type.id)}" ${FOCUS}="tpl:type-delete:${e(type.id)}">Delete</button>`
                          : ''}`}
                  </div>
                </li>`;
            }).join('')}</ul>`}
      </section>`;
  };

  // ── Render: the editor ─────────────────────────────────────────────────────

  const pickButton = (pick: ValuePick, text: string): string => {
    const index = picks.length;
    picks.push(pick);
    const chosen = editor?.pick !== null && editor?.pick?.text === pick.text && editor.pick.source === pick.source
      && editor.pick.label === pick.label && editor.pick.context === pick.context;
    return `<button type="button" class="mail-facts-value-pick" ${actionAttr}="mail-facts-ed-pick" data-pick="${index}"
      ${FOCUS}="pick:${index}" aria-pressed="${chosen ? 'true' : 'false'}">${e(text)}</button>`;
  };

  const renderTextWithPicks = (text: string, source: 'body'): string =>
    textSpans(text).map((spans) => spans.map((span) =>
      span.kind === 'text'
        ? e(span.text)
        : pickButton({ source, text: span.text, ...(span.label !== undefined ? { label: span.label } : {}), ...(span.context !== undefined ? { context: span.context } : {}) }, span.text),
    ).join('')).join('\n');

  const renderSourceEmail = (ed: Editor): string => {
    const source = ed.source;
    if (source.kind === 'sample') {
      const applied = source.applied;
      return `
        <section class="mail-facts-editor-block" aria-labelledby="mail-facts-ed-email-title">
          <h3 class="mail-facts-subheading" id="mail-facts-ed-email-title">The email</h3>
          <p class="mail-facts-subtle">Paste an email of the kind this template reads, then click its values.</p>
          <div class="mail-facts-sample">
            <label>From <input type="text" ${MAIL_FACTS_FIELD_ATTR}="ed:sample-from" ${FOCUS}="ed:sample-from" value="${e(source.sample.from)}" placeholder="UPS &lt;pkginfo@ups.com&gt;"></label>
            <label>Subject <input type="text" ${MAIL_FACTS_FIELD_ATTR}="ed:sample-subject" ${FOCUS}="ed:sample-subject" value="${e(source.sample.subject)}"></label>
            <label>Text <textarea rows="8" ${MAIL_FACTS_FIELD_ATTR}="ed:sample-body" ${FOCUS}="ed:sample-body">${e(source.sample.body)}</textarea></label>
            <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-sample-use" ${FOCUS}="ed:sample-use">${applied === null ? 'Use this email' : 'Use it again'}</button>
          </div>
          ${applied !== null ? `${renderDraft(ed)}${renderEmailBody(sampleSender(applied.from), applied.subject, applied.body, [])}` : ''}
        </section>`;
    }
    if (source.error !== null) {
      return `<section class="mail-facts-editor-block"><p class="mail-facts-error" role="alert">${e(source.error)}</p></section>`;
    }
    if (source.content === null) {
      return '<section class="mail-facts-editor-block"><p class="mail-facts-subtle" aria-live="polite">Reading the email…</p></section>';
    }
    const content = source.content;
    const sender = { name: content.from_name, address: content.email.from };
    return `
      <section class="mail-facts-editor-block" aria-labelledby="mail-facts-ed-email-title">
        <h3 class="mail-facts-subheading" id="mail-facts-ed-email-title">The email</h3>
        ${content.read === 'stored'
          ? '<p class="mail-facts-subtle">Recued could not read this email again from your mailbox, so this is the copy it keeps: its text only, without the sender’s name, the HTML or the attachments.</p>'
          : ''}
        ${content.truncated === true ? '<p class="mail-facts-subtle">This long email is shown in part; the template reads all of it.</p>' : ''}
        ${renderDraft(ed)}
        ${renderEmailBody(sender, content.email.subject, content.body_text, content.attachments)}
      </section>`;
  };

  /** §6.1 — Draft with AI, on the email the editor shows. */
  const renderDraft = (ed: Editor): string => {
    if (callers.draftTemplate === undefined) return '';
    const { drafting } = ed;
    return `
      <div class="mail-facts-draft" role="group" aria-labelledby="mail-facts-ed-draft-label" aria-busy="${drafting.loading ? 'true' : 'false'}">
        <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-draft" ${FOCUS}="ed:draft"
          id="mail-facts-ed-draft-label"${drafting.loading ? ' aria-disabled="true" aria-busy="true"' : ''}>${drafting.loading ? 'Drafting…' : 'Draft with AI'}</button>
        <span class="mail-facts-subtle">AI proposes what to read, and from which emails, from this one email. You check it with Preview before you save.</span>
        ${drafting.confirm
          ? `<p class="mail-facts-confirm" role="alert">This replaces what the template reads and which emails it reads.
              <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-draft-confirm" ${FOCUS}="ed:draft-confirm">Replace</button>
              <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-draft-cancel" ${FOCUS}="ed:draft-cancel">Keep mine</button></p>`
          : ''}
        ${drafting.late !== null
          ? `<p class="mail-facts-confirm" role="alert">The AI’s draft came after you changed the template. Using it replaces your changes.
              <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-draft-late-use" ${FOCUS}="ed:draft-late-use">Use the draft</button>
              <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-draft-late-keep" ${FOCUS}="ed:draft-late-keep">Keep mine</button></p>`
          : ''}
        ${drafting.error !== null ? `<p class="mail-facts-error" role="alert">${e(drafting.error)}</p>` : ''}
        ${drafting.done
          ? `<p class="mail-facts-subtle" role="status">Drafted by AI from this email. Check it with Preview below before you save.</p>
            ${drafting.dropped.length > 0
              ? `<details class="mail-facts-dropped"${ed.droppedOpen ? ' open' : ''}><summary ${actionAttr}="mail-facts-ed-dropped" ${FOCUS}="ed:draft-dropped">Left out (${drafting.dropped.length})</summary>
                  <ul role="list">${drafting.dropped.map((item) => `<li>${e(item)}</li>`).join('')}</ul></details>`
              : ''}`
          : ''}
      </div>`;
  };

  const renderEmailBody = (
    sender: { readonly name: string; readonly address: string },
    subject: string,
    body: string,
    attachments: readonly { readonly filename: string; readonly mime_type: string }[],
  ): string => `
    <p class="mail-facts-subtle">Click a value to say what it is.</p>
    <dl class="mail-facts-email-head">
      <div><dt>From</dt><dd>${sender.name.length > 0 ? `${pickButton({ source: 'from_name', text: sender.name }, sender.name)} ` : ''}${sender.address.length > 0 ? pickButton({ source: 'from_address', text: sender.address }, sender.address) : ''}</dd></div>
      <div><dt>Subject</dt><dd>${subject.length > 0 ? pickButton({ source: 'subject', text: subject }, subject) : ''}</dd></div>
      ${attachments.length > 0
        ? `<div><dt>Attached</dt><dd>${attachments.map((a) => pickButton({ source: 'attachment', text: a.mime_type, label: a.filename }, `${a.filename} (${a.mime_type})`)).join(' ')}</dd></div>`
        : ''}
    </dl>
    <pre class="mail-facts-email-text">${renderTextWithPicks(body, 'body')}</pre>`;

  /** §3.2 — the data fields the kind names, offered where a data path is typed. */
  const dataFieldList = (id: string, spec: MailFactTypeSpec): { readonly attr: string; readonly html: string } => {
    const fields = spec.data_fields ?? [];
    return fields.length === 0
      ? { attr: '', html: '' }
      : {
          attr: ` list="${id}"`,
          html: `<datalist id="${id}">${fields.map((field) => `<option value="${e(field.path)}">${e(field.description ?? '')}</option>`).join('')}</datalist>`,
        };
  };

  const renderPickBox = (ed: Editor, spec: MailFactTypeSpec): string => {
    const pick = ed.pick;
    if (pick === null) return '';
    const variables = editorVariables(spec).filter((variable) =>
      pick.source === 'attachment' ? variable.kind === 'file' : variable.kind !== 'file');
    const chosen = variables.find((variable) => variable.name === ed.pickTarget.variable);
    const isEnum = chosen?.kind === 'enum';
    const known = dataFieldList('mail-facts-pick-data-fields', spec);
    return `
      <div class="mail-facts-pick-box" role="group" aria-label="What this value is">
        <p>“${e(pick.source === 'attachment' ? pick.label ?? pick.text : pick.text)}” is</p>
        <label>the <select ${MAIL_FACTS_FIELD_ATTR}="ed:pick-variable" ${FOCUS}="ed:pick-variable">
          ${option('', 'choose a value…', ed.pickTarget.variable === '')}
          ${variables.map((variable) => option(variable.name, humanizeName(variable.name), variable.name === ed.pickTarget.variable)).join('')}
        </select></label>
        ${isEnum && chosen?.values !== undefined
          ? `<label>and means <select ${MAIL_FACTS_FIELD_ATTR}="ed:pick-means" ${FOCUS}="ed:pick-means">
              ${option('', 'choose…', ed.pickTarget.means === '')}
              ${chosen.values.map((value) => option(value, humanizeName(value), value === ed.pickTarget.means)).join('')}
            </select></label>`
          : ''}
        ${pick.source !== 'attachment'
          ? `<label>or data field <input type="text" ${MAIL_FACTS_FIELD_ATTR}="ed:pick-data" ${FOCUS}="ed:pick-data"
              value="${e(ed.pickTarget.data)}" placeholder="for example order.gift_note"${known.attr}></label>${known.html}`
          : ''}
        <div class="mail-facts-pick-actions">
          <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-pick-add" ${FOCUS}="ed:pick-add">Add</button>
          <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-pick-cancel" ${FOCUS}="ed:pick-cancel">Cancel</button>
        </div>
      </div>`;
  };

  const renderRules = (ed: Editor, spec: MailFactTypeSpec): string => {
    const variables = editorVariables(spec).filter((variable) => variable.kind !== 'file');
    const constantVariable = variables.find((variable) => variable.name === ed.constant.variable);
    return `
      <section class="mail-facts-editor-block" aria-labelledby="mail-facts-ed-rules-title">
        <h3 class="mail-facts-subheading" id="mail-facts-ed-rules-title" tabindex="-1" ${FOCUS}="ed:rules">What it reads</h3>
        ${ed.draft.rules.length === 0
          ? '<p class="mail-facts-subtle">Nothing yet: click a value in the email.</p>'
          : `<ul class="mail-facts-rules" role="list">${ed.draft.rules.map((rule, index) => {
              const words = describeRule(rule);
              return `<li><span class="mail-facts-rule-target">${e(words.target)}</span>
                <span class="mail-facts-rule-how">${e(words.how)}</span>
                <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-rule-remove" data-index="${index}"
                  ${FOCUS}="ed:rule-remove:${index}" aria-label="Remove the rule for ${e(words.target)}">Remove</button></li>`;
            }).join('')}</ul>`}
        <div class="mail-facts-constant" role="group" aria-label="A fixed value">
          <label>Always set <select ${MAIL_FACTS_FIELD_ATTR}="ed:constant-variable" ${FOCUS}="ed:constant-variable">
            ${option('', 'a value…', ed.constant.variable === '')}
            ${variables.map((variable) => option(variable.name, humanizeName(variable.name), variable.name === ed.constant.variable)).join('')}
          </select></label>
          <label>to ${constantVariable?.kind === 'enum' && constantVariable.values !== undefined
            ? `<select ${MAIL_FACTS_FIELD_ATTR}="ed:constant-value" ${FOCUS}="ed:constant-value">
                ${option('', 'choose…', ed.constant.value === '')}
                ${constantVariable.values.map((value) => option(value, humanizeName(value), value === ed.constant.value)).join('')}
              </select>`
            : `<input type="text" ${MAIL_FACTS_FIELD_ATTR}="ed:constant-value" ${FOCUS}="ed:constant-value" value="${e(ed.constant.value)}">`}</label>
          <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-constant-add" ${FOCUS}="ed:constant-add">Add</button>
        </div>
      </section>`;
  };

  const renderEntrance = (ed: Editor, spec: MailFactTypeSpec): string => {
    const read = [...new Set(ed.draft.rules
      .filter((rule) => rule.find.kind !== 'constant' && 'variable' in rule.target)
      .map((rule) => ('variable' in rule.target ? rule.target.variable : '')))];
    const required = new Set(effectiveVariables(ed.draft));
    return `
      <section class="mail-facts-editor-block" aria-labelledby="mail-facts-ed-entrance-title">
        <h3 class="mail-facts-subheading" id="mail-facts-ed-entrance-title">Which emails it reads</h3>
        <p class="mail-facts-subtle">Every condition must hold.</p>
        <ul class="mail-facts-conditions" role="list">
          ${ed.draft.conditions.map((condition, index) => `
            <li>
              <select ${MAIL_FACTS_FIELD_ATTR}="ed:cond-field:${index}" ${FOCUS}="ed:cond-field:${index}" aria-label="Condition ${index + 1}: what">
                ${MAIL_TEMPLATE_CONDITION_FIELDS.map((field) => option(field, FIELD_WORDS[field], field === condition.field)).join('')}
              </select>
              <select ${MAIL_FACTS_FIELD_ATTR}="ed:cond-negate:${index}" ${FOCUS}="ed:cond-negate:${index}" aria-label="Condition ${index + 1}: does or does not">
                ${option('', 'does', condition.negate !== true)}
                ${option('not', 'does not', condition.negate === true)}
              </select>
              <select ${MAIL_FACTS_FIELD_ATTR}="ed:cond-op:${index}" ${FOCUS}="ed:cond-op:${index}" aria-label="Condition ${index + 1}: how">
                ${MAIL_TEMPLATE_CONDITION_OPS_BY_FIELD[condition.field].map((op) => option(op, OP_WORDS[op], op === condition.op)).join('')}
              </select>
              <input type="text" ${MAIL_FACTS_FIELD_ATTR}="ed:cond-value:${index}" ${FOCUS}="ed:cond-value:${index}"
                value="${e(condition.value)}" aria-label="Condition ${index + 1}: value">
              <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-cond-remove" data-index="${index}"
                ${FOCUS}="ed:cond-remove:${index}" aria-label="Remove condition ${index + 1}">Remove</button>
            </li>`).join('')}
        </ul>
        <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-cond-add" ${FOCUS}="ed:cond-add">Add a condition</button>
        ${read.length > 0
          ? `<fieldset class="mail-facts-required">
              <legend>A fact exists only when it reads</legend>
              ${read.map((name) => `
                <label><input type="checkbox" ${MAIL_FACTS_FIELD_ATTR}="ed:entrance:${e(name)}" ${FOCUS}="ed:entrance:${e(name)}"${required.has(name) ? ' checked' : ''}>
                  ${e(humanizeName(name))}${spec.variables.find((v) => v.name === name)?.required === true ? ' <span class="mail-facts-subtle">(the type needs it)</span>' : ''}</label>`).join('')}
            </fieldset>`
          : ''}
        <details class="mail-facts-advanced"${ed.advancedOpen ? ' open' : ''}>
          <summary ${actionAttr}="mail-facts-ed-advanced" ${FOCUS}="ed:advanced">More</summary>
          <label><input type="checkbox" ${MAIL_FACTS_FIELD_ATTR}="ed:html" ${FOCUS}="ed:html"${ed.draft.html ? ' checked' : ''}> Read the email’s HTML as well as its text</label>
          <label>One fact per block: split the text at <input type="text" ${MAIL_FACTS_FIELD_ATTR}="ed:repeat-split" ${FOCUS}="ed:repeat-split"
            value="${e(ed.draft.repeat?.split ?? '')}" placeholder="for example Parcel \\d"></label>
        </details>
      </section>`;
  };

  /** Preview calls no model: say what the AI would be asked to fill. */
  const aiWouldFill = (ai: DraftAi, fact: { readonly variables: Readonly<Record<string, unknown>>; readonly data: unknown }): string => {
    if (!ai.enabled) return '';
    const empty = mailFactEmptyAiSlots(ai.slots, fact);
    return empty.length === 0
      ? ''
      : `<p class="mail-facts-subtle">Left for the AI, once saved: ${e(empty.map((slot) => (slot.startsWith('data.') ? `data ${slot.slice('data.'.length)}` : humanizeName(slot))).join(', '))}</p>`;
  };

  /** §4.3 — AI, off by default: the prompt, what it may fill, the pool. */
  const renderAi = (ed: Editor, spec: MailFactTypeSpec): string => {
    const { ai } = ed.draft;
    const entrance = new Set(effectiveVariables(ed.draft));
    const variables = editorVariables(spec).filter((variable) => variable.kind !== 'file');
    // The data the kind names first (§3.2), then what the rules and slots add.
    const declared = new Map((spec.data_fields ?? []).map((field) => [`data.${field.path}`, field.description ?? '']));
    const dataSlots = [...new Set([
      ...declared.keys(),
      ...ed.draft.rules.flatMap((rule) => ('data' in rule.target ? [`data.${rule.target.data}`] : [])),
      ...ai.slots.filter((slot) => slot.startsWith('data.')),
    ])];
    const known = dataFieldList('mail-facts-ai-data-fields', spec);
    const slot = (key: string, label: string): string => `
      <label><input type="checkbox" ${MAIL_FACTS_FIELD_ATTR}="ed:ai-slot:${e(key)}" ${FOCUS}="ed:ai-slot:${e(key)}"${ai.slots.includes(key) ? ' checked' : ''}> ${e(label)}</label>`;
    const dataLabel = (key: string): string => {
      const description = declared.get(key) ?? '';
      return `Data: ${key.slice('data.'.length)}${description.length > 0 ? ` (${description.replace(/\.$/, '')})` : ''}`;
    };
    return `
      <section class="mail-facts-editor-block" aria-labelledby="mail-facts-ed-ai-title">
        <h3 class="mail-facts-subheading" id="mail-facts-ed-ai-title">AI</h3>
        <label class="mail-facts-switch"><input type="checkbox" ${MAIL_FACTS_FIELD_ATTR}="ed:ai-on" ${FOCUS}="ed:ai-on"${ai.enabled ? ' checked' : ''}>
          Let AI fill in what the rules leave empty</label>
        <p class="mail-facts-subtle">Off unless you switch it on. It reads an email only once the rules above let it in, never decides whether a fact exists, and never changes what a rule read. What it fills is marked AI.</p>
        ${ai.enabled
          ? `${narrowerThanDomain(ed.draft)
              ? ''
              : '<p class="mail-facts-warn" role="note">Before AI can read these emails, narrow which ones it reads: the sender’s exact address, a subject or text condition, or a value the rules must read after a label, by a pattern or by keywords. A whole domain sends many kinds of email, and a value read whole is in every one of them.</p>'}
            <label class="mail-facts-ai-prompt">What these emails are, for the AI
              <textarea rows="3" ${MAIL_FACTS_FIELD_ATTR}="ed:ai-prompt" ${FOCUS}="ed:ai-prompt"
                placeholder="For example: order confirmations from my bike shop. The order number is in the subject.">${e(ai.prompt)}</textarea></label>
            <fieldset class="mail-facts-ai-slots">
              <legend>What it may fill in</legend>
              ${variables.map((variable) => entrance.has(variable.name)
                ? `<label class="mail-facts-subtle"><input type="checkbox" disabled> ${e(humanizeName(variable.name))} (lets an email in: the rules’ alone)</label>`
                : slot(variable.name, humanizeName(variable.name))).join('')}
              ${dataSlots.map((key) => slot(key, dataLabel(key))).join('')}
              <div class="mail-facts-ai-data">
                <label>A data field <input type="text" ${MAIL_FACTS_FIELD_ATTR}="ed:ai-data" ${FOCUS}="ed:ai-data" value="${e(ed.aiData)}" placeholder="for example items"${known.attr}></label>${known.html}
                <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-ai-data-add" ${FOCUS}="ed:ai-data-add">Add</button>
              </div>
              ${ed.aiDataError !== null ? `<p class="mail-facts-error" role="alert">${e(ed.aiDataError)}</p>` : ''}
            </fieldset>
            <label class="mail-facts-ai-pool">Which models <select ${MAIL_FACTS_FIELD_ATTR}="ed:ai-pool" ${FOCUS}="ed:ai-pool">
              ${(Object.keys(POOL_WORDS) as MailFactPoolPolicy[]).map((pool) => option(pool, POOL_WORDS[pool], pool === ai.pool)).join('')}
            </select></label>
            <p class="mail-facts-subtle">It runs in the background, so it spends your own keys only when Settings → AI models → How Recued may use AI lets it. Pause AI stops it.</p>`
          : ''}
      </section>`;
  };

  const renderPreviewEmail = (item: MailTemplatePreviewEmail, spec: MailFactTypeSpec, ai: DraftAi): string => {
    const badge = item.outcome === 'entered'
      ? '<span class="mail-facts-run-state" data-tone="ok">Read a fact</span>'
      : item.outcome === 'not_entered'
        ? '<span class="mail-facts-run-state" data-tone="bad">Did not read</span>'
        : '<span class="mail-facts-run-state" data-tone="plain">Not this kind of email</span>';
    const title = item.email !== undefined
      ? `${e(item.email.subject.length > 0 ? item.email.subject : '(no subject)')} <span class="mail-facts-subtle">${e(item.email.from)} · ${e(dateOnly(item.email.at))}</span>`
      : 'The pasted email';
    const facts = item.facts.map((fact) => `
      <dl class="mail-facts-values">
        ${editorVariables(spec).map((variable) => {
          const value = fact.variables[variable.name];
          if (value !== null && value !== undefined) {
            const pass = fact.passes[variable.name];
            return `<div class="mail-facts-value"><dt>${e(humanizeName(variable.name))}</dt><dd>${e(valueText(value))}${pass !== undefined ? ` <span class="mail-facts-pass" data-pass="${e(pass)}">${pass === 'rule' ? 'Your rule' : pass === 'standard' ? 'Standard' : 'AI'}</span>` : ''}</dd></div>`;
          }
          return fact.missing.includes(variable.name)
            ? `<div class="mail-facts-value" data-missing="true"><dt>${e(humanizeName(variable.name))}</dt><dd><span class="mail-facts-pass" data-pass="missing">Missing</span></dd></div>`
            : '';
        }).join('')}
      </dl>
      ${aiWouldFill(ai, fact)}`).join('');
    return `
      <li class="mail-facts-preview-item" data-outcome="${item.outcome}">
        <div class="mail-facts-heading">${badge} <span>${title}</span></div>
        ${item.read === 'stored' ? '<p class="mail-facts-subtle">Read from the copy Recued keeps: no sender name, HTML or attachments.</p>' : ''}
        ${item.unread !== undefined && item.unread.length > 0 ? `<p class="mail-facts-subtle">Did not find: ${e(item.unread.map(humanizeName).join(', '))}</p>` : ''}
        ${item.facts.length > 1 ? `<p class="mail-facts-subtle">${item.facts.length} facts from this email</p>` : ''}
        ${facts}
        ${(item.warnings ?? []).map((warning) => `<p class="mail-facts-subtle">${e(warning)}</p>`).join('')}
      </li>`;
  };

  const renderPreview = (ed: Editor, spec: MailFactTypeSpec): string => {
    const { preview } = ed;
    if (callers.previewTemplate === undefined) return '';
    const current = previewCurrent(ed);
    const loading = preview.loading && current;
    const body = !current
      ? '<p class="mail-facts-subtle">The template changed since this preview. Preview again to see what it reads now.</p>'
      : loading
      ? '<p class="mail-facts-subtle" aria-live="polite">Reading your mail…</p>'
      : preview.error !== null
        ? `<p class="mail-facts-error" role="alert">${e(preview.error)}</p>`
        : preview.result === null
          ? '<p class="mail-facts-subtle">See what this template reads from this email and your latest mail like it, before you save it.</p>'
          : `
            ${preview.result.source !== undefined ? `<ul class="mail-facts-preview" role="list">${renderPreviewEmail(preview.result.source, spec, ed.draft.ai)}</ul>` : ''}
            <h4 class="mail-facts-subheading">Your latest mail that meets its conditions</h4>
            ${preview.result.recent.length === 0
              ? `<p class="mail-facts-subtle">None among the ${preview.result.scanned} newest emails.</p>`
              : `<ul class="mail-facts-preview" role="list">${preview.result.recent.map((item) => renderPreviewEmail(item, spec, ed.draft.ai)).join('')}</ul>`}`;
    return `
      <section class="mail-facts-editor-block" aria-labelledby="mail-facts-ed-preview-title" aria-busy="${loading ? 'true' : 'false'}">
        <h3 class="mail-facts-subheading" id="mail-facts-ed-preview-title">Preview</h3>
        <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-preview" ${FOCUS}="ed:preview"${loading ? ' aria-disabled="true" aria-busy="true"' : ''}>Preview</button>
        ${body}
      </section>`;
  };

  /** Leaving with unsaved changes: the owner says whether they go. */
  const renderLeaving = (ed: Editor): string => {
    if (ed.leaving === null) return '';
    const question = ed.leaving.then === 'list'
      ? 'Leave this template? Your changes to it are not saved.'
      : 'Open the other email instead? Your changes to this template are not saved.';
    return `
      <div class="mail-facts-confirm" role="alertdialog" aria-label="Unsaved changes">
        <span>${question}</span>
        <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-leave-confirm" ${FOCUS}="ed:leave-confirm">Discard changes</button>
        <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-leave-cancel" ${FOCUS}="ed:leave-keep">Keep editing</button>
      </div>`;
  };

  /** A kind of email whose switch would leave rules out: the owner says so first. */
  const renderPendingType = (ed: Editor): string => {
    if (ed.pendingType === null) return '';
    const to = specOf(ed.pendingType.type)?.name ?? humanizeName(ed.pendingType.type);
    const from = specOf(ed.draft.type)?.name ?? humanizeName(ed.draft.type);
    const n = ed.pendingType.dropped;
    return `
      <p class="mail-facts-confirm" role="alert">${e(to)} has no place for ${n} of the rules you made: ${n === 1 ? 'it is' : 'they are'} left out if you switch.
        <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-type-confirm" ${FOCUS}="ed:type-confirm">Switch to ${e(to)}</button>
        <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-type-cancel" ${FOCUS}="ed:type-cancel">Keep ${e(from)}</button></p>`;
  };

  const renderEditor = (ed: Editor): string => {
    picks = [];
    const spec = specOf(ed.draft.type);
    const heading = ed.template_id === null ? 'New template' : `Edit “${e(ed.draft.name)}”`;
    if (ed.loading) {
      return `<p class="mail-facts-subtle" aria-live="polite">Loading the template…</p>`;
    }
    // A template the address named that is gone: nothing to edit or save.
    if (ed.missing) {
      return `
        <section class="mail-facts-editor" aria-labelledby="mail-facts-editor-title">
          <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-back" ${FOCUS}="ed:back">← Templates</button>
          <h3 class="mail-facts-subheading" id="mail-facts-editor-title" tabindex="-1" ${FOCUS}="ed:title">Template not found</h3>
          <p class="mail-facts-error" role="alert">This template no longer exists: it may have been deleted.</p>
        </section>`;
    }
    return `
      <section class="mail-facts-editor" aria-labelledby="mail-facts-editor-title">
        <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-back" ${FOCUS}="ed:back">← Templates</button>
        <h3 class="mail-facts-subheading" id="mail-facts-editor-title" tabindex="-1" ${FOCUS}="ed:title">${heading}</h3>
        ${renderLeaving(ed)}
        ${ed.error !== null ? `<p class="mail-facts-error" role="alert">${e(ed.error)}</p>` : ''}
        ${ed.problems.length > 0 ? `<ul class="mail-facts-problems" role="list">${ed.problems.map((p) => `<li>${e(p)}</li>`).join('')}</ul>` : ''}
        <div class="mail-facts-editor-top">
          <label>Name <input type="text" ${MAIL_FACTS_FIELD_ATTR}="ed:name" ${FOCUS}="ed:name" value="${e(ed.draft.name)}"
            placeholder="${e(definitionOf(ed.draft, ed.source).name)}"></label>
          <label>Kind of email <select ${MAIL_FACTS_FIELD_ATTR}="ed:type" ${FOCUS}="ed:type"${ed.template_id !== null || ed.saving ? ' disabled' : ''}>
            ${MAIL_FACT_BUILTIN_TYPES.map((type) => option(type.id, type.name, type.id === ed.draft.type)).join('')}
            ${list.types.length > 0
              ? `<optgroup label="Kinds you made">${list.types.map((type) => option(type.id, type.name, type.id === ed.draft.type)).join('')}</optgroup>`
              : ''}
            ${callers.createType !== undefined && ed.template_id === null ? option(NEW_TYPE, 'A new kind of email…', false) : ''}
          </select></label>
        </div>
        ${renderPendingType(ed)}
        ${spec !== undefined ? `<p class="mail-facts-subtle">${e(spec.description)}</p>` : ''}
        ${renderSourceEmail(ed)}
        ${spec !== undefined ? renderPickBox(ed, spec) : ''}
        ${spec !== undefined ? renderRules(ed, spec) : ''}
        ${spec !== undefined ? renderEntrance(ed, spec) : ''}
        ${spec !== undefined ? renderAi(ed, spec) : ''}
        ${spec !== undefined ? renderPreview(ed, spec) : ''}
        <div class="mail-facts-editor-actions">
          <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-save" ${FOCUS}="ed:save"${ed.saving ? ' aria-disabled="true" aria-busy="true"' : ''}>${ed.saving ? 'Saving…' : 'Save template'}</button>
          <button type="button" class="data-button" ${actionAttr}="mail-facts-ed-back" ${FOCUS}="ed:cancel">Cancel</button>
        </div>
        ${ed.saved && unsaved(ed) ? '<p class="mail-facts-subtle" role="status">Saved. Your changes since are not saved yet.</p>' : ''}
        <p class="mail-facts-subtle">A saved template reads the mail that arrives from now on.</p>
      </section>`;
  };

  // ── Actions ────────────────────────────────────────────────────────────────

  const addPick = (): void => {
    if (editor === null || editor.pick === null) return;
    const { pick, pickTarget } = editor;
    const spec = specOf(editor.draft.type);
    const variable = spec === undefined ? undefined : editorVariables(spec).find((v) => v.name === pickTarget.variable);
    let target: PickTarget | null = null;
    if (pickTarget.data.trim().length > 0 && variable === undefined) {
      target = { data: pickTarget.data.trim() };
    } else if (variable !== undefined) {
      if (variable.kind === 'enum') {
        if (pickTarget.means === '') {
          setEditor({ error: `Say which ${humanizeName(variable.name).toLowerCase()} “${pick.text}” means.` });
          deps.focus('ed:pick-means');
          deps.render();
          return;
        }
        target = { variable: variable.name, means: pickTarget.means };
      } else {
        target = { variable: variable.name };
      }
    }
    if (target === null) {
      setEditor({ error: 'Choose what this value is, or name a data field.' });
      deps.focus('ed:pick-variable');
      deps.render();
      return;
    }
    let rules: MailTemplateRule[];
    if (pick.source === 'attachment' && 'variable' in target) {
      rules = [
        ...editor.draft.rules.filter((rule) => !('variable' in rule.target && rule.target.variable === (target as { variable: string }).variable)),
        { target: { variable: target.variable }, source: 'attachment', find: { kind: 'attachment', by: 'type', match: pick.text } },
      ];
    } else {
      rules = ruleFromPick(pick, target, editor.draft.rules);
    }
    editor = { ...editor, pick: null, error: null, draft: { ...editor.draft, rules } };
    deps.focus('ed:rules');
    deps.render();
  };

  const addConstant = (): void => {
    if (editor === null) return;
    const { variable, value } = editor.constant;
    if (variable === '' || value.trim() === '') {
      setEditor({ error: 'Choose a value and what to set it to.' });
      deps.focus('ed:constant-variable');
      deps.render();
      return;
    }
    const rules = [
      ...editor.draft.rules.filter((rule) => !('variable' in rule.target && rule.target.variable === variable)),
      { target: { variable }, source: 'subject' as const, find: { kind: 'constant' as const, value: value.trim() } },
    ];
    editor = { ...editor, error: null, constant: { variable: '', value: '' }, draft: { ...editor.draft, rules } };
    deps.focus('ed:constant-variable');
    deps.render();
  };

  const updateCondition = (index: number, next: Partial<MailTemplateCondition>): void => {
    if (editor === null) return;
    const conditions = editor.draft.conditions.map((condition, i) => {
      if (i !== index) return condition;
      const { negate, ...merged } = { ...condition, ...next } as MailTemplateCondition;
      // A field keeps only the ops it accepts; "does" is the default, not a flag.
      const ops = MAIL_TEMPLATE_CONDITION_OPS_BY_FIELD[merged.field];
      const op = ops.includes(merged.op) ? merged.op : ops[0]!;
      return { ...merged, op, ...(negate === true ? { negate: true } : {}) };
    });
    setDraft({ conditions });
  };

  return {
    render: () => (typeEditor.isOpen() ? typeEditor.render() : editor !== null ? renderEditor(editor) : renderList()),

    refresh: async (silent = false) => {
      if (pendingOpen !== null) {
        const id = pendingOpen;
        pendingOpen = null;
        await openEditor(id, true);
        return;
      }
      if (editor !== null) return;
      await loadList(silent);
    },

    handleAction: (action, target) => {
      if (typeEditor.isOpen()) return typeEditor.handleAction(action, target);
      const templateId = target.getAttribute('data-template-id') ?? '';
      const typeId = target.getAttribute('data-type-id') ?? '';
      const index = Number(target.getAttribute('data-index') ?? '-1');
      switch (action) {
        case 'mail-facts-tpl-type-new':
          typeReturn = 'list';
          typeEditor.open(null);
          deps.render();
          return true;
        case 'mail-facts-tpl-type-edit': {
          const type = list.types.find((candidate) => candidate.id === typeId);
          if (type !== undefined) {
            typeReturn = 'list';
            typeEditor.open(type);
            deps.render();
          }
          return true;
        }
        case 'mail-facts-tpl-type-delete':
          list = { ...list, typeDelete: typeId, typeError: null };
          deps.focus(`tpl:type-cancel:${typeId}`);
          deps.render();
          return true;
        case 'mail-facts-tpl-type-delete-cancel':
          list = { ...list, typeDelete: null };
          deps.focus(`tpl:type-delete:${typeId}`);
          deps.render();
          return true;
        case 'mail-facts-tpl-type-delete-confirm':
          void deleteType(typeId);
          return true;
        case 'mail-facts-tpl-new':
          editor = newEditor(null, blankDraft(), { kind: 'sample', sample: EMPTY_SAMPLE, applied: null });
          deps.onAddressChange();
          deps.focus('ed:sample-from');
          deps.render();
          return true;
        case 'mail-facts-tpl-edit':
          void openEditor(templateId);
          return true;
        case 'mail-facts-tpl-toggle':
          void toggleTemplate(templateId);
          return true;
        case 'mail-facts-tpl-delete':
          list = { ...list, confirmDelete: templateId, rowError: null };
          deps.focus(`tpl:cancel:${templateId}`);
          deps.render();
          return true;
        case 'mail-facts-tpl-delete-cancel':
          list = { ...list, confirmDelete: null };
          deps.focus(`tpl:delete:${templateId}`);
          deps.render();
          return true;
        case 'mail-facts-tpl-delete-confirm':
          void deleteTemplate(templateId);
          return true;
        case 'mail-facts-std-toggle':
          void toggleStandards(target.getAttribute('data-type') ?? '');
          return true;
        case 'mail-facts-bf-open': {
          const max = list.backfill?.max_days ?? 365;
          list = { ...list, backfillForm: { template_id: templateId, days: Math.min(30, max), run_recipes: false }, rowError: null };
          deps.focus('bf:days');
          deps.render();
          return true;
        }
        case 'mail-facts-bf-close':
          list = { ...list, backfillForm: null };
          deps.focus(`bf:open:${templateId}`);
          deps.render();
          return true;
        case 'mail-facts-bf-start':
          void startBackfill(templateId);
          return true;
        case 'mail-facts-bf-stop':
          void stopBackfill(target.getAttribute('data-job-id') ?? '');
          return true;
        case 'mail-facts-tr-open':
          void openThenRun(templateId);
          return true;
        case 'mail-facts-tr-create':
          void createThenRun(templateId);
          return true;
        case 'mail-facts-tr-close':
          list = { ...list, thenRun: null };
          deps.focus(`tr:open:${templateId}`);
          deps.render();
          return true;
        case 'mail-facts-ed-back':
          closeEditor(false);
          return true;
        case 'mail-facts-ed-leave-confirm': {
          const leaving = editor?.leaving ?? null;
          if (leaving === null) return true;
          if (leaving.then === 'list') closeEditor(true);
          else void openFromEmail(leaving.email, true);
          return true;
        }
        case 'mail-facts-ed-leave-cancel':
          setEditor({ leaving: null });
          deps.focus('ed:title');
          deps.render();
          return true;
        // A disclosure: the browser opens or shuts it; the state keeps it so
        // across repaints. No repaint here, which would undo the toggle.
        case 'mail-facts-ed-advanced':
          if (editor !== null) setEditor({ advancedOpen: !editor.advancedOpen });
          return true;
        case 'mail-facts-ed-dropped':
          if (editor !== null) setEditor({ droppedOpen: !editor.droppedOpen });
          return true;
        case 'mail-facts-ed-type-confirm':
          if (editor?.pendingType != null) {
            switchType(editor.pendingType.type);
            deps.focus('ed:type');
            deps.render();
          }
          return true;
        case 'mail-facts-ed-draft-late-use':
          if (editor?.drafting.late != null) applyDraft(editor.drafting.late);
          deps.focus('ed:draft');
          return true;
        case 'mail-facts-ed-draft-late-keep':
          if (editor !== null) setEditor({ drafting: { ...editor.drafting, late: null } });
          deps.focus('ed:draft');
          deps.render();
          return true;
        case 'mail-facts-ed-type-cancel':
          // The picker goes back to the kind the template has.
          setEditor({ pendingType: null });
          deps.focus('ed:type');
          deps.render();
          return true;
        case 'mail-facts-ed-sample-use':
          if (editor?.source.kind === 'sample') {
            const sample = editor.source.sample;
            const from = sampleSender(sample.from).address;
            editor = {
              ...editor,
              source: { kind: 'sample', sample, applied: sample },
              draft: editor.draft.conditions.length === 0
                ? { ...editor.draft, conditions: suggestConditions(from) }
                : editor.draft,
            };
            deps.focus('ed:sample-use');
            deps.render();
          }
          return true;
        case 'mail-facts-ed-pick': {
          const pick = picks[Number(target.getAttribute('data-pick') ?? '-1')];
          if (editor !== null && pick !== undefined) {
            editor = { ...editor, pick, error: null, pickTarget: { variable: '', data: '', means: '', normalize: '' } };
            deps.focus('ed:pick-variable');
            deps.render();
          }
          return true;
        }
        case 'mail-facts-ed-pick-add':
          addPick();
          return true;
        case 'mail-facts-ed-pick-cancel':
          setEditor({ pick: null, error: null });
          deps.render();
          return true;
        case 'mail-facts-ed-rule-remove':
          if (editor !== null && index >= 0) {
            setDraft({ rules: editor.draft.rules.filter((_, i) => i !== index) });
            deps.focus('ed:rules');
            deps.render();
          }
          return true;
        case 'mail-facts-ed-constant-add':
          addConstant();
          return true;
        case 'mail-facts-ed-cond-add':
          if (editor !== null) {
            setDraft({ conditions: [...editor.draft.conditions, { field: 'subject', op: 'contains', value: '' }] });
            deps.focus(`ed:cond-value:${editor.draft.conditions.length - 1}`);
            deps.render();
          }
          return true;
        case 'mail-facts-ed-cond-remove':
          if (editor !== null && index >= 0) {
            setDraft({ conditions: editor.draft.conditions.filter((_, i) => i !== index) });
            deps.focus('ed:cond-add');
            deps.render();
          }
          return true;
        case 'mail-facts-ed-preview':
          // One at a time from the button; a Draft may start a newer one. One
          // still reading a template changed since is no longer this one's.
          if (editor !== null && !(editor.preview.loading && previewCurrent(editor))) void runPreview();
          return true;
        case 'mail-facts-ed-draft':
          if (editor !== null && !editor.drafting.loading) {
            // A draft replaces the owner's rules: ask first when there are any.
            if (editor.draft.rules.length > 0) {
              setEditor({ drafting: { ...editor.drafting, confirm: true, error: null } });
              deps.focus('ed:draft-confirm');
              deps.render();
            } else {
              void runDraft();
            }
          }
          return true;
        case 'mail-facts-ed-draft-confirm':
          void runDraft();
          return true;
        case 'mail-facts-ed-draft-cancel':
          if (editor !== null) {
            setEditor({ drafting: { ...editor.drafting, confirm: false } });
            deps.focus('ed:draft');
            deps.render();
          }
          return true;
        case 'mail-facts-ed-ai-data-add':
          if (editor !== null) {
            const path = editor.aiData.trim().replace(/^data\./, '');
            if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/.test(path)) {
              setEditor({ aiDataError: 'Write it in lower case, words joined by _ and parts by a dot: for example items or order.total.' });
            } else {
              const key = `data.${path}`;
              setDraft({ ai: { ...editor.draft.ai, slots: editor.draft.ai.slots.includes(key) ? editor.draft.ai.slots : [...editor.draft.ai.slots, key] } });
              setEditor({ aiData: '', aiDataError: null });
            }
            deps.focus('ed:ai-data');
            deps.render();
          }
          return true;
        case 'mail-facts-ed-save':
          void save();
          return true;
        default:
          return false;
      }
    },

    handleChange: (target) => {
      if (typeEditor.isOpen()) return typeEditor.handleChange(target);
      const field = target.getAttribute(MAIL_FACTS_FIELD_ATTR);
      if (field === null) return false;
      if (field === 'tr:recipe') {
        if (list.thenRun !== null) {
          list = { ...list, thenRun: { ...list.thenRun, choice: (target as HTMLSelectElement).value ?? '', error: null } };
          deps.focus(field);
          deps.render();
        }
        return true;
      }
      // The "Read past mail" form lives on the list.
      if (field === 'bf:days' || field === 'bf:run') {
        const form = list.backfillForm;
        if (form === null) return true;
        list = {
          ...list,
          backfillForm: field === 'bf:days'
            ? { ...form, days: Number((target as HTMLSelectElement).value) || form.days }
            : { ...form, run_recipes: (target as HTMLInputElement).checked === true },
        };
        deps.focus(field);
        deps.render();
        return true;
      }
      if (editor === null) return false;
      const value = (target as HTMLInputElement).value ?? '';
      const checked = (target as HTMLInputElement).checked === true;
      const [key, arg] = field.split(/:(.+)/, 2) as [string, string | undefined];
      switch (`${key}:${arg !== undefined ? arg.replace(/:.*/, '') : ''}`) {
        case 'ed:type':
          // A template keeps its kind: none changes while one is being saved.
          if (editor.saving) {
            deps.render();
            return true;
          }
          if (value === NEW_TYPE) {
            // The picker stays on the kind it had; the type editor opens.
            typeReturn = 'template';
            typeEditor.open(null);
            deps.render();
            return true;
          }
          if (value === editor.draft.type) {
            // The kind it had, picked: the owner's choice all the same.
            setEditor({ pendingType: null, typeChosen: true });
            break;
          }
          // Another kind of email: the rules that fit it stay. When some would
          // be left out, the owner says so first.
          {
            const { dropped } = carriedTo(editor.draft, value);
            if (dropped > 0) {
              setEditor({ pendingType: { type: value, dropped } });
              deps.focus('ed:type-confirm');
              deps.render();
              return true;
            }
            switchType(value);
          }
          break;
        case 'ed:ai-on':
          setDraft({ ai: { ...editor.draft.ai, enabled: checked } });
          break;
        case 'ed:ai-pool':
          setDraft({ ai: { ...editor.draft.ai, pool: value as MailFactPoolPolicy } });
          break;
        case 'ed:ai-slot': {
          const slot = field.slice('ed:ai-slot:'.length);
          const slots = new Set(editor.draft.ai.slots);
          if (checked) slots.add(slot);
          else slots.delete(slot);
          setDraft({ ai: { ...editor.draft.ai, slots: [...slots] } });
          break;
        }
        case 'ed:pick-variable':
          setEditor({ pickTarget: { ...editor.pickTarget, variable: value, means: '' } });
          break;
        case 'ed:pick-means':
          setEditor({ pickTarget: { ...editor.pickTarget, means: value } });
          break;
        case 'ed:constant-variable':
          setEditor({ constant: { variable: value, value: '' } });
          break;
        case 'ed:constant-value':
          setEditor({ constant: { ...editor.constant, value } });
          // A typed value's `change` comes as focus leaves — on the press of
          // Add: a repaint now would swallow that click. A choice repaints.
          if (target.tagName !== 'SELECT') return true;
          break;
        case 'ed:html':
          setDraft({ html: checked });
          break;
        case 'ed:cond-field': {
          const index = Number(field.split(':')[2]);
          updateCondition(index, { field: value as MailTemplateConditionField });
          break;
        }
        case 'ed:cond-op': {
          const index = Number(field.split(':')[2]);
          updateCondition(index, { op: value as MailTemplateConditionOp });
          break;
        }
        case 'ed:cond-negate': {
          const index = Number(field.split(':')[2]);
          updateCondition(index, value === 'not' ? { negate: true } : { negate: false });
          break;
        }
        case 'ed:entrance': {
          const name = field.slice('ed:entrance:'.length);
          const current = new Set(effectiveVariables(editor.draft));
          if (checked) current.add(name);
          else current.delete(name);
          setDraft({ variables: [...current] });
          break;
        }
        default:
          // A text field's `change` after its `input`s: the draft has it.
          return field.startsWith('ed:');
      }
      deps.focus(field);
      deps.render();
      return true;
    },

    handleInput: (target) => {
      if (typeEditor.isOpen()) return typeEditor.handleInput(target);
      const field = target.getAttribute(MAIL_FACTS_FIELD_ATTR);
      if (field === null || editor === null) return false;
      const value = (target as HTMLInputElement).value ?? '';
      if (field === 'ed:name') setDraft({ name: value });
      else if (field === 'ed:ai-prompt') setDraft({ ai: { ...editor.draft.ai, prompt: value } });
      else if (field === 'ed:ai-data') setEditor({ aiData: value });
      else if (field === 'ed:pick-data') setEditor({ pickTarget: { ...editor.pickTarget, data: value } });
      else if (field === 'ed:constant-value') setEditor({ constant: { ...editor.constant, value } });
      else if (field === 'ed:repeat-split') {
        setDraft({ repeat: value.length > 0 ? { source: 'body', split: value } : null });
      } else if (field.startsWith('ed:cond-value:')) {
        const index = Number(field.slice('ed:cond-value:'.length));
        const conditions = editor.draft.conditions.map((c, i) => (i === index ? { ...c, value } : c));
        setDraft({ conditions });
      } else if (field.startsWith('ed:sample-') && editor.source.kind === 'sample') {
        const part = field.slice('ed:sample-'.length) as 'from' | 'subject' | 'body';
        editor = { ...editor, source: { ...editor.source, sample: { ...editor.source.sample, [part]: value } } };
      } else {
        return false;
      }
      return true;
    },

    addressSegments: () => (editor === null ? [] : [editor.template_id ?? 'new']),

    openAddress: (segments) => {
      const id = segments[0];
      if (id === undefined) return;
      if (id === 'new') {
        editor = newEditor(null, blankDraft(), { kind: 'sample', sample: EMPTY_SAMPLE, applied: null });
      } else {
        // Loaded by the first refresh; until then the address stays as asked.
        editor = { ...newEditor(id, blankDraft(), { kind: 'sample', sample: EMPTY_SAMPLE, applied: null }), loading: true };
        pendingOpen = id;
      }
    },

    openFromEmail: (email) => openFromEmail(email),

    isBusy: () => editor !== null || typeEditor.isOpen() || list.busy !== null,

    hasUnsavedChanges: () => (editor !== null && unsaved(editor)) || typeEditor.isDirty(),

    hasInFlightWork: () =>
      editor?.saving === true || typeEditor.isSaving() || list.busy !== null || listCalls > 0,

    dispose: () => {
      disposed = true;
    },
  };
};

/** The Templates view's styles, scoped with the tab's. */
export const MAIL_FACT_TEMPLATES_STYLES = (host: string): string => MAIL_FACT_TYPE_EDITOR_STYLES(host) + `
[${host}] .mail-facts-subheading { margin: 16px 0 6px; font-size: 14px; font-weight: 650; }
[${host}] .mail-facts-row-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
[${host}] .mail-facts-switches { display: flex; flex-wrap: wrap; gap: 8px 16px; }
[${host}] .mail-facts-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
[${host}] .mail-facts-template-list, [${host}] .mail-facts-preview { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
[${host}] .mail-facts-template, [${host}] .mail-facts-preview-item {
  border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 10px; min-width: 0;
  display: flex; flex-direction: column; gap: 4px;
}
[${host}] .mail-facts-template[data-broken="true"] { border-color: var(--danger); }
[${host}] .mail-facts-template-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
[${host}] .mail-facts-template-name { font-weight: 600; overflow-wrap: anywhere; }
[${host}] .mail-facts-template-actions, [${host}] .mail-facts-confirm, [${host}] .mail-facts-pick-actions,
[${host}] .mail-facts-editor-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
[${host}] .mail-facts-broken { margin: 0; font-size: 13px; color: var(--danger); }
[${host}] .mail-facts-backfill {
  display: flex; flex-direction: column; gap: 6px; padding: 8px; font-size: 13px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg);
}
[${host}] .mail-facts-backfill label { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
[${host}] .mail-facts-backfill[role="status"] { flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; }
[${host}] .mail-facts-editor { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
[${host}] .mail-facts-editor > .data-button:first-child { align-self: flex-start; }
[${host}] .mail-facts-editor-top { display: flex; flex-wrap: wrap; gap: 8px 16px; }
[${host}] .mail-facts-editor-top label, [${host}] .mail-facts-sample label { display: grid; gap: 2px; font-size: 12px; color: var(--muted); min-width: 0; }
[${host}] .mail-facts-editor-top input { width: 24em; }
[${host}] .mail-facts-editor input[type="text"], [${host}] .mail-facts-editor textarea, [${host}] .mail-facts-editor select {
  font: inherit; font-size: 13px; color: var(--fg); max-width: 100%; box-sizing: border-box;
}
[${host}] .mail-facts-sample { display: grid; gap: 8px; max-width: 720px; }
[${host}] .mail-facts-sample textarea { width: 100%; }
[${host}] .mail-facts-editor-block { border-top: 1px solid var(--border); padding-top: 4px; min-width: 0; }
[${host}] .mail-facts-email-head { display: grid; gap: 4px; margin: 6px 0; font-size: 13px; }
[${host}] .mail-facts-email-head > div { display: grid; grid-template-columns: minmax(0, 6em) minmax(0, 1fr); gap: 8px; }
[${host}] .mail-facts-email-head dt { color: var(--muted); }
[${host}] .mail-facts-email-head dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
[${host}] .mail-facts-email-text {
  margin: 0; padding: 8px; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  font: inherit; font-size: 13px; line-height: 1.7; border: 1px solid var(--border); border-radius: 6px; background: var(--bg);
}
[${host}] .mail-facts-value-pick {
  font: inherit; color: var(--accent); background: var(--accent-weak); border: 1px solid transparent; border-radius: 4px;
  padding: 0 3px; cursor: pointer; text-align: left; overflow-wrap: anywhere; max-width: 100%;
}
[${host}] .mail-facts-value-pick[aria-pressed="true"] { border-color: var(--accent); }
[${host}] .mail-facts-pick-box {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px; font-size: 13px;
  border: 1px solid var(--accent); border-radius: 8px; background: var(--surface);
}
[${host}] .mail-facts-pick-box p { margin: 0; font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
[${host}] .mail-facts-rules, [${host}] .mail-facts-conditions { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
[${host}] .mail-facts-rules li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; }
[${host}] .mail-facts-rule-target { font-weight: 600; }
[${host}] .mail-facts-rule-how { color: var(--muted); overflow-wrap: anywhere; min-width: 0; }
[${host}] .mail-facts-conditions li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
[${host}] .mail-facts-conditions input[type="text"] { flex: 1 1 12em; min-width: 0; }
[${host}] .mail-facts-constant { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; font-size: 13px; }
[${host}] .mail-facts-required { border: 0; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; font-size: 13px; }
[${host}] .mail-facts-required legend { padding: 0; margin-bottom: 4px; color: var(--muted); }
[${host}] .mail-facts-advanced { margin-top: 8px; font-size: 13px; }
[${host}] .mail-facts-advanced summary { cursor: pointer; }
[${host}] .mail-facts-advanced label { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
[${host}] .mail-facts-problems { margin: 0; padding-left: 18px; color: var(--danger); font-size: 13px; }
[${host}] .mail-facts-draft { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 6px 0; font-size: 13px; }
[${host}] .mail-facts-draft > p, [${host}] .mail-facts-draft > details { flex: 1 1 100%; margin: 0; }
[${host}] .mail-facts-dropped ul { margin: 4px 0 0; padding-left: 18px; }
[${host}] .mail-facts-warn { margin: 6px 0; padding: 8px; font-size: 13px; border: 1px solid var(--danger); border-radius: 6px; }
[${host}] .mail-facts-ai-prompt, [${host}] .mail-facts-ai-pool { display: grid; gap: 2px; max-width: 720px; margin: 8px 0; font-size: 12px; color: var(--muted); }
[${host}] .mail-facts-ai-pool { justify-items: start; }
[${host}] .mail-facts-ai-prompt textarea { width: 100%; }
[${host}] .mail-facts-ai-slots { border: 0; margin: 8px 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 13px; }
[${host}] .mail-facts-ai-slots legend { padding: 0; margin-bottom: 4px; color: var(--muted); }
[${host}] .mail-facts-ai-slots label { display: inline-flex; align-items: center; gap: 6px; }
[${host}] .mail-facts-ai-slots > .mail-facts-ai-data, [${host}] .mail-facts-ai-slots > p { flex: 1 1 100%; }
[${host}] .mail-facts-ai-data { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
[${host}] .mail-facts-ai-data label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
@media (max-width: 720px) {
  [${host}] .mail-facts-editor-top input { min-width: 0; width: 100%; }
  [${host}] .mail-facts-editor-top label { width: 100%; }
}
`;

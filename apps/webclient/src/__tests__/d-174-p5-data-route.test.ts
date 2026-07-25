import { describe, expect, it, vi } from 'vitest';
import type {
  ContactMergeCandidate,
  ContactRecord,
  ContactSourceCycleCounts,
  ContactSourceHealth,
  FormResponse,
  FormResponseListItem,
  RecipeDefinition,
  ServerExecuteResponse,
  ServerRecipeListEntry,
  SourceRegistration,
  TimelineResponse,
  WorkEntity,
  WorkEntityKind,
} from '@recued/contracts';
import { FILE_VENDOR_DECLARATIONS, WORK_ENTITY_KINDS } from '@recued/contracts';

import {
  DATA_ROUTE_CONTACT_DETAIL_ATTR,
  DATA_ROUTE_CONTACT_DIALOG_ATTR,
  DATA_ROUTE_CONTACT_LINKS_ATTR,
  DATA_ROUTE_CONTACT_LOAD_MORE_ATTR,
  DATA_ROUTE_CONTACT_PROVENANCE_ATTR,
  DATA_ROUTE_CONTACT_SCAN_ATTR,
  DATA_ROUTE_CONTACT_SOURCES_ATTR,
  DATA_ROUTE_CHAT_RETURN_ATTR,
  DATA_ROUTE_SCAN_PROGRESS_ATTR,
  DATA_ROUTE_DOWNLOAD_FILE_ATTR,
  DATA_ROUTE_FILE_SOURCES_ATTR,
  DATA_ROUTE_FILE_SOURCE_LINK_ATTR,
  DATA_ROUTE_FORM_RESPONSE_AUTOMATE_ATTR,
  DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR,
  DATA_ROUTE_FORM_RESPONSE_EMAIL_ATTR,
  DATA_ROUTE_FORM_RESPONSE_LOAD_MORE_ATTR,
  DATA_ROUTE_FORM_RESPONSE_RUN_ATTR,
  DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR,
  DATA_ROUTE_FORM_RESPONSE_RUN_RECIPE_ATTR,
  DATA_ROUTE_FORM_RESPONSE_ROW_ATTR,
  DATA_ROUTE_FORM_RESPONSE_STATE_ATTR,
  DATA_ROUTE_FORM_RESPONSE_VALUES_ATTR,
  DATA_ROUTE_HEADING_ATTR,
  DATA_ROUTE_HOST_ATTR,
  DATA_ROUTE_LOGS_RETURN_ATTR,
  DATA_ROUTE_MIRROR_ATTR,
  DATA_ROUTE_STYLES_MARKER,
  DATA_ROUTE_TAB_ATTR,
  DATA_ROUTE_VERIFICATION_ACTION_ATTR,
  DATA_ROUTE_VERIFICATION_NEXT_ATTR,
  DATA_ROUTE_WORK_ENTITY_LOAD_MORE_ATTR,
  bootstrapDataRoute,
  type BootstrapDataRouteOptions,
  type DataContactDeleteCaller,
  type DataContactContributionsCaller,
  type DataContactGetCaller,
  type DataContactMergeConfirmCaller,
  type DataContactMergeListCaller,
  type DataContactMergeRejectCaller,
  type DataContactMergeScanNowCaller,
  type DataContactSourceListCaller,
  type DataContactImportCandidatesCaller,
  type DataContactImportPromoteCaller,
  type DataContactImportFilePreviewCaller,
  type DataContactImportFileApplyCaller,
  type DataContactListCaller,
  type DataContactUpsertCaller,
  type DataFileReadCaller,
  type DataFormResponseGetCaller,
  type DataFormResponseExportCaller,
  type DataFormResponseListCaller,
  type DataFormResponseSetStateCaller,
  type DataFormResponseUpdateCaller,
  type DataManageRescheduleLinkCaller,
  type DataMirrorSearchCaller,
  type DataRecipeListCaller,
  type DataTimelineCaller,
  type DataWorkEntityDeleteCaller,
  type DataWorkEntityGetCaller,
  type DataWorkEntityListCaller,
  type DataWorkEntityUpsertCaller,
  type WorkEntitySourceListCaller,
} from '../data/bootstrap-data-route.js';
import {
  COLLECTION_DETAIL_CLOSE_ACTION,
  COLLECTION_DETAIL_HEADING_ATTR,
  COLLECTION_INSTANCE_SLUG_ATTR,
  COLLECTION_OPEN_RECORD_ACTION,
  COLLECTION_RECORD_ID_ATTR,
  COLLECTION_SELECT_INSTANCE_ACTION,
} from '../data/collection-explorer.js';

interface FakeEl {
  tagName: string;
  textContent: string;
  innerHTML: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: Event) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev: Event) => void): void;
  removeEventListener(type: string, fn: (ev: Event) => void): void;
  remove(): void;
}

interface FakeDoc {
  styleElements: FakeEl[];
  head: {
    querySelector(sel: string): FakeEl | null;
    appendChild(el: FakeEl): FakeEl;
  };
  createElement(tag: string): FakeEl;
  addEventListener(type: string, fn: (ev: Event) => void): void;
  removeEventListener(type: string, fn: (ev: Event) => void): void;
}

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    textContent: '',
    innerHTML: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const idx = el.children.indexOf(c);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    addEventListener(type, fn) {
      const arr = el.listeners.get(type) ?? [];
      arr.push(fn);
      el.listeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = el.listeners.get(type);
      if (arr === undefined) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    remove() {
      if (el.parent !== null) el.parent.removeChild(el);
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const listeners = new Map<string, Array<(ev: Event) => void>>();
  const attrFromStyleSelector = (sel: string): string | null => {
    const match = sel.match(/^style\[([\w-]+)\]$/);
    return match?.[1] ?? null;
  };
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const attr = attrFromStyleSelector(sel);
        if (attr === null) return null;
        return styleElements.find((style) => style.attrs.has(attr)) ?? null;
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeEl(tag),
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (list === undefined) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
  };
};

const sourceRegistration = (kind: WorkEntityKind): SourceRegistration => ({
  id: `recued.${kind}`,
  top_tier_kind: kind,
  source_kind: 'builtin',
  source_label: `Recued ${kind}`,
  write_capable: true,
  mcp_exposed: false,
  enabled: true,
  registered_at: 1,
});

const emitInput = (
  routeRoot: FakeEl,
  target: {
    value: string;
    hasAttribute(k: string): boolean;
    getAttribute(k: string): string | null;
  },
): void => {
  for (const listener of routeRoot.listeners.get('input') ?? []) {
    listener({ target } as unknown as Event);
  }
};

const emitChange = (
  routeRoot: FakeEl,
  target: { value: string; getAttribute(k: string): string | null },
): void => {
  for (const listener of routeRoot.listeners.get('change') ?? []) {
    listener({ target } as unknown as Event);
  }
};

// Drive the route's delegated click handler as the DOM would: a synthetic
// target whose `closest('[data-recued-data-action]')` resolves an element
// carrying the action (the innerHTML is a string, so there are no real nodes to
// click). `extraAttrs` lets the same element also serve sibling data-attrs the
// dispatch reads off the action element (e.g. `data-collection-record` for the
// explorer record-open). Mirrors `emitInput`.
const emitClick = (
  routeRoot: FakeEl,
  action: string,
  extraAttrs: Record<string, string> = {},
): void => {
  const actionEl = {
    getAttribute: (k: string) =>
      k === 'data-recued-data-action' ? action : (extraAttrs[k] ?? null),
  };
  const target = {
    closest: (sel: string) =>
      sel === '[data-recued-data-action]' ? actionEl : null,
  };
  for (const listener of routeRoot.listeners.get('click') ?? []) {
    listener({ target } as unknown as Event);
  }
};

const taskEntity = (
  overrides: Partial<Extract<WorkEntity, { _kind: 'task' }>> = {},
): WorkEntity => ({
  _kind: 'task',
  id: 'task-1',
  title: 'Call Sam',
  done: false,
  source_id: 'recued.task',
  last_seen_at: 1,
  sync_state: 'live',
  conflict_policy: 'recued_wins',
  created_at: 1,
  updated_at: 2,
  blocks_task_ids: [],
  ...overrides,
});

const bookingEntity = (
  overrides: Partial<Extract<WorkEntity, { _kind: 'booking' }>> = {},
): Extract<WorkEntity, { _kind: 'booking' }> => ({
  _kind: 'booking',
  id: 'booking-1',
  title: 'Discovery call',
  lifecycle_state: 'confirmed',
  state_changed_at: 1,
  slot_start_at: NOW + 3_600_000,
  slot_end_at: NOW + 5_400_000,
  counterparty_contact_id: 'contact-opaque',
  source_id: 'recued.booking',
  last_seen_at: 1,
  sync_state: 'live',
  conflict_policy: 'recued_wins',
  created_at: 1,
  updated_at: 2,
  ...overrides,
});

const installFormResponseControls = (
  routeRoot: FakeEl,
  input: { values: string; email: string; lifecycle: string },
): void => {
  (routeRoot as unknown as { querySelector(selector: string): { value: string } | null })
    .querySelector = (selector) => {
      if (selector === `[${DATA_ROUTE_FORM_RESPONSE_VALUES_ATTR}]`) {
        return { value: input.values };
      }
      if (selector === `[${DATA_ROUTE_FORM_RESPONSE_EMAIL_ATTR}]`) {
        return { value: input.email };
      }
      if (selector === `[${DATA_ROUTE_FORM_RESPONSE_STATE_ATTR}]`) {
        return { value: input.lifecycle };
      }
      return null;
    };
};

const contactRecord = (
  overrides: Partial<ContactRecord> = {},
): ContactRecord => ({
  _id: 'sam@example.com',
  _collection: 'contact',
  email: 'sam@example.com',
  name: 'Sam Rivera',
  first_seen: 1,
  last_interaction: 2,
  interaction_count: 3,
  source: 'manual',
  created_at: 1,
  updated_at: 2,
  ...overrides,
});

/** D-205 #2c — a fixed "now" so the strip's relative sync times are deterministic. */
const NOW = 1_700_000_000_000;

const cycleCounts = (
  over: Partial<ContactSourceCycleCounts> = {},
): ContactSourceCycleCounts => ({
  hydrated: 0,
  unchanged: 0,
  skipped: 0, created: 0, promoted: 0,
  disconnected: 0,
  failed_rows: 0,
  unkeyable: 0,
  ambiguous: 0,
  conflicted: 0,
  repointed: 0,
  mirror_failed: 0,
  linked: 0,
  complete: true,
  ...over,
});

const sourceHealth = (
  over: Partial<ContactSourceHealth> & { source_id: string; source_label: string },
): ContactSourceHealth => ({
  enabled: true,
  last_success_at: NOW,
  degraded: false,
  stale: false,
  last_error_code: null,
  last_error_message: null,
  last_cycle: null,
  ...over,
});

const mergeCandidate = (
  overrides: Partial<ContactMergeCandidate> & { id: string; email_a: string; email_b: string },
): ContactMergeCandidate => ({
  pair_key: `${overrides.email_a}|${overrides.email_b}`,
  matched_fields: ['name', 'company'],
  detected_at: 1,
  detected_by: 'housekeeping',
  status: 'pending',
  ...overrides,
});

const formResponse = (
  overrides: Partial<FormResponse> = {},
): FormResponse => ({
  _id: 'submission-1',
  _collection: 'form_response',
  submission_id: 'submission-1',
  endpoint_id: 'endpoint-1',
  form_definition_id: 'project-intake',
  definition_snapshot: {
    form_definition_id: 'project-intake',
    fields: [
      { name: 'project', label: 'Tell us about your project', type: 'textarea' },
      { name: 'budget', label: 'Budget', type: 'number' },
    ],
  },
  values: { project: 'Launch a new site', budget: 2500 },
  visitor: { email: 'visitor@example.test' },
  submitted_at: 1_700_000_000_000,
  accepted_at: 1_700_000_005_000,
  updated_at: 1_700_000_005_000,
  origin_actor: 'anonymous',
  origin_surface: 'system',
  lifecycle_state: 'received',
  state_changed_at: 0,
  metadata: { template_ref: 'foundation:intake/project-brief' },
  ...overrides,
});

const formResponseListItem = (
  overrides: Partial<FormResponseListItem> = {},
): FormResponseListItem => ({
  submission_id: 'submission-1',
  endpoint_id: 'endpoint-1',
  form_definition_id: 'project-intake',
  visitor: { email: 'visitor@example.test' },
  submitted_at: 1_700_000_000_000,
  accepted_at: 1_700_000_005_000,
  updated_at: 1_700_000_005_000,
  lifecycle_state: 'received',
  state_changed_at: 0,
  template_ref: 'foundation:intake/project-brief',
  ...overrides,
});

const formResponseAutomationEntry = (
  recipe_id = 'handle-project-intake',
  where: Record<string, string> = { form_definition_id: 'project-intake' },
): ServerRecipeListEntry => {
  const recipe: RecipeDefinition = {
    recipe_id,
    version: 1,
    ttl: 300,
    metadata: {
      name: 'Handle project intake',
      description: '',
      author: 'local',
      supported_platforms: [],
    },
    variables: {},
    event_triggers: [{
      on: 'form_response.accepted',
      ...(Object.keys(where).length > 0 ? { where } : {}),
    }],
    prefetch_steps: [{
      id: 'form_response',
      op: 'core.data.form-response.get',
      args: { submission_id: '{{context.event.payload.record_id}}' },
    }],
    steps: [],
    output: { render: [] },
  };
  return {
    recipe_id,
    publisher_id: 'kitchen',
    version: 1,
    recipe_hash: `hash-${recipe_id}`,
    recipe,
    source: 'pair-sync',
    installed_at: 1,
  };
};

const executeResponse = (recipe_id: string): ServerExecuteResponse => ({
  recipe_id,
  recipe_hash: `hash-${recipe_id}`,
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 5,
});

const timelineResponse = (): TimelineResponse => ({
  entries: [
    {
      ts: 1_700_000_000_000,
      source: 'mail',
      kind: 'message',
      payload: { record_id: 'msg-1', subject: 'Launch', run_id: 'run-1' },
    },
  ],
});

/** A fake broadcast bus. Hoisted to module scope (it was inside the live-update
 *  describe) so the D-205 #2b scan tests can drive `merge_scan_progress` too. */
const makeSubscribe = () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const subscribe = ((kind: string, listener: (event: unknown) => void) => {
    listeners.set(kind, listener);
    return () => listeners.delete(kind);
  }) as unknown as NonNullable<BootstrapDataRouteOptions['subscribe']>;
  return { subscribe, listeners };
};

const mountRoute = (overrides: {
  sourceListCaller?: WorkEntitySourceListCaller;
  workEntityListCaller?: DataWorkEntityListCaller;
  workEntityGetCaller?: DataWorkEntityGetCaller;
  workEntityUpsertCaller?: DataWorkEntityUpsertCaller;
  workEntityDeleteCaller?: DataWorkEntityDeleteCaller;
  manageRescheduleLinkCaller?: DataManageRescheduleLinkCaller;
  contactListCaller?: DataContactListCaller;
  contactGetCaller?: DataContactGetCaller;
  /** D-205 item 3 — the per-source view. Opt-in, so the bare rig renders the detail
   *  page exactly as it did before and "unwired ⇒ no other-sources block" is the
   *  default state under test. */
  contactContributionsCaller?: DataContactContributionsCaller;
  // D-205 #2b — the merge callers are opt-in per test: unwired by DEFAULT so the
  // "no entry point when unwired" invariant is what the bare rig exercises.
  contactMergeListCaller?: DataContactMergeListCaller;
  contactMergeConfirmCaller?: DataContactMergeConfirmCaller;
  contactMergeRejectCaller?: DataContactMergeRejectCaller;
  contactMergeScanNowCaller?: DataContactMergeScanNowCaller;
  // D-205 #2c — opt-in, so the bare rig has NO strip and the no-caller-no-strip
  // invariant is the default state under test.
  contactSourceListCaller?: DataContactSourceListCaller;
  contactImportCandidatesCaller?: DataContactImportCandidatesCaller;
  contactImportPromoteCaller?: DataContactImportPromoteCaller;
  contactImportFilePreviewCaller?: DataContactImportFilePreviewCaller;
  contactImportFileApplyCaller?: DataContactImportFileApplyCaller;
  /** Opt-in clock. Only the #2c strip tests pin it (their copy is relative-time);
   *  leaving the rest on the real clock keeps the existing timeline assertions
   *  exactly as they were. */
  now?: () => number;
  contactUpsertCaller?: DataContactUpsertCaller;
  contactDeleteCaller?: DataContactDeleteCaller;
  formResponseListCaller?: DataFormResponseListCaller;
  formResponseGetCaller?: DataFormResponseGetCaller;
  formResponseUpdateCaller?: DataFormResponseUpdateCaller;
  formResponseSetStateCaller?: DataFormResponseSetStateCaller;
  formResponseExportCaller?: DataFormResponseExportCaller;
  formResponseDownload?: NonNullable<BootstrapDataRouteOptions['formResponseDownload']>;
  recipeListCaller?: DataRecipeListCaller;
  recipeExecuteCaller?: NonNullable<BootstrapDataRouteOptions['recipeExecuteCaller']>;
  omitRecipeCallers?: boolean;
  timelineCaller?: DataTimelineCaller;
  mirrorSearchCaller?: DataMirrorSearchCaller;
  fileReadCaller?: DataFileReadCaller;
  collectionListInstancesCaller?: BootstrapDataRouteOptions['collectionListInstancesCaller'];
  collectionListCaller?: BootstrapDataRouteOptions['collectionListCaller'];
  collectionGetCaller?: BootstrapDataRouteOptions['collectionGetCaller'];
  annotationListCaller?: BootstrapDataRouteOptions['annotationListCaller'];
  linkListCaller?: BootstrapDataRouteOptions['linkListCaller'];
  sharedListCaller?: BootstrapDataRouteOptions['sharedListCaller'];
  initialTab?: string;
  initialCollectionSlug?: string;
  initialEntityId?: string;
  chatReturn?: BootstrapDataRouteOptions['chatReturn'];
  logsReturn?: BootstrapDataRouteOptions['logsReturn'];
  verificationRelationship?:
    BootstrapDataRouteOptions['verificationRelationship'];
  verifyInitialSourceRecord?: boolean;
  replaceState?: (
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ) => void;
  subscribe?: BootstrapDataRouteOptions['subscribe'];
  liveRefreshDebounceMs?: number;
} = {}) => {
  const doc = makeFakeDocument();
  if (overrides.replaceState !== undefined) {
    (doc as unknown as { defaultView: unknown }).defaultView = {
      history: { replaceState: overrides.replaceState },
    };
  }
  const root = doc.createElement('div');
  const sources = WORK_ENTITY_KINDS.map(sourceRegistration);
  const sourceListCaller =
    overrides.sourceListCaller
    ?? vi.fn<WorkEntitySourceListCaller>(async () => ({
      sources,
      defaults_by_kind: { task: 'recued.task' },
    }));
  const workEntityListCaller =
    overrides.workEntityListCaller
    ?? vi.fn<DataWorkEntityListCaller>(async () => ({
      entities: [taskEntity()],
      total: 1,
    }));
  const workEntityGetCaller =
    overrides.workEntityGetCaller
    ?? vi.fn<DataWorkEntityGetCaller>(async () => ({
      entity: taskEntity(),
    }));
  const workEntityUpsertCaller =
    overrides.workEntityUpsertCaller
    ?? vi.fn<DataWorkEntityUpsertCaller>(async (args) => ({
      entity: taskEntity({
        title:
          typeof (args as { title?: unknown }).title === 'string'
            ? (args as { title: string }).title
            : 'Call Sam',
      }),
    }));
  const workEntityDeleteCaller =
    overrides.workEntityDeleteCaller
    ?? vi.fn<DataWorkEntityDeleteCaller>(async (args) => ({
      ok: true,
      id: args.id,
      tombstoned: true,
    }));
  const contactListCaller =
    overrides.contactListCaller
    ?? vi.fn<DataContactListCaller>(async () => ({
      contacts: [contactRecord()],
      total: 1,
    }));
  const contactGetCaller =
    overrides.contactGetCaller
    ?? vi.fn<DataContactGetCaller>(async () => ({
      contact: contactRecord(),
    }));
  const contactUpsertCaller =
    overrides.contactUpsertCaller
    ?? vi.fn<DataContactUpsertCaller>(async (args) => ({
      contact: contactRecord({
        email: args.email,
        name: args.name,
        phone: args.phone,
        company: args.company,
      }),
    }));
  const contactDeleteCaller =
    overrides.contactDeleteCaller
    ?? vi.fn<DataContactDeleteCaller>(async () => ({
      ok: true,
      deleted: true,
    }));
  const formResponseListCaller =
    overrides.formResponseListCaller
    ?? vi.fn<DataFormResponseListCaller>(async () => ({
      responses: [formResponseListItem()],
    }));
  const formResponseGetCaller =
    overrides.formResponseGetCaller
    ?? vi.fn<DataFormResponseGetCaller>(async (args) => ({
      response: args.submission_id === 'missing' ? null : formResponse({
        _id: args.submission_id,
        submission_id: args.submission_id,
      }),
    }));
  const formResponseUpdateCaller =
    overrides.formResponseUpdateCaller
    ?? vi.fn<DataFormResponseUpdateCaller>(async (args) => ({
      response: formResponse({
        _id: args.submission_id,
        submission_id: args.submission_id,
        values: args.values,
        visitor: args.visitor,
        updated_at: NOW + 1,
      }),
    }));
  const formResponseSetStateCaller =
    overrides.formResponseSetStateCaller
    ?? vi.fn<DataFormResponseSetStateCaller>(async (args) => ({
      response: formResponse({
        _id: args.submission_id,
        submission_id: args.submission_id,
        lifecycle_state: args.lifecycle_state,
        state_changed_at: NOW + 2,
      }),
    }));
  const formResponseExportCaller =
    overrides.formResponseExportCaller
    ?? vi.fn<DataFormResponseExportCaller>(async (args) => ({
      filename: `form-responses.${args.format}`,
      mime_type: args.format === 'json' ? 'application/json' : 'text/csv',
      content: args.format === 'json' ? '[]' : '"submission_id"',
      record_count: 0,
    }));
  const formResponseDownload =
    overrides.formResponseDownload ?? vi.fn();
  const recipeListCaller =
    overrides.recipeListCaller
    ?? vi.fn<DataRecipeListCaller>(async () => ({
      recipes: [formResponseAutomationEntry()],
    }));
  const recipeExecuteCaller =
    overrides.recipeExecuteCaller
    ?? vi.fn<NonNullable<BootstrapDataRouteOptions['recipeExecuteCaller']>>(
      async (args) => executeResponse(args.recipe_id),
    );
  const timelineCaller =
    overrides.timelineCaller
    ?? vi.fn<DataTimelineCaller>(async () => timelineResponse());
  const mirrorSearchCaller =
    overrides.mirrorSearchCaller
    ?? vi.fn<DataMirrorSearchCaller>(async () => ({
      results: [
        { entity_id: 'mail:mail:abc', label: 'Q3 proposal', sublabel: 'sam@acme.test' },
      ],
    }));

  const route = bootstrapDataRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    workEntitySourceListCaller: sourceListCaller,
    workEntityListCaller,
    workEntityGetCaller,
    workEntityUpsertCaller,
    workEntityDeleteCaller,
    ...(overrides.manageRescheduleLinkCaller !== undefined
      ? { manageRescheduleLinkCaller: overrides.manageRescheduleLinkCaller }
      : {}),
    contactListCaller,
    contactGetCaller,
    ...(overrides.contactContributionsCaller !== undefined
      ? { contactContributionsCaller: overrides.contactContributionsCaller }
      : {}),
    contactUpsertCaller,
    contactDeleteCaller,
    formResponseListCaller,
    formResponseGetCaller,
    formResponseUpdateCaller,
    formResponseSetStateCaller,
    formResponseExportCaller,
    formResponseDownload,
    ...(overrides.omitRecipeCallers === true
      ? {}
      : { recipeListCaller, recipeExecuteCaller }),
    timelineCaller,
    // `mirrorSearchCaller` still backs the run-modal file_ref picker
    // (`fileRefSearch`) + the recipe file-ref picker; the mirror-TAB timeline
    // picker it once fed was retired once mail/calendar/files moved to the
    // collection explorer.
    mirrorSearchCaller,
    ...(overrides.collectionListInstancesCaller !== undefined
      ? { collectionListInstancesCaller: overrides.collectionListInstancesCaller }
      : {}),
    ...(overrides.collectionListCaller !== undefined
      ? { collectionListCaller: overrides.collectionListCaller }
      : {}),
    ...(overrides.collectionGetCaller !== undefined
      ? { collectionGetCaller: overrides.collectionGetCaller }
      : {}),
    ...(overrides.annotationListCaller !== undefined
      ? { annotationListCaller: overrides.annotationListCaller }
      : {}),
    ...(overrides.linkListCaller !== undefined
      ? { linkListCaller: overrides.linkListCaller }
      : {}),
    ...(overrides.sharedListCaller !== undefined
      ? { sharedListCaller: overrides.sharedListCaller }
      : {}),
    ...(overrides.fileReadCaller !== undefined ? { fileReadCaller: overrides.fileReadCaller } : {}),
    ...(overrides.initialTab !== undefined ? { initialTab: overrides.initialTab } : {}),
    ...(overrides.initialCollectionSlug !== undefined
      ? { initialCollectionSlug: overrides.initialCollectionSlug }
      : {}),
    ...(overrides.initialEntityId !== undefined
      ? { initialEntityId: overrides.initialEntityId }
      : {}),
    ...(overrides.chatReturn !== undefined
      ? { chatReturn: overrides.chatReturn }
      : {}),
    ...(overrides.logsReturn !== undefined
      ? { logsReturn: overrides.logsReturn }
      : {}),
    ...(overrides.verificationRelationship !== undefined
      ? {
          verificationRelationship:
            overrides.verificationRelationship,
        }
      : {}),
    ...(overrides.verifyInitialSourceRecord === true
      ? { verifyInitialSourceRecord: true }
      : {}),
    ...(overrides.subscribe !== undefined ? { subscribe: overrides.subscribe } : {}),
    ...(overrides.liveRefreshDebounceMs !== undefined
      ? { liveRefreshDebounceMs: overrides.liveRefreshDebounceMs }
      : {}),
    // D-205 #2b — opt-in, so the bare rig has NO merge callers and the
    // no-entry-point-when-unwired invariant is the default state under test.
    ...(overrides.contactMergeListCaller !== undefined
      ? { contactMergeListCaller: overrides.contactMergeListCaller }
      : {}),
    ...(overrides.contactMergeConfirmCaller !== undefined
      ? { contactMergeConfirmCaller: overrides.contactMergeConfirmCaller }
      : {}),
    ...(overrides.contactMergeRejectCaller !== undefined
      ? { contactMergeRejectCaller: overrides.contactMergeRejectCaller }
      : {}),
    ...(overrides.contactMergeScanNowCaller !== undefined
      ? { contactMergeScanNowCaller: overrides.contactMergeScanNowCaller }
      : {}),
    ...(overrides.contactSourceListCaller !== undefined
      ? { contactSourceListCaller: overrides.contactSourceListCaller }
      : {}),
    ...(overrides.contactImportCandidatesCaller !== undefined
      ? { contactImportCandidatesCaller: overrides.contactImportCandidatesCaller }
      : {}),
    ...(overrides.contactImportPromoteCaller !== undefined
      ? { contactImportPromoteCaller: overrides.contactImportPromoteCaller }
      : {}),
    ...(overrides.contactImportFilePreviewCaller !== undefined
      ? { contactImportFilePreviewCaller: overrides.contactImportFilePreviewCaller }
      : {}),
    ...(overrides.contactImportFileApplyCaller !== undefined
      ? { contactImportFileApplyCaller: overrides.contactImportFileApplyCaller }
      : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });

  return {
    doc,
    root,
    route,
    sourceListCaller,
    workEntityListCaller,
    workEntityGetCaller,
    workEntityUpsertCaller,
    workEntityDeleteCaller,
    contactListCaller,
    contactGetCaller,
    ...(overrides.contactContributionsCaller !== undefined
      ? { contactContributionsCaller: overrides.contactContributionsCaller }
      : {}),
    contactUpsertCaller,
    contactDeleteCaller,
    formResponseListCaller,
    formResponseGetCaller,
    formResponseUpdateCaller,
    formResponseSetStateCaller,
    formResponseExportCaller,
    formResponseDownload,
    recipeListCaller,
    recipeExecuteCaller,
    timelineCaller,
    mirrorSearchCaller,
  };
};

describe('D-174 P5 Data route', () => {
  it('mounts #data as one back-office surface with own-it and mirror tabs', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();

    expect(rig.doc.styleElements[0]?.attrs.has(DATA_ROUTE_STYLES_MARKER)).toBe(true);
    const shell = rig.root.children[0]!;
    expect(shell.attrs.has(DATA_ROUTE_HOST_ATTR)).toBe(true);
    expect(shell.innerHTML).toContain(DATA_ROUTE_HEADING_ATTR);
    expect(shell.innerHTML).toContain(`${DATA_ROUTE_TAB_ATTR}="contact"`);
    expect(shell.innerHTML).toContain(`${DATA_ROUTE_TAB_ATTR}="task"`);
    expect(shell.innerHTML).toContain(`${DATA_ROUTE_TAB_ATTR}="form_response"`);
    expect(shell.innerHTML).toContain(`${DATA_ROUTE_TAB_ATTR}="mail"`);
    // Accepted visitor input has its own Received group between owner-authored
    // and connected mirror data.
    expect(shell.innerHTML).toContain('data-tab-group-label');
    expect(shell.innerHTML).toContain('Owned');
    expect(shell.innerHTML).toContain('Received');
    expect(shell.innerHTML).toContain('Connected');
    expect(shell.innerHTML).toContain('Sam Rivera');
    expect(rig.sourceListCaller).not.toHaveBeenCalled();
    expect(rig.contactListCaller).toHaveBeenCalledWith({ limit: 100 });

    rig.route.dispose();
    expect(rig.root.children).toHaveLength(0);
  });

  it('shows a connect-a-source CTA instead of a bare empty message when the warehouse is empty', async () => {
    const rig = mountRoute({
      contactListCaller: vi.fn<DataContactListCaller>(async () => ({
        contacts: [],
        total: 0,
      })),
    });
    await rig.route.whenLoaded();
    const html = rig.root.children[0]?.innerHTML ?? '';
    // Cold-start nudge (UX-review step 6), not a dead-end "No contacts returned."
    expect(html).toContain('Connect a source');
    expect(html).toContain('href="#connections"');
    expect(html).not.toContain('No contacts returned.');
    rig.route.dispose();
  });

  it('browses accepted form responses as an owner-editable Received collection', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();

    await rig.route.selectTab('form_response');

    expect(rig.formResponseListCaller).toHaveBeenCalledWith({ limit: 100 });
    expect(rig.route.formResponses()).toHaveLength(1);
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(DATA_ROUTE_FORM_RESPONSE_ROW_ATTR);
    expect(html).toContain('visitor@example.test');
    expect(html).toContain('Project Brief');
    expect(html).toContain('received');

    rig.route.dispose();
  });

  it('keeps standalone form responses independent from work-entity Sources', async () => {
    const sourceListCaller = vi.fn<WorkEntitySourceListCaller>(async () => {
      throw new Error('work-entity Sources unavailable');
    });
    const rig = mountRoute({ sourceListCaller, initialTab: 'form_response' });
    await rig.route.whenLoaded();

    expect(sourceListCaller).not.toHaveBeenCalled();
    expect(rig.formResponseListCaller).toHaveBeenCalledWith({ limit: 100 });
    expect(rig.route.getLoadErrors()).toEqual({});
    expect(rig.root.children[0]?.innerHTML).toContain('visitor@example.test');
    rig.route.dispose();
  });

  it('opens a deep response view using frozen field labels and escapes visitor values', async () => {
    const response = formResponse({
      values: {
        project: '<script>not markup</script>',
        budget: 2500,
        extra_context: ['A', 'B'],
      },
    });
    const formResponseGetCaller = vi.fn<DataFormResponseGetCaller>(async () => ({
      response,
    }));
    const rig = mountRoute({ formResponseGetCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('form_response');
    await rig.route.openFormResponse('submission-1');

    expect(formResponseGetCaller).toHaveBeenCalledWith({
      submission_id: 'submission-1',
    });
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR);
    expect(html).toContain('Tell us about your project');
    expect(html).toContain('Extra Context');
    expect(html).toContain('&lt;script&gt;not markup&lt;/script&gt;');
    expect(html).not.toContain('<script>not markup</script>');
    expect(html).toContain('Accepted');
    expect(html).toContain('submission-1');
    expect(html).toContain('endpoint-1');
    expect(html).toContain(
      `${DATA_ROUTE_FORM_RESPONSE_AUTOMATE_ATTR}="project-intake"`,
    );
    expect(html).toContain(
      'href="#kitchen/new/form-response/project-intake"',
    );
    expect(html).toContain('future owner-accepted responses');

    rig.route.closeFormResponse();
    expect(rig.root.children[0]?.innerHTML).toContain(DATA_ROUTE_FORM_RESPONSE_ROW_ATTR);
    rig.route.dispose();
  });

  it('saves edited form-response content and lifecycle through the two narrow RPCs', async () => {
    const formResponseUpdateCaller = vi.fn<DataFormResponseUpdateCaller>(async (args) => ({
      response: formResponse({
        values: args.values,
        visitor: args.visitor,
        updated_at: NOW + 1,
      }),
    }));
    const formResponseSetStateCaller = vi.fn<DataFormResponseSetStateCaller>(async (args) => ({
      response: formResponse({
        values: { project: 'Owner revised', budget: 3000 },
        visitor: { email: 'corrected@example.test' },
        lifecycle_state: args.lifecycle_state,
        state_changed_at: NOW + 2,
        updated_at: NOW + 1,
      }),
    }));
    const rig = mountRoute({ formResponseUpdateCaller, formResponseSetStateCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('form_response');
    await rig.route.openFormResponse('submission-1');
    installFormResponseControls(rig.root.children[0]!, {
      values: JSON.stringify({ project: 'Owner revised', budget: 3000 }),
      email: ' corrected@example.test ',
      lifecycle: 'in_review',
    });

    await rig.route.saveFormResponse();
    expect(formResponseUpdateCaller).toHaveBeenCalledWith({
      submission_id: 'submission-1',
      values: { project: 'Owner revised', budget: 3000 },
      visitor: { email: 'corrected@example.test' },
    });
    expect(formResponseSetStateCaller).toHaveBeenCalledWith({
      submission_id: 'submission-1',
      lifecycle_state: 'in_review',
    });
    rig.route.dispose();
  });

  it('refuses malformed answer JSON in the form-response editor before either write', async () => {
    const formResponseUpdateCaller = vi.fn<DataFormResponseUpdateCaller>();
    const formResponseSetStateCaller = vi.fn<DataFormResponseSetStateCaller>();
    const rig = mountRoute({ formResponseUpdateCaller, formResponseSetStateCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('form_response');
    await rig.route.openFormResponse('submission-1');
    installFormResponseControls(rig.root.children[0]!, {
      values: '["not", "an", "object"]',
      email: 'visitor@example.test',
      lifecycle: 'received',
    });

    await rig.route.saveFormResponse();
    expect(formResponseUpdateCaller).not.toHaveBeenCalled();
    expect(formResponseSetStateCaller).not.toHaveBeenCalled();
    expect(rig.root.children[0]?.innerHTML).toContain('Answers must be a JSON object');
    rig.route.dispose();
  });

  it('exports the received collection through the bounded server export', async () => {
    const file = {
      filename: 'form-responses-2026-07-21.csv',
      mime_type: 'text/csv' as const,
      content: '"submission_id"',
      record_count: 1,
    };
    const formResponseExportCaller = vi.fn<DataFormResponseExportCaller>(async () => file);
    const formResponseDownload = vi.fn();
    const rig = mountRoute({ formResponseExportCaller, formResponseDownload });
    await rig.route.whenLoaded();
    await rig.route.selectTab('form_response');

    await rig.route.exportFormResponses('csv');
    expect(formResponseExportCaller).toHaveBeenCalledWith({ format: 'csv' });
    expect(formResponseDownload).toHaveBeenCalledWith(file);
    rig.route.dispose();
  });

  it('follows the export resume cursor to assemble ONE complete file', async () => {
    // ⛔ The server bounds one rpc payload and returns `next_cursor`. If the
    // client did not loop, that cursor would be an unused seam and an owner
    // past the ceiling would silently download only the first chunk — the
    // failure mode that is worse than the refusal this replaced.
    const cursor = { accepted_at: 1_700_000_000_000, submission_id: 'sub-10000' };
    const chunks = [
      {
        filename: 'form-responses-2026-07-21.csv',
        mime_type: 'text/csv' as const,
        content: '"submission_id"\r\n"a"',
        record_count: 2,
        next_cursor: cursor,
      },
      {
        filename: 'form-responses-2026-07-21.csv',
        mime_type: 'text/csv' as const,
        content: '"b"',
        record_count: 1,
      },
    ];
    let call = 0;
    const formResponseExportCaller = vi.fn<DataFormResponseExportCaller>(
      async () => chunks[call++]!,
    );
    const formResponseDownload = vi.fn();
    const rig = mountRoute({ formResponseExportCaller, formResponseDownload });
    await rig.route.whenLoaded();
    await rig.route.selectTab('form_response');

    await rig.route.exportFormResponses('csv');
    expect(formResponseExportCaller).toHaveBeenNthCalledWith(1, { format: 'csv' });
    // The second call MUST carry the cursor — otherwise it re-reads chunk one.
    expect(formResponseExportCaller).toHaveBeenNthCalledWith(2, {
      format: 'csv',
      before: cursor,
    });
    const downloaded = formResponseDownload.mock.calls[0]![0] as {
      content: string;
      record_count: number;
    };
    // One header, both chunks, and a count spanning them.
    expect(downloaded.content).toBe('"submission_id"\r\n"a"\r\n"b"');
    expect(downloaded.record_count).toBe(3);
    rig.route.dispose();
  });

  it('concatenates JSON export chunks into one valid document', async () => {
    const cursor = { accepted_at: 1_700_000_000_000, submission_id: 'sub-x' };
    const chunks = [
      {
        filename: 'form-responses-2026-07-21.json',
        mime_type: 'application/json' as const,
        content: JSON.stringify([{ submission_id: 'a' }]),
        record_count: 1,
        next_cursor: cursor,
      },
      {
        filename: 'form-responses-2026-07-21.json',
        mime_type: 'application/json' as const,
        content: JSON.stringify([{ submission_id: 'b' }]),
        record_count: 1,
      },
    ];
    let call = 0;
    const formResponseExportCaller = vi.fn<DataFormResponseExportCaller>(
      async () => chunks[call++]!,
    );
    const formResponseDownload = vi.fn();
    const rig = mountRoute({ formResponseExportCaller, formResponseDownload });
    await rig.route.whenLoaded();
    await rig.route.selectTab('form_response');

    await rig.route.exportFormResponses('json');
    const downloaded = formResponseDownload.mock.calls[0]![0] as { content: string };
    // ⚠ Text-concatenating two JSON arrays would NOT parse. Re-wrapped instead.
    expect(JSON.parse(downloaded.content)).toEqual([
      { submission_id: 'a' },
      { submission_id: 'b' },
    ]);
    rig.route.dispose();
  });

  it('deep-links automation by form definition without putting a submission id in the route', async () => {
    const response = formResponse({
      form_definition_id: 'forms/client intake',
      definition_snapshot: {
        form_definition_id: 'forms/client intake',
        fields: [],
      },
    });
    const rig = mountRoute({
      formResponseGetCaller: vi.fn<DataFormResponseGetCaller>(async () => ({
        response,
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.selectTab('form_response');
    await rig.route.openFormResponse('submission-1');

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(
      'href="#kitchen/new/form-response/forms%2Fclient%20intake"',
    );
    expect(html).not.toContain(
      'href="#kitchen/new/form-response/submission-1"',
    );
    rig.route.dispose();
  });

  it('reviews and manually runs a matching automation with routing-only event context', async () => {
    const matching = formResponseAutomationEntry();
    const wrongEndpoint = formResponseAutomationEntry(
      'wrong-endpoint',
      { form_definition_id: 'project-intake', endpoint_id: 'endpoint-2' },
    );
    const recipeListCaller = vi.fn<DataRecipeListCaller>(async () => ({
      recipes: [matching, wrongEndpoint],
    }));
    const recipeExecuteCaller = vi.fn<
      NonNullable<BootstrapDataRouteOptions['recipeExecuteCaller']>
    >(async (args) => executeResponse(args.recipe_id));
    const rig = mountRoute({ recipeListCaller, recipeExecuteCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('form_response');
    await rig.route.openFormResponse('submission-1');

    let html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(DATA_ROUTE_FORM_RESPONSE_RUN_ATTR);
    expect(recipeListCaller).not.toHaveBeenCalled();

    await rig.route.discoverFormResponseAutomations();
    expect(recipeListCaller).toHaveBeenCalledTimes(1);
    html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(`${DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR}="ready"`);
    expect(html).toContain(
      `${DATA_ROUTE_FORM_RESPONSE_RUN_RECIPE_ATTR}="handle-project-intake"`,
    );
    expect(html).not.toContain(
      `${DATA_ROUTE_FORM_RESPONSE_RUN_RECIPE_ATTR}="wrong-endpoint"`,
    );
    expect(html).toContain('explicit manual run');

    // A forged/stale DOM recipe id cannot bypass the matched picker state.
    rig.route.reviewFormResponseAutomation('wrong-endpoint');
    expect(rig.root.children).toHaveLength(1);
    expect(recipeExecuteCaller).not.toHaveBeenCalled();

    rig.route.reviewFormResponseAutomation('handle-project-intake');
    expect(rig.root.children).toHaveLength(2);
    const modalHtml = rig.root.children[1]?.innerHTML ?? '';
    expect(modalHtml).toContain('Context JSON (prefilled)');
    expect(modalHtml).toContain('record_id');
    expect(modalHtml).not.toContain('visitor@example.test');
    expect(modalHtml).not.toContain('Launch a new site');

    await rig.route.confirmFormResponseAutomationRun();
    expect(recipeExecuteCaller).toHaveBeenCalledWith({
      recipe_id: 'handle-project-intake',
      config: {},
      context: {
        event: {
          topic: ['data', 'form_response', 'accepted', 'response', 'created'],
          kind: 'created',
          payload: {
            record_id: 'submission-1',
            at: 1_700_000_005_000,
            platform: 'form_response',
            slug: 'accepted',
            entity_type: 'response',
            record: {
              _id: 'submission-1',
              _collection: 'form_response',
              submission_id: 'submission-1',
              endpoint_id: 'endpoint-1',
              form_definition_id: 'project-intake',
              submitted_at: 1_700_000_000_000,
              accepted_at: 1_700_000_005_000,
            },
          },
        },
      },
    });

    rig.route.closeFormResponse();
    expect(rig.root.children).toHaveLength(1);
    rig.route.dispose();
  });

  it('drops a late automation lookup and hides manual run when callers are absent', async () => {
    let resolveRecipes!: (value: { recipes: ServerRecipeListEntry[] }) => void;
    const pending = new Promise<{ recipes: ServerRecipeListEntry[] }>((resolve) => {
      resolveRecipes = resolve;
    });
    const withPending = mountRoute({
      recipeListCaller: () => pending,
    });
    await withPending.route.whenLoaded();
    await withPending.route.selectTab('form_response');
    await withPending.route.openFormResponse('submission-1');
    const discovery = withPending.route.discoverFormResponseAutomations();
    withPending.route.closeFormResponse();
    resolveRecipes({ recipes: [formResponseAutomationEntry()] });
    await discovery;
    expect(withPending.root.children[0]?.innerHTML).not.toContain(
      DATA_ROUTE_FORM_RESPONSE_RUN_PICKER_ATTR,
    );
    withPending.route.dispose();

    const absent = mountRoute({ omitRecipeCallers: true });
    await absent.route.whenLoaded();
    await absent.route.selectTab('form_response');
    await absent.route.openFormResponse('submission-1');
    expect(absent.root.children[0]?.innerHTML).not.toContain(
      DATA_ROUTE_FORM_RESPONSE_RUN_ATTR,
    );
    absent.route.dispose();
  });

  it('renders out-of-Date-range timestamps without crashing the detail view', async () => {
    const extreme = formResponse({
      submitted_at: Number.MAX_SAFE_INTEGER,
      accepted_at: Number.MAX_SAFE_INTEGER,
    });
    const rig = mountRoute({
      formResponseGetCaller: vi.fn<DataFormResponseGetCaller>(async () => ({
        response: extreme,
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.selectTab('form_response');
    await expect(rig.route.openFormResponse('submission-1')).resolves.toBeUndefined();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR);
    expect(html).toContain(String(Number.MAX_SAFE_INTEGER));
    rig.route.dispose();
  });

  it('distinguishes a detail read failure from a genuinely missing response', async () => {
    const failing = mountRoute({
      formResponseGetCaller: vi.fn<DataFormResponseGetCaller>(async () => {
        throw new Error('server temporarily unavailable');
      }),
    });
    await failing.route.whenLoaded();
    await failing.route.selectTab('form_response');
    await failing.route.openFormResponse('submission-1');
    let html = failing.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('Could not load this form response');
    expect(html).not.toContain('This form response was not found');
    failing.route.dispose();

    const missing = mountRoute({
      formResponseGetCaller: vi.fn<DataFormResponseGetCaller>(async () => ({
        response: null,
      })),
    });
    await missing.route.whenLoaded();
    await missing.route.selectTab('form_response');
    await missing.route.openFormResponse('missing');
    html = missing.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('This form response was not found');
    expect(html).not.toContain('Could not load this form response');
    missing.route.dispose();
  });

  it('drops a stale detail fetch after a newer response opens', async () => {
    let resolveFirst!: (value: { response: FormResponse | null }) => void;
    let resolveSecond!: (value: { response: FormResponse | null }) => void;
    const first = new Promise<{ response: FormResponse | null }>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<{ response: FormResponse | null }>((resolve) => {
      resolveSecond = resolve;
    });
    const get = vi.fn<DataFormResponseGetCaller>((args) =>
      args.submission_id === 'submission-a' ? first : second,
    );
    const rig = mountRoute({ formResponseGetCaller: get });
    await rig.route.whenLoaded();
    await rig.route.selectTab('form_response');

    const openFirst = rig.route.openFormResponse('submission-a');
    const openSecond = rig.route.openFormResponse('submission-b');
    resolveSecond({
      response: formResponse({
        _id: 'submission-b',
        submission_id: 'submission-b',
        visitor: { email: 'newer@example.test' },
      }),
    });
    await openSecond;
    resolveFirst({
      response: formResponse({
        _id: 'submission-a',
        submission_id: 'submission-a',
        visitor: { email: 'stale@example.test' },
      }),
    });
    await openFirst;

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('newer@example.test');
    expect(html).not.toContain('stale@example.test');
    expect(html).toContain(
      `${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}="submission-b"`,
    );
    rig.route.dispose();
  });

  it('paginates form responses with the server composite cursor', async () => {
    const cursor = {
      accepted_at: 1_700_000_005_000,
      submission_id: 'submission-1',
    };
    const formResponseListCaller = vi.fn<DataFormResponseListCaller>(async (args) =>
      args.before === undefined
        ? {
            responses: [formResponseListItem()],
            next_cursor: cursor,
          }
        : {
            responses: [formResponseListItem({
              submission_id: 'submission-0',
              visitor: {},
              accepted_at: 1_700_000_004_000,
            })],
          },
    );
    const rig = mountRoute({ formResponseListCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('form_response');

    expect(rig.root.children[0]?.innerHTML).toContain(
      DATA_ROUTE_FORM_RESPONSE_LOAD_MORE_ATTR,
    );
    emitClick(rig.root.children[0]!, 'load-more-form-responses');
    await rig.route.whenLoaded();

    expect(formResponseListCaller).toHaveBeenLastCalledWith({
      limit: 100,
      before: cursor,
    });
    expect(rig.route.formResponses().map((row) => row.submission_id)).toEqual([
      'submission-1',
      'submission-0',
    ]);
    expect(rig.root.children[0]?.innerHTML).not.toContain(
      DATA_ROUTE_FORM_RESPONSE_LOAD_MORE_ATTR,
    );
    expect(rig.root.children[0]?.innerHTML).toContain('Anonymous visitor');
    rig.route.dispose();
  });

  it('wires contact create/edit through contact.* callers', async () => {
    const contactUpsertCaller = vi.fn<DataContactUpsertCaller>(async (args) => ({
      contact: contactRecord({
        email: args.email,
        name: args.name,
        phone: args.phone,
        company: args.company,
      }),
    }));
    const rig = mountRoute({ contactUpsertCaller });
    await rig.route.whenLoaded();

    await rig.route.openEditContactDialog('sam@example.com');
    expect(rig.contactGetCaller).toHaveBeenCalledWith({
      email: 'sam@example.com',
    });
    expect(rig.root.children[0]?.innerHTML).toContain(DATA_ROUTE_CONTACT_DIALOG_ATTR);

    rig.route.openCreateContactDialog();
    rig.route.setContactDialogValues({
      email: 'lee@example.com',
      name: 'Lee Morgan',
      phone: '+15555550123',
      company: 'Example Co',
    });
    await rig.route.confirmContactDialog();

    expect(contactUpsertCaller).toHaveBeenCalledWith({
      email: 'lee@example.com',
      name: 'Lee Morgan',
      phone: '+15555550123',
      company: 'Example Co',
    });

    rig.route.dispose();
  });

  it('loads an editable work-entity tab and submits edits via work_entity upsert', async () => {
    const workEntityUpsertCaller = vi.fn<DataWorkEntityUpsertCaller>(async (args) => ({
      entity: taskEntity({
        title:
          typeof (args as { title?: unknown }).title === 'string'
            ? (args as { title: string }).title
            : 'Call Sam',
      }),
    }));
    const rig = mountRoute({ workEntityUpsertCaller });
    await rig.route.whenLoaded();

    await rig.route.selectTab('task');
    expect(rig.workEntityListCaller).toHaveBeenCalledWith({
      kind: 'task',
      limit: 100,
    });
    expect(rig.root.children[0]?.innerHTML).toContain('work-entity-page');
    expect(rig.root.children[0]?.innerHTML).toContain('Call Sam');

    await rig.route.openEditWorkEntityDialog('task', 'task-1');
    expect(rig.workEntityGetCaller).toHaveBeenCalledWith({
      kind: 'task',
      id: 'task-1',
    });
    const dialog = rig.route.workEntityState().dialog;
    expect(dialog?.mode).toBe('edit');
    rig.route.setWorkEntityDialogValues({
      ...(dialog?.values ?? {}),
      title: 'Call Sam final',
    });
    await rig.route.confirmWorkEntityDialog();

    expect(workEntityUpsertCaller).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'task',
        id: 'task-1',
        title: 'Call Sam final',
      }),
    );

    rig.route.dispose();
  });

  it('sends booking search and lifecycle filters to the server before pagination', async () => {
    const workEntityListCaller = vi.fn<DataWorkEntityListCaller>(async () => ({
      entities: [bookingEntity()],
      total: 1,
    }));
    const rig = mountRoute({ workEntityListCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('booking');

    emitInput(rig.root.children[0]!, {
      value: 'contact-opaque',
      hasAttribute: () => false,
      getAttribute: (attr) => attr === 'data-action'
        ? 'search-work-entities'
        : attr === 'data-kind' ? 'booking' : null,
    });
    await rig.route.whenLoaded();
    expect(workEntityListCaller).toHaveBeenLastCalledWith({
      kind: 'booking',
      search: 'contact-opaque',
      limit: 100,
    });

    emitChange(rig.root.children[0]!, {
      value: 'completed',
      getAttribute: (attr) => attr === 'data-action' ? 'filter-booking-lifecycle' : null,
    });
    await rig.route.whenLoaded();
    expect(workEntityListCaller).toHaveBeenLastCalledWith({
      kind: 'booking',
      search: 'contact-opaque',
      booking_lifecycle_states: ['completed'],
      limit: 100,
    });
    rig.route.dispose();
  });

  it('opens owner booking detail with prior terminal history and the edit affordance', async () => {
    const booking = bookingEntity();
    const workEntityListCaller = vi.fn<DataWorkEntityListCaller>(async () => ({
      entities: [booking], total: 1,
    }));
    const workEntityGetCaller = vi.fn<DataWorkEntityGetCaller>(async () => ({
      entity: booking,
      booking_history: {
        counterparty_contact_id: 'contact-opaque',
        total: 1,
        entries: [{
          id: 'booking-old',
          title: 'Earlier call',
          lifecycle_state: 'no_show',
          created_at: 1,
          state_changed_at: 2,
        }],
      },
    }));
    const rig = mountRoute({ workEntityListCaller, workEntityGetCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('booking');
    emitClick(rig.root.children[0]!, 'open-work-entity-detail', {
      'data-kind': 'booking',
      'data-entity-id': 'booking-1',
    });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    expect(workEntityGetCaller).toHaveBeenCalledWith({ kind: 'booking', id: 'booking-1' });
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('Discovery call');
    expect(html).toContain('Previous bookings (1)');
    expect(html).toContain('Earlier call');
    expect(html).toContain('Edit / reschedule');
    expect(html).not.toContain('@');
    rig.route.dispose();
  });

  it('copies a manage link from Reception booking detail and hides the action for manual bookings', async () => {
    const manageRescheduleLinkCaller = vi.fn<DataManageRescheduleLinkCaller>(async () => ({
      url: 'https://recued.test/reception/manage/one-time-secret',
      expires_at: NOW + 86_400_000,
    }));
    const writeText = vi.fn(async (_value: string) => undefined);
    const receptionBooking = bookingEntity({ reception_record_id: 'reservation-1' });
    const rig = mountRoute({
      workEntityListCaller: vi.fn(async () => ({ entities: [receptionBooking], total: 1 })),
      workEntityGetCaller: vi.fn(async () => ({ entity: receptionBooking })),
      manageRescheduleLinkCaller,
    });
    (rig.doc as unknown as { defaultView: unknown }).defaultView = {
      navigator: { clipboard: { writeText } },
    };
    await rig.route.whenLoaded();
    await rig.route.selectTab('booking');
    emitClick(rig.root.children[0]!, 'open-work-entity-detail', {
      'data-kind': 'booking', 'data-entity-id': receptionBooking.id,
    });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(rig.root.children[0]?.innerHTML).toContain('Copy reschedule link');

    emitClick(rig.root.children[0]!, 'copy-booking-manage-link', {
      'data-entity-id': receptionBooking.id,
    });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(manageRescheduleLinkCaller).toHaveBeenCalledWith({ booking_id: receptionBooking.id });
    expect(writeText).toHaveBeenCalledWith(
      'https://recued.test/reception/manage/one-time-secret',
    );
    expect(rig.root.children[0]?.innerHTML).toContain('single-use and expires soon');
    expect(rig.root.children[0]?.innerHTML).not.toContain('one-time-secret');
    rig.route.dispose();

    const manual = bookingEntity({ id: 'manual-booking' });
    const manualRig = mountRoute({
      workEntityListCaller: vi.fn(async () => ({ entities: [manual], total: 1 })),
      workEntityGetCaller: vi.fn(async () => ({ entity: manual })),
      manageRescheduleLinkCaller,
    });
    await manualRig.route.whenLoaded();
    await manualRig.route.selectTab('booking');
    emitClick(manualRig.root.children[0]!, 'open-work-entity-detail', {
      'data-kind': 'booking', 'data-entity-id': manual.id,
    });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(manualRig.root.children[0]?.innerHTML).not.toContain('Copy reschedule link');
    manualRig.route.dispose();
  });

  it('shows the manage URL when clipboard is unavailable and drops a stale mint completion', async () => {
    let resolveMint!: (value: { url: string; expires_at: number }) => void;
    const mint = new Promise<{ url: string; expires_at: number }>((resolve) => {
      resolveMint = resolve;
    });
    const manageRescheduleLinkCaller = vi.fn<DataManageRescheduleLinkCaller>(() => mint);
    const workEntityGetCaller = vi.fn<DataWorkEntityGetCaller>(async ({ id }) => ({
      entity: bookingEntity({
        id,
        title: id === 'booking-2' ? 'Second booking' : 'First booking',
        reception_record_id: `reservation-${id}`,
      }),
    }));
    const rig = mountRoute({
      workEntityListCaller: vi.fn(async () => ({ entities: [], total: 0 })),
      workEntityGetCaller,
      manageRescheduleLinkCaller,
    });
    await rig.route.whenLoaded();
    await rig.route.selectTab('booking');
    emitClick(rig.root.children[0]!, 'open-work-entity-detail', {
      'data-kind': 'booking', 'data-entity-id': 'booking-1',
    });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    emitClick(rig.root.children[0]!, 'copy-booking-manage-link');
    for (let i = 0; i < 2; i += 1) await Promise.resolve();
    emitClick(rig.root.children[0]!, 'open-work-entity-detail', {
      'data-kind': 'booking', 'data-entity-id': 'booking-2',
    });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();

    resolveMint({
      url: 'https://recued.test/reception/manage/stale-secret',
      expires_at: NOW + 86_400_000,
    });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('Second booking');
    expect(html).not.toContain('stale-secret');
    expect(html).not.toContain('single-use and expires soon');
    rig.route.dispose();

    const fallbackCaller = vi.fn<DataManageRescheduleLinkCaller>(async () => ({
      url: 'https://recued.test/reception/manage/manual-copy',
      expires_at: NOW + 86_400_000,
    }));
    const fallbackBooking = bookingEntity({ reception_record_id: 'reservation-fallback' });
    const fallbackRig = mountRoute({
      workEntityListCaller: vi.fn(async () => ({ entities: [fallbackBooking], total: 1 })),
      workEntityGetCaller: vi.fn(async () => ({ entity: fallbackBooking })),
      manageRescheduleLinkCaller: fallbackCaller,
    });
    await fallbackRig.route.whenLoaded();
    await fallbackRig.route.selectTab('booking');
    emitClick(fallbackRig.root.children[0]!, 'open-work-entity-detail', {
      'data-kind': 'booking', 'data-entity-id': fallbackBooking.id,
    });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    emitClick(fallbackRig.root.children[0]!, 'copy-booking-manage-link');
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(fallbackRig.root.children[0]?.innerHTML).toContain(
      'https://recued.test/reception/manage/manual-copy',
    );
    fallbackRig.route.dispose();
  });

  it('hydrates a booking deep link and drops a stale detail response', async () => {
    const deepGet = vi.fn<DataWorkEntityGetCaller>(async () => ({
      entity: bookingEntity({ id: 'booking-deep', title: 'Deep-linked booking' }),
      booking_history: {
        counterparty_contact_id: 'contact-opaque', total: 0, entries: [],
      },
    }));
    const deep = mountRoute({
      initialTab: 'booking',
      initialEntityId: 'booking-deep',
      workEntityListCaller: vi.fn(async () => ({ entities: [], total: 0 })),
      workEntityGetCaller: deepGet,
    });
    await deep.route.whenLoaded();
    expect(deepGet).toHaveBeenCalledWith({ kind: 'booking', id: 'booking-deep' });
    expect(deep.root.children[0]?.innerHTML).toContain('Deep-linked booking');
    deep.route.dispose();

    let resolveFirst!: (value: { entity: WorkEntity | null }) => void;
    let resolveSecond!: (value: { entity: WorkEntity | null }) => void;
    const first = new Promise<{ entity: WorkEntity | null }>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<{ entity: WorkEntity | null }>((resolve) => { resolveSecond = resolve; });
    let call = 0;
    const staleGet = vi.fn<DataWorkEntityGetCaller>(() => (++call === 1 ? first : second));
    const rig = mountRoute({
      workEntityListCaller: vi.fn(async () => ({ entities: [bookingEntity()], total: 1 })),
      workEntityGetCaller: staleGet,
    });
    await rig.route.whenLoaded();
    await rig.route.selectTab('booking');
    emitClick(rig.root.children[0]!, 'open-work-entity-detail', {
      'data-kind': 'booking', 'data-entity-id': 'booking-first',
    });
    emitClick(rig.root.children[0]!, 'open-work-entity-detail', {
      'data-kind': 'booking', 'data-entity-id': 'booking-second',
    });
    resolveSecond({ entity: bookingEntity({ id: 'booking-second', title: 'Second booking' }) });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    resolveFirst({ entity: bookingEntity({ id: 'booking-first', title: 'Stale first booking' }) });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(rig.root.children[0]?.innerHTML).toContain('Second booking');
    expect(rig.root.children[0]?.innerHTML).not.toContain('Stale first booking');
    rig.route.dispose();
  });

  it('filters work-entity rows when the list search input changes', async () => {
    const workEntityListCaller = vi.fn<DataWorkEntityListCaller>(async () => ({
      entities: [
        taskEntity({ id: 'task-call', title: 'Call Sam' }),
        taskEntity({ id: 'task-budget', title: 'Draft budget' }),
      ],
      total: 2,
    }));
    const rig = mountRoute({ workEntityListCaller });
    await rig.route.whenLoaded();

    await rig.route.selectTab('task');
    expect(rig.root.children[0]?.innerHTML).toContain('Call Sam');
    expect(rig.root.children[0]?.innerHTML).toContain('Draft budget');

    emitInput(rig.root.children[0]!, {
      value: 'budget',
      hasAttribute: () => false,
      getAttribute: (attr) => {
        if (attr === 'data-action') return 'search-work-entities';
        if (attr === 'data-kind') return 'task';
        return null;
      },
    });

    expect(rig.route.workEntityState().search_query).toBe('budget');
    expect(rig.root.children[0]?.innerHTML).not.toContain('Call Sam');
    expect(rig.root.children[0]?.innerHTML).toContain('Draft budget');

    rig.route.dispose();
  });

  it('renders data.contact ref fields as live name→id picker shells (single + array)', async () => {
    // The string-only fake DOM can't ATTACH the live picker (the route
    // guards on a missing querySelector), but it DOES store the rendered
    // innerHTML — enough to prove the dialog emits picker SHELLS with the
    // hidden id mirrors `readFormValues` reads back. Live wiring + the
    // Add/Remove flow are verified in the review rig (real DOM).
    const rig = mountRoute({
      sourceListCaller: vi.fn<WorkEntitySourceListCaller>(async () => ({
        sources: WORK_ENTITY_KINDS.map(sourceRegistration),
        defaults_by_kind: { task: 'recued.task', note: 'recued.note' },
      })),
    });
    await rig.route.whenLoaded();

    // Single ref — task.assigned_contact → one picker shell + a
    // data-form-field mirror (not the old raw-id input).
    await rig.route.selectTab('task');
    rig.route.openCreateWorkEntityDialog();
    let html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('data-ref-picker="form-ref-assigned_contact"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('data-form-field="assigned_contact"');
    expect(html).toContain('data-ref-picker-value');

    // Array<ref> — note.related_contact → a per-item picker shell with an
    // array-addressed mirror, plus the live Add/Remove buttons (the
    // owner's "add form doesn't work" bug).
    await rig.route.selectTab('note');
    rig.route.openCreateWorkEntityDialog();
    rig.route.setWorkEntityDialogValues({
      ...(rig.route.workEntityState().dialog?.values ?? {}),
      related_contact: ['a@x.com'],
    });
    html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('data-ref-picker="form-ref-related_contact-0"');
    expect(html).toContain('data-form-array-item="related_contact"');
    expect(html).toContain('value="a@x.com"');
    expect(html).toContain('data-form-array-add="related_contact"');
    expect(html).toContain('data-form-array-remove="related_contact"');

    rig.route.dispose();
  });

  it('persists source-extension fields in work_entity upsert requests', async () => {
    const hubspotTaskSource: SourceRegistration = {
      ...sourceRegistration('task'),
      id: 'hubspot.conn-1.task',
      source_kind: 'connection',
      source_label: 'HubSpot tasks',
      schema_extension_blob: {
        fields: [
          { name: 'hubspot_owner_id', type: 'text' },
          {
            name: 'hubspot_priority',
            type: 'enum',
            enum_values: ['LOW', 'HIGH'],
          },
          { name: 'hubspot_billable', type: 'boolean', nullable: true },
        ],
      },
    };
    const sourceListCaller = vi.fn<WorkEntitySourceListCaller>(async () => ({
      sources: [hubspotTaskSource],
      defaults_by_kind: { task: hubspotTaskSource.id },
    }));
    const workEntityGetCaller = vi.fn<DataWorkEntityGetCaller>(async () => ({
      entity: taskEntity({
        id: 'task-hubspot',
        source_id: hubspotTaskSource.id,
        title: 'Sync HubSpot renewal',
        source_extension_blob: {
          hubspot_owner_id: 'owner-existing',
          hubspot_priority: 'LOW',
          hubspot_billable: true,
        },
      }),
    }));
    const workEntityUpsertCaller = vi.fn<DataWorkEntityUpsertCaller>(async (args) => ({
      entity: taskEntity({
        id: (args as { id?: string }).id ?? 'task-hubspot',
        source_id: hubspotTaskSource.id,
        title:
          typeof (args as { title?: unknown }).title === 'string'
            ? (args as { title: string }).title
            : 'Sync HubSpot renewal',
      }),
    }));
    const rig = mountRoute({
      sourceListCaller,
      workEntityGetCaller,
      workEntityUpsertCaller,
    });
    await rig.route.whenLoaded();

    await rig.route.selectTab('task');
    await rig.route.openEditWorkEntityDialog('task', 'task-hubspot');
    const dialog = rig.route.workEntityState().dialog;
    expect(dialog?.values.hubspot_owner_id).toBe('owner-existing');
    expect(dialog?.values.hubspot_priority).toBe('LOW');

    rig.route.setWorkEntityDialogValues({
      ...(dialog?.values ?? {}),
      hubspot_owner_id: 'owner-123',
      hubspot_priority: 'HIGH',
      hubspot_billable: false,
    });
    await rig.route.confirmWorkEntityDialog();

    expect(workEntityUpsertCaller).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'task',
        id: 'task-hubspot',
        title: 'Sync HubSpot renewal',
        source_extension_blob: {
          hubspot_owner_id: 'owner-123',
          hubspot_priority: 'HIGH',
          hubspot_billable: false,
        },
      }),
    );

    rig.route.dispose();
  });

  it('renders the crm drill-down as a read-only data.timeline panel', async () => {
    // D-198 Slice 5 — mail/calendar (Phase 1b) + files (Phase 1c) browse via the
    // collection explorer; only `crm` remains a raw-id `data.timeline`
    // drill-down (not a CollectionPlatform). It is a native scope, so the
    // meta-section gating below matches mail's old behavior.
    const timelineCaller = vi.fn<DataTimelineCaller>(async () => timelineResponse());
    const rig = mountRoute({ timelineCaller });
    await rig.route.whenLoaded();

    await rig.route.openTimelineDrilldown('crm', 'crm-1');

    expect(timelineCaller).toHaveBeenCalledWith({
      entity_id: 'crm:crm-1',
      limit: 50,
    });
    expect(rig.route.activeTab()).toBe('crm');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(`${DATA_ROUTE_MIRROR_ATTR}="crm"`);
    expect(html).toContain('read-only');
    // Renders the ui-shared entity-detail panel, not the old flat list.
    expect(html).toContain('memory-entity-detail-panel');
    expect(html).toContain('Launch');
    // Run-link preserved via the panel's host-supplied runHref callback.
    expect(html).toContain('memory-timeline-entry-run-link');
    expect(html).toContain('href="#logs/run-1"');
    expect(html).toContain('Open run');
    // Native scope → meta section (+ its misleading "install a pack" hint) is
    // gated off entirely.
    expect(html).not.toContain('memory-entity-detail-section--meta');
    expect(html).not.toContain('No vendor-entity registry entry');
    expect(html).not.toContain('open-create-work-entity-dialog');
    expect(html).not.toContain('open-create-contact');

    rig.route.dispose();
  });

  it('D-205 #2: a contact row opens the detail — record + timeline — and closes back to the list', async () => {
    const timelineCaller = vi.fn<DataTimelineCaller>(async () => timelineResponse());
    const rig = mountRoute({ timelineCaller });
    await rig.route.whenLoaded();

    // The row IS the detail affordance now (the separate Timeline button is gone
    // — the timeline is a panel inside the detail).
    expect(rig.root.children[0]?.innerHTML ?? '').toContain('open-contact-detail');

    await rig.route.openContactDetail('sam@example.com');

    // BOTH halves are fetched: the projected record (which carries the
    // provenance) and the activity feed.
    expect(rig.contactGetCaller).toHaveBeenCalledWith({ email: 'sam@example.com' });
    expect(timelineCaller).toHaveBeenCalledWith({
      entity_id: 'contact:sam@example.com',
      limit: 50,
    });
    const detailHtml = rig.root.children[0]?.innerHTML ?? '';
    expect(detailHtml).toContain(
      `${DATA_ROUTE_CONTACT_DETAIL_ATTR}="sam@example.com"`,
    );
    // Reuses the mounted ui-shared entity-detail panel for the Activity section.
    expect(detailHtml).toContain('memory-entity-detail-panel');
    expect(detailHtml).toContain('Launch');
    expect(detailHtml).toContain('close-contact-detail');

    rig.route.closeContactDetail();
    const backHtml = rig.root.children[0]?.innerHTML ?? '';
    expect(backHtml).toContain('open-contact-detail');
    expect(backHtml).not.toContain('memory-entity-detail-panel');

    rig.route.dispose();
  });

  it('D-205 #2: renders per-field provenance, keyed by CONTRIBUTION KIND not column name', async () => {
    // The trap this pins: the projection_provenance map is keyed by the
    // contribution KIND, and two kinds do not match their ContactRecord column —
    // `company` is asserted as `org`, `mailing_address` as `address`. Reading the
    // map by column name yields undefined for exactly those two, so a field that
    // HAS provenance would silently render as if it had none.
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async () => ({
        contact: contactRecord({
          name: 'Sam Rivera',
          company: 'Acme',
          title: 'Head of Ops',
          phone: '+15551234567',
          mailing_address: {
            address1: '1 main street',
            city: 'austin',
            state: 'TX',
            zip: '78701',
            country: 'US',
          },
          projection_provenance: {
            name: { source: 'manual', source_id: 'manual' },
            org: { source: 'vendor_meta', source_id: 'hubspot.work.contact' },
            title: { source: 'vendor_meta', source_id: 'hubspot.work.contact' },
            phone: { source: 'contact_book', source_id: 'google.personal.contact' },
            address: { source: 'derived', source_id: 'recued.derived' },
          },
        }),
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactDetail('sam@example.com');
    const html = rig.root.children[0]?.innerHTML ?? '';

    expect(html).toContain(
      `${DATA_ROUTE_CONTACT_PROVENANCE_ATTR}="sam@example.com"`,
    );
    // The two mismatched keys are the whole point — assert them explicitly.
    expect(html).toContain('data-provenance-field="org"');
    expect(html).toContain('data-provenance-field="address"');

    // The vendor is named WITH its connection, because two HubSpot portals are
    // two Sources — collapsing them to "HubSpot" is the identity confusion the
    // (contact_id, kind, source_id) key exists to prevent.
    expect(html).toContain('from HubSpot (work)');
    expect(html).toContain('from Google (personal)');
    // Recued's own two internal writers are described by their RUNG, never named
    // as if they were a vendor.
    expect(html).toContain('you typed this');
    expect(html).toContain('derived from your mail and calendar');
    expect(html).not.toContain('from manual');
    expect(html).not.toContain('from Recued');

    rig.route.dispose();
  });

  it('D-205 item 3: renders what the OTHER sources said, and never re-ranks them', async () => {
    // The view that makes the ladder legible in its INPUT rather than only its
    // outcome. HubSpot's `Acme Inc.` is what Recued kept; Google's `Acme Corp` is what
    // it did NOT — and until this block existed the user could not see the second one
    // at all, only that Recued had "chosen" something.
    //
    // ⛔ `winner` comes from the SERVER (stamped by the one resolver). Note the loser
    // here is the FRESHER row: a client that re-ranked by recency would flip these,
    // which is exactly the bug merge-review item 1 fixed. The rig hands the dialog a
    // winner that recency would contradict, so any client-side ladder shows up here.
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async () => ({
        contact: contactRecord({
          company: 'Acme Inc.',
          projection_provenance: {
            org: { source: 'vendor_meta', source_id: 'hubspot.work.contact' },
          },
        }),
      })),
      contactContributionsCaller: vi.fn<DataContactContributionsCaller>(async () => ({
        contributions: [
          {
            kind: 'org', value: 'Acme Inc.', source: 'vendor_meta',
            source_id: 'hubspot.work.contact', confidence: 1,
            as_of: 1_600_000_000_000, winner: true,
          },
          {
            kind: 'org', value: 'Acme Corp', source: 'contact_book',
            source_id: 'google.personal.contact', confidence: 1,
            as_of: 1_700_000_000_000, winner: false,
          },
        ],
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactDetail('sam@example.com');
    const html = rig.root.children[0]?.innerHTML ?? '';

    // The losing value is now visible, attributed to the source that asserted it.
    expect(html).toContain('data-alt-source="contact_book"');
    expect(html).toContain('Acme Corp');
    expect(html).toContain('from Google (personal)');
    // The winner is NOT repeated in the other-sources list — it is already the value.
    expect(html).not.toMatch(
      /<li class="data-contact-alt-source"[^>]*>[\s\S]*?Acme Inc\.[\s\S]*?<\/li>/,
    );

    rig.route.dispose();
  });

  it('D-205 item 3: renders NO other-sources list when only one source asserts a field', async () => {
    // An "other sources" heading over an empty list would imply Recued looked and
    // found disagreement where there is none.
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async () => ({
        contact: contactRecord({
          company: 'Acme Inc.',
          projection_provenance: {
            org: { source: 'vendor_meta', source_id: 'hubspot.work.contact' },
          },
        }),
      })),
      contactContributionsCaller: vi.fn<DataContactContributionsCaller>(async () => ({
        contributions: [
          {
            kind: 'org', value: 'Acme Inc.', source: 'vendor_meta',
            source_id: 'hubspot.work.contact', confidence: 1,
            as_of: 1_600_000_000_000, winner: true,
          },
        ],
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactDetail('sam@example.com');
    const html = rig.root.children[0]?.innerHTML ?? '';

    expect(html).toContain('data-provenance-field="org"');
    expect(html).not.toContain('data-contact-alt-sources');

    rig.route.dispose();
  });

  it('D-205 item 3: a FAILED contributions fetch says so — it must not read as "no other sources"', async () => {
    // 🔑 The whole reason this has its own error slot + flag. The other-sources list
    // is an ABSENCE-shaped surface: rendering nothing is a CLAIM — "nothing else
    // asserts this field" — and that is a claim about the user's data. A failed fetch
    // that renders the same nothing makes that claim falsely, and the user cannot
    // tell. Same class as the D-205 #3 read fences refusing into `{matches: []}`.
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async () => ({
        contact: contactRecord({
          company: 'Acme Inc.',
          projection_provenance: {
            org: { source: 'vendor_meta', source_id: 'hubspot.work.contact' },
          },
        }),
      })),
      contactContributionsCaller: vi.fn<DataContactContributionsCaller>(async () => {
        throw new Error('rpc exploded');
      }),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactDetail('sam@example.com');
    const html = rig.root.children[0]?.innerHTML ?? '';

    // The field still renders with its winner — a broken sidecar must not sink the page.
    expect(html).toContain('data-provenance-field="org"');
    expect(html).toContain('Acme Inc.');
    // But the page SAYS the evidence is missing, rather than implying there is none.
    expect(html).toContain('could not load what your other sources say');
    // And the raw failure is still reported in the route's own error slot.
    expect(rig.route.getLoadErrors().contact_contributions).toContain('rpc exploded');

    rig.route.dispose();
  });

  it('D-205 item 3: an UNWIRED caller renders the page exactly as before — no block, no error', async () => {
    // Not wiring the view is not a failure: the host simply does not offer it.
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async () => ({
        contact: contactRecord({
          company: 'Acme Inc.',
          projection_provenance: {
            org: { source: 'vendor_meta', source_id: 'hubspot.work.contact' },
          },
        }),
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactDetail('sam@example.com');
    const html = rig.root.children[0]?.innerHTML ?? '';

    expect(html).toContain('data-provenance-field="org"');
    expect(html).not.toContain('data-contact-alt-sources');
    expect(html).not.toContain('could not load what your other sources say');
    expect(rig.route.getLoadErrors().contact_contributions).toBeUndefined();

    rig.route.dispose();
  });

  it('D-205 #2: never invents a source — a rung with no source_id names no vendor', async () => {
    // ContactFieldProvenance.source_id is optional because an older row may carry
    // no recorded instance. "We don't know who" is then the truth, and a surface
    // renders provenance as FACT — so the rung alone must drive the copy.
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async () => ({
        contact: contactRecord({
          company: 'Acme',
          projection_provenance: {
            org: { source: 'vendor_meta' },
          },
        }),
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactDetail('sam@example.com');
    const html = rig.root.children[0]?.innerHTML ?? '';

    expect(html).toContain('from a connected CRM');
    expect(html).not.toContain('from undefined');
    expect(html).not.toContain('HubSpot');

    rig.route.dispose();
  });

  it('D-205 #2: renders the platform links and flags a merged tombstone', async () => {
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async () => ({
        contact: contactRecord({
          merged_into: 'samuel@example.com',
          platform_ids: [
            {
              vendor: 'hubspot',
              platform_id: 'hubspot_contact_47291',
              state: 'confirmed',
              linked_at: 5,
              linked_by: 'user:sam@example.com',
            },
          ],
        }),
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactDetail('sam@example.com');
    const html = rig.root.children[0]?.innerHTML ?? '';

    expect(html).toContain(DATA_ROUTE_CONTACT_LINKS_ATTR);
    expect(html).toContain('hubspot_contact_47291');
    expect(html).toContain('confirmed by you');
    // A tombstone must not read as a live contact — it points at its survivor.
    expect(html).toContain('was merged into');
    expect(html).toContain('samuel%40example.com');

    rig.route.dispose();
  });

  it('D-205 #2c: the Sources strip surfaces the cycle counters — the first reader they have ever had', async () => {
    const rig = mountRoute({
      now: () => NOW,
      contactSourceListCaller: vi.fn<DataContactSourceListCaller>(async () => ({
        sources: [
          sourceHealth({
            source_id: 'hubspot.work.contact',
            source_label: 'HubSpot (work)',
            last_success_at: NOW - 2 * 3_600_000,
            last_cycle: cycleCounts({ hydrated: 1240, linked: 1240, skipped: 8800 }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();
    const html = rig.root.children[0]?.innerHTML ?? '';

    expect(html).toContain(DATA_ROUTE_CONTACT_SOURCES_ATTR);
    expect(html).toContain('HubSpot (work)');
    expect(html).toContain('synced 2h ago');
    // The counters. Before #2c these were written by the runner and read by nobody.
    expect(html).toContain('1,240 hydrated');
    expect(html).toContain('8,800 not matched');
    expect(html).toContain('1 healthy');

    rig.route.dispose();
  });

  it('D-205 #2c: a degraded Source names its failures and quotes the runner samples', async () => {
    // `degraded: true` is a shrug. The counters say WHAT broke and the message —
    // carrying the runner's failure SAMPLES — says WHY. That is the whole point of
    // #1 persisting them and #2c reading them.
    const message =
      '12 record(s) failed their supplies promise or could not be written'
      + ' — hs_1: attributes.address promised by the declaration but absent from the record';
    const rig = mountRoute({
      now: () => NOW,
      contactSourceListCaller: vi.fn<DataContactSourceListCaller>(async () => ({
        sources: [
          sourceHealth({
            source_id: 'hubspot.work.contact',
            source_label: 'HubSpot (work)',
            degraded: true,
            stale: true,
            last_error_code: 'records_failed',
            last_error_message: message,
            last_cycle: cycleCounts({ failed_rows: 12, unkeyable: 3, complete: false }),
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();
    const html = rig.root.children[0]?.innerHTML ?? '';

    expect(html).toContain('Degraded');
    expect(html).toContain('1 of 1 need attention');
    // Each red counter is a DISTINCT failure with a distinct consequence — named,
    // not summed.
    expect(html).toContain('12 records failed to import');
    expect(html).toContain('3 records had no usable id (deletions paused)');
    // An incomplete walk is NOT degradation, but the user must see it: it means
    // nothing was disconnected this cycle (fail-closed).
    expect(html).toContain('could not confirm it saw every record');
    // The samples, verbatim — a bug report, not a lossy re-parse.
    expect(html).toContain('attributes.address promised by the declaration but absent');

    rig.route.dispose();
  });

  it('D-205 #2c: a DISABLED Source reads as off, not broken; and no caller means no strip', async () => {
    const off = mountRoute({
      now: () => NOW,
      contactSourceListCaller: vi.fn<DataContactSourceListCaller>(async () => ({
        sources: [
          sourceHealth({
            source_id: 'hubspot.work.contact',
            source_label: 'HubSpot (work)',
            enabled: false,
            // A Source that is not running is stale by the clock — but it is not
            // BROKEN, and the strip must not cry wolf about a switch the user threw.
            stale: true,
          }),
        ],
      })),
    });
    await off.route.whenLoaded();
    const offHtml = off.root.children[0]?.innerHTML ?? '';
    expect(offHtml).toContain('Off');
    expect(offHtml).toContain('not running');
    expect(offHtml).not.toContain('Degraded');
    off.route.dispose();

    // Unwired → no strip at all. A Source list we cannot read is not one to guess at.
    const bare = mountRoute({});
    await bare.route.whenLoaded();
    expect(bare.root.children[0]?.innerHTML ?? '').not.toContain(
      DATA_ROUTE_CONTACT_SOURCES_ATTR,
    );
    bare.route.dispose();
  });

  it('D-205 #2b: groups edges into clusters, and a reject sends ONLY that cluster’s surfaced edges', async () => {
    // TWO independent clusters in one queue, deliberately:
    //   cluster 1 — a—b, b—c  (3 people, 2 detected edges: ONE cluster, not 2 pairs)
    //   cluster 2 — d—e       (unrelated)
    //
    // 🔑 Rejecting cluster 1 must send exactly ITS 2 surfaced candidate ids.
    // `reject` writes one PERMANENT rejection row per id it is handed, so any
    // extra id durably suppresses a merge the user never saw, let alone declined
    // — and it is invisible afterwards, because a rejected pair simply stops
    // being offered. Two failure modes this pins:
    //   • sending the transitive closure (a—c would be rejected: never proposed)
    //   • leaking cluster 2's edge in (d—e rejected while the user judged a/b/c)
    // A single-cluster fixture cannot tell a correct filter from a broken one —
    // with only one component, "all candidates" and "this component's edges" are
    // the same list.
    const contacts: Record<string, ContactRecord> = {
      'a@x.com': contactRecord({ email: 'a@x.com', name: 'Bob Smith', last_interaction: 10 }),
      'b@x.com': contactRecord({ email: 'b@x.com', name: 'Robert Smith', last_interaction: 30 }),
      'c@x.com': contactRecord({ email: 'c@x.com', name: 'Rob Smith', last_interaction: 20 }),
      'd@y.com': contactRecord({ email: 'd@y.com', name: 'Jane Doe', last_interaction: 5 }),
      'e@y.com': contactRecord({ email: 'e@y.com', name: 'Janet Doe', last_interaction: 7 }),
    };
    const rejectCaller = vi.fn<DataContactMergeRejectCaller>(async () => ({
      candidates: [],
      rejection_rows_written: 2,
    }));
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async ({ email }) => ({
        contact: contacts[email] ?? null,
      })),
      contactMergeListCaller: vi.fn<DataContactMergeListCaller>(async () => ({
        candidates: [
          mergeCandidate({ id: 'cand-ab', email_a: 'a@x.com', email_b: 'b@x.com' }),
          mergeCandidate({ id: 'cand-bc', email_a: 'b@x.com', email_b: 'c@x.com' }),
          mergeCandidate({ id: 'cand-de', email_a: 'd@y.com', email_b: 'e@y.com' }),
        ],
      })),
      contactMergeRejectCaller: rejectCaller,
    });
    await rig.route.whenLoaded();
    await rig.route.openContactScan();

    const scan = rig.route.contactScan();
    // TWO clusters — and the first is a cluster of 3, not two separate pairs.
    expect(scan?.dialog.items).toHaveLength(2);
    expect(scan?.dialog.items[0]?.cards.map((c) => c.email)).toEqual([
      'a@x.com', 'b@x.com', 'c@x.com',
    ]);
    expect(scan?.dialog.items[1]?.cards.map((c) => c.email)).toEqual([
      'd@y.com', 'e@y.com',
    ]);
    // Default survivor = most recent last_interaction (b, at 30).
    expect(scan?.dialog.items[0]?.default_survivor).toBe('b@x.com');

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(DATA_ROUTE_CONTACT_SCAN_ATTR);
    expect(html).toContain('merge-review-dialog');

    await rig.route.resolveMergeItem('reject');
    // 🔑 Cluster 1's 2 surfaced edges. NOT the closure (no synthetic a—c), and
    // NOT cluster 2's `cand-de`.
    expect(rejectCaller).toHaveBeenCalledWith({
      candidate_ids: ['cand-ab', 'cand-bc'],
    });

    rig.route.dispose();
  });

  it('D-205 #2b: confirm sends the chosen survivor, and the radio pick overrides the default', async () => {
    const contacts: Record<string, ContactRecord> = {
      'a@x.com': contactRecord({ email: 'a@x.com', last_interaction: 10 }),
      'b@x.com': contactRecord({ email: 'b@x.com', last_interaction: 30 }),
    };
    const confirmCaller = vi.fn<DataContactMergeConfirmCaller>(async () => ({
      survivor: contacts['a@x.com'] as ContactRecord,
      losers: [],
    }));
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async ({ email }) => ({
        contact: contacts[email] ?? null,
      })),
      contactMergeListCaller: vi.fn<DataContactMergeListCaller>(async () => ({
        candidates: [
          mergeCandidate({ id: 'cand-ab', email_a: 'a@x.com', email_b: 'b@x.com' }),
        ],
      })),
      contactMergeConfirmCaller: confirmCaller,
    });
    await rig.route.whenLoaded();
    await rig.route.openContactScan();

    // Default is b (most recent). Override to a.
    expect(rig.route.contactScan()?.dialog.items[0]?.default_survivor).toBe('b@x.com');
    rig.route.setMergeSurvivor('a@x.com');
    await rig.route.resolveMergeItem('confirm');

    expect(confirmCaller).toHaveBeenCalledWith({
      candidate_ids: ['cand-ab'],
      survivor_email: 'a@x.com',
    });

    rig.route.dispose();
  });

  it('D-205 #2b: a re-hydrate DROPS survivor overrides — they are keyed by a cursor that re-indexes', async () => {
    // survivor_overrides is keyed by CURSOR (a position in the queue). Resolving
    // a cluster removes it, so everything after shifts up by one. Carrying the
    // old map across a re-hydrate would apply the survivor the user picked for
    // cluster N to whatever cluster now SITS at index N — committing a merge
    // against a person they never chose. The override must not survive.
    const contacts: Record<string, ContactRecord> = {
      'a@x.com': contactRecord({ email: 'a@x.com', last_interaction: 10 }),
      'b@x.com': contactRecord({ email: 'b@x.com', last_interaction: 30 }),
      'd@y.com': contactRecord({ email: 'd@y.com', last_interaction: 10 }),
      'e@y.com': contactRecord({ email: 'e@y.com', last_interaction: 30 }),
    };
    let resolved = false;
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async ({ email }) => ({
        contact: contacts[email] ?? null,
      })),
      contactMergeListCaller: vi.fn<DataContactMergeListCaller>(async () => ({
        // After the first cluster is rejected it leaves the queue, so the SECOND
        // cluster slides into index 0 — the slot the override was keyed on.
        candidates: resolved
          ? [mergeCandidate({ id: 'cand-de', email_a: 'd@y.com', email_b: 'e@y.com' })]
          : [
              mergeCandidate({ id: 'cand-ab', email_a: 'a@x.com', email_b: 'b@x.com' }),
              mergeCandidate({ id: 'cand-de', email_a: 'd@y.com', email_b: 'e@y.com' }),
            ],
      })),
      contactMergeRejectCaller: vi.fn<DataContactMergeRejectCaller>(async () => {
        resolved = true;
        return { candidates: [], rejection_rows_written: 1 };
      }),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactScan();

    // Override cluster 0's survivor to the NON-default (a, not b).
    rig.route.setMergeSurvivor('a@x.com');
    expect(rig.route.contactScan()?.dialog.survivor_overrides[0]).toBe('a@x.com');

    await rig.route.resolveMergeItem('reject');

    // The d/e cluster now sits at index 0. The stale override MUST be gone — its
    // survivor (`a@x.com`) is not even a member of this cluster.
    const scan = rig.route.contactScan();
    expect(scan?.dialog.items[0]?.cards.map((c) => c.email)).toEqual(['d@y.com', 'e@y.com']);
    expect(scan?.dialog.survivor_overrides).toEqual({});

    rig.route.dispose();
  });

  it('D-205 #2b: FAIL-CLOSED — the destructive "Also merge upstream" is never offered', async () => {
    // The host has not wired `upstream_merge.*`. The cards DO carry platform_ids
    // (post-slice-7 that is the normal case for CRM-sourced duplicates), so the
    // old coupling would have rendered a destructive button that did nothing.
    const linked = contactRecord({
      email: 'a@x.com',
      platform_ids: [{
        vendor: 'hubspot',
        platform_id: 'hubspot_contact_1',
        state: 'auto',
        linked_at: 1,
        linked_by: 'auto:email_match',
      }],
    });
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async ({ email }) => ({
        contact: email === 'a@x.com' ? linked : contactRecord({ email }),
      })),
      contactMergeListCaller: vi.fn<DataContactMergeListCaller>(async () => ({
        candidates: [
          mergeCandidate({ id: 'cand-ab', email_a: 'a@x.com', email_b: 'b@x.com' }),
        ],
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactScan();
    const html = rig.root.children[0]?.innerHTML ?? '';

    expect(html).not.toContain('contact-merge-confirm-upstream');
    expect(html).not.toContain('Also merge upstream');
    // …but the vendor link is still SHOWN. Suppressing the action must not
    // suppress the fact.
    expect(html).toContain('merge-review-platform-badge');

    rig.route.dispose();
  });

  it('D-205 #2b: no "Find duplicates" entry point when the merge callers are unwired', async () => {
    // A page that cannot act must not be advertised — that is how this arc
    // produced six "built and wired to nothing" clusters.
    const rig = mountRoute({});
    await rig.route.whenLoaded();
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain('open-contact-scan');
    rig.route.dispose();
  });

  it('D-205 #2b: the merge_scan_progress broadcast drives the live progress line', async () => {
    const { subscribe, listeners } = makeSubscribe();
    const rig = mountRoute({
      subscribe,
      liveRefreshDebounceMs: 0,
      contactMergeListCaller: vi.fn<DataContactMergeListCaller>(async () => ({
        candidates: [],
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactScan();

    const onProgress = listeners.get('merge_scan_progress');
    expect(onProgress).toBeDefined();
    onProgress?.({
      kind: 'merge_scan_progress',
      op: 'progress',
      mode: 'full',
      iterated: 120,
      total: 1000,
      surfaced_count: 3,
      cursor: 1,
    });

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(DATA_ROUTE_SCAN_PROGRESS_ATTR);
    expect(html).toContain('Compared 120 of 1,000 contacts');
    expect(html).toContain('3 possible duplicates');

    rig.route.dispose();
  });

  it('D-205 #2: a detail-fetch failure does not masquerade as a list failure', async () => {
    // errors.contacts is the LIST's slot. Folding one record's contact.get
    // failure into it would show "failed to load contacts" over a list that
    // loaded perfectly well, the moment the user navigated back.
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async () => {
        throw new Error('get exploded');
      }),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactDetail('sam@example.com');

    expect(rig.route.getLoadErrors().contact_detail).toContain('get exploded');
    expect(rig.route.getLoadErrors().contacts).toBeUndefined();

    // …and closing the detail carries neither error back to the list.
    rig.route.closeContactDetail();
    expect(rig.route.getLoadErrors().contact_detail).toBeUndefined();
    expect(rig.route.getLoadErrors().timeline).toBeUndefined();

    rig.route.dispose();
  });

  it('D-205 #2: a failing timeline still leaves the provenance block on screen', async () => {
    // The two fetches are independent: the identity + provenance block is the
    // reason the page exists, and a dead activity feed must not take it down.
    const rig = mountRoute({
      timelineCaller: vi.fn<DataTimelineCaller>(async () => {
        throw new Error('timeline exploded');
      }),
      contactGetCaller: vi.fn<DataContactGetCaller>(async () => ({
        contact: contactRecord({
          company: 'Acme',
          projection_provenance: {
            org: { source: 'vendor_meta', source_id: 'hubspot.work.contact' },
          },
        }),
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactDetail('sam@example.com');
    const html = rig.root.children[0]?.innerHTML ?? '';

    expect(html).toContain('from HubSpot (work)');
    expect(rig.route.getLoadErrors().timeline).toContain('timeline exploded');

    rig.route.dispose();
  });

  it('D-205 #2: editing from the detail re-fetches it — a manual write changes the WINNER', async () => {
    // A manual edit lands as a `manual` contribution, which sits at the TOP of
    // the C-2a ladder: it does not merely change the value, it changes which
    // source WON — and therefore every provenance line on screen. Refreshing only
    // the list behind the detail would keep rendering "from HubSpot" under a
    // value the user just typed themselves.
    let upserted = false;
    const rig = mountRoute({
      contactGetCaller: vi.fn<DataContactGetCaller>(async () => ({
        contact: contactRecord({
          company: upserted ? 'Globex' : 'Acme',
          projection_provenance: {
            org: upserted
              ? { source: 'manual', source_id: 'manual' }
              : { source: 'vendor_meta', source_id: 'hubspot.work.contact' },
          },
        }),
      })),
      contactUpsertCaller: vi.fn<DataContactUpsertCaller>(async (args) => {
        upserted = true;
        return { contact: contactRecord({ email: args.email }) };
      }),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactDetail('sam@example.com');
    expect(rig.root.children[0]?.innerHTML ?? '').toContain('from HubSpot (work)');

    await rig.route.openEditContactDialog('sam@example.com');
    rig.route.setContactDialogValues({ company: 'Globex' });
    await rig.route.confirmContactDialog();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('Globex');
    expect(html).toContain('you typed this');
    expect(html).not.toContain('from HubSpot (work)');

    rig.route.dispose();
  });

  it('derives enrichments + vendor meta from the timeline enrichment entries', async () => {
    const timelineCaller = vi.fn<DataTimelineCaller>(async () => ({
      entries: [
        {
          ts: 1_700_000_000_000,
          source: 'enrichment',
          kind: 'deal_health_score',
          payload: {
            enrichment_id: 'e1',
            topic: 'deal_health_score',
            scope: 'connection.api.hubspot.deal',
            target_id: 'hubspot_deal_47291',
            value: { score: 78 },
            meta: { name: 'Acme Q3 Expansion', stage: 'negotiation' },
            ingredient_slug: 'ai-score',
            model_id: 'gpt-4o-mini',
            staleness_class: 'fresh',
            authored_by: 'system.housekeeping.deal_health_score',
          },
        },
      ],
    }));
    const rig = mountRoute({ timelineCaller });
    await rig.route.whenLoaded();

    await rig.route.openTimelineDrilldown('crm', 'hubspot_deal_47291');

    const html = rig.root.children[0]?.innerHTML ?? '';
    // Enrichment-source timeline entry → enrichment card.
    expect(html).toContain('data-topic="deal_health_score"');
    expect(html).toContain('score 78');
    // Platform-reference scope (from the entry payload) → vendor entity
    // resolved from CONNECTION_VENDOR_ENTITIES + meta section shown.
    expect(html).toContain('About this HubSpot Deal');
    expect(html).toContain('memory-entity-detail-section--meta');
    expect(html).toContain('Acme Q3 Expansion');

    rig.route.dispose();
  });

  it('keeps warehouse delete callers wired behind route methods', async () => {
    const workEntityDeleteCaller = vi.fn<DataWorkEntityDeleteCaller>(async (args) => ({
      ok: true,
      id: args.id,
      tombstoned: true,
    }));
    const contactDeleteCaller = vi.fn<DataContactDeleteCaller>(async () => ({
      ok: true,
      deleted: true,
    }));
    const rig = mountRoute({ workEntityDeleteCaller, contactDeleteCaller });
    await rig.route.whenLoaded();

    await rig.route.deleteWorkEntity('task', 'task-1');
    await rig.route.deleteContact('sam@example.com');

    expect(workEntityDeleteCaller).toHaveBeenCalledWith({
      kind: 'task',
      id: 'task-1',
    });
    expect(contactDeleteCaller).toHaveBeenCalledWith({
      email: 'sam@example.com',
    });

    rig.route.dispose();
  });

  // ── D-198 Slice 5 — mail/calendar → collection explorer ──────────
  it('mail + calendar tabs render the collection explorer, not the drill-down/picker', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    for (const tab of ['mail', 'calendar'] as const) {
      await rig.route.selectTab(tab);
      const html = rig.root.children[0]?.innerHTML ?? '';
      expect(html).toContain('data-recued-collection-explorer');
      // The old raw-id drill-down box + mirror-search picker are gone for these.
      expect(html).not.toContain('data-recued-data-timeline-entity');
      expect(html).not.toContain('data-ref-picker="data-mirror-search"');
    }
    rig.route.dispose();
  });

  it('the explorer auto-selects the sole instance + lists its records (collection.list)', async () => {
    const listInstances = vi.fn(async () => ({
      instances: [
        { slug: 'gmail', platform: 'mail', adapter_type: 'gmail', caps: {}, auth_state: 'ok', last_synced_at: null },
      ],
    }));
    const list = vi.fn(async () => ({
      records: [
        { record_id: 'msg-1', received_at: 1, modified_at: 1, hot_fields: { subject: 'Renewal', from: 'sam@acme.com' }, size_bytes: 0, source_id: 'msg-1' },
      ],
    }));
    const rig = mountRoute({
      collectionListInstancesCaller: listInstances as never,
      collectionListCaller: list as never,
    });
    await rig.route.whenLoaded();
    await rig.route.selectTab('mail');
    // One instance → auto-selected → its records fetched for (platform, slug).
    expect(list).toHaveBeenCalledWith({ platform: 'mail', slug: 'gmail', limit: expect.any(Number) });
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('Renewal'); // primary_field (subject) title
    expect(html).toContain('sam@acme.com'); // summary field
    rig.route.dispose();
  });

  // ── D-210 step 3 — the calendar detail renders data.timeline ──────────
  const flushOpen = async (): Promise<void> => {
    // `openExplorerRecord` is fire-and-forget with TWO async hops (collection.get
    // → data.timeline), not chained onto whenLoaded(); flush micro + macro tasks
    // so both settle and re-render.
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  it('opening a calendar record fetches its timeline (calendar:<source_id>) and renders it below the fields', async () => {
    const calRecord = {
      record_id: 'evt-1', received_at: 1, modified_at: 1,
      hot_fields: { summary: 'Booking with Alex' }, size_bytes: 0, source_id: 'evt-1',
    };
    const listInstances = vi.fn(async () => ({
      instances: [
        { slug: 'local', platform: 'calendar', adapter_type: 'local', caps: {}, auth_state: 'ok', last_synced_at: null },
      ],
    }));
    const list = vi.fn(async () => ({ records: [calRecord] }));
    const get = vi.fn(async () => ({ record: calRecord }));
    const timeline = vi.fn(async () => ({
      entries: [
        // the D-119 origin edge (reception booking → this event)
        {
          ts: 100, source: 'link', kind: 'inbound:scheduled-from',
          payload: {
            role: 'scheduled-from', direction: 'inbound',
            other_collection: 'reception_booking_request', other_id: 'req-1',
          },
        },
        // a D-120 write link (the owner moved the event)
        { ts: 200, source: 'memory', kind: 'execution.write', payload: { run_id: 'run-9', recipe_id: 'move-booking' } },
      ],
    }));
    const rig = mountRoute({
      collectionListInstancesCaller: listInstances as never,
      collectionListCaller: list as never,
      collectionGetCaller: get as never,
      timelineCaller: timeline as never,
    });
    await rig.route.whenLoaded();
    await rig.route.selectTab('calendar');
    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, { [COLLECTION_RECORD_ID_ATTR]: 'evt-1' });
    await flushOpen();
    // Keyed on the event's source_id — the `calendar:<source_id>` subject the
    // D-120 links + the D-119 scheduled-from edge are written against — NOT the
    // tab id or record_id-as-something-else.
    expect(timeline).toHaveBeenCalledWith({ entity_id: 'calendar:evt-1', limit: expect.any(Number) });
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('Timeline'); // the section title renders
    expect(html).toContain('scheduled-from'); // the origin edge is shown
    rig.route.dispose();
  });

  it('opening a NON-calendar (mail) record does NOT fetch a timeline (calendar-scoped)', async () => {
    const mailRecord = {
      record_id: 'msg-1', received_at: 1, modified_at: 1,
      hot_fields: { subject: 'Renewal' }, size_bytes: 0, source_id: 'msg-1',
    };
    const listInstances = vi.fn(async () => ({
      instances: [
        { slug: 'gmail', platform: 'mail', adapter_type: 'gmail', caps: {}, auth_state: 'ok', last_synced_at: null },
      ],
    }));
    const timeline = vi.fn(async () => timelineResponse());
    const rig = mountRoute({
      collectionListInstancesCaller: listInstances as never,
      collectionListCaller: (vi.fn(async () => ({ records: [mailRecord] }))) as never,
      collectionGetCaller: (vi.fn(async () => ({ record: mailRecord }))) as never,
      timelineCaller: timeline as never,
    });
    await rig.route.whenLoaded();
    await rig.route.selectTab('mail');
    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, { [COLLECTION_RECORD_ID_ATTR]: 'msg-1' });
    await flushOpen();
    // The gate is `platform === 'calendar'` — mail opens must not fetch a timeline.
    expect(timeline).not.toHaveBeenCalled();
    rig.route.dispose();
  });

  // ── D-210 R-4 — the owner's reschedule control on a calendar event ──
  const RESCHED_T1 = 1_700_000_000_000;
  const RESCHED_T2 = 1_700_003_600_000; // +1h duration
  const reschedCalRecord = {
    record_id: 'evt-1', received_at: 1, modified_at: 1,
    hot_fields: { summary: 'Booking with Alex', start_at: RESCHED_T1, end_at: RESCHED_T2 },
    size_bytes: 0, source_id: 'evt-1',
  };
  const mountCalendar = (
    over: Parameters<typeof mountRoute>[0] = {},
  ): ReturnType<typeof mountRoute> =>
    mountRoute({
      collectionListInstancesCaller: vi.fn(async () => ({
        instances: [{ slug: 'local', platform: 'calendar', adapter_type: 'local', caps: {}, auth_state: 'ok', last_synced_at: null }],
      })) as never,
      collectionListCaller: vi.fn(async () => ({ records: [reschedCalRecord] })) as never,
      collectionGetCaller: vi.fn(async () => ({ record: reschedCalRecord })) as never,
      ...over,
    });

  it('a calendar event detail shows a Reschedule button that opens a datetime form', async () => {
    const rig = mountCalendar();
    await rig.route.whenLoaded();
    await rig.route.selectTab('calendar');
    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, { [COLLECTION_RECORD_ID_ATTR]: 'evt-1' });
    await flushOpen();
    expect(rig.root.children[0]?.innerHTML ?? '').toContain('reschedule-open'); // the button
    emitClick(rig.root.children[0]!, 'reschedule-open');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('datetime-local'); // the picker opened
    expect(html).toContain('reschedule-submit'); // the Save button
    rig.route.dispose();
  });

  it('Save runs reschedule-calendar-event with the slug, source_id, and new start/end (end shifts by duration)', async () => {
    const recipeExecuteCaller = vi.fn<
      NonNullable<BootstrapDataRouteOptions['recipeExecuteCaller']>
    >(async (args) => executeResponse(args.recipe_id));
    const rig = mountCalendar({ recipeExecuteCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('calendar');
    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, { [COLLECTION_RECORD_ID_ATTR]: 'evt-1' });
    await flushOpen();
    emitClick(rig.root.children[0]!, 'reschedule-open');
    const newValue = '2026-05-01T09:30';
    emitInput(rig.root.children[0]!, {
      value: newValue,
      hasAttribute: () => false,
      getAttribute: (k) => (k === 'data-recued-data-action' ? 'reschedule-input' : null),
    });
    emitClick(rig.root.children[0]!, 'reschedule-submit');
    await flushOpen();
    // The exact new_start_at is computed the SAME way the code does (local-time
    // parse), so the assertion is timezone-consistent; the end shifts by the
    // event's current duration.
    const expectedStart = new Date(newValue).getTime();
    expect(recipeExecuteCaller).toHaveBeenCalledWith({
      recipe_id: 'reschedule-calendar-event',
      config: {
        calendar_slug: 'local',
        event_source_id: 'evt-1',
        new_start_at: expectedStart,
        new_end_at: expectedStart + (RESCHED_T2 - RESCHED_T1),
      },
    });
    rig.route.dispose();
  });

  it('a NON-calendar (mail) record shows no Reschedule button (calendar-gated)', async () => {
    const mailRecord = {
      record_id: 'msg-1', received_at: 1, modified_at: 1,
      hot_fields: { subject: 'Renewal' }, size_bytes: 0, source_id: 'msg-1',
    };
    const rig = mountRoute({
      collectionListInstancesCaller: vi.fn(async () => ({
        instances: [{ slug: 'gmail', platform: 'mail', adapter_type: 'gmail', caps: {}, auth_state: 'ok', last_synced_at: null }],
      })) as never,
      collectionListCaller: vi.fn(async () => ({ records: [mailRecord] })) as never,
      collectionGetCaller: vi.fn(async () => ({ record: mailRecord })) as never,
    });
    await rig.route.whenLoaded();
    await rig.route.selectTab('mail');
    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, { [COLLECTION_RECORD_ID_ATTR]: 'msg-1' });
    await flushOpen();
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain('reschedule-open');
    rig.route.dispose();
  });

  it('a reschedule completion that lands after the owner navigated away is DROPPED (no resurrected form)', async () => {
    // A deferred execute so we can navigate mid-flight, then resolve as a failure —
    // which, without the seq guard, would resurrect this form's error over whatever
    // is now open. The guard must drop the stale completion.
    let resolveExec: (v: unknown) => void = () => {};
    const execPromise = new Promise((r) => { resolveExec = r; });
    const recipeExecuteCaller = vi.fn<
      NonNullable<BootstrapDataRouteOptions['recipeExecuteCaller']>
    >(() => execPromise as never);
    const rig = mountCalendar({ recipeExecuteCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('calendar');
    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, { [COLLECTION_RECORD_ID_ATTR]: 'evt-1' });
    await flushOpen();
    emitClick(rig.root.children[0]!, 'reschedule-open');
    emitInput(rig.root.children[0]!, {
      value: '2026-05-01T09:30',
      hasAttribute: () => false,
      getAttribute: (k) => (k === 'data-recued-data-action' ? 'reschedule-input' : null),
    });
    emitClick(rig.root.children[0]!, 'reschedule-submit'); // in-flight (execPromise pending)
    // Navigate away — re-opening the record bumps explorerSeq + nulls the form.
    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, { [COLLECTION_RECORD_ID_ATTR]: 'evt-1' });
    await flushOpen();
    // Now the reschedule resolves as a FAILURE — the stale completion must be dropped.
    resolveExec({ recipe_id: 'reschedule-calendar-event', recipe_hash: 'h', success: false, output: {}, steps: [], errors: [], duration_ms: 1 });
    await flushOpen();
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain('Reschedule failed'); // not resurrected
    rig.route.dispose();
  });

  // D-210 A.2: visitor manage-link coverage now lives with booking-detail tests;
  // calendar-event detail remains a separate, owner-only reschedule surface.

  // ── D-198 Slice 5 Phase 1c — files → collection explorer (+ chrome) ──
  it('files tab browses via the explorer, not the drill-down/picker', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    await rig.route.selectTab('files');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('data-recued-collection-explorer');
    // The old raw-id drill-down box + mirror-search picker are gone for files.
    expect(html).not.toContain('data-recued-data-timeline-entity');
    expect(html).not.toContain('data-ref-picker="data-mirror-search"');
    rig.route.dispose();
  });

  it('the files explorer lists file records with the path as the title', async () => {
    const listInstances = vi.fn(async () => ({
      instances: [
        { slug: 'inbox', platform: 'file', adapter_type: 'local', caps: {}, auth_state: 'ok', last_synced_at: null },
      ],
    }));
    const list = vi.fn(async () => ({
      records: [
        { record_id: 'rec-1', received_at: 1, modified_at: 1, hot_fields: { path: '/docs/notes.txt', size: 5, mime_type: 'text/plain' }, size_bytes: 5, source_id: 'rec-1' },
      ],
    }));
    const rig = mountRoute({
      collectionListInstancesCaller: listInstances as never,
      collectionListCaller: list as never,
    });
    await rig.route.whenLoaded();
    await rig.route.selectTab('files');
    // One instance → auto-selected → its records fetched for (file, inbox).
    expect(list).toHaveBeenCalledWith({ platform: 'file', slug: 'inbox', limit: expect.any(Number) });
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('/docs/notes.txt'); // primary_field (path) title
    // Upload widget + file-source CTA are preserved as persistent tab chrome.
    expect(html).toContain(DATA_ROUTE_FILE_SOURCES_ATTR);
    rig.route.dispose();
  });

  // ── D-198 Slice 5 — webhook explorer tab (Received cluster) ──────────
  it('mounts the "Webhook deliveries" tab inside the Received cluster (not Connected)', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(`${DATA_ROUTE_TAB_ATTR}="webhook"`);
    expect(html).toContain('Webhook deliveries');
    // Grouped under the "Received" cluster label, before "Connected".
    const received = html.indexOf('Received');
    const webhook = html.indexOf(`${DATA_ROUTE_TAB_ATTR}="webhook"`);
    const connected = html.indexOf('Connected');
    expect(received).toBeGreaterThanOrEqual(0);
    expect(received).toBeLessThan(webhook);
    expect(webhook).toBeLessThan(connected);
    rig.route.dispose();
  });

  it('webhook tab browses via the explorer, not the form-response surface', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    await rig.route.selectTab('webhook');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('data-recued-collection-explorer');
    // `isReceivedTab` stays form_response-only, so the form-response detail
    // surface must NOT render for webhook.
    expect(html).not.toContain(DATA_ROUTE_FORM_RESPONSE_ROW_ATTR);
    rig.route.dispose();
  });

  it('the webhook explorer lists deliveries with the method as the title', async () => {
    const listInstances = vi.fn(async () => ({
      instances: [
        { slug: 'intake', platform: 'webhook', adapter_type: 'webhook', caps: {}, auth_state: 'ok', last_synced_at: null },
      ],
    }));
    const list = vi.fn(async () => ({
      records: [
        { record_id: 'wh-1', received_at: 1, modified_at: 1, hot_fields: { method: 'POST', remote_ip: '203.0.113.4' }, size_bytes: 0, source_id: 'wh-1' },
      ],
    }));
    const rig = mountRoute({
      collectionListInstancesCaller: listInstances as never,
      collectionListCaller: list as never,
    });
    await rig.route.whenLoaded();
    await rig.route.selectTab('webhook');
    // The webhook tab id IS the canonical platform name — no `files`-style remap.
    expect(list).toHaveBeenCalledWith({ platform: 'webhook', slug: 'intake', limit: expect.any(Number) });
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('POST'); // primary_field (method) title
    expect(html).toContain('203.0.113.4'); // summary field (remote_ip)
    rig.route.dispose();
  });

  // ── D-198 Phase 2 — Provenance cluster (annotation / link) ───────────
  it('mounts Annotations + Links tabs under the "Provenance" cluster (after Connected)', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(`${DATA_ROUTE_TAB_ATTR}="annotation"`);
    expect(html).toContain(`${DATA_ROUTE_TAB_ATTR}="link"`);
    expect(html).toContain('Annotations');
    expect(html).toContain('Links');
    expect(html.indexOf('Connected')).toBeLessThan(html.indexOf('Provenance'));
    rig.route.dispose();
  });

  it('the annotation tab browses annotation.list (single collection), titled by key', async () => {
    const annotationList = vi.fn(async () => ({
      annotations: [
        { _id: 'a1', _collection: 'annotation', target_collection: 'mail', target_id: 'msg-1', key: 'summary', value: 'Wants a call', authored_by_recipe_id: 'r1', source_record_hash: 'h', recipe_hash: 'rh', authored_at: 1 },
      ],
    }));
    const rig = mountRoute({ annotationListCaller: annotationList as never });
    await rig.route.whenLoaded();
    await rig.route.selectTab('annotation');
    expect(annotationList).toHaveBeenCalled();
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('data-recued-collection-explorer');
    expect(html).toContain('summary'); // primary_field (key) as title
    expect(html).toContain('msg-1'); // summary field (target_id)
    // Single collection → no instance chips, no "Nothing connected".
    expect(html).not.toContain('col-explorer-instance-chip');
    expect(html).not.toContain('Nothing connected');
    rig.route.dispose();
  });

  it('the link tab opens detail from the loaded list — no collection.get', async () => {
    const linkList = vi.fn(async () => ({
      links: [
        { _id: 'l1', _collection: 'link', from_collection: 'mail', from_id: 'msg-1', to_collection: 'calendar', to_id: 'evt-1', role: 'scheduled-from', created_at: 1, authored_by_recipe_id: 'r1' },
      ],
    }));
    const getCaller = vi.fn(async () => ({ record: null }));
    const rig = mountRoute({ linkListCaller: linkList as never, collectionGetCaller: getCaller as never });
    await rig.route.whenLoaded();
    await rig.route.selectTab('link');
    expect(rig.root.children[0]?.innerHTML ?? '').toContain('scheduled-from'); // primary_field (role)

    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, { [COLLECTION_RECORD_ID_ATTR]: 'l1' });
    await rig.route.whenLoaded();
    const detail = rig.root.children[0]?.innerHTML ?? '';
    expect(detail).toContain('Record detail');
    expect(detail).toContain('scheduled-from'); // detail rendered from the loaded record
    expect(getCaller).not.toHaveBeenCalled(); // provenance detail never hits collection.get
    rig.route.dispose();
  });

  it('a provenance detail resolves against the CURRENT list (removed id → "no longer exists")', async () => {
    const linkList = vi.fn(async () => ({
      links: [
        { _id: 'l1', _collection: 'link', from_collection: 'mail', from_id: 'm', to_collection: 'calendar', to_id: 'e', role: 'scheduled-from', created_at: 1, authored_by_recipe_id: 'r' },
      ],
    }));
    const rig = mountRoute({ linkListCaller: linkList as never });
    await rig.route.whenLoaded();
    await rig.route.selectTab('link');
    // Open an id NOT in the loaded list (as if a live refresh removed it) — the
    // detail resolves to null (→ "no longer exists"), never a stuck "Loading".
    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, { [COLLECTION_RECORD_ID_ATTR]: 'gone' });
    await rig.route.whenLoaded();
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('no longer exists');
    expect(html).not.toContain('Loading record');
    rig.route.dispose();
  });

  it('a provenance tab with no caller wired shows a not-wired notice', async () => {
    const rig = mountRoute(); // no annotationListCaller
    await rig.route.whenLoaded();
    await rig.route.selectTab('annotation');
    expect(rig.root.children[0]?.innerHTML ?? '').toContain('not wired');
    rig.route.dispose();
  });

  // ── D-198 Phase 3 — Storage cluster (shared KV) ──────────────────────
  it('mounts the Shared tab under the "Storage" cluster (after Provenance)', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(`${DATA_ROUTE_TAB_ATTR}="shared"`);
    expect(html).toContain('Storage'); // cluster label
    expect(html.indexOf('Provenance')).toBeLessThan(html.indexOf('Storage'));
    rig.route.dispose();
  });

  it('the Shared tab browses the durable KV (shared.list), titled by key', async () => {
    const sharedList = vi.fn(async () => ({
      entries: [
        { key: 'data.shared.onboarding.step', value: 'welcome' },
        { key: 'data.shared.counter', value: 42 },
      ],
    }));
    const rig = mountRoute({ sharedListCaller: sharedList as never });
    await rig.route.whenLoaded();
    await rig.route.selectTab('shared');
    expect(sharedList).toHaveBeenCalled();
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('data-recued-collection-explorer');
    expect(html).toContain('data.shared.onboarding.step'); // primary_field (key) title
    expect(html).toContain('welcome'); // summary field (value)
    // Single global collection → no instance bar.
    expect(html).not.toContain('col-explorer-instance-chip');
    rig.route.dispose();
  });

  it('D-192 — Files tab renders the "Add a file source" CTA with one enroll deep link per declared file vendor', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    await rig.route.selectTab('files');
    const html = rig.root.children[0]?.innerHTML ?? '';
    // The CTA block is present on the Files tab...
    expect(html).toContain(DATA_ROUTE_FILE_SOURCES_ATTR);
    // ...registry-driven: exactly one enroll deep link per FILE_VENDOR_DECLARATIONS
    // entry (a future 3rd file vendor surfaces here with no route edit).
    expect(FILE_VENDOR_DECLARATIONS.length).toBeGreaterThan(0);
    for (const v of FILE_VENDOR_DECLARATIONS) {
      expect(html).toContain(`${DATA_ROUTE_FILE_SOURCE_LINK_ATTR}="${v.vendor}"`);
      // The `#`-hash + `/` separators survive `e()` (it escapes only &<>"'),
      // so the deep link is a valid clickable shell route.
      expect(html).toContain(`href="#connections/others/enroll/${v.vendor}"`);
      expect(html).toContain(v.display_name);
    }
    // No stray links beyond the registry.
    const linkCount = (
      html.match(new RegExp(`${DATA_ROUTE_FILE_SOURCE_LINK_ATTR}=`, 'g')) ?? []
    ).length;
    expect(linkCount).toBe(FILE_VENDOR_DECLARATIONS.length);
    rig.route.dispose();
  });

  it('D-192 — the file-source CTA is Files-tab-only (absent on mail / calendar / crm mirrors)', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    for (const tab of ['mail', 'calendar', 'crm'] as const) {
      await rig.route.selectTab(tab);
      expect(rig.root.children[0]?.innerHTML ?? '').not.toContain(
        DATA_ROUTE_FILE_SOURCES_ATTR,
      );
    }
    rig.route.dispose();
  });

  it('crm mirror tab keeps the raw-id box (no local searchable store)', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    await rig.route.selectTab('crm');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('data-recued-data-timeline-entity');
    expect(html).not.toContain('data-ref-picker="data-mirror-search"');
    rig.route.dispose();
  });

});

describe('R18 — Data deep-linking (#data/<tab>/<entity_id>)', () => {
  it('hydrates a form-response detail from the deep link', async () => {
    const formResponseGetCaller = vi.fn<DataFormResponseGetCaller>(async (args) => ({
      response: formResponse({ _id: args.submission_id, submission_id: args.submission_id }),
    }));
    const rig = mountRoute({
      initialTab: 'form_response',
      initialEntityId: 'submission-deep',
      formResponseGetCaller,
    });
    await rig.route.whenLoaded();

    expect(rig.route.activeTab()).toBe('form_response');
    expect(formResponseGetCaller).toHaveBeenCalledWith({
      submission_id: 'submission-deep',
    });
    expect(rig.root.children[0]?.innerHTML).toContain(
      `${DATA_ROUTE_FORM_RESPONSE_DETAIL_ATTR}="submission-deep"`,
    );
    rig.route.dispose();
  });

  it('an explorer-tab deep link opens the addressed record via collection.get (no timeline)', async () => {
    // D-198 sub-record deep link — `#data/mail/msg-1` opens that record's detail
    // (not just the tab, and never a timeline the explorer wouldn't render).
    const timelineCaller = vi.fn<DataTimelineCaller>(async () => timelineResponse());
    const listInstances = vi.fn(async () => ({
      instances: [{ slug: 'gmail', platform: 'mail', adapter_type: 'gmail', caps: {}, auth_state: 'ok', last_synced_at: null }],
    }));
    const list = vi.fn(async () => ({
      records: [{ record_id: 'msg-1', received_at: 1, modified_at: 1, hot_fields: { subject: 'Renewal', from: 's@a.com' }, size_bytes: 0, source_id: 'msg-1' }],
    }));
    const get = vi.fn(async () => ({
      record: { record_id: 'msg-1', received_at: 1, modified_at: 1, hot_fields: { subject: 'Renewal', from: 's@a.com' }, size_bytes: 0, source_id: 'msg-1', body_inline: 'hi' },
    }));
    const rig = mountRoute({
      timelineCaller, initialTab: 'mail', initialEntityId: 'msg-1',
      collectionListInstancesCaller: listInstances as never,
      collectionListCaller: list as never,
      collectionGetCaller: get as never,
    });
    await rig.route.whenLoaded();

    expect(rig.route.activeTab()).toBe('mail');
    // Opened the addressed record (auto-selected sole instance → get).
    expect(get).toHaveBeenCalledWith({ platform: 'mail', slug: 'gmail', record_id: 'msg-1' });
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('Record detail');
    expect(html).toContain('Renewal');
    expect(timelineCaller).not.toHaveBeenCalled();

    rig.route.dispose();
  });

  it('an exact citation link selects its account, opens the record, and offers the cited-answer return', async () => {
    const record = {
      record_id: 'msg-1',
      received_at: 1,
      modified_at: 1,
      hot_fields: { subject: 'Quarterly planning', from: 'lead@example.com' },
      size_bytes: 0,
      source_id: 'provider-msg-1',
      body_inline: 'Agenda and decisions',
    };
    const listInstances = vi.fn(async () => ({
      instances: [
        {
          slug: 'personal',
          platform: 'mail',
          adapter_type: 'gmail',
          caps: {},
          auth_state: 'healthy',
          last_synced_at: 1,
        },
        {
          slug: 'work',
          platform: 'mail',
          adapter_type: 'gmail',
          caps: {},
          auth_state: 'healthy',
          last_synced_at: 1,
        },
      ],
    }));
    const list = vi.fn(async () => ({ records: [record] }));
    const get = vi.fn(async () => ({ record }));
    const rig = mountRoute({
      initialTab: 'mail',
      initialCollectionSlug: 'work',
      initialEntityId: 'msg-1',
      chatReturn: {
        sessionId: 'chat/one',
        messageId: 'answer #1',
      },
      collectionListInstancesCaller: listInstances as never,
      collectionListCaller: list as never,
      collectionGetCaller: get as never,
    });
    await rig.route.whenLoaded();

    expect(list).toHaveBeenCalledWith({
      platform: 'mail',
      slug: 'work',
      limit: expect.any(Number),
    });
    expect(list).not.toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'personal' }),
    );
    expect(get).toHaveBeenCalledWith({
      platform: 'mail',
      slug: 'work',
      record_id: 'msg-1',
    });
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(`${DATA_ROUTE_CHAT_RETURN_ATTR}`);
    expect(html).toContain('You came here from a cited Chat answer.');
    expect(html).toContain(
      'href="#chat/session/chat%2Fone/answer/answer%20%231"',
    );
    expect(html).toContain('Back to cited answer');
    expect(html).toContain('Quarterly planning');

    rig.route.dispose();
  });

  it('resolves a run-affected source record across accounts, opens only the unique match, and preserves the run return', async () => {
    const record = {
      record_id: 'event-1',
      received_at: 1,
      modified_at: 1,
      hot_fields: { summary: 'Customer review' },
      size_bytes: 0,
      source_id: 'provider-event-1',
    };
    const listInstances = vi.fn(async () => ({
      instances: [
        {
          slug: 'personal',
          platform: 'calendar',
          adapter_type: 'gcal',
          caps: {},
          auth_state: 'healthy',
          last_synced_at: 1,
        },
        {
          slug: 'work',
          platform: 'calendar',
          adapter_type: 'gcal',
          caps: {},
          auth_state: 'healthy',
          last_synced_at: 1,
        },
      ],
    }));
    const list = vi.fn(async () => ({ records: [record] }));
    const get = vi.fn(async (request: {
      platform: string;
      slug: string;
      record_id: string;
    }) => ({
      record: request.slug === 'work' ? record : null,
    }));
    const replaceState = vi.fn();
    const logsReturn = {
      runId: 'run/one',
      returnToChat: {
        sessionId: 'chat 1',
        planId: 'plan/2',
      },
    };
    const rig = mountRoute({
      initialTab: 'calendar',
      initialEntityId: 'event-1',
      verifyInitialSourceRecord: true,
      logsReturn,
      verificationRelationship: 'derived',
      replaceState,
      collectionListInstancesCaller: listInstances as never,
      collectionListCaller: list as never,
      collectionGetCaller: get as never,
    });
    const loadingHtml = rig.root.children[0]?.innerHTML ?? '';
    expect(loadingHtml).toContain(DATA_ROUTE_VERIFICATION_NEXT_ATTR);
    expect(loadingHtml).toContain(
      'Loading the linked item before next steps become available',
    );
    expect(loadingHtml).not.toContain(
      `${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="reviewed"`,
    );
    await rig.route.whenLoaded();

    expect(get).toHaveBeenCalledWith({
      platform: 'calendar',
      slug: 'personal',
      record_id: 'event-1',
    });
    expect(get).toHaveBeenCalledWith({
      platform: 'calendar',
      slug: 'work',
      record_id: 'event-1',
    });
    expect(list).toHaveBeenCalledWith({
      platform: 'calendar',
      slug: 'work',
      limit: expect.any(Number),
    });
    expect(list).not.toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'personal' }),
    );
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(DATA_ROUTE_LOGS_RETURN_ATTR);
    expect(html).toContain('Confirm the created or changed record');
    expect(html).toContain(
      'This record was written by the run.',
    );
    expect(html).toContain(
      `${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="reviewed"`,
    );
    expect(html).toContain(
      'href="#chat/session/chat%201/plan/plan%2F2/verification/reviewed/'
      + 'run/run%2Fone/relationship/derived"',
    );
    expect(html).toContain(
      'href="#chat/session/chat%201/plan/plan%2F2/'
      + 'verification/needs_help/run/run%2Fone/relationship/derived"',
    );
    expect(html).toContain('I reviewed it — continue in Chat');
    expect(html).toContain('I need help interpreting this');
    expect(html).toContain(
      'nothing retries from this page',
    );
    expect(html).toContain(
      'href="#logs/run%2Fone/return/chat/session/chat%201/plan/plan%2F2"',
    );
    expect(html).toContain('Back to run outcome');
    expect(html).toContain('Customer review');
    expect(html).toContain(
      `<h2 class="col-explorer-detail-title" `
      + `${COLLECTION_DETAIL_HEADING_ATTR} tabindex="-1">Customer review</h2>`,
    );
    expect(html.indexOf('Customer review')).toBeLessThan(
      html.indexOf(DATA_ROUTE_VERIFICATION_NEXT_ATTR),
    );
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      '',
      '#data/calendar/record/work/event-1/relationship/derived/'
      + 'return/logs/run%2Fone/return/chat/session/chat%201/plan/plan%2F2',
    );

    await rig.route.selectTab('contact');
    const navigatedHtml = rig.root.children[0]?.innerHTML ?? '';
    expect(navigatedHtml).not.toContain(DATA_ROUTE_LOGS_RETURN_ATTR);
    expect(navigatedHtml).not.toContain(DATA_ROUTE_VERIFICATION_NEXT_ATTR);
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      '',
      '#data/contact',
    );

    rig.route.dispose();
  });

  it('does not guess when a run-affected record id is ambiguous across accounts', async () => {
    const record = {
      record_id: 'event-1',
      received_at: 1,
      modified_at: 1,
      hot_fields: { summary: 'Shared id' },
      size_bytes: 0,
      source_id: 'event-1',
    };
    const list = vi.fn(
      () => new Promise<{ records: typeof record[] }>(() => {}),
    );
    const replaceState = vi.fn();
    const rig = mountRoute({
      initialTab: 'calendar',
      initialEntityId: 'event-1',
      verifyInitialSourceRecord: true,
      logsReturn: {
        runId: 'run-1',
        returnToChat: {
          sessionId: 'chat-1',
          planId: 'plan-1',
        },
      },
      replaceState,
      collectionListInstancesCaller: vi.fn(async () => ({
        instances: [
          {
            slug: 'personal',
            platform: 'calendar',
            adapter_type: 'gcal',
            caps: {},
            auth_state: 'healthy',
            last_synced_at: 1,
          },
          {
            slug: 'work',
            platform: 'calendar',
            adapter_type: 'gcal',
            caps: {},
            auth_state: 'healthy',
            last_synced_at: 1,
          },
        ],
      })) as never,
      collectionListCaller: list as never,
      collectionGetCaller: vi.fn(async () => ({ record })) as never,
    });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(
      'This record id appears in more than one connected source.',
    );
    expect(html).toContain('Choose the source you want to verify.');
    expect(html).toContain('gcal · personal');
    expect(html).toContain('gcal · work');
    expect(html).toContain(DATA_ROUTE_LOGS_RETURN_ATTR);
    expect(list).not.toHaveBeenCalled();
    expect(html).not.toContain('Record detail');
    expect(html).toContain(
      `${DATA_ROUTE_VERIFICATION_NEXT_ATTR} data-state="unresolved"`,
    );
    expect(html).not.toContain(
      `${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="reviewed"`,
    );
    expect(html).toContain(
      `${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="needs-help"`,
    );
    expect(html).toContain('I need help finding this item');

    emitClick(
      rig.root.children[0]!,
      COLLECTION_SELECT_INSTANCE_ACTION,
      { [COLLECTION_INSTANCE_SLUG_ATTR]: 'personal' },
    );
    expect(list).toHaveBeenCalledWith({
      platform: 'calendar',
      slug: 'personal',
      limit: expect.any(Number),
    });
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      '',
      '#data/calendar/verify/event-1/return/logs/run-1/return/chat/'
      + 'session/chat-1/plan/plan-1',
    );

    rig.route.dispose();
  });

  it('does not claim a unique source when another account could not be checked', async () => {
    const record = {
      record_id: 'event-1',
      received_at: 1,
      modified_at: 1,
      hot_fields: { summary: 'Apparent match' },
      size_bytes: 0,
      source_id: 'event-1',
    };
    const list = vi.fn(async () => ({ records: [record] }));
    const get = vi.fn(async (request: { slug: string }) => {
      if (request.slug === 'work') throw new Error('account unavailable');
      return { record };
    });
    const rig = mountRoute({
      initialTab: 'calendar',
      initialEntityId: 'event-1',
      verifyInitialSourceRecord: true,
      logsReturn: { runId: 'run-1' },
      collectionListInstancesCaller: vi.fn(async () => ({
        instances: [
          {
            slug: 'personal',
            platform: 'calendar',
            adapter_type: 'gcal',
            caps: {},
            auth_state: 'healthy',
            last_synced_at: 1,
          },
          {
            slug: 'work',
            platform: 'calendar',
            adapter_type: 'gcal',
            caps: {},
            auth_state: 'degraded',
            last_synced_at: 1,
          },
        ],
      })) as never,
      collectionListCaller: list as never,
      collectionGetCaller: get as never,
    });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(
      'Recued could not check every connected source.',
    );
    expect(html).toContain('Choose a source to verify this item.');
    expect(html).toContain('gcal · personal');
    expect(html).toContain('gcal · work');
    expect(html).toContain(DATA_ROUTE_LOGS_RETURN_ATTR);
    expect(list).not.toHaveBeenCalled();
    expect(html).not.toContain('Record detail');

    rig.route.dispose();
  });

  it('explains a missing run-affected source record without dropping the run return', async () => {
    const rig = mountRoute({
      initialTab: 'mail',
      initialEntityId: 'message-deleted',
      verifyInitialSourceRecord: true,
      logsReturn: { runId: 'run-1' },
      collectionListInstancesCaller: vi.fn(async () => ({
        instances: [
          {
            slug: 'personal',
            platform: 'mail',
            adapter_type: 'gmail',
            caps: {},
            auth_state: 'healthy',
            last_synced_at: 1,
          },
          {
            slug: 'work',
            platform: 'mail',
            adapter_type: 'gmail',
            caps: {},
            auth_state: 'healthy',
            last_synced_at: 1,
          },
        ],
      })) as never,
      collectionListCaller: vi.fn(async () => ({ records: [] })) as never,
      collectionGetCaller: vi.fn(async () => ({ record: null })) as never,
    });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(
      'This affected item is not currently in connected Data.',
    );
    expect(html).toContain('It may have been deleted or not synced yet.');
    expect(html).toContain('Back to run outcome');
    expect(html).not.toContain('Record detail');

    rig.route.dispose();
  });

  it('keeps the run return on a globally addressable Data item after hydration', async () => {
    const replaceState = vi.fn();
    const rig = mountRoute({
      initialTab: 'contact',
      initialEntityId: 'sam@example.com',
      logsReturn: { runId: 'run-1' },
      verificationRelationship: 'action',
      replaceState,
      contactGetCaller: vi.fn(async () => ({
        contact: contactRecord({ email: 'sam@example.com', name: 'Sam' }),
      })),
    });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(DATA_ROUTE_LOGS_RETURN_ATTR);
    expect(html).toContain('Back to run outcome');
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      '',
      '#data/contact/item/sam%40example.com/relationship/action/'
      + 'return/logs/run-1',
    );
    expect(html).toContain('Review the record used by the action');
    expect(html).not.toContain(
      `${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="reviewed"`,
    );

    rig.route.dispose();
  });

  it('drops a queued citation open after the user switches Data tabs', async () => {
    let resolveInitialInstances!: (value: {
      instances: Array<Record<string, unknown>>;
    }) => void;
    const initialInstances = new Promise<{
      instances: Array<Record<string, unknown>>;
    }>((resolve) => {
      resolveInitialInstances = resolve;
    });
    let instanceReads = 0;
    const listInstances = vi.fn(() => {
      instanceReads += 1;
      if (instanceReads === 1) return initialInstances;
      return Promise.resolve({
        instances: [{
          slug: 'office',
          platform: 'calendar',
          adapter_type: 'gcal',
          caps: {},
          auth_state: 'healthy',
          last_synced_at: 1,
        }],
      });
    });
    const get = vi.fn(async () => ({ record: null }));
    const rig = mountRoute({
      initialTab: 'mail',
      initialCollectionSlug: 'work',
      initialEntityId: 'mail-1',
      collectionListInstancesCaller: listInstances as never,
      collectionListCaller: vi.fn(async () => ({ records: [] })) as never,
      collectionGetCaller: get as never,
    });
    const initialLoad = rig.route.whenLoaded();

    await rig.route.selectTab('calendar');
    resolveInitialInstances({
      instances: [{
        slug: 'work',
        platform: 'mail',
        adapter_type: 'gmail',
        caps: {},
        auth_state: 'healthy',
        last_synced_at: 1,
      }],
    });
    await initialLoad;

    expect(rig.route.activeTab()).toBe('calendar');
    expect(get).not.toHaveBeenCalled();
    rig.route.dispose();
  });

  it('keeps the Chat return available when the cited source was disconnected', async () => {
    const get = vi.fn(async () => ({ record: null }));
    const rig = mountRoute({
      initialTab: 'mail',
      initialCollectionSlug: 'work',
      initialEntityId: 'mail-1',
      chatReturn: {
        sessionId: 'chat_1',
        messageId: 'msg_cited',
      },
      collectionListInstancesCaller: vi.fn(async () => ({
        instances: [{
          slug: 'personal',
          platform: 'mail',
          adapter_type: 'gmail',
          caps: {},
          auth_state: 'healthy',
          last_synced_at: 1,
        }],
      })) as never,
      collectionListCaller: vi.fn(async () => ({ records: [] })) as never,
      collectionGetCaller: get as never,
    });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(
      'The connected source for this cited record is no longer available.',
    );
    expect(html).toContain('Back to cited answer');
    expect(get).not.toHaveBeenCalled();
    rig.route.dispose();
  });

  it('a single-collection deep link opens the addressed record from the loaded list', async () => {
    const annotationList = vi.fn(async () => ({
      annotations: [
        { _id: 'a1', _collection: 'annotation', target_collection: 'mail', target_id: 'msg-1', key: 'summary', value: 'Wants a call', authored_by_recipe_id: 'r', source_record_hash: 'h', recipe_hash: 'rh', authored_at: 1 },
      ],
    }));
    const rig = mountRoute({ initialTab: 'annotation', initialEntityId: 'a1', annotationListCaller: annotationList as never });
    await rig.route.whenLoaded();

    expect(rig.route.activeTab()).toBe('annotation');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('Record detail'); // detail opened directly from the deep link
    expect(html).toContain('Wants a call'); // the record's value, from the loaded list
    rig.route.dispose();
  });

  it('a crm deep link still hydrates its data.timeline drill-down', async () => {
    const timelineCaller = vi.fn<DataTimelineCaller>(async () => timelineResponse());
    const rig = mountRoute({ timelineCaller, initialTab: 'crm', initialEntityId: 'hubspot_deal_1' });
    await rig.route.whenLoaded();

    expect(rig.route.activeTab()).toBe('crm');
    expect(timelineCaller).toHaveBeenCalledWith({ entity_id: 'crm:hubspot_deal_1', limit: 50 });

    rig.route.dispose();
  });

  it('hydrates a contact timeline from the deep link', async () => {
    const timelineCaller = vi.fn<DataTimelineCaller>(async () => timelineResponse());
    const rig = mountRoute({
      timelineCaller,
      initialTab: 'contact',
      initialEntityId: 'sam@acme.test',
    });
    await rig.route.whenLoaded();

    expect(rig.route.activeTab()).toBe('contact');
    expect(timelineCaller).toHaveBeenCalledWith({
      entity_id: 'contact:sam@acme.test',
      limit: 50,
    });

    rig.route.dispose();
  });

  it('falls back to the Contacts tab on an unknown initialTab', async () => {
    const rig = mountRoute({ initialTab: 'bogus-kind' });
    await rig.route.whenLoaded();
    expect(rig.route.activeTab()).toBe('contact');
    rig.route.dispose();
  });

  it('syncs the URL via replaceState on tab switch + timeline open (no remount)', async () => {
    const replaceState = vi.fn();
    const rig = mountRoute();
    // Attach a fake window/history to the route's document.
    (rig.doc as unknown as { defaultView: unknown }).defaultView = {
      history: { replaceState },
    };
    await rig.route.whenLoaded();

    await rig.route.selectTab('task');
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '#data/task');

    await rig.route.openTimelineDrilldown('mail', 'msg-1');
    // Synced at open (raw) then re-synced after the id normalizes to `mail:msg-1`
    // (codex fold #3) — the final URL matches the rendered entity.
    expect(replaceState).toHaveBeenCalledWith(null, '', '#data/mail/msg-1');
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '#data/mail/mail%3Amsg-1');

    rig.route.dispose();
  });
});

describe('R18 — Data live-update (warehouse / memory broadcasts)', () => {
  it('subscribes to Data invalidations and silently re-fetches on a warehouse write', async () => {
    const { subscribe, listeners } = makeSubscribe();
    const rig = mountRoute({ subscribe, liveRefreshDebounceMs: 0 });
    await rig.route.whenLoaded();

    expect(listeners.has('warehouse')).toBe(true);
    expect(listeners.has('memory')).toBe(true);
    const before = vi.mocked(rig.contactListCaller).mock.calls.length;

    // A background warehouse write fans in → silent list re-fetch (no loading
    // flash; the data swaps in on the next render).
    listeners.get('warehouse')!({
      kind: 'warehouse',
      subkind: 'contact',
      id: 'c1',
      cursor: 2,
    });
    await rig.route.whenLoaded();

    expect(vi.mocked(rig.contactListCaller).mock.calls.length).toBeGreaterThan(before);

    rig.route.dispose();
  });

  it('refreshes Form responses after its canonical warehouse insert', async () => {
    const { subscribe, listeners } = makeSubscribe();
    const formResponseListCaller = vi.fn<DataFormResponseListCaller>(async () => ({
      responses: [formResponseListItem()],
    }));
    const rig = mountRoute({
      initialTab: 'form_response',
      formResponseListCaller,
      subscribe,
      liveRefreshDebounceMs: 0,
    });
    await rig.route.whenLoaded();
    const before = formResponseListCaller.mock.calls.length;

    listeners.get('warehouse')!({
      kind: 'warehouse',
      collection: 'form_response',
      op: 'insert',
      id: 'submission-2',
      cursor: 2,
    });
    await rig.route.whenLoaded();
    expect(formResponseListCaller.mock.calls.length).toBeGreaterThan(before);
    rig.route.dispose();
  });

  it('unsubscribes from the live-update bus on dispose', async () => {
    const { subscribe, listeners } = makeSubscribe();
    const rig = mountRoute({ subscribe, liveRefreshDebounceMs: 0 });
    await rig.route.whenLoaded();
    // Name the kinds rather than counting them, so adding one is a deliberate
    // edit here. `merge_*` are D-205 #2b — the first listeners those two
    // broadcast kinds have ever had (both were already in
    // WEBCLIENT_DEFAULT_SUBSCRIPTIONS, fanned to this client and read by nobody).
    expect([...listeners.keys()].sort()).toEqual([
      'memory',
      'merge_candidate',
      'merge_scan_progress',
      'warehouse',
    ]);

    rig.route.dispose();
    // The invariant that actually matters: EVERY subscription is torn down —
    // not that there happened to be N of them.
    expect(listeners.size).toBe(0);
  });
});

describe('R18 — codex fold (stale-response guards + URL honesty)', () => {
  const makeDeferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it('MEDIUM: a stale list refresh does not clobber a newer one (generation guard)', async () => {
    const dz: Array<ReturnType<typeof makeDeferred<{ contacts: ContactRecord[]; total: number }>>> = [];
    const contactListCaller = vi.fn<DataContactListCaller>(() => {
      const d = makeDeferred<{ contacts: ContactRecord[]; total: number }>();
      dz.push(d);
      return d.promise;
    });
    const rig = mountRoute({ contactListCaller });
    rig.route.refresh(); // gen2 (mount kicked off gen1)
    await flush();
    expect(dz).toHaveLength(2); // both refreshes reached contact.list

    // The newer refresh (gen2) resolves first + renders.
    dz[1]!.resolve({ contacts: [contactRecord({ email: 'b@x.test' })], total: 1 });
    await flush();
    expect(rig.route.contacts().map((c) => c.email)).toEqual(['b@x.test']);

    // The older refresh (gen1) resolves LATE — the guard drops it (no clobber).
    dz[0]!.resolve({ contacts: [contactRecord({ email: 'a@x.test' })], total: 1 });
    await flush();
    expect(rig.route.contacts().map((c) => c.email)).toEqual(['b@x.test']);

    rig.route.dispose();
  });

  it('MEDIUM: a stale mirror timeline refresh does not clobber a newer selection', async () => {
    const dz: Array<ReturnType<typeof makeDeferred<TimelineResponse>>> = [];
    const timelineCaller = vi.fn<DataTimelineCaller>(() => {
      const d = makeDeferred<TimelineResponse>();
      dz.push(d);
      return d.promise;
    });
    const rig = mountRoute({ timelineCaller });
    await rig.route.whenLoaded();

    // Open A, then B before A resolves.
    void rig.route.openTimelineDrilldown('mail', 'A');
    void rig.route.openTimelineDrilldown('mail', 'B');
    await flush();
    expect(dz).toHaveLength(2);

    // B (newer) resolves first.
    dz[1]!.resolve(timelineResponse());
    await flush();
    expect(rig.route.timeline()?.entity_id).toBe('mail:B');

    // A (stale) resolves LATE — dropped; the page keeps showing B.
    dz[0]!.resolve(timelineResponse());
    await flush();
    expect(rig.route.timeline()?.entity_id).toBe('mail:B');

    rig.route.dispose();
  });

  it('LOW: the mirror timeline re-syncs the URL to the resolved id after load', async () => {
    const replaceState = vi.fn();
    const rig = mountRoute();
    (rig.doc as unknown as { defaultView: unknown }).defaultView = {
      history: { replaceState },
    };
    await rig.route.whenLoaded();

    await rig.route.openTimelineDrilldown('mail', 'msg-1');
    // After the id normalizes to `mail:msg-1`, the URL matches the rendered
    // entity (and round-trips on refresh).
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '#data/mail/mail%3Amsg-1');

    rig.route.dispose();
  });

  it('opens the edit dialog for a work-entity deep link and keeps the id in the URL', async () => {
    const replaceState = vi.fn();
    const rig = mountRoute({ initialTab: 'task', initialEntityId: 'task-1' });
    (rig.doc as unknown as { defaultView: unknown }).defaultView = {
      history: { replaceState },
    };
    await rig.route.whenLoaded();

    // Work-entity detail IS the edit dialog — the deep link opens it on `task-1`
    // (fetched to hydrate the form).
    expect(rig.workEntityGetCaller).toHaveBeenCalledWith({ kind: 'task', id: 'task-1' });
    const dialog = rig.route.workEntityState().dialog;
    expect(dialog?.mode).toBe('edit');
    expect(dialog?.entity_id).toBe('task-1');
    // The id stays in the URL so a refresh / shared link re-opens it (symmetric
    // with the contact + mirror timeline deep links).
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '#data/task/task-1');

    rig.route.dispose();
  });

  it('drops the id from the URL when the work-entity edit dialog closes', async () => {
    const replaceState = vi.fn();
    const rig = mountRoute({ initialTab: 'task', initialEntityId: 'task-1' });
    (rig.doc as unknown as { defaultView: unknown }).defaultView = {
      history: { replaceState },
    };
    await rig.route.whenLoaded();
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '#data/task/task-1');

    // Closing the dialog re-normalizes the URL to the bare tab (no false
    // selection) — the render()-tail hash sync handles every close path.
    emitClick(rig.root.children[0]!, 'close-work-entity-dialog');
    expect(rig.route.workEntityState().dialog).toBeNull();
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '#data/task');

    rig.route.dispose();
  });
});

describe('D-174 P5 Data route — R18 contact load-more pagination', () => {
  // A caller that returns a FIXED page (default 2) starting at the requested
  // offset, with a stable `total` — so the route pages through it regardless of
  // the DEFAULT_LIMIT (100) it asks for.
  const pagedContactCaller = (total: number, pageSize = 2) =>
    vi.fn<DataContactListCaller>(async (args) => {
      const offset = args.offset ?? 0;
      const n = Math.max(0, Math.min(pageSize, total - offset));
      const contacts = Array.from({ length: n }, (_, i) =>
        contactRecord({
          email: `c${offset + i}@x.test`,
          name: `Contact ${offset + i}`,
        }),
      );
      return { contacts, total };
    });

  it('shows a "N of M loaded" footer and appends the next page at offset = loaded', async () => {
    const contactListCaller = pagedContactCaller(5);
    const rig = mountRoute({ contactListCaller });
    await rig.route.whenLoaded();

    let html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(DATA_ROUTE_CONTACT_LOAD_MORE_ATTR);
    expect(html).toContain('2 of 5 loaded');
    expect(html).toContain('Contact 0');
    expect(html).toContain('Contact 1');
    expect(html).not.toContain('Contact 2');
    // Initial fetch is offset-0 (no `offset` key).
    expect(contactListCaller).toHaveBeenCalledWith({ limit: 100 });

    emitClick(rig.root.children[0]!, 'load-more-contacts');
    await rig.route.whenLoaded();

    html = rig.root.children[0]?.innerHTML ?? '';
    expect(contactListCaller).toHaveBeenCalledWith({ limit: 100, offset: 2 });
    expect(html).toContain('4 of 5 loaded');
    expect(html).toContain('Contact 0'); // kept
    expect(html).toContain('Contact 2'); // appended
    expect(html).toContain('Contact 3');

    rig.route.dispose();
  });

  it('drops the footer once every contact is loaded', async () => {
    const contactListCaller = pagedContactCaller(3);
    const rig = mountRoute({ contactListCaller });
    await rig.route.whenLoaded(); // 2 of 3 → footer

    emitClick(rig.root.children[0]!, 'load-more-contacts');
    await rig.route.whenLoaded(); // offset 2 → 1 more → 3 of 3

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).not.toContain(DATA_ROUTE_CONTACT_LOAD_MORE_ATTR);
    expect(html).toContain('Contact 2');

    rig.route.dispose();
  });

  it('renders no footer when the first page already holds every contact', async () => {
    // Default caller: 1 contact, total 1.
    const rig = mountRoute();
    await rig.route.whenLoaded();
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain(
      DATA_ROUTE_CONTACT_LOAD_MORE_ATTR,
    );
    rig.route.dispose();
  });

  it('carries the active search filter into the load-more offset fetch', async () => {
    const contactListCaller = pagedContactCaller(5);
    const rig = mountRoute({ contactListCaller });
    await rig.route.whenLoaded();

    // Type a search → immediate replace fetch (offset 0 + name_contains).
    emitInput(rig.root.children[0]!, {
      value: 'rivera',
      hasAttribute: (k) => k === 'data-recued-data-contact-search',
      getAttribute: () => null,
    });
    await rig.route.whenLoaded();
    expect(contactListCaller).toHaveBeenCalledWith({
      limit: 100,
      name_contains: 'rivera',
    });

    emitClick(rig.root.children[0]!, 'load-more-contacts');
    await rig.route.whenLoaded();
    expect(contactListCaller).toHaveBeenCalledWith({
      limit: 100,
      offset: 2,
      name_contains: 'rivera',
    });

    rig.route.dispose();
  });
});

describe('D-174 P5 Data route — R18 work-entity load-more pagination', () => {
  // Paged task caller: a FIXED page (default 2) from the requested offset with a
  // stable server `total` (the kind/Source count — the client-side search is
  // applied later, so it never narrows `total`).
  const pagedTaskCaller = (total: number, pageSize = 2) =>
    vi.fn<DataWorkEntityListCaller>(async (args) => {
      const offset = args.offset ?? 0;
      const n = Math.max(0, Math.min(pageSize, total - offset));
      const entities = Array.from({ length: n }, (_, i) =>
        taskEntity({ id: `task-${offset + i}`, title: `Task ${offset + i}` }),
      );
      return { entities, total };
    });

  it('shows a footer and appends the next page at offset = loaded', async () => {
    const workEntityListCaller = pagedTaskCaller(5);
    const rig = mountRoute({ workEntityListCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('task');

    let html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(DATA_ROUTE_WORK_ENTITY_LOAD_MORE_ATTR);
    expect(html).toContain('2 of 5 loaded');
    expect(html).toContain('Task 0');
    expect(html).not.toContain('Task 2');
    // First work-entity fetch is offset-0 (no `offset` key).
    expect(workEntityListCaller.mock.calls[0]![0].offset).toBeUndefined();

    emitClick(rig.root.children[0]!, 'load-more-work-entities');
    await rig.route.whenLoaded();

    html = rig.root.children[0]?.innerHTML ?? '';
    expect(workEntityListCaller.mock.calls.at(-1)![0].offset).toBe(2);
    expect(html).toContain('4 of 5 loaded');
    expect(html).toContain('Task 0'); // kept
    expect(html).toContain('Task 2'); // appended
    expect(html).toContain('Task 3');

    rig.route.dispose();
  });

  it('drops the footer once every row is loaded', async () => {
    const workEntityListCaller = pagedTaskCaller(3);
    const rig = mountRoute({ workEntityListCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('task'); // 2 of 3 → footer

    emitClick(rig.root.children[0]!, 'load-more-work-entities');
    await rig.route.whenLoaded(); // offset 2 → 1 more → 3 of 3

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).not.toContain(DATA_ROUTE_WORK_ENTITY_LOAD_MORE_ATTR);
    expect(html).toContain('Task 2');

    rig.route.dispose();
  });

  it('renders no footer when the first page holds every row', async () => {
    // Default work-entity caller: 1 task, total 1.
    const rig = mountRoute();
    await rig.route.whenLoaded();
    await rig.route.selectTab('task');
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain(
      DATA_ROUTE_WORK_ENTITY_LOAD_MORE_ATTR,
    );
    rig.route.dispose();
  });

  it('keeps the footer under a search so a match past the first page can be loaded', async () => {
    const workEntityListCaller = pagedTaskCaller(5);
    const rig = mountRoute({ workEntityListCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('task'); // loaded [Task 0, Task 1] of 5

    // Search for a row NOT in the loaded page — the client filter hides every
    // row, but the footer stays (its "N of M loaded" count is honest and Load
    // more is how you reach the match).
    emitInput(rig.root.children[0]!, {
      value: 'Task 3',
      hasAttribute: () => false,
      getAttribute: (attr) =>
        attr === 'data-action'
          ? 'search-work-entities'
          : attr === 'data-kind'
            ? 'task'
            : null,
    });
    expect(rig.route.workEntityState().search_query).toBe('Task 3');
    let html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(DATA_ROUTE_WORK_ENTITY_LOAD_MORE_ATTR);
    // The `task-3` ROW isn't loaded yet (assert the row id, not the title —
    // 'Task 3' also appears as the search input's value).
    expect(html).not.toContain('data-entity-id="task-3"');

    // Load more (search still active) → task-3 arrives → the client search now
    // surfaces it.
    emitClick(rig.root.children[0]!, 'load-more-work-entities');
    await rig.route.whenLoaded();
    html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('data-entity-id="task-3"');

    rig.route.dispose();
  });
});

describe('D-174 P5 Data route — contact source label', () => {
  it('shows a friendly contact-source label, not the raw enum token', async () => {
    const contactListCaller = vi.fn<DataContactListCaller>(async () => ({
      contacts: [
        contactRecord({ email: 'a@x.test', source: 'email_from' }),
        contactRecord({ email: 'b@x.test', source: 'calendar_attendee' }),
      ],
      total: 2,
    }));
    const rig = mountRoute({ contactListCaller });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    // The row shows the human label…
    expect(html).toContain('Inbound email');
    expect(html).toContain('Calendar');
    // …not the raw `ContactSource` enum token (which read as cryptic + collided
    // with the first-class "Source" concept used elsewhere in #data).
    expect(html).not.toContain('email_from');
    expect(html).not.toContain('calendar_attendee');

    rig.route.dispose();
  });
});

describe('D-174 P5 Data route — work-entity edit dialog robustness', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('withholds reviewed until the exact work entity finishes loading', async () => {
    const detail = deferred<{ entity: WorkEntity | null }>();
    const workEntityGetCaller = vi.fn<DataWorkEntityGetCaller>(
      () => detail.promise,
    );
    const rig = mountRoute({
      initialTab: 'task',
      initialEntityId: 'task-1',
      logsReturn: {
        runId: 'run-1',
        returnToChat: {
          sessionId: 'chat-1',
          planId: 'plan-1',
        },
      },
      workEntityGetCaller,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(workEntityGetCaller).toHaveBeenCalledWith({
      kind: 'task',
      id: 'task-1',
    });
    const loadingHtml = rig.root.children[0]?.innerHTML ?? '';
    expect(loadingHtml).toContain(
      `${DATA_ROUTE_VERIFICATION_NEXT_ATTR} data-state="loading"`,
    );
    expect(loadingHtml).not.toContain(
      `${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="reviewed"`,
    );

    detail.resolve({ entity: taskEntity({ id: 'task-1' }) });
    await rig.route.whenLoaded();

    const readyHtml = rig.root.children[0]?.innerHTML ?? '';
    expect(readyHtml).toContain(
      `${DATA_ROUTE_VERIFICATION_NEXT_ATTR} data-state="ready"`,
    );
    expect(readyHtml).toContain(
      `${DATA_ROUTE_VERIFICATION_ACTION_ATTR}="reviewed"`,
    );

    rig.route.dispose();
  });

  it('drops a stale edit fetch superseded by a newer open (no stale dialog)', async () => {
    const d1 = deferred<{ entity: WorkEntity | null }>();
    const d2 = deferred<{ entity: WorkEntity | null }>();
    let n = 0;
    const workEntityGetCaller = vi.fn<DataWorkEntityGetCaller>(() => {
      n += 1;
      return n === 1 ? d1.promise : d2.promise;
    });
    const rig = mountRoute({ workEntityGetCaller });
    await rig.route.whenLoaded();
    await rig.route.selectTab('task');

    const p1 = rig.route.openEditWorkEntityDialog('task', 'task-1');
    const p2 = rig.route.openEditWorkEntityDialog('task', 'task-2');
    // The newer open (task-2) resolves first, then the now-stale task-1 fetch.
    d2.resolve({ entity: taskEntity({ id: 'task-2', title: 'Task 2' }) });
    await p2;
    d1.resolve({ entity: taskEntity({ id: 'task-1', title: 'Task 1' }) });
    await p1;

    const dialog = rig.route.workEntityState().dialog;
    expect(dialog?.mode).toBe('edit');
    expect(dialog?.entity_id).toBe('task-2'); // NOT the stale task-1
    rig.route.dispose();
  });

  it('closes the edit dialog when its entity is deleted', async () => {
    const workEntityDeleteCaller = vi.fn<DataWorkEntityDeleteCaller>(async (args) => ({
      ok: true,
      id: args.id,
      tombstoned: true,
    }));
    const rig = mountRoute({ workEntityDeleteCaller });
    await rig.route.whenLoaded();
    await rig.route.openEditWorkEntityDialog('task', 'task-1');
    expect(rig.route.workEntityState().dialog?.entity_id).toBe('task-1');

    await rig.route.deleteWorkEntity('task', 'task-1');
    expect(rig.route.workEntityState().dialog).toBeNull();
    rig.route.dispose();
  });
});

describe('D-174 P5 Data route — D-172 file download (explorer detail)', () => {
  const fileInstances = vi.fn(async () => ({
    instances: [
      { slug: 'inbox', platform: 'file', adapter_type: 'local', caps: {}, auth_state: 'ok', last_synced_at: null },
    ],
  }));
  const fileRecord = {
    record_id: 'rec-1',
    received_at: 1,
    modified_at: 1,
    hot_fields: { path: '/docs/notes.txt', size: 5, mime_type: 'text/plain' },
    size_bytes: 5,
    source_id: 'rec-1',
  };

  it('downloads the OPEN file record via data.file.read (from the explorer detail)', async () => {
    const fileReadCaller = vi.fn<DataFileReadCaller>(async () => ({
      record_id: 'rec-1',
      bytes_b64: 'aGVsbG8=', // base64('hello')
      mime_type: 'text/plain',
      filename: 'notes.txt',
      size_bytes: 5,
    }));
    // The get echoes back the record it was asked for, so opening the RIGHT
    // record is observable (not a coincidence of a single hardcoded id).
    const get = vi.fn(async (args: { record_id: string }) => ({
      record: { ...fileRecord, record_id: args.record_id },
    }));
    const rig = mountRoute({
      initialTab: 'files',
      fileReadCaller,
      collectionListInstancesCaller: fileInstances as never,
      collectionListCaller: (vi.fn(async () => ({ records: [fileRecord] }))) as never,
      collectionGetCaller: get as never,
    });
    await rig.route.whenLoaded();

    // No Download control in the LIST view — a record must be opened first.
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain(DATA_ROUTE_DOWNLOAD_FILE_ATTR);

    // Open the file record → the detail view shows the Download control.
    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, {
      [COLLECTION_RECORD_ID_ATTR]: 'rec-1',
    });
    await rig.route.whenLoaded();
    // The open targeted (file, inbox, rec-1) — not the tab id `files`.
    expect(get).toHaveBeenCalledWith({ platform: 'file', slug: 'inbox', record_id: 'rec-1' });
    expect(rig.root.children[0]?.innerHTML ?? '').toContain(DATA_ROUTE_DOWNLOAD_FILE_ATTR);

    emitClick(rig.root.children[0]!, 'download-file');
    await rig.route.whenLoaded();

    // The explorer record id is passed WHOLE to data.file.read (this fixture's
    // id has no `file:` prefix; the realistic-id cases below cover the prefix).
    expect(fileReadCaller).toHaveBeenCalledWith({ record_id: 'rec-1' });
    rig.route.dispose();
  });

  // D-192 remote byte-fetch — the download must pass the record_id WHOLE. Real
  // ids are `file:<32hex>` (CAS) / `file:remote:<b64>:<b64>` (vendor mirror); the
  // read path is keyed by the FULL id (CAS `collection.get`, remote
  // `parseRemoteFileRecordId`), so stripping the `file:` prefix breaks BOTH. The
  // `'rec-1'` case above never caught it (no prefix to strip).
  const downloadPassesWholeId = (label: string, id: string): void => {
    it(label, async () => {
      const fileReadCaller = vi.fn<DataFileReadCaller>(async () => ({
        record_id: id, bytes_b64: 'aGk=', mime_type: 'application/pdf', filename: 'r.pdf', size_bytes: 2,
      }));
      const row = { ...fileRecord, record_id: id, source_id: id };
      const get = vi.fn(async (args: { record_id: string }) => ({ record: { ...row, record_id: args.record_id } }));
      const rig = mountRoute({
        initialTab: 'files',
        fileReadCaller,
        collectionListInstancesCaller: fileInstances as never,
        collectionListCaller: (vi.fn(async () => ({ records: [row] }))) as never,
        collectionGetCaller: get as never,
      });
      await rig.route.whenLoaded();
      emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, { [COLLECTION_RECORD_ID_ATTR]: id });
      await rig.route.whenLoaded();
      emitClick(rig.root.children[0]!, 'download-file');
      await rig.route.whenLoaded();
      // The WHOLE id reaches data.file.read — a stripped form is unresolvable (404).
      expect(fileReadCaller).toHaveBeenCalledWith({ record_id: id });
      rig.route.dispose();
    });
  };
  downloadPassesWholeId(
    'passes the FULL file:remote:* id to data.file.read (never strips — the parser needs the prefix)',
    'file:remote:czNjb25u:V29yay9yZXBvcnQucGRm',
  );
  downloadPassesWholeId(
    'passes the FULL file:<hex> CAS id to data.file.read (collection.get is keyed by the full id)',
    'file:0123456789abcdef0123456789abcdef',
  );

  it('renders no download control when no fileReadCaller is wired', async () => {
    const rig = mountRoute({
      initialTab: 'files',
      collectionListInstancesCaller: fileInstances as never,
      collectionListCaller: (vi.fn(async () => ({ records: [fileRecord] }))) as never,
      collectionGetCaller: (vi.fn(async () => ({ record: fileRecord }))) as never,
    });
    await rig.route.whenLoaded();
    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, {
      [COLLECTION_RECORD_ID_ATTR]: 'rec-1',
    });
    await rig.route.whenLoaded();
    // Even with a record open, no read caller → no download affordance.
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain(
      DATA_ROUTE_DOWNLOAD_FILE_ATTR,
    );
    rig.route.dispose();
  });

  it('Back abandons an in-flight collection.get (no detail/Download reopen)', async () => {
    // Open a record whose get is still pending, hit Back, THEN let the get
    // resolve — the abandoned response must not reinstate the detail view.
    let resolveGet!: (v: { record: typeof fileRecord }) => void;
    const get = vi.fn(
      () => new Promise<{ record: typeof fileRecord }>((r) => { resolveGet = r; }),
    );
    const rig = mountRoute({
      initialTab: 'files',
      fileReadCaller: (vi.fn(async () => ({
        record_id: 'rec-1', bytes_b64: '', mime_type: 'text/plain', filename: 'x', size_bytes: 0,
      }))) as never,
      collectionListInstancesCaller: fileInstances as never,
      collectionListCaller: (vi.fn(async () => ({ records: [fileRecord] }))) as never,
      collectionGetCaller: get as never,
    });
    await rig.route.whenLoaded();

    emitClick(rig.root.children[0]!, COLLECTION_OPEN_RECORD_ACTION, {
      [COLLECTION_RECORD_ID_ATTR]: 'rec-1',
    });
    // Detail view is up (loading), Download painted; now navigate Back.
    expect(rig.root.children[0]?.innerHTML ?? '').toContain('Record detail');
    emitClick(rig.root.children[0]!, COLLECTION_DETAIL_CLOSE_ACTION);
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain('Record detail');

    // The stale get resolves AFTER Back — it must be dropped, not re-shown.
    resolveGet({ record: fileRecord });
    await rig.route.whenLoaded();
    await Promise.resolve();
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('data-recued-collection-explorer');
    expect(html).not.toContain('Record detail');
    expect(html).not.toContain(DATA_ROUTE_DOWNLOAD_FILE_ATTR);
    rig.route.dispose();
  });
});

// ── D-205 #5b — `#data/contact/import`: selective CRM promotion ─────────────
//
//  The cliff: a CRM is `hydrate_on_match`, so on an empty graph it mints ZERO
//  contacts. Connect HubSpot with ten thousand records and `#data/contact` sits
//  empty. Correct, and it reads as broken. This page is where that stops being a
//  mystery — and it is also the FIRST CALLER of the `contact.import.*` rpcs, which
//  shipped one commit earlier with none.

const importSourceHealth = (over: Record<string, unknown> = {}): ContactSourceHealth =>
  ({
    source_id: 'hubspot.work.contact',
    source_label: 'HubSpot (work)',
    enabled: true,
    last_success_at: 1_000,
    degraded: false,
    stale: false,
    last_error_code: null,
    last_error_message: null,
    last_cycle: {
      hydrated: 12,
      unchanged: 0,
      skipped: 9_988, // ← the strangers. Straight off the runner's own counters.
      created: 0,
      promoted: 0,
      disconnected: 0,
      failed_rows: 0,
      unkeyable: 0,
      ambiguous: 0,
      conflicted: 0,
      repointed: 0,
      mirror_failed: 0,
      linked: 12,
      complete: true,
    },
    ...over,
  }) as ContactSourceHealth;

describe('D-205 #5b — the import page', () => {
  const rigWithImport = (over: Record<string, unknown> = {}) =>
    mountRoute({
      contactSourceListCaller: vi.fn<DataContactSourceListCaller>(async () => ({
        sources: [importSourceHealth()],
      })),
      contactImportCandidatesCaller: vi.fn<DataContactImportCandidatesCaller>(async () => ({
        candidates: [
          { target_id: 'hubspot:contact:work:hs_2', email: 'carol@acme.test', name: 'Carol Jones', company: 'Acme' },
          { target_id: 'hubspot:contact:work:hs_3', email: 'dave@acme.test', name: 'Dave Lee' },
        ],
        total: 9_988,
        mirrored: 10_000,
      })),
      contactImportPromoteCaller: vi.fn<DataContactImportPromoteCaller>(async () => ({
        created: 1,
        already_known: 0,
        failures: [],
      })),
      ...over,
    });

  it('⛔ FAIL-CLOSED: no Import entry point unless BOTH callers are wired', async () => {
    // A picker that can list but not add is a dead end; one that can add but not list
    // is unusable. Absent → no entry point at all, rather than a page that cannot act.
    // (The discipline #2b established when it fail-closed the upstream-merge button.)
    const rig = mountRoute({}); // neither caller
    await rig.route.whenLoaded();
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain('open-contact-import');
    rig.route.dispose();
  });

  it('🔑 the OVERVIEW makes the cliff legible — the runner already counted the strangers', async () => {
    const rig = rigWithImport();
    await rig.route.whenLoaded();
    await rig.route.openContactImport();

    const html = rig.root.children[0]?.innerHTML ?? '';
    // Nothing new is computed. `skipped` IS the stranger count — it has been persisted
    // on every cycle since #1 and this is the first surface to say what it MEANS.
    expect(html).toContain('12 of your contacts enriched');
    expect(html).toContain('9988 people you have not corresponded with');
    expect(html).toContain('Browse &amp; add');
    rig.route.dispose();
  });

  it('a CONTACT BOOK offers no picker — full_import already took everyone', async () => {
    const rig = rigWithImport({
      contactSourceListCaller: vi.fn<DataContactSourceListCaller>(async () => ({
        sources: [
          importSourceHealth({
            source_id: 'google.personal.contact',
            source_label: 'Google Contacts (personal)',
            last_cycle: {
              ...importSourceHealth().last_cycle!,
              hydrated: 40,
              created: 300,
              skipped: 0, // a contact book NEVER skips a stranger
            },
          }),
        ],
      })),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactImport();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('nothing to choose');
    // ⛔ No picker. Offering one would be an affordance that does nothing — the
    // posture is read off the DECLARATION (`import_scope`), never guessed.
    expect(html).not.toContain('contact-import-browse');
    rig.route.dispose();
  });

  it('browsing lists the STRANGERS, and promoting sends exactly the ticked ids', async () => {
    const promoteCaller = vi.fn<DataContactImportPromoteCaller>(async () => ({
      created: 1,
      already_known: 0,
      failures: [],
    }));
    const rig = rigWithImport({ contactImportPromoteCaller: promoteCaller });
    await rig.route.whenLoaded();
    await rig.route.openContactImport();
    await rig.route.browseImportSource('hubspot.work.contact');

    let html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('Carol Jones');
    expect(html).toContain('10000 records in this CRM');
    expect(html).toContain('9988 people you have not corresponded with');

    rig.route.toggleImportTarget('hubspot:contact:work:hs_2');
    await rig.route.promoteImport();

    expect(rig.route.contactImport()).not.toBeNull();
    expect(promoteCaller).toHaveBeenCalledWith({
      source_id: 'hubspot.work.contact',
      target_ids: ['hubspot:contact:work:hs_2'], // ONLY the ticked one
    });

    // The ticks are cleared: those people are contacts now, and the re-read drops them
    // from the stranger list. A tick left behind would address someone no longer in it.
    expect(rig.route.contactImport()?.selected.size).toBe(0);
    html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('1 added');
    rig.route.dispose();
  });

  it('🔑 leaving a Source DROPS the selection — a tick must never cross CRMs', async () => {
    // The same `target_id` addresses a different person in a different CRM. Carrying a
    // tick across would promote someone the user never looked at.
    const rig = rigWithImport();
    await rig.route.whenLoaded();
    await rig.route.openContactImport();
    await rig.route.browseImportSource('hubspot.work.contact');

    rig.route.toggleImportTarget('hubspot:contact:work:hs_2');
    expect(rig.route.contactImport()?.selected.size).toBe(1);

    await rig.route.browseImportSource('salesforce.crm.contact');
    expect(rig.route.contactImport()?.selected.size).toBe(0);
    rig.route.dispose();
  });

  it('`#data/contact/import` is addressable, and cannot collide with a contact id', async () => {
    const rig = rigWithImport({ initialEntityId: 'import', initialTab: 'contact' });
    await rig.route.whenLoaded();
    // Every email carries an `@`; `import` does not.
    expect(rig.route.contactImport()).not.toBeNull();
    expect(rig.root.children[0]?.innerHTML ?? '').toContain('Import contacts');
    rig.route.dispose();
  });
});

// ── D-205 #5c — the manual vCard / CSV import ──────────────────────────────
//
//  An upload writes at the `manual` rung — the TOP of the C-2a ladder, where nothing
//  can ever correct it. Right when you TYPE a value; a foot-gun when you upload a
//  stale export you never opened. So the review shows ONLY the conflicts, and the
//  changes are OPT-IN.

const fakeFile = (name: string, text: string): File =>
  ({ name, text: async () => text }) as unknown as File;

const samplePlan = () => ({
  format: 'vcard' as const,
  adds: 2,
  unchanged: 5,
  changes: [
    {
      email: 'bob@x.test',
      name: 'Bob Smith',
      line: 3,
      fields: [{ field: 'company', from: 'Acme Inc.', to: 'STALE Inc' }],
    },
  ],
  errors: ['line 9: no email, name or phone — nothing could identify this person'],
});

describe('D-205 #5c — the file import panel', () => {
  const rigWithFile = (over: Record<string, unknown> = {}) =>
    mountRoute({
      contactSourceListCaller: vi.fn<DataContactSourceListCaller>(async () => ({ sources: [] })),
      contactImportFilePreviewCaller: vi.fn<DataContactImportFilePreviewCaller>(
        async () => samplePlan(),
      ),
      contactImportFileApplyCaller: vi.fn<DataContactImportFileApplyCaller>(async () => ({
        added: 2,
        changed: 0,
        skipped: 1,
        failures: [],
      })),
      ...over,
    });

  it('⛔ FAIL-CLOSED: no upload panel unless BOTH callers are wired', async () => {
    const rig = mountRoute({
      contactSourceListCaller: vi.fn<DataContactSourceListCaller>(async () => ({ sources: [] })),
      // preview only — you could look and never act
      contactImportFilePreviewCaller: vi.fn<DataContactImportFilePreviewCaller>(
        async () => samplePlan(),
      ),
    });
    await rig.route.whenLoaded();
    await rig.route.openContactImport();
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain('contact-import-file-pick');
    rig.route.dispose();
  });

  it('🔑 the review shows ONLY the conflicts — and the changes DEFAULT TO OFF', async () => {
    const rig = rigWithFile();
    await rig.route.whenLoaded();
    await rig.route.openContactImport();
    await rig.route.previewImportFile(fakeFile('contacts.vcf', 'BEGIN:VCARD\nEND:VCARD'));

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('2 new');
    expect(html).toContain('1 change');
    expect(html).toContain('5 already up to date');
    // The conflict renders `from → to` — the user sees exactly what would move.
    expect(html).toContain('Bob Smith');
    expect(html).toContain('Acme Inc.');
    expect(html).toContain('STALE Inc');
    // ⚠ Rows the parser could not read are SHOWN. A row that vanishes is a person
    // missing from the graph and the user would have no way to know.
    expect(html).toContain('1 row could not be read');

    // 🔑 The button offers ONLY the adds. The changes are the risky half — three
    // thousand stale values landing at the top of the ladder — so opting IN is the
    // whole point of the review.
    expect(rig.route.contactImport()?.file?.apply_changes).toBe(false);
    expect(html).toContain('Import 2 new');
    expect(html).not.toContain('and 1 change');
    rig.route.dispose();
  });

  it('applying sends the SAME bytes the plan came from, with the users choice', async () => {
    const applyCaller = vi.fn<DataContactImportFileApplyCaller>(async () => ({
      added: 2,
      changed: 1,
      skipped: 0,
      failures: [],
    }));
    const rig = rigWithFile({ contactImportFileApplyCaller: applyCaller });
    await rig.route.whenLoaded();
    await rig.route.openContactImport();
    await rig.route.previewImportFile(fakeFile('contacts.vcf', 'BEGIN:VCARD\nFN:Bob\nEND:VCARD'));

    rig.route.setImportApplyChanges(true);
    await rig.route.applyImportFile();

    // The client re-sends the FILE, not the plan — the server re-parses and re-derives
    // it, so a client cannot hand back a plan it edited.
    expect(applyCaller).toHaveBeenCalledWith({
      text: 'BEGIN:VCARD\nFN:Bob\nEND:VCARD',
      apply_changes: true,
    });

    // The plan is spent — re-showing it would invite a second apply over contacts that
    // have already moved.
    expect(rig.route.contactImport()?.file?.plan).toBeNull();
    expect(rig.root.children[0]?.innerHTML ?? '').toContain('2 added · 1 changed');
    rig.route.dispose();
  });
});

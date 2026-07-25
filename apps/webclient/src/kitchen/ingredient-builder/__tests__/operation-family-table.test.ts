import { describe, expect, it } from 'vitest';
import {
  ENTITY_FIELD_PRIVACY_KINDS,
  CRM_ALIAS_VALUES,
  ACCT_ALIAS_VALUES,
  type CompositionDecomposeResult,
  type CompositionIngredient,
  type CompositionReviewView,
  type IngredientDraftSummary,
  type IngredientInstallResult,
  type IngredientPreviewResult,
} from '@recued/contracts';

import {
  INGREDIENT_BUILDER_ADD_ROW_ATTR,
  INGREDIENT_BUILDER_AUTH_MODEL_ATTR,
  INGREDIENT_BUILDER_CLI_READINESS_ATTR,
  INGREDIENT_BUILDER_CLI_TOOL_ATTR,
  INGREDIENT_BUILDER_CONNECTION_ATTR,
  INGREDIENT_BUILDER_DEFAULT_GRANTS_ATTR,
  INGREDIENT_BUILDER_HTTP_BASE_ATTR,
  INGREDIENT_BUILDER_HTTP_RESULT_PATH_ATTR,
  INGREDIENT_BUILDER_HTTP_SEARCH_STYLE_ATTR,
  INGREDIENT_BUILDER_HTTP_WRITE_STYLE_ATTR,
  INGREDIENT_BUILDER_DRAFT_PICKER_ATTR,
  INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR,
  INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR,
  INGREDIENT_BUILDER_ENTITY_FIELD_ATTR,
  INGREDIENT_BUILDER_ENTITY_REMOVE_ROW_ATTR,
  INGREDIENT_BUILDER_ENTITY_TABLE_ATTR,
  INGREDIENT_BUILDER_FIELD_PRIVACY_ATTR,
  INGREDIENT_BUILDER_FIELD_ATTR,
  INGREDIENT_BUILDER_INSTALL_ATTR,
  INGREDIENT_BUILDER_INSTALL_STATUS_ATTR,
  INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR,
  INGREDIENT_BUILDER_OPERATION_ARG_ADD_ATTR,
  INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR,
  INGREDIENT_BUILDER_OPERATION_ARG_REMOVE_ATTR,
  INGREDIENT_BUILDER_PACK_DESCRIPTION_ATTR,
  INGREDIENT_BUILDER_PACK_DEPENDENCIES_ATTR,
  INGREDIENT_BUILDER_PACK_KIND_ATTR,
  INGREDIENT_BUILDER_PACK_SLUG_ATTR,
  INGREDIENT_BUILDER_PACK_TAGS_ATTR,
  INGREDIENT_BUILDER_PUBLISHER_ATTR,
  INGREDIENT_BUILDER_REMOVE_ROW_ATTR,
  INGREDIENT_BUILDER_PREVIEW_ARGS_ATTR,
  INGREDIENT_BUILDER_PREVIEW_ATTR,
  INGREDIENT_BUILDER_PREVIEW_STATUS_ATTR,
  INGREDIENT_BUILDER_REVIEW_ISSUE_ATTR,
  INGREDIENT_BUILDER_REVIEW_STATUS_ATTR,
  INGREDIENT_BUILDER_ROUTE_ATTR,
  INGREDIENT_BUILDER_ROW_ATTR,
  INGREDIENT_BUILDER_SAVE_ATTR,
  INGREDIENT_BUILDER_SECTION_VIEW_ATTR,
  INGREDIENT_BUILDER_SERVICE_KIND_ATTR,
  INGREDIENT_BUILDER_SLUG_ATTR,
  INGREDIENT_BUILDER_STATUS_ATTR,
  INGREDIENT_BUILDER_TABLE_ATTR,
  INGREDIENT_BUILDER_TITLE_ATTR,
  bootstrapIngredientBuilderRoute,
  type IngredientBuilderConn,
} from '../operation-family-table.js';
import {
  WEBCLIENT_ROUTE_IDS,
  parseRouteFromHash,
} from '../../../webclient-bootstrap.js';
import {
  INSTALL_GRANT_ACCESS_OPTION_ATTR,
  INSTALL_GRANT_PICKER_ATTR,
  INSTALL_GRANT_SCOPE_OPTION_ATTR,
} from '../../../settings/install-grant-picker.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  value: string;
  type: string;
  checked: boolean;
  disabled: boolean;
  selected: boolean;
  className: string;
  parent: FakeElement | null;
  attrs: Map<string, string>;
  children: FakeElement[];
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeElement | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  remove(): void;
  addEventListener(name: string, fn: () => void): void;
  click(): void;
  dispatch(name: string): void;
}

interface FakeDocument {
  styleElements: FakeElement[];
  head: {
    querySelector(sel: string): FakeElement | null;
    appendChild(el: FakeElement): FakeElement;
  };
  createElement(tag: string): FakeElement;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    value: '',
    type: '',
    checked: false,
    disabled: false,
    selected: false,
    className: '',
    parent: null,
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
      if (k === 'type') el.type = v;
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(child) {
      el.children.push(child);
      child.parent = el;
      return child;
    },
    removeChild(child) {
      const idx = el.children.indexOf(child);
      if (idx < 0) throw new Error('removeChild: child not found');
      el.children.splice(idx, 1);
      child.parent = null;
      return child;
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener(name, fn) {
      const list = el.listeners.get(name) ?? [];
      list.push(fn);
      el.listeners.set(name, list);
    },
    click() {
      if (el.disabled) return;
      for (const fn of el.listeners.get('click') ?? []) fn();
    },
    dispatch(name) {
      for (const fn of el.listeners.get(name) ?? []) fn();
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDocument => {
  const styleElements: FakeElement[] = [];
  const attrFromSelector = (sel: string): string | null => {
    const m = sel.match(/^style\[([\w-]+)\]$/);
    return m === null ? null : m[1]!;
  };
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const attr = attrFromSelector(sel);
        if (attr === null) return null;
        return styleElements.find((el) => el.hasAttribute(attr)) ?? null;
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeElement(tag),
  };
};

const findAllByAttr = (
  root: FakeElement,
  attr: string,
  out: FakeElement[] = [],
): FakeElement[] => {
  if (root.hasAttribute(attr)) out.push(root);
  for (const child of root.children) findAllByAttr(child, attr, out);
  return out;
};

const findByAttr = (root: FakeElement, attr: string): FakeElement | undefined =>
  findAllByAttr(root, attr)[0];

const findAllByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement[] =>
  findAllByAttr(root, attr).filter((el) => el.getAttribute(attr) === value);

const findByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement | undefined =>
  findAllByAttrValue(root, attr, value)[0];

const textOf = (root: FakeElement): string =>
  [root.textContent, ...root.children.map((child) => textOf(child))]
    .filter((part) => part.length > 0)
    .join(' ');

const setValue = (el: FakeElement | undefined, value: string): void => {
  if (el === undefined) throw new Error(`missing element for value ${value}`);
  el.value = value;
  el.dispatch('input');
  el.dispatch('change');
};

const setChecked = (el: FakeElement | undefined, checked: boolean): void => {
  if (el === undefined) throw new Error('missing checkbox');
  el.checked = checked;
  el.dispatch('change');
};

const tick = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const validReview = (overrides: Partial<CompositionReviewView> = {}): CompositionReviewView => ({
  valid: true,
  summary: {
    catalog_slug: 'hubspot-local',
    catalog_slugs: ['hubspot-local'],
    artifact_shape: 'multi',
    counts: {
      compositions: 1,
      operation_families: 1,
      entity_fields: 0,
      pii_fields: 0,
      pack_contents: 0,
      compiled_outputs: 1,
    },
  },
  operation_families: [
    {
      key: 'contact.read',
      surface: 'api',
      risk_tier: 'read',
      approval_mapping: 'never',
    },
  ],
  field_privacy: [],
  issues: [],
  ...overrides,
});

const makeConn = (options: {
  decompose?: CompositionDecomposeResult;
  draftListError?: Error;
  drafts?: IngredientDraftSummary[];
  draftBodies?: Record<string, { title?: string; body: unknown }>;
  preview?: IngredientPreviewResult;
  install?: IngredientInstallResult;
} = {}) => {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const savedDrafts = new Map<string, { title?: string; body: unknown }>();
  for (const [draftId, draft] of Object.entries(options.draftBodies ?? {})) {
    savedDrafts.set(draftId, draft);
  }
  const conn = (async (method: string, payload: unknown) => {
    calls.push({ method, payload });
    if (method === 'ingredient.draft.list') {
      if (options.draftListError !== undefined) throw options.draftListError;
      return { ok: true, drafts: options.drafts ?? [] };
    }
    if (method === 'ingredient.draft.get') {
      const draftId = (payload as { draft_id?: string }).draft_id ?? '';
      const stored = savedDrafts.get(draftId);
      if (stored === undefined) {
        return { ok: false, code: 'not_found', message: `no draft '${draftId}'` };
      }
      return {
        ok: true,
        draft: {
          draft_id: draftId,
          title: stored.title,
          body: stored.body,
          created_at: 1,
          updated_at: 2,
        },
      };
    }
    if (method === 'ingredient.compose.decompose') {
      return options.decompose ?? {
        ok: true,
        draft_id: 'draft-1',
        artifacts: {
          entity_schemas: [],
          operation_groups: [],
          default_grants: [],
        },
        review: validReview(),
      };
    }
    if (method === 'ingredient.preview') {
      return options.preview ?? {
        ok: true,
        operation_key: 'contact.read',
        risk_tier: 'read',
        approval: 'never',
        target: {
          surface: 'api',
          verb: 'GET',
          request: 'GET /crm/v3/objects/contacts/C1',
          auth: {
            model: 'recued_injected',
            connection: 'hubspot-main',
            connection_enrolled: true,
          },
        },
        execution: {
          executed: true,
          outcome: 'ok',
          status: 200,
          output_preview: { id: 'C1', properties: { email: 'a@example.invalid' } },
          truncated: false,
          mapping_preview: [
            {
              entity_field: 'properties.email',
              source_path: 'properties.email',
              type: 'string',
              sample: 'a@example.invalid',
            },
          ],
        },
      };
    }
    if (method === 'ingredient.install') {
      return options.install ?? {
        ok: true,
        installed: {
          kind: 'pack',
          pack_slug: 'hubspot-local-pack',
          pack_version: 1,
          catalog_id: 'hubspot-local',
          entity_schema_count: 1,
        },
        ingredient_ids: ['hubspot-local'],
        warnings: [],
      };
    }
    const draftId = (payload as { draft_id?: string }).draft_id ?? 'draft-1';
    const title = (payload as { title?: string }).title ?? 'HubSpot local';
    const body = (payload as { body: unknown }).body;
    savedDrafts.set(draftId, { title, body });
    return {
      ok: true,
      draft: {
        draft_id: draftId,
        title,
        body,
        created_at: 1,
        updated_at: 2,
      },
    };
  }) as IngredientBuilderConn;
  return { conn, calls };
};

describe('D-170 N.7.1/N.7.2 webclient ingredient builder tables', () => {
  it('mounts operation and entity-field tables with a pending server review banner', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    expect(findByAttr(root, INGREDIENT_BUILDER_ROUTE_ATTR)).toBeDefined();
    expect(findByAttr(root, INGREDIENT_BUILDER_TABLE_ATTR)).toBeDefined();
    expect(findByAttr(root, INGREDIENT_BUILDER_ENTITY_TABLE_ATTR)).toBeDefined();
    expect(findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)).toBeUndefined();
    expect(findAllByAttr(root, INGREDIENT_BUILDER_REMOVE_ROW_ATTR)).toHaveLength(1);
    expect(findAllByAttr(root, INGREDIENT_BUILDER_REMOVE_ROW_ATTR)[0]!.disabled).toBe(true);
    expect(findByAttr(root, INGREDIENT_BUILDER_REVIEW_STATUS_ATTR)?.textContent)
      .toBe('Review pending');
    expect(route.buildDraftBody().operations).toHaveLength(1);
    expect(route.buildDraftBody().ingredients[0]!.entities).toBeUndefined();

    route.dispose();
    expect(findByAttr(root, INGREDIENT_BUILDER_ROUTE_ATTR)).toBeUndefined();
  });

  it('renders the workbench overview, empty entity state, and draft-list errors', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn({
      draftListError: new Error('draft list failed'),
    });

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    expect(textOf(root)).toContain('Operations 0/1 reviewed');
    expect(textOf(root)).toContain('Fields 0/0 reviewed');
    expect(textOf(root)).toContain('No entity fields');

    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'reviewed'), true);
    expect(textOf(root)).toContain('Operations 1/1 reviewed');

    await tick();
    expect(textOf(root)).toContain('draft list failed');
  });

  it('edits an API operation row and saves the composition draft over pair RPC', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn, calls } = makeConn();

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    setValue(findByAttr(root, INGREDIENT_BUILDER_TITLE_ATTR), 'HubSpot local');
    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'hubspot-local');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'family'), 'contact');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'verb'), 'get');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'restPathTemplate'), '/crm/v3/objects/contacts/{contact_id}');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'risk'), 'read');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'approval'), 'never');
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'reviewed'), true);

    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();

    const authoringCalls = calls.filter((call) => call.method !== 'ingredient.draft.list');
    expect(authoringCalls).toHaveLength(2);
    expect(authoringCalls[0]!.method).toBe('ingredient.draft.save');
    expect(authoringCalls[1]).toEqual({
      method: 'ingredient.compose.decompose',
      payload: { draft_id: 'draft-1' },
    });
    const payload = authoringCalls[0]!.payload as {
      title: string;
      body: CompositionIngredient;
    };
    expect(payload.title).toBe('HubSpot local');
    expect(payload.body).toMatchObject({
      schema_version: 1,
      slug: 'hubspot-local',
      catalog_kind: 'private_byo',
    });
    expect(payload.body.ingredients).toEqual([
      {
        slug: 'hubspot-local',
        kind: 'http',
        http: { base: 'https://api.example.com' },
      },
    ]);
    expect(payload.body.operations).toEqual([
      {
        op: 'contact.read',
        ingredient: 'hubspot-local',
        risk: 'read',
        approval: 'never',
        bind: {
          kind: 'rest',
          method: 'GET',
          path_template: '/crm/v3/objects/contacts/{contact_id}',
        },
      },
    ]);
    expect(findByAttr(root, INGREDIENT_BUILDER_REVIEW_STATUS_ATTR)?.textContent)
      .toBe('Valid | 1 operation | 0 fields | 0 PII tags | 1 output');
  });

  it('adds and removes operation rows without dropping the first row', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    findByAttr(root, INGREDIENT_BUILDER_ADD_ROW_ATTR)?.click();
    expect(findAllByAttr(root, INGREDIENT_BUILDER_REMOVE_ROW_ATTR)).toHaveLength(2);

    findAllByAttr(root, INGREDIENT_BUILDER_REMOVE_ROW_ATTR)[1]!.click();
    expect(findAllByAttr(root, INGREDIENT_BUILDER_REMOVE_ROW_ATTR)).toHaveLength(1);
    expect(findAllByAttr(root, INGREDIENT_BUILDER_REMOVE_ROW_ATTR)[0]!.disabled).toBe(true);
  });

  it('edits entity-field rows and serializes explicit per-field privacy tags', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    findByAttr(root, INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR)?.click();
    expect(findAllByAttr(root, INGREDIENT_BUILDER_ENTITY_REMOVE_ROW_ATTR)).toHaveLength(1);

    const piiSelect = findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'pii');
    expect(piiSelect?.children.map((child) => child.value)).toEqual([
      '',
      ...ENTITY_FIELD_PRIVACY_KINDS,
    ]);
    expect(piiSelect?.children.map((child) => child.value)).not.toContain('*');
    expect(piiSelect?.children.map((child) => child.value)).not.toContain('wildcard');

    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'entity'), 'Contact');
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'field_path'),
      'properties.email',
    );
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'type'), 'string');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'maps_to'), 'email');
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'optional'), true);
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'applies'), 'resp');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'pii'), 'email');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'source'), 'schema');
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'reviewed'), true);

    expect(route.buildDraftBody().ingredients[0]!.entities).toEqual({
      Contact: {
        fields: [
          {
            field_path: 'properties.email',
            type: 'string',
            maps_to: 'email',
            optional: true,
            applies: 'resp',
            pii: 'email',
            source: 'schema',
          },
        ],
      },
    });

    findByAttr(root, INGREDIENT_BUILDER_ENTITY_REMOVE_ROW_ATTR)?.click();
    expect(route.buildDraftBody().ingredients[0]!.entities).toBeUndefined();
  });

  it('round-trips entity-field extras: description, source_operation, date_granularity, derivation (Tier-2)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();
    const initialBody = {
      schema_version: 1,
      slug: 'entity-extras-roundtrip',
      catalog_kind: 'official',
      ingredients: [
        {
          slug: 'entity-extras-roundtrip',
          kind: 'http',
          http: { base: 'https://api.hubapi.com', connection: 'hubspot' },
          entities: {
            Deal: {
              fields: [
                {
                  field_path: 'properties.closedate',
                  type: 'datetime',
                  maps_to: 'close_date',
                  optional: true,
                  applies: 'both',
                  source: 'schema',
                  description: 'Deal close date',
                  source_operation: 'deal.read',
                  date_granularity: 'datetime',
                  derivation: {
                    kind: 'closed_state',
                    closed_path: 'properties.hs_is_closed',
                    won_path: 'properties.hs_is_closed_won',
                  },
                },
              ],
            },
          },
        },
      ],
      operations: [],
    };

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialBody,
    });

    // The extras surfaced in the per-field Advanced controls.
    expect(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'description')?.value)
      .toBe('Deal close date');
    expect(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'source_operation')?.value)
      .toBe('deal.read');
    expect(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'date_granularity')?.value)
      .toBe('datetime');
    expect(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'derivation_kind')?.value)
      .toBe('closed_state');

    // …and they survive the save (were dropped before this slice).
    expect(route.buildDraftBody().ingredients[0]!.entities).toEqual({
      Deal: {
        fields: [
          {
            field_path: 'properties.closedate',
            type: 'datetime',
            maps_to: 'close_date',
            optional: true,
            applies: 'both',
            source: 'schema',
            source_operation: 'deal.read',
            description: 'Deal close date',
            date_granularity: 'datetime',
            derivation: {
              kind: 'closed_state',
              closed_path: 'properties.hs_is_closed',
              won_path: 'properties.hs_is_closed_won',
            },
          },
        ],
      },
    });
  });

  it('authors entity-field extras from the per-field Advanced controls (Tier-2)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    findByAttr(root, INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR)?.click();
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'entity'), 'Deal');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'field_path'), 'properties.amount');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'maps_to'), 'amount');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'description'), 'Deal amount');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'source_operation'), 'deal.read');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'date_granularity'), 'date');

    const field = route.buildDraftBody().ingredients[0]!.entities!.Deal!.fields[0]!;
    expect(field.description).toBe('Deal amount');
    expect(field.source_operation).toBe('deal.read');
    expect(field.date_granularity).toBe('date');
  });

  it('emits a closed_state derivation only once kind + both vendor paths are set', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    findByAttr(root, INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR)?.click();
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'entity'), 'Deal');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'maps_to'), 'close_state');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'derivation_kind'), 'closed_state');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'derivation_closed_path'), 'properties.hs_is_closed');

    // Kind + one path is incomplete → derivation dropped.
    const fieldA = route.buildDraftBody().ingredients[0]!.entities!.Deal!.fields[0]!;
    expect('derivation' in fieldA).toBe(false);

    // Complete the won path → derivation now emitted.
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'derivation_won_path'), 'properties.hs_is_closed_won');
    const fieldB = route.buildDraftBody().ingredients[0]!.entities!.Deal!.fields[0]!;
    expect(fieldB.derivation).toEqual({
      kind: 'closed_state',
      closed_path: 'properties.hs_is_closed',
      won_path: 'properties.hs_is_closed_won',
    });
  });

  // D-185 Tier-1 data-loss fixes — load a CRM/API composition carrying the fields
  // the old build/parse glue silently dropped, then re-serialize via buildDraftBody
  // and assert each survives the round-trip: entity crm_alias (was destructured off
  // a row that never carried it), http.base (was hardcoded to a placeholder on
  // save), catalog_kind (was hardcoded to private_byo), and the op-level
  // idempotency/accepts_media/produces_media/request_schema/response_schema (were
  // dropped by the PackOperationRow projection).
  it('round-trips crm_alias, http.base, catalog_kind, and op idempotency/media/schemas (Tier-1)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();
    const initialBody = {
      schema_version: 1,
      slug: 'crm-roundtrip',
      catalog_kind: 'official',
      ingredients: [
        {
          slug: 'crm-roundtrip',
          kind: 'http',
          http: { base: 'https://api.hubapi.com', connection: 'hubspot' },
          entities: {
            Deal: {
              crm_alias: 'deal',
              fields: [
                { field_path: 'properties.amount', type: 'number', maps_to: 'amount' },
              ],
            },
          },
        },
      ],
      operations: [
        {
          op: 'deal.read',
          ingredient: 'crm-roundtrip',
          risk: 'read',
          approval: 'never',
          bind: { kind: 'rest', method: 'GET', path_template: '/crm/v3/objects/deals/{id}' },
          idempotency: 'safe',
          accepts_media: ['text'],
          produces_media: ['text'],
          request_schema: { type: 'object' },
          response_schema: { type: 'object' },
        },
      ],
    };

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialBody,
    });

    const body = route.buildDraftBody();
    expect(body.catalog_kind).toBe('official');
    expect(body.ingredients[0]!.http?.base).toBe('https://api.hubapi.com');
    expect(body.ingredients[0]!.entities?.Deal?.crm_alias).toBe('deal');
    const op = body.operations[0]!;
    expect(op.idempotency).toBe('safe');
    expect(op.accepts_media).toEqual(['text']);
    expect(op.produces_media).toEqual(['text']);
    expect(op.request_schema).toEqual({ type: 'object' });
    expect(op.response_schema).toEqual({ type: 'object' });
  });

  // D-182 Tier-2 — the entity-level cross-vendor alias is authored once per
  // entity, in the entity-group header (not per field row). A single combined
  // picker covers both the CRM and accounting axes and routes the pick to
  // crm_alias / acct_alias on save (the value sets are disjoint).
  it('authors crm_alias from the entity-group alias picker (Tier-2)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    findByAttr(root, INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR)?.click();
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'entity'), 'Deal');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'maps_to'), 'amount');
    // The entity name only regroups on the next rerender (matches the op-family
    // Family field) — toggle Reviewed to surface the named "Deal" group + picker.
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'reviewed'), true);

    const aliasSelect = findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR, 'Deal');
    expect(aliasSelect).toBeDefined();
    // One combined picker, no duplicate option across the two axes.
    expect(aliasSelect?.children.map((child) => child.value)).toEqual([
      '',
      ...CRM_ALIAS_VALUES,
      ...ACCT_ALIAS_VALUES,
    ]);

    setValue(aliasSelect, 'deal');
    const entity = route.buildDraftBody().ingredients[0]!.entities!.Deal!;
    expect(entity.crm_alias).toBe('deal');
    expect(entity.acct_alias).toBeUndefined();
  });

  it('round-trips an entity acct_alias load → save (Tier-2)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();
    const initialBody = {
      schema_version: 1,
      slug: 'acct-roundtrip',
      catalog_kind: 'private_byo',
      ingredients: [
        {
          slug: 'acct-roundtrip',
          kind: 'http',
          http: { base: 'https://api.accounting.example', connection: 'books' },
          entities: {
            Invoice: {
              acct_alias: 'invoice',
              fields: [{ field_path: 'total_amount', type: 'number', maps_to: 'total' }],
            },
          },
        },
      ],
      operations: [],
    };

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialBody,
    });

    // The picker surfaces the loaded acct_alias (no crm_alias control collision).
    expect(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR, 'Invoice')?.value)
      .toBe('invoice');

    const body = route.buildDraftBody();
    expect(body.ingredients[0]!.entities?.Invoice?.acct_alias).toBe('invoice');
    expect(body.ingredients[0]!.entities?.Invoice?.crm_alias).toBeUndefined();
  });

  it('one picker enforces crm/acct exclusion and clears the alias (Tier-2)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    findByAttr(root, INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR)?.click();
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'entity'), 'Invoice');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'maps_to'), 'total');
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'reviewed'), true);

    // Accounting alias.
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR, 'Invoice'), 'invoice');
    let entity = route.buildDraftBody().ingredients[0]!.entities!.Invoice!;
    expect(entity.acct_alias).toBe('invoice');
    expect(entity.crm_alias).toBeUndefined();

    // Switching to a CRM value flips the axis — one value, so the two are
    // mutually exclusive by construction.
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR, 'Invoice'), 'contact');
    entity = route.buildDraftBody().ingredients[0]!.entities!.Invoice!;
    expect(entity.crm_alias).toBe('contact');
    expect(entity.acct_alias).toBeUndefined();

    // Back to "none" drops both.
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR, 'Invoice'), '');
    entity = route.buildDraftBody().ingredients[0]!.entities!.Invoice!;
    expect(entity.crm_alias).toBeUndefined();
    expect(entity.acct_alias).toBeUndefined();
  });

  it('groups field rows by entity, one alias picker per named entity (Tier-2)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();
    const initialBody = {
      schema_version: 1,
      slug: 'multi-entity',
      catalog_kind: 'private_byo',
      ingredients: [
        {
          slug: 'multi-entity',
          kind: 'http',
          http: { base: 'https://api.example.com' },
          entities: {
            Deal: {
              crm_alias: 'deal',
              fields: [{ field_path: 'properties.amount', type: 'number', maps_to: 'amount' }],
            },
            // A blank-entity row folds into an "Ungrouped" bucket with no
            // picker — and any alias on it must NOT round-trip (there'd be no UI
            // to see or clear it).
            '': {
              crm_alias: 'contact',
              fields: [{ field_path: 'raw', type: 'string', maps_to: 'raw' }],
            },
          },
        },
      ],
      operations: [],
    };

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialBody,
    });

    // One alias picker for the named "Deal" entity; none for the blank bucket.
    expect(findAllByAttr(root, INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR)).toHaveLength(1);
    expect(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR, 'Deal')?.value).toBe('deal');
    // Both field rows still render (two remove buttons across the two groups).
    expect(findAllByAttr(root, INGREDIENT_BUILDER_ENTITY_REMOVE_ROW_ATTR)).toHaveLength(2);

    const body = route.buildDraftBody();
    expect(body.ingredients[0]!.entities?.Deal?.crm_alias).toBe('deal');
    // The blank-entity alias is dropped (no picker rendered for it → no save).
    expect(body.ingredients[0]!.entities?.['']?.crm_alias).toBeUndefined();
  });

  // The new entityAliases map is a fresh state field, so it must be copied in
  // applyDraftState (a recurring trap in this editor). Bootstrap empty, then
  // load a saved draft carrying a crm_alias via the picker — if the copy is
  // missing the alias is lost on load.
  it('copies entityAliases through applyDraftState on draft load (Tier-2)', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const savedBody = {
      schema_version: 1,
      slug: 'crm-saved',
      catalog_kind: 'private_byo',
      ingredients: [
        {
          slug: 'crm-saved',
          kind: 'http',
          http: { base: 'https://api.hubapi.com', connection: 'hubspot' },
          entities: {
            Deal: {
              crm_alias: 'deal',
              fields: [{ field_path: 'properties.amount', type: 'number', maps_to: 'amount' }],
            },
          },
        },
      ],
      operations: [],
    };
    const { conn } = makeConn({
      drafts: [
        {
          draft_id: 'draft-crm',
          title: 'CRM saved',
          slug: 'crm-saved',
          surface: 'api',
          operation_count: 0,
          created_at: 1,
          updated_at: 2,
        },
      ],
      draftBodies: { 'draft-crm': { title: 'CRM saved', body: savedBody } },
    });

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    await tick();

    // Pick the saved draft → ingredient.draft.get → applyDraftState.
    setValue(findByAttr(root, INGREDIENT_BUILDER_DRAFT_PICKER_ATTR), 'draft-crm');
    await tick();

    expect(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR, 'Deal')?.value).toBe('deal');
    expect(route.buildDraftBody().ingredients[0]!.entities?.Deal?.crm_alias).toBe('deal');
  });

  it('round-trips operation args across bare-string, typed, and affects_target forms (Tier-2)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();
    const initialBody = {
      schema_version: 1,
      slug: 'args-roundtrip',
      catalog_kind: 'private_byo',
      ingredients: [{ slug: 'args-roundtrip', kind: 'http', http: { base: 'https://api.example.com' } }],
      operations: [
        {
          op: 'contact.read',
          ingredient: 'args-roundtrip',
          risk: 'read',
          approval: 'never',
          bind: { kind: 'rest', method: 'GET', path_template: '/c/{contact_id}' },
          // bare string · typed object · authority object · explicit-string object
          args: [
            'contact_id',
            { key: 'limit', type: 'number' },
            { key: 'to', affects_target: true },
            { key: 'mode', type: 'string' },
          ],
        },
      ],
    };

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialBody,
    });

    // The structured arg rows surfaced in the DOM (one key input per arg).
    expect(findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR, 'row-0:0:key')?.value)
      .toBe('contact_id');
    expect(findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR, 'row-0:1:type')?.value)
      .toBe('number');
    expect(findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR, 'row-0:2:affects_target')?.checked)
      .toBe(true);

    // Save re-compacts: a plain required-string arg (incl. the explicit
    // `{ key, type: 'string' }`) collapses back to a bare string; the typed and
    // authority args stay objects (the `affects_target` one drops its default
    // 'string' type).
    const op = route.buildDraftBody().operations[0]!;
    expect(op.args).toEqual([
      'contact_id',
      { key: 'limit', type: 'number' },
      { key: 'to', affects_target: true },
      'mode',
    ]);
  });

  it('authors operation args from the repeater and drops empty-key rows (Tier-2)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'args-author');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'restPathTemplate'), '/c/{contact_id}');

    // Start with no args; add four rows (each add re-renders).
    expect(findAllByAttr(root, INGREDIENT_BUILDER_OPERATION_ARG_REMOVE_ATTR)).toHaveLength(0);
    for (let i = 0; i < 4; i += 1) {
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ARG_ADD_ATTR, 'row-0')?.click();
    }
    expect(findAllByAttr(root, INGREDIENT_BUILDER_OPERATION_ARG_REMOVE_ATTR)).toHaveLength(4);

    // row 0 — bare-string default; row 1 — typed; row 2 — authority; row 3 — blank key (dropped).
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR, 'row-0:0:key'), 'contact_id');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR, 'row-0:1:key'), 'limit');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR, 'row-0:1:type'), 'number');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR, 'row-0:2:key'), 'to');
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR, 'row-0:2:affects_target'), true);

    const op = route.buildDraftBody().operations[0]!;
    expect(op.args).toEqual([
      'contact_id',
      { key: 'limit', type: 'number' },
      { key: 'to', affects_target: true },
    ]);
  });

  it('removes an authored argument row', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();
    const initialBody = {
      schema_version: 1,
      slug: 'args-remove',
      catalog_kind: 'private_byo',
      ingredients: [{ slug: 'args-remove', kind: 'http', http: { base: 'https://api.example.com' } }],
      operations: [
        {
          op: 'contact.read',
          ingredient: 'args-remove',
          risk: 'read',
          approval: 'never',
          bind: { kind: 'rest', method: 'GET', path_template: '/c/{contact_id}' },
          args: ['contact_id', { key: 'limit', type: 'number' }],
        },
      ],
    };

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialBody,
    });

    expect(findAllByAttr(root, INGREDIENT_BUILDER_OPERATION_ARG_REMOVE_ATTR)).toHaveLength(2);
    // Remove the first arg (`contact_id`).
    findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ARG_REMOVE_ATTR, 'row-0:0')?.click();
    expect(findAllByAttr(root, INGREDIENT_BUILDER_OPERATION_ARG_REMOVE_ATTR)).toHaveLength(1);

    const op = route.buildDraftBody().operations[0]!;
    expect(op.args).toEqual([{ key: 'limit', type: 'number' }]);
  });

  // The structured repeater is the SOLE source of `args` — `args` typed into the
  // Extra JSON escape hatch is dropped (it would otherwise bypass the
  // parser/compactor and let an empty repeater save hidden args). A legit
  // extra-JSON-only column on the same blob still passes through.
  it('ignores args smuggled through the Extra JSON field (repeater is the sole source)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'args-smuggle');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'thing.read');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'restPathTemplate'), '/things/{id}');
    // Repeater stays empty; the Extra JSON box carries an `args` value plus a
    // legit extra-JSON-only column (idempotency).
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:extra_json'),
      '{"args":["smuggled"],"idempotency":"safe"}',
    );

    const op = route.buildDraftBody().operations[0]!;
    expect('args' in op).toBe(false);
    expect(op.idempotency).toBe('safe');
  });

  it('round-trips the http base URL, connection, and catalog dialects (Tier-2 API Setup)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();
    const initialBody = {
      schema_version: 1,
      slug: 'api-setup-roundtrip',
      catalog_kind: 'official',
      ingredients: [
        {
          slug: 'api-setup-roundtrip',
          kind: 'http',
          http: {
            base: 'https://api.hubapi.com',
            connection: 'hubspot',
            result_path: 'results',
            search_style: 'hubspot_search',
            write_style: 'hubspot_properties',
          },
        },
      ],
      operations: [
        {
          op: 'deal.read',
          ingredient: 'api-setup-roundtrip',
          risk: 'read',
          approval: 'never',
          bind: { kind: 'rest', method: 'GET', path_template: '/crm/v3/objects/deals/{id}' },
        },
      ],
    };

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialBody,
    });

    // The Setup controls surfaced the loaded values.
    expect(findByAttr(root, INGREDIENT_BUILDER_HTTP_BASE_ATTR)?.value).toBe('https://api.hubapi.com');
    expect(findByAttr(root, INGREDIENT_BUILDER_HTTP_RESULT_PATH_ATTR)?.value).toBe('results');
    expect(findByAttr(root, INGREDIENT_BUILDER_HTTP_SEARCH_STYLE_ATTR)?.value).toBe('hubspot_search');
    expect(findByAttr(root, INGREDIENT_BUILDER_HTTP_WRITE_STYLE_ATTR)?.value).toBe('hubspot_properties');

    // …and save preserves them (the old build dropped result_path/search_style/
    // write_style and hardcoded the base).
    const http = route.buildDraftBody().ingredients[0]!.http;
    expect(http).toEqual({
      base: 'https://api.hubapi.com',
      connection: 'hubspot',
      result_path: 'results',
      search_style: 'hubspot_search',
      write_style: 'hubspot_properties',
    });
  });

  it('authors the http base URL, connection, and dialects from the Setup controls (Tier-2 API Setup)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    // Fresh editor defaults to the api (`recued_injected`) auth model, so the API
    // connector controls render.
    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'stripe-local');
    setValue(findByAttr(root, INGREDIENT_BUILDER_HTTP_BASE_ATTR), 'https://api.stripe.com');
    setValue(findByAttr(root, INGREDIENT_BUILDER_CONNECTION_ATTR), 'stripe-main');
    setValue(findByAttr(root, INGREDIENT_BUILDER_HTTP_RESULT_PATH_ATTR), 'data');
    setValue(findByAttr(root, INGREDIENT_BUILDER_HTTP_SEARCH_STYLE_ATTR), 'soql');
    setValue(findByAttr(root, INGREDIENT_BUILDER_HTTP_WRITE_STYLE_ATTR), 'salesforce_sobject');

    const http = route.buildDraftBody().ingredients[0]!.http;
    expect(http).toEqual({
      base: 'https://api.stripe.com',
      connection: 'stripe-main',
      result_path: 'data',
      search_style: 'soql',
      write_style: 'salesforce_sobject',
    });
  });

  it('preserves the http dialects when loading a saved draft from the picker (applyDraftState)', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const savedBody: CompositionIngredient = {
      schema_version: 1,
      slug: 'sf-saved',
      catalog_kind: 'official',
      ingredients: [
        {
          slug: 'sf-saved',
          kind: 'http',
          http: {
            base: 'https://example.my.salesforce.com',
            connection: 'salesforce',
            result_path: 'records',
            search_style: 'soql',
            write_style: 'salesforce_sobject',
          },
        },
      ],
      operations: [
        {
          op: 'opportunity.read',
          ingredient: 'sf-saved',
          risk: 'read',
          approval: 'never',
          bind: { kind: 'rest', method: 'GET', path_template: '/services/data/v59.0/sobjects/Opportunity/{id}' },
        },
      ],
    };
    const { conn } = makeConn({
      drafts: [
        {
          draft_id: 'draft-sf',
          title: 'Salesforce saved',
          slug: 'sf-saved',
          surface: 'api',
          operation_count: 1,
          created_at: 1,
          updated_at: 2,
        },
      ],
      draftBodies: { 'draft-sf': { title: 'Salesforce saved', body: savedBody } },
    });

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    await tick();

    // Pick the saved draft → ingredient.draft.get → applyDraftState.
    setValue(findByAttr(root, INGREDIENT_BUILDER_DRAFT_PICKER_ATTR), 'draft-sf');
    await tick();

    // applyDraftState must copy the dialects (not just base/connection), else the
    // Setup controls + the next save silently drop them.
    expect(findByAttr(root, INGREDIENT_BUILDER_HTTP_RESULT_PATH_ATTR)?.value).toBe('records');
    expect(findByAttr(root, INGREDIENT_BUILDER_HTTP_SEARCH_STYLE_ATTR)?.value).toBe('soql');
    expect(findByAttr(root, INGREDIENT_BUILDER_HTTP_WRITE_STYLE_ATTR)?.value).toBe('salesforce_sobject');
    expect(route.buildDraftBody().ingredients[0]!.http).toEqual({
      base: 'https://example.my.salesforce.com',
      connection: 'salesforce',
      result_path: 'records',
      search_style: 'soql',
      write_style: 'salesforce_sobject',
    });
  });

  // D-182 op-model direct-binding refactor — behavior-preservation guards for the
  // two escape-hatch edges the one-hop save must keep matching the old two-hop
  // projection: the extra-JSON object is a fallback for the modeled meta columns
  // when their dedicated input is empty, and any non-column key is dropped.
  it('keeps the extra-JSON fallback for modeled columns and drops unmodeled keys (refactor guard)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'extra-fallback');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'thing.read');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'restPathTemplate'), '/things/{id}');
    // The extra-JSON escape hatch carries a modeled column (timeout_ms) plus an
    // extra-JSON-only column (idempotency) plus an unmodeled key; the dedicated
    // Timeout input stays empty so the fallback is what supplies timeout_ms.
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:extra_json'),
      '{"timeout_ms":5000,"idempotency":"safe","not_a_column":true}',
    );

    const op = route.buildDraftBody().operations[0]!;
    expect(op.timeout_ms).toBe(5000);
    expect(op.idempotency).toBe('safe');
    expect('not_a_column' in op).toBe(false);
  });

  it('loads an existing saved draft from the draft picker', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const savedBody: CompositionIngredient = {
      schema_version: 1,
      slug: 'hubspot-saved',
      catalog_kind: 'official',
      ingredients: [
        {
          slug: 'hubspot-saved',
          kind: 'http',
          http: { base: 'https://api.hubapi.com', connection: 'hubspot-main' },
          entities: {
            Contact: {
              fields: [
                {
                  field_path: 'properties.email',
                  type: 'string',
                  maps_to: 'properties.email',
                  applies: 'resp',
                  pii: 'email',
                },
              ],
            },
          },
        },
      ],
      operations: [
        {
          op: 'contact.read',
          ingredient: 'hubspot-saved',
          risk: 'read',
          approval: 'never',
          bind: {
            kind: 'rest',
            method: 'GET',
            path_template: '/crm/v3/objects/contacts/{contact_id}',
          },
        },
      ],
    };
    const { conn, calls } = makeConn({
      drafts: [
        {
          draft_id: 'draft-existing',
          title: 'HubSpot saved',
          slug: 'hubspot-saved',
          surface: 'api',
          operation_count: 1,
          created_at: 1,
          updated_at: 2,
        },
      ],
      draftBodies: {
        'draft-existing': { title: 'HubSpot saved', body: savedBody },
      },
    });

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    await tick();

    const picker = findByAttr(root, INGREDIENT_BUILDER_DRAFT_PICKER_ATTR);
    expect(picker?.children.map((child) => child.value)).toEqual(['', 'draft-existing']);
    setValue(picker, 'draft-existing');
    await tick();

    expect(calls.map((call) => call.method)).toContain('ingredient.draft.get');
    expect(calls.map((call) => call.method)).toContain('ingredient.compose.decompose');
    expect(findByAttr(root, INGREDIENT_BUILDER_TITLE_ATTR)?.value).toBe('HubSpot saved');
    expect(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR)?.value).toBe('hubspot-saved');
    expect(findByAttr(root, INGREDIENT_BUILDER_CONNECTION_ATTR)?.value).toBe('hubspot-main');
    expect(findByAttr(root, INGREDIENT_BUILDER_STATUS_ATTR)?.textContent)
      .toBe('Draft loaded and validated');
    expect(findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)?.disabled).toBe(false);
    expect(route.buildDraftBody().ingredients[0]!.entities!.Contact!.fields[0]).toMatchObject({
      field_path: 'properties.email',
      pii: 'email',
    });
    // D-185 Tier-1 — http.base and catalog_kind survive the draft-picker
    // (applyDraftState) path, not just the initial bootstrap. These are the two
    // top-level state fields applyDraftState reconstructs; before the fix it
    // re-emitted the hardcoded placeholder base / private_byo here.
    const pickerBody = route.buildDraftBody();
    expect(pickerBody.ingredients[0]!.http?.base).toBe('https://api.hubapi.com');
    expect(pickerBody.catalog_kind).toBe('official');
  });

  it('loads composition and metadata from a saved v3 pack body', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const composition: CompositionIngredient = {
      schema_version: 1,
      slug: 'codex-local',
      catalog_kind: 'private_byo',
      ingredients: [
        {
          slug: 'codex-local',
          kind: 'cli',
          cli: { tool: 'codex', probe: ['codex', '--version'] },
        },
      ],
      operations: [
        {
          op: 'codex.issue.run',
          ingredient: 'codex-local',
          risk: 'write',
          approval: 'ask',
          bind: {
            kind: 'cli_invocation',
            argv_template: ['codex', 'exec'],
            shape: 'text',
            exit_code_handling: 'zero_is_success',
          },
        },
      ],
    };
    const packBody = {
      manifest_version: 2,
      artifact_type: 'pack',
      pack_kind: 'app_pack',
      service_kind: 'cli',
      slug: 'codex-pack',
      publisher: 'local-authoring',
      name: 'Codex pack',
      description: 'Local Codex CLI pack',
      version: 1,
      recipes: [],
      requires: ['bulk_pack.install'],
      tags: ['local', 'codex'],
      dependencies: [{ type: 'pack', slug: 'github-pack', min_version: 1 }],
      contents: [{ type: 'composition', composition }],
    };
    const { conn } = makeConn({
      drafts: [
        {
          draft_id: 'draft-pack',
          title: 'Codex saved pack',
          slug: 'codex-pack',
          surface: 'connector',
          operation_count: 1,
          created_at: 1,
          updated_at: 2,
        },
      ],
      draftBodies: {
        'draft-pack': { title: 'Codex saved pack', body: packBody },
      },
    });

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    await tick();

    setValue(findByAttr(root, INGREDIENT_BUILDER_DRAFT_PICKER_ATTR), 'draft-pack');
    await tick();

    expect(findByAttr(root, INGREDIENT_BUILDER_PACK_SLUG_ATTR)?.value).toBe('codex-pack');
    expect(findByAttr(root, INGREDIENT_BUILDER_SERVICE_KIND_ATTR)?.value).toBe('cli');
    expect(findByAttr(root, INGREDIENT_BUILDER_AUTH_MODEL_ATTR)?.value).toBe('cli_delegated');
    expect(findByAttr(root, INGREDIENT_BUILDER_CLI_TOOL_ATTR)?.value).toBe('codex');
    expect(findByAttr(root, INGREDIENT_BUILDER_PACK_DEPENDENCIES_ATTR)?.value)
      .toBe('[{"type":"pack","slug":"github-pack","min_version":1}]');
    expect(route.buildDraftBody()).toMatchObject({
      slug: 'codex-local',
      ingredients: [
        {
          slug: 'codex-local',
          kind: 'cli',
          cli: { tool: 'codex', probe: ['codex', '--version'] },
        },
      ],
    });
  });

  it('serializes connector rows as cli invocation bindings', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'bindingKind'), 'cli_invocation');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'family'), 'container');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'container.ls');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'verb'), 'ls');
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'cliArgvText'),
      '["container","ls","--format","json"]',
    );
    // D-185 — the realized output shape (structured stdout).
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:cli_shape'),
      'json',
    );
    // D-185 Slice 2 — the ref-output storage backing round-trips too.
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:cli_storage'),
      'temp',
    );

    const body = route.buildDraftBody();
    expect(body.operations[0]).toMatchObject({
      op: 'container.ls',
      ingredient: 'local-ingredient',
      bind: {
        kind: 'cli_invocation',
        argv_template: ['container', 'ls', '--format', 'json'],
        stdin_handling: 'none',
        shape: 'json',
        storage: 'temp',
        exit_code_handling: 'zero_is_success',
      },
    });
  });

  it('serializes cli-delegated auth and detached connector binding JSON', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'bindingKind'), 'cli_invocation');
    setValue(findByAttr(root, INGREDIENT_BUILDER_AUTH_MODEL_ATTR), 'cli_delegated');
    setValue(findByAttr(root, INGREDIENT_BUILDER_CLI_TOOL_ATTR), 'codex');
    setValue(findByAttr(root, INGREDIENT_BUILDER_CLI_READINESS_ATTR), '["codex","--version"]');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'family'), 'codex');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'codex.issue.run');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'verb'), 'run');
    // The typed CLI fields replace the raw-JSON binding cell: argv (the primary
    // cell), stdin, exit-code handling, and the detached job spec each author
    // their own labeled control.
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'cliArgvText'),
      '["codex","exec","--json"]',
    );
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:cli_stdin'),
      'pipe_body',
    );
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:cli_exit_code'),
      '{"success_codes":[0,2]}',
    );
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:cli_detached'),
      JSON.stringify({
        mode: 'runtime_managed',
        completion: {
          kind: 'marker_file',
          exit_pattern: '/tmp/recued/codex-{code}.done',
        },
      }),
    );

    const body = route.buildDraftBody();
    expect(body).toMatchObject({
      ingredients: [
        {
          slug: 'local-ingredient',
          kind: 'cli',
          cli: { tool: 'codex', probe: ['codex', '--version'] },
        },
      ],
    });
    expect(body.operations[0]?.bind).toEqual({
      kind: 'cli_invocation',
      argv_template: ['codex', 'exec', '--json'],
      stdin_handling: 'pipe_body',
      shape: 'text',
      exit_code_handling: { success_codes: [0, 2] },
      detached: {
        mode: 'runtime_managed',
        completion: {
          kind: 'marker_file',
          exit_pattern: '/tmp/recued/codex-{code}.done',
        },
      },
    });
  });

  it('loads and round-trips v3 operation pagination and advanced fields from a saved pack body', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const composition: CompositionIngredient = {
      schema_version: 1,
      slug: 'stripe-billing',
      catalog_kind: 'private_byo',
      ingredients: [
        {
          slug: 'stripe-billing',
          kind: 'http',
          http: { base: 'https://api.example.com', connection: 'stripe-main' },
        },
      ],
      operations: [
        {
          op: 'payment.search',
          ingredient: 'stripe-billing',
          risk: 'read',
          approval: 'never',
          bind: {
            kind: 'rest',
            method: 'GET',
            path_template: '/v1/payment_intents',
          },
          description: 'List Stripe payment intents.',
          editable_args: [
            { key: 'created.gte', type: 'number', label: 'Created after' },
          ],
          timeout_ms: 15000,
          cache_ttl_ms: 60000,
          result_path: 'data',
          pagination: {
            style: 'body_cursor',
            page_size: { placement: 'query', param: 'limit', value: 100, max: 100 },
            next_when: { path: 'has_more', equals: true },
            cursor_from: { path: 'data', select: 'last', field: 'id' },
            cursor_to: { placement: 'query', param: 'starting_after' },
          },
        },
      ],
    };
    const { conn } = makeConn({
      drafts: [
        {
          draft_id: 'draft-stripe-pack',
          title: 'Stripe billing pack',
          slug: 'stripe-billing-pack',
          surface: 'api',
          operation_count: 1,
          created_at: 1,
          updated_at: 2,
        },
      ],
      draftBodies: {
        'draft-stripe-pack': {
          title: 'Stripe billing pack',
          body: {
            manifest_version: 2,
            artifact_type: 'pack',
            pack_kind: 'app_pack',
            service_kind: 'entity_platform',
            slug: 'stripe-billing-pack',
            publisher: 'local-authoring',
            name: 'Stripe billing pack',
            description: 'Stripe billing pack',
            version: 1,
            recipes: [],
            requires: ['bulk_pack.install'],
            tags: ['stripe', 'billing', 'v3'],
            contents: [{ type: 'composition', composition }],
          },
        },
      },
    });

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    await tick();

    setValue(findByAttr(root, INGREDIENT_BUILDER_DRAFT_PICKER_ATTR), 'draft-stripe-pack');
    await tick();

    expect(findByAttrValue(
      root,
      INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR,
      'row-0:pagination_style',
    )?.value).toBe('body_cursor');
    expect(findByAttrValue(
      root,
      INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR,
      'row-0:pagination_page_size_param',
    )?.value).toBe('limit');
    expect(findByAttrValue(
      root,
      INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR,
      'row-0:editable_args',
    )?.value).toContain('created.gte');

    const op = route.buildDraftBody().operations[0]!;
    expect(op).toMatchObject({
      op: 'payment.search',
      ingredient: 'stripe-billing',
      description: 'List Stripe payment intents.',
      editable_args: [
        { key: 'created.gte', type: 'number', label: 'Created after' },
      ],
      timeout_ms: 15000,
      cache_ttl_ms: 60000,
      result_path: 'data',
      pagination: {
        style: 'body_cursor',
        page_size: { placement: 'query', param: 'limit', value: 100, max: 100 },
        next_when: { path: 'has_more', equals: true },
        cursor_from: { path: 'data', select: 'last', field: 'id' },
        cursor_to: { placement: 'query', param: 'starting_after' },
      },
    });
  });

  it('authors operation-local pagination from the per-row advanced controls', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'github-local');
    setValue(findByAttr(root, INGREDIENT_BUILDER_CONNECTION_ATTR), 'github-main');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'family'), 'issues');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'issues.list');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'verb'), 'list');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'restPathTemplate'), '/repos/{owner}/{repo}/issues');
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'reviewed'), true);

    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:result_path'),
      '',
    );
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:pagination_style'),
      'link_header',
    );
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:pagination_page_size_param'),
      'per_page',
    );
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:pagination_page_size_value'),
      '100',
    );
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:pagination_page_size_max'),
      '100',
    );
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:pagination_details'),
      '{"header":"link"}',
    );

    expect(route.buildDraftBody().operations[0]).toMatchObject({
      op: 'issues.list',
      pagination: {
        style: 'link_header',
        page_size: { placement: 'query', param: 'per_page', value: 100, max: 100 },
        header: 'link',
      },
    });
  });

  it('surfaces malformed advanced-field JSON as a save error instead of wedging the save', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn, calls } = makeConn();

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'hubspot-local');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'family'), 'contact');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'verb'), 'get');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'restPathTemplate'), '/crm/v3/objects/contacts/{contact_id}');
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:editable_args'),
      '{not json',
    );

    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();

    // The rpc was never attempted and the button is usable again — not stuck
    // disabled in the 'Saving' stage.
    expect(calls.filter((call) => call.method !== 'ingredient.draft.list')).toHaveLength(0);
    const saveAfterError = findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR);
    expect(saveAfterError?.disabled).toBeFalsy();
    expect(saveAfterError?.textContent).toBe('Save');

    // Fixing the field makes the same button save normally.
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR, 'row-0:editable_args'),
      '[]',
    );
    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();

    expect(calls.some((call) => call.method === 'ingredient.draft.save')).toBe(true);
  });

  it('round-trips REST binding extras and graphql bindings on API rows verbatim', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const searchBinding = {
      kind: 'rest' as const,
      method: 'GET' as const,
      path_template: '/search/issues',
      static_query: { state: 'open' },
    };
    const sendBinding = {
      kind: 'rest' as const,
      method: 'POST' as const,
      path_template: '/v1/invoices/{invoice_id}/send',
    };
    const graphqlBinding = {
      kind: 'graphql' as const,
      operation_type: 'query' as const,
      endpoint_path: '/graphql',
      query: 'query Org { organization { id } }',
    };
    const composition: CompositionIngredient = {
      schema_version: 1,
      slug: 'github-local',
      catalog_kind: 'private_byo',
      ingredients: [
        {
          slug: 'github-local',
          kind: 'http',
          http: { base: 'https://api.example.com', connection: 'github-main' },
        },
      ],
      operations: [
        {
          op: 'issue.search',
          ingredient: 'github-local',
          risk: 'read',
          approval: 'never',
          bind: searchBinding,
        },
        {
          op: 'invoice.send',
          ingredient: 'github-local',
          risk: 'write',
          approval: 'ask',
          bind: sendBinding,
        },
        {
          op: 'org.query',
          ingredient: 'github-local',
          risk: 'read',
          approval: 'never',
          bind: graphqlBinding,
        },
      ],
    };
    const { conn } = makeConn({
      drafts: [
        {
          draft_id: 'draft-bindings',
          title: 'GitHub local',
          slug: 'github-local',
          surface: 'api',
          operation_count: 3,
          created_at: 1,
          updated_at: 2,
        },
      ],
      draftBodies: {
        'draft-bindings': { title: 'GitHub local', body: composition },
      },
    });

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    await tick();

    setValue(findByAttr(root, INGREDIENT_BUILDER_DRAFT_PICKER_ATTR), 'draft-bindings');
    await tick();

    // Each binding deserializes onto the typed flat fields: every row's Kind
    // select carries its discriminator, the REST extras land in their labeled
    // advanced controls, and the graphql query rides its own primary cell.
    const kindSelects = findAllByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'bindingKind');
    expect(kindSelects.map((s) => s.value)).toEqual(['rest', 'rest', 'graphql']);
    expect(findByAttrValue(
      root,
      INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR,
      'row-0:rest_static_query',
    )?.value).toContain('"state":"open"');
    expect(findByAttrValue(
      root,
      INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR,
      'row-1:rest_method',
    )?.value).toBe('POST');
    expect(findAllByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'graphqlQueryText')[0]?.value)
      .toContain('organization');

    const operations = route.buildDraftBody().operations;
    expect(operations[0]?.bind).toEqual(searchBinding);
    expect(operations[1]?.bind).toEqual(sendBinding);
    expect(operations[2]?.bind).toEqual(graphqlBinding);
  });

  it('runs ingredient.preview against the saved reviewed draft', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn, calls } = makeConn();

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'hubspot-local');
    setValue(findByAttr(root, INGREDIENT_BUILDER_CONNECTION_ATTR), 'hubspot-main');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'family'), 'contact');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'restPathTemplate'), '/crm/v3/objects/contacts/{contact_id}');
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'reviewed'), true);

    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();
    setValue(findByAttr(root, INGREDIENT_BUILDER_PREVIEW_ARGS_ATTR), '{"contact_id":"C1"}');
    findByAttr(root, INGREDIENT_BUILDER_PREVIEW_ATTR)?.click();
    await tick();

    const previewCall = calls.find((call) => call.method === 'ingredient.preview');
    expect(previewCall).toEqual({
      method: 'ingredient.preview',
      payload: {
        draft_id: 'draft-1',
        operation_key: 'contact.read',
        args: { contact_id: 'C1' },
      },
    });
    expect(findByAttr(root, INGREDIENT_BUILDER_PREVIEW_STATUS_ATTR)?.textContent)
      .toBe('Preview executed: 200');
  });

  it('blocks install until review passes and installs the saved privacy-tagged draft', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn, calls } = makeConn();

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    expect(findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)).toBeUndefined();
    expect(findByAttr(root, INGREDIENT_BUILDER_INSTALL_STATUS_ATTR)).toBeUndefined();

    setValue(findByAttr(root, INGREDIENT_BUILDER_TITLE_ATTR), 'HubSpot local');
    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'hubspot-local');
    setValue(findByAttr(root, INGREDIENT_BUILDER_CONNECTION_ATTR), 'hubspot-main');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'family'), 'contact');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'restPathTemplate'), '/crm/v3/objects/contacts/{contact_id}');
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'reviewed'), true);

    findByAttr(root, INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR)?.click();
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'entity'), 'Contact');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'field_path'), 'properties.email');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'type'), 'string');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'maps_to'), 'properties.email');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'applies'), 'resp');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'pii'), 'email');
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, 'reviewed'), true);

    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();
    expect(findByAttr(root, INGREDIENT_BUILDER_INSTALL_STATUS_ATTR)?.textContent)
      .toBe('Ready to install from reviewed draft');
    expect(findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)?.disabled).toBe(false);

    findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)?.click();
    await tick();

    const installCall = calls.find((call) => call.method === 'ingredient.install');
    const manifest = (installCall?.payload as { manifest: unknown }).manifest as {
      manifest_version: number;
      slug: string;
      pack_kind: string;
      service_kind: string;
      tags: string[];
      contents: Array<{ type: string; composition: CompositionIngredient }>;
    };
    expect(manifest.manifest_version).toBe(2);
    expect(manifest.slug).toBe('hubspot-local-pack');
    expect(manifest.pack_kind).toBe('app_pack');
    expect(manifest.service_kind).toBe('entity_platform');
    expect(manifest.tags).toEqual(['local', 'composition', 'v3']);
    expect(manifest.contents[0]).toMatchObject({
      type: 'composition',
      composition: {
        slug: 'hubspot-local',
        ingredients: [
          expect.objectContaining({
            kind: 'http',
            http: { base: 'https://api.example.com', connection: 'hubspot-main' },
            entities: {
              Contact: {
                fields: [
                  expect.objectContaining({
                    field_path: 'properties.email',
                    pii: 'email',
                  }),
                ],
              },
            },
          }),
        ],
      },
    });
    expect(findByAttr(root, INGREDIENT_BUILDER_INSTALL_STATUS_ATTR)?.textContent)
      .toBe('Installed pack hubspot-local-pack');
  });

  it('installs a reviewed draft with authored v3 pack metadata', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn, calls } = makeConn();

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    setValue(findByAttr(root, INGREDIENT_BUILDER_TITLE_ATTR), 'Solo business starter');
    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'solo-business-starter');
    setValue(findByAttr(root, INGREDIENT_BUILDER_CONNECTION_ATTR), 'hubspot-main');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'family'), 'deal');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'deal.search');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'restPathTemplate'), '/crm/v3/objects/deals/search');
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'reviewed'), true);

    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();

    setValue(findByAttr(root, INGREDIENT_BUILDER_PACK_SLUG_ATTR), 'solo-starter-suite');
    setValue(findByAttr(root, INGREDIENT_BUILDER_PUBLISHER_ATTR), 'local-one-person-company');
    setValue(findByAttr(root, INGREDIENT_BUILDER_PACK_KIND_ATTR), 'foundation_pack');
    setValue(findByAttr(root, INGREDIENT_BUILDER_SERVICE_KIND_ATTR), 'tool_function');
    setValue(findByAttr(root, INGREDIENT_BUILDER_PACK_DESCRIPTION_ATTR), 'One-person company starter workflows');
    setValue(findByAttr(root, INGREDIENT_BUILDER_PACK_TAGS_ATTR), 'local,solo-business,starter');
    setValue(
      findByAttr(root, INGREDIENT_BUILDER_PACK_DEPENDENCIES_ATTR),
      '[{"type":"pack","slug":"github-pack","min_version":1}]',
    );

    expect(findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)?.disabled).toBe(false);
    findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)?.click();
    await tick();

    const installCall = calls.find((call) => call.method === 'ingredient.install');
    const manifest = (installCall?.payload as { manifest: unknown }).manifest as {
      slug: string;
      publisher: string;
      pack_kind: string;
      service_kind: string;
      description: string;
      tags: string[];
      dependencies?: Array<{ type: string; slug: string; min_version?: number }>;
    };
    expect(manifest).toMatchObject({
      slug: 'solo-starter-suite',
      publisher: 'local-one-person-company',
      pack_kind: 'foundation_pack',
      service_kind: 'tool_function',
      description: 'One-person company starter workflows',
      tags: ['local', 'solo-business', 'starter'],
      dependencies: [{ type: 'pack', slug: 'github-pack', min_version: 1 }],
    });
    expect(calls.filter((call) => call.method === 'ingredient.draft.save')).toHaveLength(1);
  });

  it('round-trips and authors composition default_grants (Tier-2 Publish)', () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();
    const initialBody = {
      schema_version: 1,
      slug: 'reception-pack',
      catalog_kind: 'private_byo',
      ingredients: [{ slug: 'reception-pack', kind: 'http', http: { base: 'https://api.example.com' } }],
      operations: [
        {
          op: 'inbox.materialize',
          ingredient: 'reception-pack',
          risk: 'write',
          approval: 'ask',
          bind: { kind: 'rest', method: 'POST', path_template: '/inbox/{id}/materialize' },
        },
      ],
      default_grants: ['reception-pack.inbox.write', 'reception-pack.inbox.read'],
    };

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialBody,
    });

    // Loaded as comma-separated text, round-trips back to the array.
    expect(findByAttr(root, INGREDIENT_BUILDER_DEFAULT_GRANTS_ATTR)?.value)
      .toBe('reception-pack.inbox.write, reception-pack.inbox.read');
    expect(route.buildDraftBody().default_grants)
      .toEqual(['reception-pack.inbox.write', 'reception-pack.inbox.read']);

    // Edit the control.
    setValue(findByAttr(root, INGREDIENT_BUILDER_DEFAULT_GRANTS_ATTR), 'reception-pack.inbox.read');
    expect(route.buildDraftBody().default_grants).toEqual(['reception-pack.inbox.read']);

    // Cleared → the field is omitted from the composition.
    setValue(findByAttr(root, INGREDIENT_BUILDER_DEFAULT_GRANTS_ATTR), '');
    expect('default_grants' in route.buildDraftBody()).toBe(false);
  });

  it('carries default_grants through the draft picker (applyDraftState)', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const savedBody: CompositionIngredient = {
      schema_version: 1,
      slug: 'reception-saved',
      catalog_kind: 'private_byo',
      ingredients: [{ slug: 'reception-saved', kind: 'http', http: { base: 'https://api.example.com' } }],
      operations: [
        {
          op: 'inbox.materialize',
          ingredient: 'reception-saved',
          risk: 'write',
          approval: 'ask',
          bind: { kind: 'rest', method: 'POST', path_template: '/inbox/{id}/materialize' },
        },
      ],
      default_grants: ['reception-saved.inbox.write'],
    };
    const { conn } = makeConn({
      drafts: [
        {
          draft_id: 'draft-reception',
          title: 'Reception saved',
          slug: 'reception-saved',
          surface: 'api',
          operation_count: 1,
          created_at: 1,
          updated_at: 2,
        },
      ],
      draftBodies: { 'draft-reception': { title: 'Reception saved', body: savedBody } },
    });

    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    await tick();

    setValue(findByAttr(root, INGREDIENT_BUILDER_DRAFT_PICKER_ATTR), 'draft-reception');
    await tick();

    // applyDraftState (the field-by-field copy) must carry packDefaultGrantsText.
    expect(findByAttr(root, INGREDIENT_BUILDER_DEFAULT_GRANTS_ATTR)?.value)
      .toBe('reception-saved.inbox.write');
    expect(route.buildDraftBody().default_grants).toEqual(['reception-saved.inbox.write']);
  });

  it('renders decompose validation_failed issues and field-privacy review', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const issue = {
      severity: 'error',
      code: 'composition_entity_field_unreviewed',
      path: 'entity_fields[0].reviewed',
      message: 'entity field row must be reviewed before validation can pass',
    } as const;
    const failedReview: CompositionReviewView = {
      ...validReview(),
      valid: false,
      summary: {
        ...validReview().summary,
        counts: {
          compositions: 1,
          operation_families: 1,
          entity_fields: 1,
          pii_fields: 1,
          pack_contents: 0,
          compiled_outputs: 0,
        },
      },
      field_privacy: [{ path: 'properties.email', privacy_kind: 'email' }],
      issues: [issue],
    };
    const { conn, calls } = makeConn({
      decompose: {
        ok: false,
        code: 'validation_failed',
        message: 'draft composition failed validation',
        issues: [issue],
        review: failedReview,
      },
    });

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });

    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();

    expect(calls.map((call) => call.method).filter((method) => method !== 'ingredient.draft.list')).toEqual([
      'ingredient.draft.save',
      'ingredient.compose.decompose',
    ]);
    const banner = findByAttr(root, INGREDIENT_BUILDER_REVIEW_STATUS_ATTR);
    expect(banner?.getAttribute('data-state')).toBe('invalid');
    expect(banner?.textContent).toBe('Validation failed: 1 issue');
    expect(findByAttr(root, INGREDIENT_BUILDER_STATUS_ATTR)?.textContent)
      .toBe('Validation failed');
    expect(findByAttr(root, INGREDIENT_BUILDER_FIELD_PRIVACY_ATTR)?.textContent)
      .toBe('properties.email: email');
    expect(findByAttr(root, INGREDIENT_BUILDER_REVIEW_ISSUE_ATTR)?.textContent)
      .toContain('composition_entity_field_unreviewed');
  });

  it('registers the top-level kitchen route hash', () => {
    expect(parseRouteFromHash('#kitchen')).toBe('kitchen');
    expect(parseRouteFromHash('#/kitchen')).toBe('kitchen');
    expect(WEBCLIENT_ROUTE_IDS).toContain('kitchen');
  });

  // ──────────────────────────────────────────────────────────────
  // D-182 §7.1 / D-196 — the install-time {Access × Audience} picker
  // ──────────────────────────────────────────────────────────────

  /** Drive a fresh route to the reviewed-valid state for a single-op draft,
   *  using the supplied review (its `operation_families` decide the picker). */
  const reviewedRoute = async (review: CompositionReviewView) => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn, calls } = makeConn({
      decompose: {
        ok: true,
        draft_id: 'draft-1',
        artifacts: { entity_schemas: [], operation_groups: [], default_grants: [] },
        review,
      },
    });
    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    setValue(findByAttr(root, INGREDIENT_BUILDER_TITLE_ATTR), 'HubSpot local');
    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'hubspot-local');
    setValue(findByAttr(root, INGREDIENT_BUILDER_CONNECTION_ATTR), 'hubspot-main');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'family'), 'contact');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'restPathTemplate'),
      '/crm/v3/objects/contacts/{contact_id}',
    );
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'reviewed'), true);
    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();
    return { root, calls };
  };

  const apiReview = (
    families: CompositionReviewView['operation_families'],
  ): CompositionReviewView => validReview({ operation_families: families });

  const accessRadio = (root: FakeElement, access: string): FakeElement | undefined =>
    findAllByAttr(root, INSTALL_GRANT_ACCESS_OPTION_ATTR).find(
      (r) => r.getAttribute('data-access') === access,
    );

  const audienceCheck = (root: FakeElement, scope: string): FakeElement | undefined =>
    findAllByAttr(root, INSTALL_GRANT_SCOPE_OPTION_ATTR).find(
      (r) => r.getAttribute('data-scope') === scope,
    );

  const installScopeOf = (calls: Array<{ method: string; payload: unknown }>) => {
    const call = calls.find((c) => c.method === 'ingredient.install');
    return (call?.payload as { install_scope?: { access: string } }).install_scope;
  };

  it('renders the picker for a connection-backed reviewed draft + sends install_scope read by default', async () => {
    const { root, calls } = await reviewedRoute(
      apiReview([
        { key: 'contact.read', surface: 'api', risk_tier: 'read', approval_mapping: 'never' },
        { key: 'contact.update', surface: 'api', risk_tier: 'write', approval_mapping: 'ask' },
      ]),
    );
    expect(findByAttr(root, INSTALL_GRANT_PICKER_ATTR)).toBeDefined();
    findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)?.click();
    await tick();
    expect(installScopeOf(calls)).toEqual({
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
  });

  it('sends the picked +Write tier as install_scope.access', async () => {
    const { root, calls } = await reviewedRoute(
      apiReview([
        { key: 'contact.read', surface: 'api', risk_tier: 'read', approval_mapping: 'never' },
        { key: 'contact.update', surface: 'api', risk_tier: 'write', approval_mapping: 'ask' },
      ]),
    );
    const writeRadio = accessRadio(root, 'write');
    expect(writeRadio).toBeDefined();
    writeRadio!.dispatch('change');
    findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)?.click();
    await tick();
    expect(installScopeOf(calls)).toEqual({
      access: 'write',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
  });

  it('sends owner-plus-customers as independent install audience checks', async () => {
    const { root, calls } = await reviewedRoute(
      apiReview([
        { key: 'contact.read', surface: 'api', risk_tier: 'read', approval_mapping: 'never' },
        { key: 'contact.update', surface: 'api', risk_tier: 'write', approval_mapping: 'ask' },
      ]),
    );
    const customers = audienceCheck(root, 'all_customers');
    expect(customers).toBeDefined();
    customers!.checked = true;
    customers!.dispatch('change');
    findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)?.click();
    await tick();
    expect(installScopeOf(calls)).toEqual({
      access: 'read',
      audience: { owner: true, all_customers: true, all_other_contracts: false },
    });
  });

  it('resets the picked tier to read when the draft is edited + re-reviewed (Codex MED)', async () => {
    const { root, calls } = await reviewedRoute(
      apiReview([
        { key: 'contact.read', surface: 'api', risk_tier: 'read', approval_mapping: 'never' },
        { key: 'contact.update', surface: 'api', risk_tier: 'write', approval_mapping: 'ask' },
      ]),
    );
    accessRadio(root, 'write')!.dispatch('change');
    // Edit a field → markDirty invalidates the review + resets the grant tier;
    // re-save re-reviews, and the picker must show `read` again, not the stale
    // `write`.
    setValue(findByAttr(root, INGREDIENT_BUILDER_TITLE_ATTR), 'HubSpot local edited');
    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();
    expect(accessRadio(root, 'read')?.checked).toBe(true);
    expect(accessRadio(root, 'write')?.checked).toBe(false);
    findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)?.click();
    await tick();
    expect(installScopeOf(calls)).toEqual({
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
  });

  it('renders NO picker + sends NO install_scope for a cli (connector) reviewed draft', async () => {
    const { root, calls } = await reviewedRoute(
      apiReview([
        { key: 'audio.transcribe', surface: 'connector', risk_tier: 'write', approval_mapping: 'ask' },
      ]),
    );
    expect(findByAttr(root, INSTALL_GRANT_PICKER_ATTR)).toBeUndefined();
    findByAttr(root, INGREDIENT_BUILDER_INSTALL_ATTR)?.click();
    await tick();
    expect(installScopeOf(calls)).toBeUndefined();
  });
});

describe('Edit→Kitchen — initialDraftId self-load + onDraftChange (deep link)', () => {
  const crmSavedBody = () => ({
    schema_version: 1,
    slug: 'crm-saved',
    catalog_kind: 'private_byo',
    ingredients: [
      {
        slug: 'crm-saved',
        kind: 'http',
        http: { base: 'https://api.hubapi.com', connection: 'hubspot' },
        entities: {
          Deal: {
            crm_alias: 'deal',
            fields: [{ field_path: 'properties.amount', type: 'number', maps_to: 'amount' }],
          },
        },
      },
    ],
    operations: [],
  });

  const crmDraftConn = () =>
    makeConn({
      drafts: [
        {
          draft_id: 'draft-crm',
          title: 'CRM saved',
          slug: 'crm-saved',
          surface: 'api',
          operation_count: 0,
          created_at: 1,
          updated_at: 2,
        },
      ],
      draftBodies: { 'draft-crm': { title: 'CRM saved', body: crmSavedBody() } },
    });

  it('self-loads initialDraftId on arrival (no in-page pick) + fires onDraftChange with the id', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn, calls } = crmDraftConn();
    const draftChanges: Array<string | undefined> = [];

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialDraftId: 'draft-crm',
      onDraftChange: (id) => draftChanges.push(id),
    });
    await tick();

    // The deep-link arrival self-loaded the draft (fetch), with no picker use.
    expect(
      calls.some(
        (c) =>
          c.method === 'ingredient.draft.get'
          && (c.payload as { draft_id?: string }).draft_id === 'draft-crm',
      ),
    ).toBe(true);
    // Its body rendered into the editor (proves the load applied).
    expect(findByAttrValue(root, INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR, 'Deal')?.value).toBe('deal');
    // onDraftChange fired with the loaded id — this drives the URL sync to
    // `#kitchen/pack/draft-crm`.
    expect(draftChanges).toContain('draft-crm');
  });

  it('does NOT self-load when an initialBody is supplied (draft already in hand)', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn, calls } = crmDraftConn();

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialDraftId: 'draft-crm',
      initialBody: crmSavedBody(),
    });
    await tick();

    // The body was passed in, so no fetch — the picker path stays the only
    // draft.get caller.
    expect(
      calls.some((c) => c.method === 'ingredient.draft.get'),
    ).toBe(false);
  });

  it('fires onDraftChange on an in-page draft pick (id) and on "new" (undefined)', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = crmDraftConn();
    const draftChanges: Array<string | undefined> = [];

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      onDraftChange: (id) => draftChanges.push(id),
    });
    await tick();
    // No self-load on a bare mount (no initialDraftId) — onDraftChange silent.
    expect(draftChanges).toHaveLength(0);

    // Pick a saved draft → onDraftChange(id).
    setValue(findByAttr(root, INGREDIENT_BUILDER_DRAFT_PICKER_ATTR), 'draft-crm');
    await tick();
    expect(draftChanges).toContain('draft-crm');

    // Pick "new" (empty option) → newDraft → onDraftChange(undefined).
    setValue(findByAttr(root, INGREDIENT_BUILDER_DRAFT_PICKER_ATTR), '');
    await tick();
    expect(draftChanges).toContain(undefined);
  });

  it('fires onDraftChange with the server id when a fresh draft is first saved', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn();
    const draftChanges: Array<string | undefined> = [];

    bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      onDraftChange: (id) => draftChanges.push(id),
    });

    // Author a minimal valid composition (mirrors the save-flow test above).
    setValue(findByAttr(root, INGREDIENT_BUILDER_TITLE_ATTR), 'HubSpot local');
    setValue(findByAttr(root, INGREDIENT_BUILDER_SLUG_ATTR), 'hubspot-local');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'family'), 'contact');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'verb'), 'get');
    setValue(
      findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'restPathTemplate'),
      '/crm/v3/objects/contacts/{contact_id}',
    );
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'risk'), 'read');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'approval'), 'never');
    setChecked(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'reviewed'), true);

    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();

    // The save assigned 'draft-1' — onDraftChange surfaces it so a fresh draft's
    // URL (`#kitchen/pack`) becomes shareable (`#kitchen/pack/draft-1`).
    expect(draftChanges).toContain('draft-1');
  });
});

// ────────────────────────────────────────────────────────────────
// Polish pass — live topbar sync, host-level issues, error status,
// publish hint, op-card open persistence
// ────────────────────────────────────────────────────────────────

describe('pack editor polish — feedback correctness', () => {
  const mount = (options: Parameters<typeof makeConn>[0] = {}) => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn, calls } = makeConn(options);
    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    return { doc, root, route, calls };
  };

  const findAllByClass = (
    node: FakeElement,
    cls: string,
    out: FakeElement[] = [],
  ): FakeElement[] => {
    if (node.className.split(' ').includes(cls)) out.push(node);
    for (const child of node.children) findAllByClass(child, cls, out);
    return out;
  };

  const failedDecompose: CompositionDecomposeResult = {
    ok: false,
    code: 'validation_failed',
    message: 'validation failed',
    issues: [
      {
        severity: 'error',
        code: 'missing_binding',
        path: 'operations[0].bind',
        message: 'operation has no binding',
      },
    ],
  } as never;

  it('a focused field edit updates the topbar cues in place (no rerender)', async () => {
    const { root } = mount();

    // Save once so the topbar shows the clean/valid state.
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'family'), 'contact');
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();
    expect(findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.textContent).toBe('Saved');
    expect(findByAttr(root, INGREDIENT_BUILDER_STATUS_ATTR)?.textContent).toBe(
      'Draft saved and validated',
    );

    // Clean state: the (always-rendered) dirty cue is empty.
    expect(findAllByClass(root, 'ingredient-builder-dirty-dot')[0]?.textContent).toBe('');

    // A focused field edit (input event, NO structural rerender) must flip the
    // cues immediately — the pre-polish editor kept claiming Saved/validated.
    setValue(findByAttr(root, INGREDIENT_BUILDER_TITLE_ATTR), 'Renamed pack');

    expect(findAllByClass(root, 'ingredient-builder-dirty-dot')[0]?.textContent).toBe(
      'Unsaved',
    );
    expect(findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.textContent).toBe('Save');
    expect(findByAttr(root, INGREDIENT_BUILDER_STATUS_ATTR)?.textContent).toBe('');
    expect(
      findByAttr(root, INGREDIENT_BUILDER_REVIEW_STATUS_ATTR)?.textContent,
    ).toBe('Review pending');
    expect(
      findByAttr(root, INGREDIENT_BUILDER_REVIEW_STATUS_ATTR)?.getAttribute('data-state'),
    ).toBe('pending');
  });

  it('validation issues render host-level (outside every section view)', async () => {
    const { root } = mount({ decompose: failedDecompose });

    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();

    const issue = findByAttr(root, INGREDIENT_BUILDER_REVIEW_ISSUE_ATTR);
    expect(issue).toBeDefined();
    // Walk ancestors: the issue must NOT live inside a section view (the old
    // placement was the Overview view — invisible from the other sections).
    let node: FakeElement | null = issue ?? null;
    let insideSectionView = false;
    while (node !== null) {
      if (node.hasAttribute(INGREDIENT_BUILDER_SECTION_VIEW_ATTR)) insideSectionView = true;
      node = node.parent;
    }
    expect(insideSectionView).toBe(false);
    expect(issue?.getAttribute('data-severity')).toBe('error');
  });

  it('a failed save colors the status line as an error', async () => {
    const { root } = mount({ decompose: failedDecompose });

    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();

    const status = findByAttr(root, INGREDIENT_BUILDER_STATUS_ATTR);
    expect(status?.textContent).toBe('Validation failed');
    expect(status?.getAttribute('data-state')).toBe('error');
  });

  it('Setup-only edits on a fresh draft count as unsaved content', () => {
    const { root } = mount();
    expect(findAllByClass(root, 'ingredient-builder-dirty-dot')[0]?.textContent).toBe('');

    setValue(findByAttr(root, INGREDIENT_BUILDER_CONNECTION_ATTR), 'hubspot');

    // Pre-fix, only op/entity content counted — a Setup-only draft showed no
    // Unsaved cue and Cmd+S / the New-confirm treated it as discardable.
    expect(findAllByClass(root, 'ingredient-builder-dirty-dot')[0]?.textContent).toBe(
      'Unsaved',
    );
  });

  it('an edit landing mid-save is not reported clean by the completion', async () => {
    const { root } = mount();
    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();

    // The save/decompose promises are still pending — type before they land.
    setValue(findByAttr(root, INGREDIENT_BUILDER_TITLE_ATTR), 'edited mid-save');
    await tick();

    // The completion saw the epoch move: the draft is NOT clean.
    expect(findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.textContent).toBe('Save');
    expect(findByAttr(root, INGREDIENT_BUILDER_STATUS_ATTR)?.textContent).toBe(
      'Saved — newer edits pending',
    );
    expect(findAllByClass(root, 'ingredient-builder-dirty-dot')[0]?.textContent).toBe(
      'Unsaved',
    );
  });

  it('hasUnsavedChanges: true during the save flight, clean after, edits-only otherwise', async () => {
    const { root, route } = mount();
    expect(route.hasUnsavedChanges()).toBe(false);

    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    expect(route.hasUnsavedChanges()).toBe(true);

    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    // In flight (save rpc not yet acked) — leaving now could lose the edits.
    expect(route.hasUnsavedChanges()).toBe(true);
    await tick();
    expect(route.hasUnsavedChanges()).toBe(false);
  });

  it('a draft whose LOAD validation fails is not "unsaved" (nothing to lose)', async () => {
    const doc = makeFakeDocument();
    const root = makeFakeElement('main');
    const { conn } = makeConn({
      draftBodies: { 'draft-broken': { title: 'Broken', body: { schema_version: 1, slug: 'x', ingredients: [], operations: [] } } },
      decompose: {
        ok: false,
        code: 'validation_failed',
        message: 'validation failed',
        issues: [
          { severity: 'error', code: 'missing_binding', path: 'operations', message: 'no ops' },
        ],
      } as never,
    });
    const route = bootstrapIngredientBuilderRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialDraftId: 'draft-broken',
    });
    await tick();

    // Load ended at saveStage 'error' — but the user typed nothing; the body
    // is persisted server-side. Leaving must NOT prompt.
    expect(route.getState().saveStage).toBe('error');
    expect(route.hasUnsavedChanges()).toBe(false);
  });

  it('warn issues riding a VALID review stay visible host-level', async () => {
    const { root } = mount({
      decompose: {
        ok: true,
        draft_id: 'draft-1',
        artifacts: { entity_schemas: [], operation_groups: [], default_grants: [] },
        review: validReview({
          issues: [
            {
              severity: 'warn',
              code: 'composition_1x1_privacy_tags_dropped',
              path: 'ingredients[0]',
              message: 'privacy tags are dropped on a 1x1 install',
            },
          ],
        }),
      } as never,
    });

    setValue(findByAttrValue(root, INGREDIENT_BUILDER_FIELD_ATTR, 'operation'), 'contact.read');
    findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.click();
    await tick();

    // Saved-and-valid — but the warning still renders (it used to vanish:
    // the old gate only opened for invalid reviews).
    expect(findByAttr(root, INGREDIENT_BUILDER_SAVE_ATTR)?.textContent).toBe('Saved');
    const issue = findByAttr(root, INGREDIENT_BUILDER_REVIEW_ISSUE_ATTR);
    expect(issue?.getAttribute('data-severity')).toBe('warn');
    expect(issue?.textContent).toContain('privacy tags are dropped');
  });

  it('the Publish section explains why Preview/Install are locked', () => {
    const { root } = mount();
    const hints = findAllByClass(root, 'ingredient-builder-publish-hint');
    expect(hints.length).toBe(1);
    expect(hints[0]!.textContent).toContain('Preview and Install unlock');
  });

  it('a user card toggle survives a structural rerender; removal prunes it', () => {
    const { root } = mount();

    // The single blank row renders open (unreviewed default).
    const row = findAllByAttr(root, INGREDIENT_BUILDER_ROW_ATTR)[0];
    expect(row?.hasAttribute('open')).toBe(true);

    // User collapses it (fake toggle: set open then dispatch).
    (row as unknown as { open: boolean }).open = false;
    row!.dispatch('toggle');

    // A structural rerender (add a second operation) keeps it collapsed.
    findByAttr(root, INGREDIENT_BUILDER_ADD_ROW_ATTR)?.click();
    const rowsAfter = findAllByAttr(root, INGREDIENT_BUILDER_ROW_ATTR);
    expect(rowsAfter[0]?.hasAttribute('open')).toBe(false);
    expect(rowsAfter[1]?.hasAttribute('open')).toBe(true);

    // Removing the collapsed row prunes its override; the surviving + newly
    // added (unreviewed) rows all render open by default.
    findAllByAttr(root, INGREDIENT_BUILDER_REMOVE_ROW_ATTR)[0]?.click();
    findByAttr(root, INGREDIENT_BUILDER_ADD_ROW_ATTR)?.click();
    const rowsFinal = findAllByAttr(root, INGREDIENT_BUILDER_ROW_ATTR);
    expect(rowsFinal.length).toBe(2);
    for (const r of rowsFinal) {
      expect(r.hasAttribute('open')).toBe(true);
    }
  });
});

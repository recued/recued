import { describe, expect, it, vi } from 'vitest';
import type {
  RecordsFriendlyRecord,
  RecordsGlobalQuotaSnapshot,
  RecordsNamespaceView,
  RecordsOwnerRecordDiagnostics,
  RecordsSchemaSnapshot,
} from '@recued/contracts';
import { bootstrapDataRoute } from '../bootstrap-data-route.js';
import { renderRecordsExplorer, type RecordsExplorerState } from '../records-explorer.js';

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    job: {
      kind: 'job',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'title', slot: 's1', kind: 'string', required: true },
        { key: 'customer.email', slot: 's2', kind: 'string', required: true, privacy: 'email' },
        { key: 'amount', slot: 'dec1', kind: 'decimal', required: true },
        { key: 'parent', slot: 'r1', kind: 'ref', required: false },
      ],
    },
  },
};

const namespace = (publisher: string): RecordsNamespaceView => ({
  owner: { publisher, pack_slug: 'same-board' },
  state: {
    state: 'ready',
    version: 3,
    storage_schema_hash: 'a'.repeat(64),
    declaration_hash: 'b'.repeat(64),
  },
  activation_generation: 2,
  state_generation: 4,
  quota: {
    row_count: 1,
    payload_bytes: 42,
    row_limit: 100,
    byte_limit: 1_000,
    outbox_count: 0,
    outbox_limit: 100,
    data_generation: 1,
  },
  schema,
  artifact_digest: 'artifact',
  subscriber_digest: 'subscriber',
  updated_at: 1_800_000_000_000,
});

const record: RecordsFriendlyRecord = {
  id: 'job-1',
  title: 'Prepare quote',
  customer: { email: 'alice@example.test' },
  amount: '9.0000',
  parent: 'job/job-0',
  _record: {
    entity: 'job',
    version: 3,
    revision: 1,
    created_at: 1_800_000_000_000,
    updated_at: 1_800_000_000_100,
  },
};

const globalQuota: RecordsGlobalQuotaSnapshot = {
  row_count: 2,
  payload_bytes: 84,
  outbox_count: 1,
  reserved_payload_bytes: 16,
  row_limit: 10_000,
  byte_limit: 1_000_000,
  outbox_limit: 1_000,
};

const state = (overrides: Partial<RecordsExplorerState> = {}): RecordsExplorerState => ({
  namespaces: [namespace('publisher-a'), namespace('publisher-b')],
  globalQuota,
  selectedNamespace: namespace('publisher-a'),
  kinds: [{ kind: 'job', rows: 1, payload_bytes: 42 }],
  selectedKind: 'job',
  records: [record],
  detail: null,
  diagnostics: null,
  outbox: {
    pending: 1,
    delivered: 2,
    dead_letter: 1,
    total_retries: 3,
    oldest_pending_at: 1_800_000_000_000,
    oldest_pending_age_ms: 60_000,
    events: [],
  },
  retention: { job: { mode: 'keep' } },
  loading: false,
  deletePending: false,
  deleting: false,
  exporting: false,
  retiringEventId: null,
  purgePending: false,
  purging: false,
  canDelete: true,
  canExport: true,
  canRetireEvents: true,
  canPurge: true,
  ...overrides,
});

describe('D-221 #data Records explorer', () => {
  it('groups by full pack ref, preserves exact decimals, and masks PII in list previews', () => {
    const html = renderRecordsExplorer(state());
    expect(html).toContain('publisher-a');
    expect(html).toContain('publisher-b');
    expect(html).toContain('same-board');
    expect(html).toContain('9.0000');
    expect(html).toContain('••••');
    expect(html).toContain('email');
    expect(html).not.toContain('alice@example.test');
    expect(html).toContain('Global Records quota');
    expect(html).toContain('Migration reserve');
    expect(html).toContain('data-action="records-open-reference"');
    expect(html).toContain('1 pending');
    expect(html).toContain('1 dead-lettered');
  });

  it('reveals classified values only in an owner-opened detail and shows CAS metadata', () => {
    const diagnostics: RecordsOwnerRecordDiagnostics = {
      raw_slots: {
        s1: 'Prepare quote',
        s2: 'alice@example.test',
        dec1: '90000',
        r1: 'job/job-0',
      } as unknown as RecordsOwnerRecordDiagnostics['raw_slots'],
      outgoing: [{
        source_entity: 'job', source_id: 'job-1', source_field: 'parent', source_slot: 'r1',
        target_entity: 'job', target_id: 'job-0',
      }],
      incoming: [{
        source_entity: 'job', source_id: 'job-2', source_field: 'parent', source_slot: 'r1',
        target_entity: 'job', target_id: 'job-1',
      }],
    };
    const html = renderRecordsExplorer(state({ detail: record, diagnostics, deletePending: true }));
    expect(html).toContain('alice@example.test');
    expect(html).toContain('Pack version 3 · revision 1');
    expect(html).toContain('1 incoming relationship will be checked');
    expect(html).toContain('Advanced raw-slot diagnostics');
    expect(html).toContain('&quot;dec1&quot;: &quot;90000&quot;');
    expect(html).toContain('job/job-2');
    expect(html).toContain('Export pack CSV');
  });
});

interface FakeEl {
  innerHTML: string;
  textContent: string;
  children: FakeEl[];
  attrs: Map<string, string>;
  listeners: Map<string, Array<(event: Event) => void>>;
  parent: FakeEl | null;
  readonly firstChild: FakeEl | null;
  setAttribute(key: string, value: string): void;
  getAttribute(key: string): string | null;
  appendChild(child: FakeEl): FakeEl;
  removeChild(child: FakeEl): FakeEl;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  remove(): void;
}

const fakeElement = (): FakeEl => {
  const element: FakeEl = {
    innerHTML: '', textContent: '', children: [], attrs: new Map(), listeners: new Map(), parent: null,
    get firstChild() { return element.children[0] ?? null; },
    setAttribute(key, value) { element.attrs.set(key, value); },
    getAttribute(key) { return element.attrs.get(key) ?? null; },
    appendChild(child) { child.parent = element; element.children.push(child); return child; },
    removeChild(child) { element.children.splice(element.children.indexOf(child), 1); child.parent = null; return child; },
    addEventListener(type, listener) { element.listeners.set(type, [...(element.listeners.get(type) ?? []), listener]); },
    removeEventListener(type, listener) {
      element.listeners.set(type, (element.listeners.get(type) ?? []).filter((entry) => entry !== listener));
    },
    remove() { if (element.parent) element.parent.removeChild(element); },
  };
  return element;
};

const fakeDocument = (): Document => {
  const styles: FakeEl[] = [];
  const head = {
    querySelector: () => styles[0] ?? null,
    appendChild: (element: FakeEl) => { styles.push(element); return element; },
  };
  return {
    head,
    createElement: () => fakeElement(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
};

describe('D-221 Records route control-plane seam', () => {
  it('loads the Records tab only through records.* callers', async () => {
    const root = fakeElement();
    const listNamespaces = vi.fn(async () => ({
      namespaces: [namespace('publisher-a')],
      global_quota: globalQuota,
    }));
    const listKinds = vi.fn(async () => ({ kinds: [{ kind: 'job', rows: 1, payload_bytes: 42 }] }));
    const search = vi.fn(async () => ({ records: [record] }));
    const route = bootstrapDataRoute({
      root: root as unknown as HTMLElement,
      document: fakeDocument(),
      initialTab: 'records',
      recordsNamespaceListCaller: listNamespaces,
      recordsKindListCaller: listKinds,
      recordsSearchCaller: search,
      recordsGetCaller: vi.fn(),
      recordsRetentionListCaller: vi.fn(async () => ({ policies: { job: { mode: 'keep' as const } } })),
    });
    await route.whenLoaded();
    expect(route.activeTab()).toBe('records');
    expect(listNamespaces).toHaveBeenCalledOnce();
    expect(listKinds).toHaveBeenCalledWith({ owner: { publisher: 'publisher-a', pack_slug: 'same-board' } });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      owner: { publisher: 'publisher-a', pack_slug: 'same-board' },
      entity: 'job',
    }));
    expect(root.children[0]!.innerHTML).toContain('data-recued-records-explorer');
    expect(root.children[0]!.innerHTML).toContain('All event backlog');
    expect(root.children[0]!.innerHTML).not.toContain('alice@example.test');
    route.dispose();
  });
});

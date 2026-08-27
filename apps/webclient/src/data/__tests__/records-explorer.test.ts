import { describe, expect, it, vi } from 'vitest';
import type {
  RecordsFriendlyRecord,
  RecordsGlobalQuotaSnapshot,
  RecordsNamespaceView,
  RecordsOwnerRecordDiagnostics,
  RecordsSchemaSnapshot,
} from '@recued/contracts';
import { bootstrapDataRoute } from '../bootstrap-data-route.js';
import {
  RECORDS_EXPLORER_STYLES,
  RECORDS_KIND_PANEL_ATTR,
  renderRecordsExplorer,
  type RecordsExplorerState,
} from '../records-explorer.js';

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
  outboxOpen: false,
  outboxRefreshing: false,
  retention: { job: { mode: 'keep' } },
  loading: false,
  loadingNamespaceKey: null,
  loadingKind: null,
  deletePending: false,
  deleting: false,
  exporting: false,
  exportingAction: null,
  retiringEventId: null,
  retiringEventBusy: false,
  purgePending: false,
  purgeConfirmation: '',
  purging: false,
  canDelete: true,
  canExport: true,
  canRetireEvents: true,
  canPurge: true,
  ...overrides,
});

describe('D-221 #data Records explorer', () => {
  it('gives Records controls a consistent full-size interaction target', () => {
    expect(RECORDS_EXPLORER_STYLES).toContain(
      '.records-explorer button{box-sizing:border-box;min-height:36px',
    );
    expect(RECORDS_EXPLORER_STYLES).toContain(
      '.records-explorer summary{box-sizing:border-box;min-height:36px',
    );
    expect(RECORDS_EXPLORER_STYLES).toContain(
      '.records-explorer input{box-sizing:border-box;min-height:38px',
    );
    expect(RECORDS_EXPLORER_STYLES).toContain(
      'grid-template-columns:minmax(190px,260px) minmax(0,1fr)',
    );
    expect(RECORDS_EXPLORER_STYLES).toContain(
      '.records-layout>.records-content{min-width:0}',
    );
    expect(RECORDS_EXPLORER_STYLES).toContain(
      '.records-namespace strong,.records-namespace span,'
        + '.records-namespace small{overflow-wrap:anywhere}',
    );
    expect(RECORDS_EXPLORER_STYLES).toContain(
      '.records-detail pre{box-sizing:border-box;max-width:100%;min-width:0;overflow:auto',
    );
    expect(RECORDS_EXPLORER_STYLES).toContain(
      '.records-explorer .records-ref-link,'
        + '.records-explorer .records-ref-link:hover:not([aria-disabled=true])'
        + '{border:0;padding:0',
    );
    expect(RECORDS_EXPLORER_STYLES).toContain(
      '.records-detail header{display:flex;justify-content:space-between;'
        + 'align-items:flex-start',
    );
    expect(RECORDS_EXPLORER_STYLES).toContain(
      '.records-purge-confirm input{width:100%;max-width:360px;min-width:0}',
    );
    const html = renderRecordsExplorer(state());
    expect(html).toContain(
      '<section class="records-content" aria-label="Record contents">',
    );
    expect(html).not.toContain('<main>');
  });

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
    expect(html).toContain('data-recued-reference="action"');
    expect(html).toContain('data-recued-reference-id="job/job-0"');
    expect(html).toContain('aria-label="Open record job-1"');
    expect(html).not.toContain('<tr tabindex=');
    expect(html).toContain('1 pending');
    expect(html).toContain('1 dead-lettered');
  });

  it('links one roving kind tab stop to the selected records panel', () => {
    const html = renderRecordsExplorer(state({
      kinds: [
        { kind: 'invoice', rows: 2, payload_bytes: 84 },
        { kind: 'job', rows: 1, payload_bytes: 42 },
      ],
      selectedKind: 'job',
    }));
    const tab = (kind: string): string => {
      const marker = `data-records-kind="${kind}"`;
      const index = html.indexOf(marker);
      return html.slice(
        html.lastIndexOf('<button', index),
        html.indexOf('</button>', index),
      );
    };

    expect(tab('invoice')).toContain(
      'id="recued-records-kind-tab-invoice"',
    );
    expect(tab('invoice')).toContain(
      'aria-controls="recued-records-kind-panel"',
    );
    expect(tab('invoice')).toContain('aria-selected="false"');
    expect(tab('invoice')).toContain('tabindex="-1"');
    expect(tab('job')).toContain('aria-selected="true"');
    expect(tab('job')).toContain('tabindex="0"');
    expect(html).toMatch(
      new RegExp(
        `${RECORDS_KIND_PANEL_ATTR}=""\\s+`
          + 'id="recued-records-kind-panel"\\s+role="tabpanel"',
      ),
    );
    expect(html).toContain(
      'aria-labelledby="recued-records-kind-tab-job"',
    );
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
    const html = renderRecordsExplorer(state({
      detail: record,
      diagnostics,
      deletePending: true,
      deleting: true,
    }));
    expect(html).toContain('alice@example.test');
    expect(html).toContain('id="records-detail-title" tabindex="-1"');
    expect(html).toContain(
      'data-action="records-confirm-delete" aria-disabled="true" aria-busy="true"',
    );
    expect(html).toContain(
      'data-action="records-cancel-delete" aria-disabled="true"',
    );
    expect(html).toContain('Pack version 3 · revision 1');
    expect(html).toContain('1 incoming relationship will be checked');
    expect(html).toContain('Advanced raw-slot diagnostics');
    expect(html).toContain('&quot;dec1&quot;: &quot;90000&quot;');
    expect(html).toContain('job/job-2');
    expect(html).toContain('Export pack CSV');
  });

  it('keeps the initiating export focusable and marks sibling exports unavailable', () => {
    const html = renderRecordsExplorer(state({
      exporting: true,
      exportingAction: 'records-export-kind-csv',
    }));
    const initiatingStart = html.indexOf('data-action="records-export-kind-csv"');
    const initiating = html.slice(
      initiatingStart,
      html.indexOf('</button>', initiatingStart),
    );
    const siblingStart = html.indexOf('data-action="records-export-pack"');
    const sibling = html.slice(siblingStart, html.indexOf('</button>', siblingStart));
    expect(initiating).toContain('aria-disabled="true"');
    expect(initiating).toContain('aria-busy="true"');
    expect(initiating).toContain('Exporting…');
    expect(initiating).not.toContain(' disabled');
    expect(sibling).toContain('aria-disabled="true"');
    expect(sibling).not.toContain('aria-busy');
    expect(sibling).toContain('Export pack JSON');
  });

  it('keeps outbox refresh focusable while its read is pending', () => {
    const html = renderRecordsExplorer(state({
      outboxOpen: true,
      outboxRefreshing: true,
    }));
    const start = html.indexOf('data-action="records-refresh-outbox"');
    const button = html.slice(start, html.indexOf('</button>', start));
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain('Refreshing…');
    expect(button).not.toContain(' disabled');
  });

  it('identifies the exact pending Records namespace and kind without native disabling', () => {
    const namespaceHtml = renderRecordsExplorer(state({
      loadingNamespaceKey: 'publisher-b/same-board',
    }));
    const namespaceMarker = 'data-records-namespace="publisher-b/same-board"';
    const namespaceMarkerIndex = namespaceHtml.indexOf(namespaceMarker);
    const pendingNamespace = namespaceHtml.slice(
      namespaceHtml.lastIndexOf('<button', namespaceMarkerIndex),
      namespaceHtml.indexOf('</button>', namespaceMarkerIndex),
    );
    const selectedNamespaceMarker = 'data-records-namespace="publisher-a/same-board"';
    const selectedNamespaceMarkerIndex = namespaceHtml.indexOf(selectedNamespaceMarker);
    const selectedNamespace = namespaceHtml.slice(
      namespaceHtml.lastIndexOf('<button', selectedNamespaceMarkerIndex),
      namespaceHtml.indexOf('</button>', selectedNamespaceMarkerIndex),
    );
    expect(pendingNamespace).toContain('aria-disabled="true"');
    expect(pendingNamespace).toContain('aria-busy="true"');
    expect(pendingNamespace).not.toContain(' disabled');
    expect(selectedNamespace).toContain('aria-disabled="true"');
    expect(selectedNamespace).not.toContain('aria-busy');

    const kindHtml = renderRecordsExplorer(state({ loadingKind: 'job' }));
    const kindMarker = 'data-records-kind="job"';
    const kindMarkerIndex = kindHtml.indexOf(kindMarker);
    const pendingKind = kindHtml.slice(
      kindHtml.lastIndexOf('<button', kindMarkerIndex),
      kindHtml.indexOf('</button>', kindMarkerIndex),
    );
    expect(pendingKind).toContain('aria-disabled="true"');
    expect(pendingKind).toContain('aria-busy="true"');
    expect(pendingKind).not.toContain(' disabled');
  });

  it('preserves an orphaned-namespace purge confirmation while busy', () => {
    const orphaned: RecordsNamespaceView = {
      ...namespace('publisher-a'),
      state: {
        state: 'orphaned',
        last_version: 3,
        storage_schema_hash: 'a'.repeat(64),
        declaration_hash: 'b'.repeat(64),
      },
    };
    const html = renderRecordsExplorer(state({
      namespaces: [orphaned],
      selectedNamespace: orphaned,
      purgePending: true,
      purgeConfirmation: 'publisher-a/same-board',
      purging: true,
    }));
    const inputStart = html.indexOf('data-records-purge-confirmation');
    const input = html.slice(inputStart, html.indexOf('>', inputStart));
    const buttonStart = html.indexOf('data-action="records-confirm-purge"');
    const button = html.slice(buttonStart, html.indexOf('</button>', buttonStart));
    expect(input).toContain('value="publisher-a/same-board"');
    expect(input).toContain('readonly');
    expect(input).toContain('aria-disabled="true"');
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain('Purging…');
    expect(button).not.toContain(' disabled');
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

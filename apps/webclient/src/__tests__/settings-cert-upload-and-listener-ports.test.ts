/** Two gaps in the Settings → Server surfaces, closed together because they
 *  are the two halves of one dead end.
 *
 *  A user who picked cert source "Upload my own certificate" in the Hostnames
 *  panel could not upload a certificate anywhere in the webclient: the
 *  `tls_domain.upload` dispatch builders shipped with ZERO production callers
 *  and no mount, so the row could never serve TLS (`selectSniCertChain` fails
 *  `tls_domain_unknown` without a `byo_upload` row) and could never be
 *  verified either (`cert_proof` asserts a live handshake served a matching
 *  cert). Separately, `listener_ports` was accepted by `collection.hostname.*`
 *  and rendered read-only on the row, but neither form had a control — so the
 *  four-member closed list was unreachable and the `[443]` default was applied
 *  silently rather than shown.
 *
 *  Two properties are load-bearing here and neither is a shape check:
 *    - an EMPTY port selection must be refused CLIENT-side, because
 *      `normalizePorts` swaps in `[443]` rather than erroring — a form that
 *      submitted it would report success having saved something the user
 *      never chose.
 *    - the upload's `source` must be `byo_upload` and must not be a field:
 *      the other two members mean "the fleet issued and renews this", and a
 *      hand-uploaded cert filed under one is a cert nobody can renew. */

import { describe, expect, it, vi } from 'vitest';

import {
  HOSTNAMES_ADD_FIELD_ATTR,
  HOSTNAMES_ADD_OPEN_BTN_ATTR,
  HOSTNAMES_ADD_SUBMIT_BTN_ATTR,
  HOSTNAMES_PANEL_ERROR_ATTR,
  HOSTNAMES_PORTS_FIELDSET_ATTR,
  HOSTNAMES_ROW_NEEDS_CERT_ATTR,
  HOSTNAMES_UPDATE_FIELD_ATTR,
  mountHostnamesPanel,
  portFieldName,
  type HostnamesAddCaller,
  type HostnamesListCaller,
  type HostnamesUpdateCaller,
} from '../settings/hostnames.js';
import {
  TLS_CERTS_EMPTY_ATTR,
  TLS_CERTS_ERROR_ATTR,
  TLS_CERTS_ISSUE_ATTR,
  TLS_CERTS_RESULT_ATTR,
  TLS_CERTS_ROW_ATTR,
  TLS_CERTS_UPLOAD_FIELD_ATTR,
  TLS_CERTS_UPLOAD_FILE_ATTR,
  TLS_CERTS_UPLOAD_FORM_ATTR,
  TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR,
  TLS_UPLOAD_ISSUE_COPY,
  extractUploadIssues,
  mountTlsCertificatesPanel,
  type TlsDomainListCaller,
  type TlsDomainRemoveCaller,
  type TlsDomainUploadCaller,
  type TlsCertificatesUploadFormValues,
} from '../settings/tls-certificates.js';
import type {
  HostnameAddRequest,
  HostnameListResponse,
  HostnameProjection,
  HostnameUpdateRequest,
  TLSDomainCertListEntry,
} from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM — same shape as the sibling panel tests, plus the fields the
// controls under test actually read (`checked`, `value`, `files`).
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  checked: boolean;
  className: string;
  type: string;
  value: string;
  rows: number;
  placeholder: string;
  children: FakeElement[];
  parent: FakeElement | null;
  readonly parentNode: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
  fire(name: string): void;
  focus(): void;
  contains(node: FakeElement | null): boolean;
}

interface FakeFocusDocument { activeElement: FakeElement | null }

const makeFakeElement = (tagName: string, doc?: FakeFocusDocument): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    checked: false,
    className: '',
    type: '',
    value: '',
    rows: 0,
    placeholder: '',
    children,
    parent: null,
    get parentNode() { return el.parent; },
    attrs,
    listeners,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => { attrs.delete(k); },
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      if (doc && target.contains(doc.activeElement)) doc.activeElement = null;
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click: () => {
      for (const fn of listeners.get('click') ?? []) fn({ target: el });
    },
    fire: (name) => {
      for (const fn of listeners.get(name) ?? []) fn({ target: el });
    },
    focus: () => { if (doc !== undefined) doc.activeElement = el; },
    contains: (node) => node === el || children.some(child => child.contains(node)),
  };
  return el;
};

const makeFakeDocument = () => {
  const doc: FakeFocusDocument & { createElement(tag: string): FakeElement } = {
    activeElement: null,
    createElement: (tag) => makeFakeElement(tag, doc),
  };
  return doc;
};

const findByAttrValue = (
  root: FakeElement,
  attr: string,
  value?: string,
): FakeElement | null => {
  if (root.hasAttribute(attr) && (value === undefined || root.getAttribute(attr) === value)) {
    return root;
  }
  for (const c of root.children) {
    const hit = findByAttrValue(c, attr, value);
    if (hit) return hit;
  }
  return null;
};

const findAllByAttr = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  if (root.hasAttribute(attr)) out.push(root);
  for (const c of root.children) out.push(...findAllByAttr(c, attr));
  return out;
};

/** Toggle a port checkbox the way a user would: flip `checked`, then fire
 *  `change`. Going through the DOM rather than `setAddField` is deliberate —
 *  the rebuild-from-the-contract-list logic lives in the change handler, and a
 *  test that called the setter would never execute it. */
const togglePort = (root: FakeElement, attr: string, port: number, on: boolean): void => {
  const box = findByAttrValue(root, attr, portFieldName(port as 443));
  if (box === null) throw new Error(`no port checkbox for ${port}`);
  box.checked = on;
  box.fire('change');
};

const setText = (root: FakeElement, attr: string, field: string, value: string): void => {
  const input = findByAttrValue(root, attr, field);
  if (input === null) throw new Error(`no field ${field}`);
  input.value = value;
  input.fire('input');
};

// ──────────────────────────────────────────────────────────────────
// Listener ports — Hostnames panel
// ──────────────────────────────────────────────────────────────────

const hostnameRow = (overrides: Partial<HostnameProjection> = {}): HostnameProjection => ({
  hostname_id: 'h-1',
  hostname: 'example.com',
  cert_source: 'byo_external',
  ownership_status: 'verified',
  listener_ports: [443],
  ddns_managed: false,
  enabled: true,
  tls_topology: 'server_terminated',
  ...overrides,
});

const unusedCaller = (): never => {
  throw new Error('caller not expected in this path');
};

const mountHostnames = async (args: {
  rows?: HostnameProjection[];
  runAdd?: HostnamesAddCaller;
  runUpdate?: HostnamesUpdateCaller;
}) => {
  const rows = args.rows ?? [];
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const runList: HostnamesListCaller = async (): Promise<HostnameListResponse> => ({
    hostnames: rows,
  });
  const mount = mountHostnamesPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList,
    runGet: unusedCaller as never,
    runAdd: (args.runAdd ?? (unusedCaller as never)) as HostnamesAddCaller,
    runUpdate: (args.runUpdate ?? (unusedCaller as never)) as HostnamesUpdateCaller,
    runRemove: unusedCaller as never,
    runVerifyOwnership: unusedCaller as never,
  });
  await mount.whenLoaded();
  return { host, mount, doc };
};

describe('Hostnames — listener ports control', () => {
  for (const mode of ['add', 'update'] as const) {
    it.each(['listener_port_8446', 'method', 'cert_source'] as const)(
      `returns ${mode} focus to the changed %s control after redrawing its dependent fields`,
      async (field) => {
        const { host, mount, doc } = await mountHostnames({ rows: [hostnameRow()] });
        if (mode === 'add') mount.openAdd(); else mount.openUpdate('example.com');
        const attr = mode === 'add' ? HOSTNAMES_ADD_FIELD_ATTR : HOSTNAMES_UPDATE_FIELD_ATTR;
        setText(host, attr, 'verification_token_hash', 'synthetic-proof-draft');
        const input = findByAttrValue(host, attr, field)!;
        input.focus();
        if (field === 'listener_port_8446') input.checked = true;
        else input.value = field === 'method' ? 'http_token' : 'byo_uploaded';
        input.fire('change');

        const current = findByAttrValue(host, attr, field)!;
        expect(doc.activeElement).toBe(current);
        expect(mount.getState()[mode].values.verification_token_hash).toBe('synthetic-proof-draft');
        if (field === 'listener_port_8446') {
          expect(mount.getState()[mode].values.listener_ports).toEqual([443, 8446]);
          current.checked = false;
          current.fire('change');
          expect(doc.activeElement).toBe(findByAttrValue(host, attr, field));
          expect(mount.getState()[mode].values.listener_ports).toEqual([443]);
        } else if (field === 'cert_source') {
          expect(mount.getState()[mode].values.verification_method).toBe('cert_proof');
          expect(findByAttrValue(host, attr, 'verification_token_hash')).toBeNull();
        } else {
          expect(mount.getState()[mode].values.verification_method).toBe('http_token');
          expect(findByAttrValue(host, attr, 'verification_token_hash')?.value).toBe('synthetic-proof-draft');
        }
      },
    );

    it(`leaves outside focus alone when an unfocused ${mode} choice changes`, async () => {
      const { host, mount, doc } = await mountHostnames({ rows: [hostnameRow()] });
      if (mode === 'add') mount.openAdd(); else mount.openUpdate('example.com');
      const attr = mode === 'add' ? HOSTNAMES_ADD_FIELD_ATTR : HOSTNAMES_UPDATE_FIELD_ATTR;
      const outside = doc.createElement('button');
      outside.focus();
      for (const field of ['listener_port_8446', 'method', 'cert_source']) {
        const input = findByAttrValue(host, attr, field)!;
        if (field === 'listener_port_8446') input.checked = true;
        else input.value = field === 'method' ? 'http_token' : 'byo_uploaded';
        input.fire('change');
        expect(doc.activeElement).toBe(outside);
      }
    });
  }

  it('the add form renders one checkbox per contract port, 443 pre-checked', async () => {
    const { host, mount } = await mountHostnames({});
    mount.openAdd();

    const fieldset = findByAttrValue(host, HOSTNAMES_PORTS_FIELDSET_ATTR, 'add');
    expect(fieldset).not.toBeNull();

    for (const [port, expected] of [
      [443, true],
      [8446, false],
      [8447, false],
      [8448, false],
    ] as const) {
      const box = findByAttrValue(host, HOSTNAMES_ADD_FIELD_ATTR, portFieldName(port));
      expect(box, `checkbox for ${port}`).not.toBeNull();
      expect(box!.checked, `checked state for ${port}`).toBe(expected);
    }
  });

  it('add SENDS listener_ports rather than leaving the server to default it', async () => {
    const runAdd = vi.fn(async (_req: HostnameAddRequest) => ({
      hostname: hostnameRow({ hostname: 'a.example.com' }),
    }));
    const { host, mount } = await mountHostnames({ runAdd });
    mount.openAdd();
    setText(host, HOSTNAMES_ADD_FIELD_ATTR, 'hostname', 'a.example.com');
    setText(host, HOSTNAMES_ADD_FIELD_ATTR, 'verification_token_hash', 'abc123');
    await mount.submitAdd();

    expect(runAdd).toHaveBeenCalledTimes(1);
    expect(runAdd.mock.calls[0]![0]!.listener_ports).toEqual([443]);
  });

  it('an alternate port is reachable and arrives in contract order', async () => {
    const runAdd = vi.fn(async (_req: HostnameAddRequest) => ({
      hostname: hostnameRow({ hostname: 'a.example.com' }),
    }));
    const { host, mount } = await mountHostnames({ runAdd });
    mount.openAdd();
    setText(host, HOSTNAMES_ADD_FIELD_ATTR, 'hostname', 'a.example.com');
    setText(host, HOSTNAMES_ADD_FIELD_ATTR, 'verification_token_hash', 'abc123');
    // Check the LAST port first, then an earlier one — the request must still
    // come out in `HOSTNAME_LISTENER_PORTS` order, not click order.
    togglePort(host, HOSTNAMES_ADD_FIELD_ATTR, 8448, true);
    togglePort(host, HOSTNAMES_ADD_FIELD_ATTR, 8446, true);
    await mount.submitAdd();

    expect(runAdd.mock.calls[0]![0]!.listener_ports).toEqual([443, 8446, 8448]);
  });

  it('⛔ clearing every port BLOCKS submit — the server would have silently saved 443', async () => {
    const runAdd = vi.fn(async (_req: HostnameAddRequest) => ({
      hostname: hostnameRow(),
    }));
    const { host, mount } = await mountHostnames({ runAdd });
    mount.openAdd();
    setText(host, HOSTNAMES_ADD_FIELD_ATTR, 'hostname', 'a.example.com');
    setText(host, HOSTNAMES_ADD_FIELD_ATTR, 'verification_token_hash', 'abc123');
    togglePort(host, HOSTNAMES_ADD_FIELD_ATTR, 443, false);
    await mount.submitAdd();

    expect(runAdd).not.toHaveBeenCalled();
    expect(mount.getState().add.error).toBe('Pick at least one port.');
    const err = findByAttrValue(host, HOSTNAMES_PANEL_ERROR_ATTR);
    expect(err?.textContent).toBe('Pick at least one port.');
    // Still open, so the user can fix it rather than losing the form.
    expect(mount.getState().add.open).toBe(true);
  });

  it('the update form seeds from the ROW, not from the 443 default', async () => {
    const { host, mount } = await mountHostnames({
      rows: [hostnameRow({ listener_ports: [8447] })],
    });
    mount.openUpdate('example.com');

    expect(mount.getState().update.values.listener_ports).toEqual([8447]);
    const p443 = findByAttrValue(host, HOSTNAMES_UPDATE_FIELD_ATTR, portFieldName(443));
    const p8447 = findByAttrValue(host, HOSTNAMES_UPDATE_FIELD_ATTR, portFieldName(8447));
    expect(p443?.checked).toBe(false);
    expect(p8447?.checked).toBe(true);
  });

  it('update sends listener_ports only when they CHANGED', async () => {
    const runUpdate = vi.fn(async (_req: HostnameUpdateRequest) => ({
      hostname: hostnameRow({ listener_ports: [443, 8446] }),
    }));
    const { host, mount } = await mountHostnames({
      rows: [hostnameRow({ listener_ports: [443] })],
      runUpdate,
    });

    // No-op save: nothing touched ⇒ no request at all.
    mount.openUpdate('example.com');
    await mount.submitUpdate();
    expect(runUpdate).not.toHaveBeenCalled();

    // Now change the ports ⇒ the diff carries them.
    mount.openUpdate('example.com');
    togglePort(host, HOSTNAMES_UPDATE_FIELD_ATTR, 8446, true);
    await mount.submitUpdate();
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(runUpdate.mock.calls[0]![0]!.listener_ports).toEqual([443, 8446]);
  });

  it('a byo_uploaded row with no cert says where the certificate goes', async () => {
    const { host } = await mountHostnames({
      rows: [hostnameRow({ cert_source: 'byo_uploaded' })],
    });
    const hint = findByAttrValue(host, HOSTNAMES_ROW_NEEDS_CERT_ATTR, 'example.com');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain('Certificates');
  });

  it('the same row STOPS saying it once a cert is installed', async () => {
    const { host } = await mountHostnames({
      rows: [hostnameRow({ cert_source: 'byo_uploaded', cert_fingerprint: 'ab12' })],
    });
    expect(findByAttrValue(host, HOSTNAMES_ROW_NEEDS_CERT_ATTR)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Certificate upload panel
// ──────────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const CERT_PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const KEY_PEM = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----';

const certEntry = (
  overrides: Partial<TLSDomainCertListEntry> = {},
): TLSDomainCertListEntry => ({
  domain: 'server.example.com',
  fingerprint: 'ab12cd34ef56789abcdef0123456789abcdef0123456789abcdef0123456789ab',
  expires_at: NOW + 90 * DAY,
  issuer: "Let's Encrypt",
  source: 'byo_upload',
  ...overrides,
});

const mountCerts = async (args: {
  entries?: TLSDomainCertListEntry[];
  runList?: TlsDomainListCaller;
  runUpload?: TlsDomainUploadCaller;
  runRemove?: TlsDomainRemoveCaller;
  onUploaded?: (domain: string, result: Awaited<ReturnType<TlsDomainUploadCaller>>) => void;
}) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const listed = [...(args.entries ?? [])];
  const runList: TlsDomainListCaller = async () => ({ entries: listed });
  const mount = mountTlsCertificatesPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList: args.runList ?? runList,
    runUpload: args.runUpload ?? (unusedCaller as never),
    ...(args.runRemove !== undefined ? { runRemove: args.runRemove } : {}),
    ...(args.onUploaded !== undefined ? { onUploaded: args.onUploaded } : {}),
    now: () => NOW,
  });
  await mount.whenLoaded();
  return { host, doc, mount, listed };
};

describe('Certificates — inventory read recovery', () => {
  const retryAttr = 'data-recued-tls-certs-read-retry';
  const headingAttr = 'data-recued-tls-certs-read-heading';
  const statusAttr = 'data-recued-tls-certs-status';
  const removedAttr = 'data-recued-tls-certs-removal-result';
  const retry = (host: FakeElement) => findByAttrValue(host, retryAttr)!;
  const deferred = () => {
    let resolve!: (result: { entries: TLSDomainCertListEntry[] }) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<{ entries: TLSDomainCertListEntry[] }>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };

  it('offers read Retry without claiming an empty inventory after initial failure', async () => {
    const { host, mount } = await mountCerts({ runList: async () => { throw new Error('Read unavailable'); } });
    expect(retry(host)?.textContent).toBe('Retry');
    expect(retry(host)?.getAttribute('aria-label')).toBe('Retry loading certificates');
    expect(findByAttrValue(host, TLS_CERTS_ERROR_ATTR)?.textContent).toContain('Could not load certificates.');
    expect(findByAttrValue(host, TLS_CERTS_EMPTY_ATTR)).toBeNull();
    expect(mount.getState().model).toBeNull();
  });

  for (const outcome of ['success', 'error'] as const) {
    for (const owner of ['retry', 'outside', 'blurred'] as const) {
      it(`Retry ${outcome} respects ${owner} focus and ignores duplicate/stale activation`, async () => {
        const pending = deferred();
        const runList = vi.fn<TlsDomainListCaller>()
          .mockRejectedValueOnce(new Error('Read unavailable')).mockReturnValueOnce(pending.promise);
        const { host, doc, mount } = await mountCerts({ runList });
        const oldRetry = retry(host);
        oldRetry.focus(); oldRetry.click();
        const completion = mount.whenLoaded();
        const loading = findByAttrValue(host, statusAttr)!;
        expect(doc.activeElement).toBe(loading);
        expect(loading.getAttribute('role')).toBe('status');
        expect(loading.getAttribute('aria-atomic')).toBe('true');
        expect(loading.getAttribute('tabindex')).toBe('-1');
        oldRetry.click(); oldRetry.click();
        expect(mount.refresh()).toBe(completion);
        expect(runList).toHaveBeenCalledTimes(2);
        const outside = doc.createElement('button');
        if (owner === 'outside') outside.focus();
        if (owner === 'blurred') doc.activeElement = null;
        if (outcome === 'success') pending.resolve({ entries: [] });
        else pending.reject(new Error('Read still unavailable'));
        await completion;
        expect(doc.activeElement).toBe(owner === 'outside' ? outside : owner === 'blurred' ? null
          : findByAttrValue(host, outcome === 'success' ? headingAttr : retryAttr));
        expect(findByAttrValue(host, TLS_CERTS_EMPTY_ATTR) !== null).toBe(outcome === 'success');
        oldRetry.click();
        expect(runList).toHaveBeenCalledTimes(2);
        expect(runList.mock.calls).toEqual([[], []]);
      });
    }

    it(`keeps a draft's controls, values and focus across Retry ${outcome}`, async () => {
      const pending = deferred();
      const runList = vi.fn<TlsDomainListCaller>()
        .mockRejectedValueOnce(new Error('Read unavailable')).mockReturnValueOnce(pending.promise);
      const runUpload = vi.fn<TlsDomainUploadCaller>();
      const { host, doc, mount } = await mountCerts({ runList, runUpload });
      mount.openUpload();
      const form = findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR);
      const fields = findAllByAttr(host, TLS_CERTS_UPLOAD_FIELD_ATTR);
      const files = findAllByAttr(host, TLS_CERTS_UPLOAD_FILE_ATTR);
      mount.setUploadField('domain', 'draft.example.test');
      mount.setUploadField('cert_pem', '-----BEGIN CERTIFICATE----- synthetic');
      mount.setUploadField('private_key_pem', '-----BEGIN PRIVATE KEY----- synthetic');
      mount.setUploadField('chain_pem', '-----BEGIN CERTIFICATE----- synthetic chain');
      retry(host).focus(); retry(host).click();
      await mount.submitUpload();
      expect(runUpload).not.toHaveBeenCalled();
      const key = findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, 'private_key_pem')!;
      key.focus(); key.value += ' edited'; key.fire('input');
      if (outcome === 'success') pending.resolve({ entries: [certEntry()] });
      else pending.reject(new Error('Read unavailable'));
      await mount.whenLoaded();
      expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR)).toBe(form);
      const currentFields = findAllByAttr(host, TLS_CERTS_UPLOAD_FIELD_ATTR);
      const currentFiles = findAllByAttr(host, TLS_CERTS_UPLOAD_FILE_ATTR);
      fields.forEach((field, i) => expect(currentFields[i]).toBe(field));
      files.forEach((file, i) => expect(currentFiles[i]).toBe(file));
      expect(doc.activeElement).toBe(key);
      expect(mount.getState().upload.values.private_key_pem).toBe(key.value);
      expect(mount.getState().upload.values.domain).toBe('draft.example.test');
      expect(runUpload).not.toHaveBeenCalled();
    });

    it(`ignores a late Retry ${outcome} after disposal`, async () => {
      const pending = deferred();
      const runList = vi.fn<TlsDomainListCaller>()
        .mockRejectedValueOnce(new Error('Read unavailable')).mockReturnValueOnce(pending.promise);
      const { host, doc, mount } = await mountCerts({ runList });
      const oldRetry = retry(host);
      oldRetry.focus(); oldRetry.click();
      const completion = mount.whenLoaded();
      mount.dispose();
      const outside = doc.createElement('button'); outside.focus();
      if (outcome === 'success') pending.resolve({ entries: [] });
      else pending.reject(new Error('Read unavailable'));
      await completion;
      oldRetry.click(); await mount.refresh();
      expect(host.children).toEqual([]);
      expect(doc.activeElement).toBe(outside);
      expect(runList).toHaveBeenCalledTimes(2);
    });
  }

  for (const removed of [true, false]) {
    it(`keeps removal acknowledgment (${removed}) separate from refresh failure`, async () => {
      const runList = vi.fn<TlsDomainListCaller>().mockResolvedValueOnce({ entries: [certEntry()] })
        .mockRejectedValueOnce(new Error('Refresh unavailable')).mockResolvedValueOnce({ entries: [] });
      const runRemove = vi.fn<TlsDomainRemoveCaller>().mockResolvedValue({ removed });
      const { host, mount } = await mountCerts({ runList, runRemove });
      mount.openRemove('server.example.com'); await mount.confirmRemove();
      expect(findByAttrValue(host, removedAttr)?.textContent).toContain(removed ? 'Certificate removed for server.example.com.' : 'No certificate is installed for server.example.com.');
      expect(findByAttrValue(host, TLS_CERTS_ERROR_ATTR)?.textContent).toContain('Could not refresh certificates.');
      expect(findAllByAttr(host, TLS_CERTS_ROW_ATTR)).toEqual([]);
      expect(findByAttrValue(host, TLS_CERTS_EMPTY_ATTR)).toBeNull();
      expect(mount.getState().remove.error).toBeNull();
      retry(host).click(); await mount.whenLoaded();
      expect(findByAttrValue(host, TLS_CERTS_EMPTY_ATTR)).not.toBeNull();
      expect(findByAttrValue(host, removedAttr)).not.toBeNull();
      expect(runRemove).toHaveBeenCalledExactlyOnceWith({ domain: 'server.example.com' });
    });
  }

  it('keeps upload success and drops the draft key when its refresh fails', async () => {
    const runList = vi.fn<TlsDomainListCaller>().mockResolvedValueOnce({ entries: [certEntry()] })
      .mockRejectedValueOnce(new Error('Refresh unavailable')).mockResolvedValueOnce({ entries: [] });
    const result = { fingerprint: 'synthetic replacement', expires_at: NOW + 90 * DAY, san: ['server.example.com'] };
    const runUpload = vi.fn<TlsDomainUploadCaller>().mockResolvedValue(result);
    const { host, mount } = await mountCerts({ runList, runUpload });
    mount.openUpload('server.example.com');
    mount.setUploadField('cert_pem', '-----BEGIN CERTIFICATE----- synthetic');
    mount.setUploadField('private_key_pem', '-----BEGIN PRIVATE KEY----- synthetic');
    await mount.submitUpload();
    expect(findByAttrValue(host, TLS_CERTS_RESULT_ATTR)).not.toBeNull();
    expect(findByAttrValue(host, TLS_CERTS_ERROR_ATTR)?.textContent).toContain('Could not refresh certificates.');
    expect(findAllByAttr(host, TLS_CERTS_ROW_ATTR)).toEqual([]);
    expect(mount.getState().upload.values.private_key_pem).toBe('');
    expect(mount.getState().upload.error).toBeNull();
    retry(host).click(); await mount.whenLoaded();
    expect(findByAttrValue(host, TLS_CERTS_RESULT_ATTR)).not.toBeNull();
    expect(runUpload).toHaveBeenCalledTimes(1);
  });

  for (const entries of [[], [certEntry()]]) {
    it(`qualifies a failed refresh of ${entries.length} previously loaded certificates`, async () => {
      const runList = vi.fn<TlsDomainListCaller>().mockResolvedValueOnce({ entries })
        .mockRejectedValueOnce(new Error('Refresh unavailable'));
      const { host, mount } = await mountCerts({ runList });
      mount.openUpload();
      const form = findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR);
      await mount.refresh();
      expect(findByAttrValue(host, TLS_CERTS_EMPTY_ATTR)).toBeNull();
      expect(findAllByAttr(host, TLS_CERTS_ROW_ATTR)).toHaveLength(entries.length);
      expect(findByAttrValue(host, 'data-recued-tls-certs-stale') !== null).toBe(entries.length > 0);
      expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR)).toBe(form);
      expect(retry(host)).not.toBeNull();
    });
  }
});

describe('Certificates — BYO upload panel', () => {
  it.each([
    ['domain', ' ', 'You need to give a name.'],
    ['cert_pem', 'not a certificate', 'Certificate must be a PEM block'],
    ['private_key_pem', '', 'Private key must be a PEM block'],
    ['chain_pem', 'not a chain', 'Issuer chain must be a PEM block'],
  ] as const)('links the local %s error and focuses only after submit', async (field, invalid, copy) => {
    const runUpload = vi.fn<TlsDomainUploadCaller>();
    const { host, doc, mount } = await mountCerts({ runUpload });
    mount.openUpload();
    const valid: TlsCertificatesUploadFormValues = {
      domain: 'server.example.com', cert_pem: CERT_PEM, private_key_pem: KEY_PEM, chain_pem: CERT_PEM,
    };
    for (const name of Object.keys(valid) as Array<keyof TlsCertificatesUploadFormValues>) {
      setText(host, TLS_CERTS_UPLOAD_FIELD_ATTR, name, name === field ? invalid : valid[name]);
    }
    const inputs = findAllByAttr(host, TLS_CERTS_UPLOAD_FIELD_ATTR);
    const files = findAllByAttr(host, TLS_CERTS_UPLOAD_FILE_ATTR);
    const input = findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, field)!;
    input.setAttribute('aria-describedby', 'field-help shared-help');
    expect(inputs.every(node => node.getAttribute('aria-invalid') === null)).toBe(true);
    await mount.submitUpload();
    const error = findByAttrValue(host, TLS_CERTS_ERROR_ATTR)!;
    const id = error.getAttribute('id')!;
    expect(error.textContent).toContain(copy);
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.parent).toBe(input.parent!.parent);
    expect(input.parent!.contains(error)).toBe(false); // Keep the label's name unchanged.
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(`field-help shared-help ${id}`);
    expect(doc.activeElement).toBe(input);
    for (const sibling of inputs.filter(node => node !== input)) expect(sibling.getAttribute('aria-invalid')).toBeNull();
    await mount.submitUpload();
    expect(findByAttrValue(host, TLS_CERTS_ERROR_ATTR)!.getAttribute('id')).toBe(id);
    expect(input.getAttribute('aria-describedby')).toBe(`field-help shared-help ${id}`);
    const outside = doc.createElement('button'); outside.focus();
    await mount.refresh();
    expect(doc.activeElement).toBe(outside);
    expect(input.getAttribute('aria-describedby')).toBe(`field-help shared-help ${id}`);
    input.focus(); input.value = valid[field]; input.fire('input');
    expect(doc.activeElement).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe('field-help shared-help');
    expect(findByAttrValue(host, TLS_CERTS_ERROR_ATTR)).toBeNull();
    expect(mount.getState().upload.error).toBeNull();
    for (const node of [...inputs, ...files]) expect(host.contains(node)).toBe(true);
    expect(runUpload).not.toHaveBeenCalled();
  });

  it.each(['generic', 'issues'] as const)('keeps a later %s server refusal separate from local field errors', async kind => {
    const error = Object.assign(new Error('Synthetic server refusal'), kind === 'issues'
      ? { details: { issues: [{ code: 'tls_san_mismatch' }] } } : {});
    const runUpload = vi.fn<TlsDomainUploadCaller>().mockRejectedValue(error);
    const { host, doc, mount } = await mountCerts({ runUpload });
    mount.openUpload(); await mount.submitUpload();
    mount.setUploadField('domain', 'server.example.com');
    mount.setUploadField('cert_pem', CERT_PEM); mount.setUploadField('private_key_pem', KEY_PEM);
    const outside = doc.createElement('button'); outside.focus();
    await mount.submitUpload();
    expect(doc.activeElement).toBe(outside);
    for (const input of findAllByAttr(host, TLS_CERTS_UPLOAD_FIELD_ATTR)) {
      expect(input.getAttribute('aria-invalid')).toBeNull();
      expect(input.getAttribute('aria-describedby')).toBeNull();
    }
    const message = findByAttrValue(host, kind === 'issues' ? TLS_CERTS_ISSUE_ATTR : TLS_CERTS_ERROR_ATTR)!;
    expect(message.parent!.className).toBe('tls-certs-upload-feedback');
    expect(runUpload).toHaveBeenCalledTimes(1);
  });

  it('keeps validation IDs distinct and retires associations on cancel, reopen and disposal', async () => {
    const first = await mountCerts({}), second = await mountCerts({});
    first.mount.openUpload(); second.mount.openUpload();
    await first.mount.submitUpload(); await second.mount.submitUpload();
    const oldInput = findByAttrValue(first.host, TLS_CERTS_UPLOAD_FIELD_ATTR, 'domain')!;
    const error = findByAttrValue(first.host, TLS_CERTS_ERROR_ATTR)!;
    expect(error.getAttribute('id')).not.toBe(findByAttrValue(second.host, TLS_CERTS_ERROR_ATTR)!.getAttribute('id'));
    first.mount.cancelUpload();
    expect(oldInput.getAttribute('aria-invalid')).toBeNull();
    expect(oldInput.getAttribute('aria-describedby')).toBeNull();
    expect(error.parent).toBeNull();
    first.mount.openUpload();
    expect(findByAttrValue(first.host, TLS_CERTS_UPLOAD_FIELD_ATTR, 'domain')!.getAttribute('aria-invalid')).toBeNull();
    expect(findByAttrValue(first.host, TLS_CERTS_ERROR_ATTR)).toBeNull();
    const secondInput = findByAttrValue(second.host, TLS_CERTS_UPLOAD_FIELD_ATTR, 'domain')!;
    second.mount.dispose();
    expect(secondInput.getAttribute('aria-invalid')).toBeNull();
    expect(secondInput.getAttribute('aria-describedby')).toBeNull();
    first.mount.dispose();
  });

  it.each(['domain', 'cert_pem', 'private_key_pem', 'chain_pem'] as const)(
    'keeps the %s control and its sibling fields mounted during consecutive input events',
    async (field) => {
      const { host, mount } = await mountCerts({});
      mount.openUpload();
      const form = findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR);
      const fields = findAllByAttr(host, TLS_CERTS_UPLOAD_FIELD_ATTR);
      const files = findAllByAttr(host, TLS_CERTS_UPLOAD_FILE_ATTR);
      const input = findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, field)!;

      input.value = 'a';
      input.fire('input');
      expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR)).toBe(form);
      for (const control of [...fields, ...files]) {
        const attr = control.hasAttribute(TLS_CERTS_UPLOAD_FIELD_ATTR)
          ? TLS_CERTS_UPLOAD_FIELD_ATTR : TLS_CERTS_UPLOAD_FILE_ATTR;
        expect(findByAttrValue(host, attr, control.getAttribute(attr)!)).toBe(control);
      }
      input.value += 'b';
      input.fire('input');
      expect(mount.getState().upload.values[field]).toBe('ab');
      expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, field)?.value).toBe('ab');
    },
  );

  it.each(['local', 'server'] as const)('clears %s validation feedback without replacing the corrected draft', async (kind) => {
    const runUpload = vi.fn(async () => {
      throw Object.assign(new Error('validation failed'), {
        details: { issues: [{ code: 'tls_san_mismatch' }, { code: 'tls_chain_invalid' }] },
      });
    });
    const { host, mount } = await mountCerts({ runUpload });
    mount.openUpload();
    if (kind === 'server') {
      mount.setUploadField('domain', 'server.example.com');
      mount.setUploadField('cert_pem', CERT_PEM);
      mount.setUploadField('private_key_pem', KEY_PEM);
    }
    await mount.submitUpload();
    expect(findAllByAttr(host, kind === 'local' ? TLS_CERTS_ERROR_ATTR : TLS_CERTS_ISSUE_ATTR)).not.toHaveLength(0);
    const input = findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, 'domain')!;
    input.value = 'edited.example.com';
    input.fire('input');

    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, 'domain')).toBe(input);
    expect(findAllByAttr(host, TLS_CERTS_ERROR_ATTR)).toHaveLength(0);
    expect(findAllByAttr(host, TLS_CERTS_ISSUE_ATTR)).toHaveLength(0);
    expect(mount.getState().upload.error).toBeNull();
    expect(mount.getState().upload.issues).toEqual([]);
    expect(mount.getState().upload.values.private_key_pem).toBe(kind === 'server' ? KEY_PEM : '');
    expect(runUpload).toHaveBeenCalledTimes(kind === 'server' ? 1 : 0);
  });

  it('updates the current mounted draft through the public setter after cancel and reopen', async () => {
    const { host, mount } = await mountCerts({});
    mount.openUpload();
    mount.setUploadField('private_key_pem', KEY_PEM);
    const oldInput = findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, 'private_key_pem')!;
    mount.cancelUpload();
    expect(mount.getState().upload.values.private_key_pem).toBe('');
    mount.openUpload();
    const input = findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, 'private_key_pem')!;
    expect(input.value).toBe('');
    mount.setUploadField('private_key_pem', 'replacement draft');

    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, 'private_key_pem')).toBe(input);
    expect(input.value).toBe('replacement draft');
    expect(oldInput.value).toBe(KEY_PEM);
  });

  it('renders the installed certs', async () => {
    const { host } = await mountCerts({
      entries: [certEntry(), certEntry({ domain: 'other.example.com' })],
    });
    expect(findAllByAttr(host, TLS_CERTS_ROW_ATTR)).toHaveLength(2);
    expect(findByAttrValue(host, TLS_CERTS_ROW_ATTR, 'server.example.com')).not.toBeNull();
  });

  it('an empty store points at the hostname source that needs a cert', async () => {
    const { host } = await mountCerts({ entries: [] });
    const empty = findByAttrValue(host, TLS_CERTS_EMPTY_ATTR);
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain('Upload my own certificate');
  });

  it('🔑 uploads under `byo_upload` — the source is pinned, not a field', async () => {
    const runUpload = vi.fn(async (_req: Parameters<TlsDomainUploadCaller>[0]) => ({
      fingerprint: 'ff00',
      expires_at: NOW + 60 * DAY,
      san: ['server.example.com'],
    }));
    const { mount } = await mountCerts({ entries: [], runUpload });

    mount.openUpload('server.example.com');
    mount.setUploadField('cert_pem', CERT_PEM);
    mount.setUploadField('private_key_pem', KEY_PEM);
    await mount.submitUpload();

    expect(runUpload).toHaveBeenCalledTimes(1);
    const sent = runUpload.mock.calls[0]![0]!;
    expect(sent.source).toBe('byo_upload');
    expect(sent.domain).toBe('server.example.com');
    expect(sent.cert_pem).toBe(CERT_PEM);
    expect(sent.private_key_pem).toBe(KEY_PEM);
    // Omitted, not sent empty — the handler rejects a non-PEM `chain_pem`.
    expect('chain_pem' in sent).toBe(false);
  });

  it('⛔ the DOM path works end to end — real inputs, real button, no mount API', async () => {
    // Every other upload test drives `mount.setUploadField` / `submitUpload`,
    // which would ALL still pass with the textarea's `input` listener or the
    // submit button's `click` listener severed. This one starts where the
    // value is actually born.
    // AWAIT THE CALL, not a wall-clock guess: the click handler discards the
    // promise, so an assertion racing a `whenLoaded()` could pass on timing
    // alone. Blocking on the caller means a severed listener HANGS this test
    // into a timeout instead of quietly succeeding.
    let sawUpload!: () => void;
    const uploadCalled = new Promise<void>((resolve) => { sawUpload = resolve; });
    const runUpload = vi.fn(async (_req: Parameters<TlsDomainUploadCaller>[0]) => {
      sawUpload();
      return {
        fingerprint: 'ff00',
        expires_at: NOW + 60 * DAY,
        san: ['server.example.com'],
      };
    });
    const { host, mount } = await mountCerts({ entries: [], runUpload });

    findByAttrValue(host, 'data-recued-tls-certs-upload-open')!.click();
    setText(host, 'data-recued-tls-certs-upload-field', 'domain', 'server.example.com');
    setText(host, 'data-recued-tls-certs-upload-field', 'cert_pem', CERT_PEM);
    setText(host, 'data-recued-tls-certs-upload-field', 'private_key_pem', KEY_PEM);
    findByAttrValue(host, 'data-recued-tls-certs-upload-submit')!.click();
    await uploadCalled;

    expect(runUpload).toHaveBeenCalledTimes(1);
    expect(runUpload.mock.calls[0]![0]).toMatchObject({
      domain: 'server.example.com',
      cert_pem: CERT_PEM,
      private_key_pem: KEY_PEM,
      source: 'byo_upload',
    });
  });

  it('drops the pasted private key from client state once the server has it', async () => {
    const runUpload = vi.fn(async () => ({
      fingerprint: 'ff00',
      expires_at: NOW + 60 * DAY,
      san: ['server.example.com'],
    }));
    const { host, mount } = await mountCerts({ entries: [], runUpload });

    mount.openUpload('server.example.com');
    mount.setUploadField('cert_pem', CERT_PEM);
    mount.setUploadField('private_key_pem', KEY_PEM);
    await mount.submitUpload();

    expect(mount.getState().upload.values.private_key_pem).toBe('');
    expect(mount.getState().upload.values.cert_pem).toBe('');
    expect(findByAttrValue(host, TLS_CERTS_RESULT_ATTR)).not.toBeNull();
  });

  it('refuses a non-PEM paste locally without a round trip', async () => {
    const runUpload = vi.fn(async () => ({ fingerprint: '', expires_at: 0, san: [] }));
    const { mount } = await mountCerts({ entries: [], runUpload });

    mount.openUpload('server.example.com');
    mount.setUploadField('cert_pem', 'not a certificate');
    mount.setUploadField('private_key_pem', KEY_PEM);
    await mount.submitUpload();

    expect(runUpload).not.toHaveBeenCalled();
    expect(mount.getState().upload.error).toContain('PEM block');
  });

  it('a missing hostname is refused before the cert checks', async () => {
    const runUpload = vi.fn(async () => ({ fingerprint: '', expires_at: 0, san: [] }));
    const { mount } = await mountCerts({ entries: [], runUpload });

    mount.openUpload();
    mount.setUploadField('cert_pem', CERT_PEM);
    mount.setUploadField('private_key_pem', KEY_PEM);
    await mount.submitUpload();

    expect(runUpload).not.toHaveBeenCalled();
    expect(mount.getState().upload.error).toBe('You need to give a name.');
  });

  it('surfaces the server\'s closed-list issues inline, one node per code', async () => {
    const err = Object.assign(new Error('tls_domain.upload: validation failed'), {
      code: 'tls_san_mismatch',
      details: {
        issues: [
          { code: 'tls_san_mismatch', san: ['other.example.com'], domain: 'server.example.com' },
          { code: 'tls_chain_invalid' },
        ],
      },
    });
    const runUpload = vi.fn(async () => {
      throw err;
    });
    const { host, mount } = await mountCerts({ entries: [], runUpload: runUpload as never });

    mount.openUpload('server.example.com');
    mount.setUploadField('cert_pem', CERT_PEM);
    mount.setUploadField('private_key_pem', KEY_PEM);
    await mount.submitUpload();

    const issues = findAllByAttr(host, TLS_CERTS_ISSUE_ATTR);
    expect(issues.map((n) => n.getAttribute(TLS_CERTS_ISSUE_ATTR))).toEqual([
      'tls_san_mismatch',
      'tls_chain_invalid',
    ]);
    expect(issues[0]!.textContent).toBe(TLS_UPLOAD_ISSUE_COPY.tls_san_mismatch);
    // The inline lines ARE the message — no humanized duplicate above them.
    expect(findByAttrValue(host, TLS_CERTS_ERROR_ATTR)).toBeNull();
    // The form stays open with the values intact so the user can re-pick.
    expect(mount.getState().upload.open).toBe(true);
  });

  it('falls back to a humanized message when the error carries no issues', async () => {
    const runUpload = vi.fn(async () => {
      throw new Error('boom');
    });
    const { host, mount } = await mountCerts({ entries: [], runUpload: runUpload as never });

    mount.openUpload('server.example.com');
    mount.setUploadField('cert_pem', CERT_PEM);
    mount.setUploadField('private_key_pem', KEY_PEM);
    await mount.submitUpload();

    expect(findAllByAttr(host, TLS_CERTS_ISSUE_ATTR)).toHaveLength(0);
    expect(mount.getState().upload.error).not.toBeNull();
  });

  it('removes a cert through the confirm step', async () => {
    const runRemove = vi.fn(async (_req: { domain: string }) => ({ removed: true }));
    const { mount } = await mountCerts({ entries: [certEntry()], runRemove });

    mount.openRemove('server.example.com');
    expect(mount.getState().remove.domain).toBe('server.example.com');
    await mount.confirmRemove();

    expect(runRemove).toHaveBeenCalledWith({ domain: 'server.example.com' });
    expect(mount.getState().remove.domain).toBeNull();
  });

  it('renders no Remove action when the host wired no remove caller', async () => {
    const { host } = await mountCerts({ entries: [certEntry()] });
    expect(findByAttrValue(host, 'data-recued-tls-certs-remove-open')).toBeNull();
  });
});

describe('extractUploadIssues', () => {
  it('maps known codes through the shared copy table', () => {
    const out = extractUploadIssues({
      details: { issues: [{ code: 'tls_key_pair_mismatch' }] },
    });
    expect(out).toEqual([
      { code: 'tls_key_pair_mismatch', copy: TLS_UPLOAD_ISSUE_COPY.tls_key_pair_mismatch },
    ]);
  });

  it('drops codes it has no copy for rather than rendering a blank line', () => {
    const out = extractUploadIssues({
      details: { issues: [{ code: 'tls_some_future_gate' }, { code: 'tls_chain_invalid' }] },
    });
    expect(out.map((i) => i.code)).toEqual(['tls_chain_invalid']);
  });

  it('returns [] for anything that is not an issue array', () => {
    expect(extractUploadIssues(undefined)).toEqual([]);
    expect(extractUploadIssues(null)).toEqual([]);
    expect(extractUploadIssues(new Error('plain'))).toEqual([]);
    expect(extractUploadIssues({ details: null })).toEqual([]);
    expect(extractUploadIssues({ details: { issues: 'nope' } })).toEqual([]);
    expect(extractUploadIssues({ details: { issues: [null, 7, 'x'] } })).toEqual([]);
  });
});

describe('Certificates — pending upload drafts', () => {
  type UploadResult = Awaited<ReturnType<TlsDomainUploadCaller>>;
  const result: UploadResult = { fingerprint: 'synthetic', expires_at: NOW + 60 * DAY, san: ['server.example.com'] };
  const values: TlsCertificatesUploadFormValues = { domain: 'server.example.com', cert_pem: CERT_PEM, private_key_pem: KEY_PEM, chain_pem: '' };
  const deferredUpload = () => {
    let resolve!: (result: UploadResult) => void, reject!: (error: Error) => void;
    const promise = new Promise<UploadResult>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const fill = (mount: ReturnType<typeof mountTlsCertificatesPanel>, draft = values) => {
    for (const field of Object.keys(draft) as Array<keyof TlsCertificatesUploadFormValues>) mount.setUploadField(field, draft[field]);
  };

  for (const outcome of ['success', 'failure'] as const) {
    it.each(['domain', 'cert_pem', 'private_key_pem', 'chain_pem'] as const)(`keeps a newer %s draft after ${outcome} without another upload`, async field => {
      const gate = deferredUpload(), runUpload = vi.fn<TlsDomainUploadCaller>().mockReturnValue(gate.promise);
      const runList = vi.fn<TlsDomainListCaller>().mockResolvedValue({ entries: [] }), onUploaded = vi.fn();
      const { host, doc, mount } = await mountCerts({ runUpload, runList, onUploaded });
      mount.openUpload(); fill(mount);
      const form = findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR);
      const input = findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, field)!;
      const files = findAllByAttr(host, TLS_CERTS_UPLOAD_FILE_ATTR);
      const pending = mount.submitUpload();
      const next = field === 'domain' ? 'newer.example.com' : `newer ${field} draft`;
      input.focus(); input.value = next; input.fire('input');
      if (outcome === 'success') gate.resolve(result); else gate.reject(new Error('Synthetic upload failure'));
      await pending;
      expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR)).toBe(form);
      expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, field)).toBe(input);
      expect(input.value).toBe(next); expect(doc.activeElement).toBe(input);
      expect(mount.getState().upload.values).toEqual({ ...values, [field]: next });
      expect(mount.getState().upload.open).toBe(true); expect(mount.getState().upload.saving).toBe(false);
      expect(mount.hasUnsavedChanges()).toBe(true); expect(mount.hasInFlightWork()).toBe(false);
      for (const file of files) expect(host.contains(file)).toBe(true);
      const status = findByAttrValue(host, TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR)!;
      expect(status.textContent).toContain('server.example.com');
      expect(status.textContent).toContain('Your newer edits still need uploading.');
      expect(status.getAttribute('role')).toBe('status');
      if (field === 'domain') expect(status.textContent).not.toContain(next);
      expect(runUpload).toHaveBeenCalledExactlyOnceWith({ domain: values.domain, cert_pem: values.cert_pem, private_key_pem: values.private_key_pem, source: 'byo_upload' });
      expect(runList).toHaveBeenCalledTimes(outcome === 'success' ? 2 : 1);
      if (outcome === 'success') {
        expect(onUploaded).toHaveBeenCalledExactlyOnceWith(values.domain, result);
        expect(mount.getState().upload.result).toBe(result);
      } else {
        expect(onUploaded).not.toHaveBeenCalled();
        expect(mount.getState().upload.error).toContain('Synthetic upload failure');
        mount.setUploadField(field, `${next} corrected`);
        expect(findByAttrValue(host, TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR)).toBeNull();
      }
      mount.dispose();
    });
  }

  it.each(['unchanged', 'equal setter', 'reverted edit'] as const)('closes and clears the completed %s draft', async kind => {
    const gate = deferredUpload(), runUpload = vi.fn<TlsDomainUploadCaller>().mockReturnValue(gate.promise);
    const { host, mount } = await mountCerts({ runUpload }); mount.openUpload(); fill(mount);
    const pending = mount.submitUpload();
    if (kind === 'equal setter') mount.setUploadField('private_key_pem', KEY_PEM);
    if (kind === 'reverted edit') { mount.setUploadField('private_key_pem', 'temporary'); mount.setUploadField('private_key_pem', KEY_PEM); }
    gate.resolve(result); await pending;
    expect(mount.getState().upload.open).toBe(false); expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR)).toBeNull();
    expect(mount.getState().upload.values).toEqual({ domain: '', cert_pem: '', private_key_pem: '', chain_pem: '' });
    expect(mount.hasUnsavedChanges()).toBe(false); expect(mount.hasInFlightWork()).toBe(false);
    expect(findByAttrValue(host, TLS_CERTS_RESULT_ATTR)).not.toBeNull();
    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR)).toBeNull();
    mount.dispose();
  });

  it('preserves a file-only change while the submitted text is unchanged', async () => {
    const gate = deferredUpload(), runUpload = vi.fn<TlsDomainUploadCaller>().mockReturnValue(gate.promise);
    const { host, mount } = await mountCerts({ runUpload }); mount.openUpload(); fill(mount);
    const file = findByAttrValue(host, TLS_CERTS_UPLOAD_FILE_ATTR, 'cert_pem')!;
    Object.assign(file, { files: { length: 1, 0: { name: 'previous.pem' } } });
    const pending = mount.submitUpload();
    Object.assign(file, { files: { length: 0 } }); file.fire('change');
    gate.resolve(result); await pending;
    expect(mount.getState().upload.values).toEqual(values); expect(mount.getState().upload.open).toBe(true);
    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FILE_ATTR, 'cert_pem')).toBe(file);
    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR)).not.toBeNull();
    expect(runUpload).toHaveBeenCalledTimes(1); mount.dispose();
  });

  it.each(['success', 'failure'] as const)('ignores a retired form\'s late %s while a newer upload is pending', async outcome => {
    const first = deferredUpload(), second = deferredUpload();
    const runUpload = vi.fn<TlsDomainUploadCaller>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const runList = vi.fn<TlsDomainListCaller>().mockResolvedValue({ entries: [] }), onUploaded = vi.fn();
    const { host, mount } = await mountCerts({ runUpload, runList, onUploaded });
    mount.openUpload(); fill(mount); const oldPending = mount.submitUpload();
    mount.cancelUpload(); mount.openUpload(); const newer = { ...values, domain: 'newer.example.com' }; fill(mount, newer);
    const form = findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR), newPending = mount.submitUpload();
    if (outcome === 'success') first.resolve(result); else first.reject(new Error('Retired failure'));
    await oldPending;
    expect(mount.getState().upload.values).toEqual(newer); expect(mount.getState().upload.saving).toBe(true);
    expect(mount.getState().upload.error).toBeNull(); expect(mount.getState().upload.result).toBeNull();
    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR)).toBe(form);
    expect(onUploaded).not.toHaveBeenCalled(); expect(runList).toHaveBeenCalledTimes(1);
    second.resolve(result); await newPending;
    expect(mount.getState().upload.open).toBe(false); expect(mount.getState().upload.values.private_key_pem).toBe('');
    expect(onUploaded).toHaveBeenCalledExactlyOnceWith(newer.domain, result);
    expect(runUpload).toHaveBeenCalledTimes(2); mount.dispose();
  });

  it.each(['success', 'failure'] as const)('ignores a disposed form\'s late %s', async outcome => {
    const gate = deferredUpload(), runUpload = vi.fn<TlsDomainUploadCaller>().mockReturnValue(gate.promise), onUploaded = vi.fn();
    const runList = vi.fn<TlsDomainListCaller>().mockResolvedValue({ entries: [] });
    const { host, mount } = await mountCerts({ runUpload, runList, onUploaded }); mount.openUpload(); fill(mount);
    const pending = mount.submitUpload(); mount.dispose();
    if (outcome === 'success') gate.resolve(result); else gate.reject(new Error('Disposed failure'));
    await pending; expect(host.children).toHaveLength(0); expect(onUploaded).not.toHaveBeenCalled();
    expect(runList).toHaveBeenCalledTimes(1); expect(mount.hasInFlightWork()).toBe(false);
  });

  it('requires a live upload form before starting a request', async () => {
    const runUpload = vi.fn<TlsDomainUploadCaller>(); const { mount } = await mountCerts({ runUpload });
    fill(mount); await mount.submitUpload(); expect(runUpload).not.toHaveBeenCalled();
    expect(mount.hasInFlightWork()).toBe(false); mount.dispose();
  });

  it('keeps newer values and the upload acknowledgment through a failed inventory refresh', async () => {
    const gate = deferredUpload(), runUpload = vi.fn<TlsDomainUploadCaller>().mockReturnValue(gate.promise);
    const runList = vi.fn<TlsDomainListCaller>().mockResolvedValueOnce({ entries: [] }).mockRejectedValueOnce(new Error('Refresh unavailable')).mockResolvedValueOnce({ entries: [] });
    const { host, mount } = await mountCerts({ runUpload, runList }); mount.openUpload(); fill(mount);
    const pending = mount.submitUpload(); mount.setUploadField('private_key_pem', 'newer key'); gate.resolve(result); await pending;
    const form = findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR);
    expect(mount.getState().error).toContain('Refresh unavailable'); expect(mount.getState().upload.values.private_key_pem).toBe('newer key');
    expect(findByAttrValue(host, TLS_CERTS_RESULT_ATTR)).not.toBeNull(); expect(mount.hasUnsavedChanges()).toBe(true);
    await mount.refresh(); expect(mount.getState().error).toBeNull();
    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR)).toBe(form); expect(mount.getState().upload.values.private_key_pem).toBe('newer key'); mount.dispose();
  });

  it('clears the earlier structured failure qualification before a later local validation error', async () => {
    const gate = deferredUpload(), runUpload = vi.fn<TlsDomainUploadCaller>().mockReturnValue(gate.promise);
    const { host, mount } = await mountCerts({ runUpload }); mount.openUpload(); fill(mount);
    const pending = mount.submitUpload(); mount.setUploadField('cert_pem', 'newer invalid draft');
    gate.reject(Object.assign(new Error('Synthetic refusal'), { details: { issues: [{ code: 'tls_san_mismatch' }] } })); await pending;
    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR)).not.toBeNull(); expect(findByAttrValue(host, TLS_CERTS_ISSUE_ATTR)).not.toBeNull();
    await mount.submitUpload();
    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR)).toBeNull(); expect(findByAttrValue(host, TLS_CERTS_ISSUE_ATTR)).toBeNull();
    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, 'cert_pem')!.getAttribute('aria-invalid')).toBe('true');
    expect(runUpload).toHaveBeenCalledTimes(1); mount.dispose();
  });
});

describe('Certificates — retained draft notices', () => {
  it.each(['before completion', 'after completion'] as const)('updates the retained completion notice when the draft is cleared %s', async when => {
    let resolve!: (result: Awaited<ReturnType<TlsDomainUploadCaller>>) => void;
    const promise = new Promise<Awaited<ReturnType<TlsDomainUploadCaller>>>(yes => { resolve = yes; });
    const runUpload = vi.fn<TlsDomainUploadCaller>().mockReturnValue(promise);
    const { host, doc, mount } = await mountCerts({ runUpload });
    mount.openUpload(); mount.setUploadField('domain', 'server.example.com'); mount.setUploadField('cert_pem', CERT_PEM); mount.setUploadField('private_key_pem', KEY_PEM);
    const form = findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR), input = findByAttrValue(host, TLS_CERTS_UPLOAD_FIELD_ATTR, 'private_key_pem')!;
    const clear = () => {
      for (const field of ['domain', 'cert_pem', 'private_key_pem', 'chain_pem'] as const) mount.setUploadField(field, '');
    };
    const pending = mount.submitUpload();
    if (when === 'before completion') clear(); else mount.setUploadField('private_key_pem', 'newer key');
    resolve({ fingerprint: 'synthetic', expires_at: NOW + DAY, san: ['server.example.com'] }); await pending;
    input.focus(); if (when === 'after completion') clear();
    expect(mount.hasUnsavedChanges()).toBe(false); expect(mount.getState().upload.open).toBe(true);
    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR)).toBeNull();
    const caption = findByAttrValue(host, TLS_CERTS_RESULT_ATTR)!.children[0]!;
    expect(caption.textContent).toBe('Certificate installed for server.example.com.');
    const file = findByAttrValue(host, TLS_CERTS_UPLOAD_FILE_ATTR, 'private_key_pem')!;
    Object.assign(file, { files: { length: 1, 0: { name: 'empty.pem' } } }); file.fire('change');
    expect(mount.hasUnsavedChanges()).toBe(true);
    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR)).toBe(caption);
    expect(caption.textContent).toContain('Your newer edits still need uploading.');
    Object.assign(file, { files: { length: 0 } }); file.fire('change');
    expect(mount.hasUnsavedChanges()).toBe(false); expect(findByAttrValue(host, TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR)).toBeNull();
    expect(caption.textContent).toBe('Certificate installed for server.example.com.');
    expect(findByAttrValue(host, TLS_CERTS_UPLOAD_FORM_ATTR)).toBe(form); expect(doc.activeElement).toBe(input);
    expect(runUpload).toHaveBeenCalledTimes(1); mount.dispose();
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  INSECURE_CONTEXT_SPLASH_MESSAGE,
  WEBCRYPTO_MISSING_SPLASH_MESSAGE,
  type SecureContextIssue,
} from './secure-context-guard.js';
import {
  SECURE_ACCESS_HANDOFF_ATTR,
  SECURE_ACCESS_HTTPS_FORM_ATTR,
  SECURE_ACCESS_HTTPS_INPUT_ATTR,
  SECURE_ACCESS_LOCAL_COPY_ATTR,
  SECURE_ACCESS_LOCAL_OPEN_ATTR,
  SECURE_ACCESS_LOCAL_URL_ATTR,
  SECURE_ACCESS_RELOAD_ATTR,
  SECURE_ACCESS_STATUS_ATTR,
  buildLocalhostAccessUrl,
  mountSecureAccessHandoff,
  replaceSecureAccessHistoryEntry,
  resolveSecureAccessUrl,
  type SecureAccessLocation,
} from './secure-access-handoff.js';
import {
  SECURE_ACCESS_RESUME_PARAM,
  SECURE_ACCESS_RESUME_VALUE,
} from './secure-access-resume.js';

const RESUME_QUERY =
  `${SECURE_ACCESS_RESUME_PARAM}=${SECURE_ACCESS_RESUME_VALUE}`;

const LOCATION: SecureAccessLocation = {
  protocol: 'http:',
  hostname: '192.168.1.42',
  port: '4319',
  pathname: '/webclient/',
  search: '?url=https%3A%2F%2Falice.recued.cloud&code=PAIR%201234',
  hash: '#chat/session/chat_1',
};

const INSECURE_ISSUE: SecureContextIssue = {
  kind: 'insecure_context',
  message: INSECURE_CONTEXT_SPLASH_MESSAGE,
};

interface FakeHandoffDom {
  readonly document: Document;
  readonly html: () => string;
  readonly localInput: HTMLInputElement;
  readonly httpsInput: HTMLInputElement;
  readonly status: HTMLElement;
  readonly titleFocus: ReturnType<typeof vi.fn>;
  readonly localFocus: ReturnType<typeof vi.fn>;
  readonly localSelect: ReturnType<typeof vi.fn>;
  readonly httpsFocus: ReturnType<typeof vi.fn>;
  readonly copyFocus: ReturnType<typeof vi.fn>;
  readonly execCommand: ReturnType<typeof vi.fn>;
  readonly fireClick: (attribute: string) => void;
  readonly fireSubmit: () => void;
  readonly fireInput: (attribute: string) => void;
}

const fakeHandoffDom = (): FakeHandoffDom => {
  let html = '';
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const titleFocus = vi.fn();
  const localFocus = vi.fn();
  const localSelect = vi.fn();
  const httpsFocus = vi.fn();
  const copyFocus = vi.fn();
  const execCommand = vi.fn(() => true);
  const statusClasses = new Set<string>();
  const statusAttributes = new Map<string, string>();

  const title = { focus: titleFocus } as unknown as HTMLElement;
  const localInput = {
    value: '',
    focus: localFocus,
    select: localSelect,
  } as unknown as HTMLInputElement;
  const httpsAttributes = new Map<string, string>();
  const httpsInput = {
    value: '',
    focus: httpsFocus,
    setAttribute: (name: string, value: string) => {
      httpsAttributes.set(name, value);
    },
    removeAttribute: (name: string) => {
      httpsAttributes.delete(name);
    },
    getAttribute: (name: string) => httpsAttributes.get(name) ?? null,
  } as unknown as HTMLInputElement;
  const copyButton = { focus: copyFocus } as unknown as HTMLButtonElement;
  const status = {
    textContent: '',
    classList: {
      toggle: (name: string, force?: boolean) => {
        if (force === false) statusClasses.delete(name);
        else statusClasses.add(name);
      },
      contains: (name: string) => statusClasses.has(name),
    },
    setAttribute: (name: string, value: string) => {
      statusAttributes.set(name, value);
    },
    getAttribute: (name: string) => statusAttributes.get(name) ?? null,
  } as unknown as HTMLElement;
  const splash = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    querySelector: (selector: string) => {
      if (selector === '#webclient-secure-access-title') return title;
      if (
        selector === `[${SECURE_ACCESS_LOCAL_URL_ATTR}]`
        && html.includes(SECURE_ACCESS_LOCAL_URL_ATTR)
      ) return localInput;
      if (
        selector === `[${SECURE_ACCESS_LOCAL_COPY_ATTR}]`
        && html.includes(SECURE_ACCESS_LOCAL_COPY_ATTR)
      ) return copyButton;
      if (
        selector === `[${SECURE_ACCESS_HTTPS_INPUT_ATTR}]`
        && html.includes(SECURE_ACCESS_HTTPS_INPUT_ATTR)
      ) return httpsInput;
      if (
        selector === `[${SECURE_ACCESS_STATUS_ATTR}]`
        && html.includes(SECURE_ACCESS_STATUS_ATTR)
      ) return status;
      return null;
    },
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const typeListeners = listeners.get(type) ?? new Set();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as HTMLElement;
  let styleNode: unknown = null;
  const document = {
    head: {
      querySelector: () => styleNode,
      appendChild: (node: unknown) => {
        styleNode = node;
        return node;
      },
    },
    createElement: () => ({
      setAttribute: vi.fn(),
      textContent: '',
    }),
    getElementById: (id: string) =>
      id === 'webclient-boot-splash-message' ? splash : null,
    execCommand,
  } as unknown as Document;

  const eventFor = (attribute: string): Event => ({
    target: {
      closest: (selector: string) =>
        selector === `[${attribute}]` ? {} : null,
    },
    preventDefault: vi.fn(),
  }) as unknown as Event;

  return {
    document,
    html: () => html,
    localInput,
    httpsInput,
    status,
    titleFocus,
    localFocus,
    localSelect,
    httpsFocus,
    copyFocus,
    execCommand,
    fireClick: (attribute) => {
      for (const listener of listeners.get('click') ?? []) {
        listener(eventFor(attribute));
      }
    },
    fireSubmit: () => {
      const event = eventFor(SECURE_ACCESS_HTTPS_FORM_ATTR);
      for (const listener of listeners.get('submit') ?? []) listener(event);
    },
    fireInput: (attribute) => {
      for (const listener of listeners.get('input') ?? []) {
        listener(eventFor(attribute));
      }
    },
  };
};

describe('secure access URL handoff', () => {
  it('replaces the blocked history entry instead of pushing another page', () => {
    const replace = vi.fn();
    const assign = vi.fn();
    const fakeLocation = { replace, assign };

    replaceSecureAccessHistoryEntry(
      'https://alice.recued.cloud/webclient/#chat',
      fakeLocation,
    );

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(
      'https://alice.recued.cloud/webclient/#chat',
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('builds an exact localhost URL without inventing HTTPS', () => {
    expect(buildLocalhostAccessUrl(LOCATION)).toBe(
      `http://localhost:4319/webclient/?url=https%3A%2F%2Falice.recued.cloud&code=PAIR%201234&${RESUME_QUERY}#chat/session/chat_1`,
    );
    expect(buildLocalhostAccessUrl({ ...LOCATION, protocol: 'https:' })).toBeNull();
    expect(buildLocalhostAccessUrl({ ...LOCATION, protocol: 'file:' })).toBeNull();
    expect(buildLocalhostAccessUrl({ ...LOCATION, port: '4319/path' })).toBeNull();
    for (const hostname of [
      'localhost',
      'LOCALHOST.',
      'recued.localhost',
      '127.0.0.1',
      '[::1]',
    ]) {
      expect(
        buildLocalhostAccessUrl({ ...LOCATION, hostname }),
        `expected ${hostname} not to produce a no-op localhost link`,
      ).toBeNull();
    }
  });

  it('validates a trusted HTTPS base and carries over path, pairing query, and hash', () => {
    expect(resolveSecureAccessUrl(
      ' https://alice.recued.cloud:8443/old?discard=1#discard ',
      LOCATION,
    )).toEqual({
      ok: true,
      url: `https://alice.recued.cloud:8443/webclient/?url=https%3A%2F%2Falice.recued.cloud&code=PAIR%201234&${RESUME_QUERY}#chat/session/chat_1`,
    });
    expect(resolveSecureAccessUrl('', LOCATION)).toMatchObject({ ok: false });
    expect(resolveSecureAccessUrl('alice.recued.cloud', LOCATION)).toMatchObject({
      ok: false,
    });
    expect(resolveSecureAccessUrl('http://alice.recued.cloud', LOCATION)).toEqual({
      ok: false,
      message: 'Use a trusted address that starts with https://.',
    });
    expect(resolveSecureAccessUrl(
      'https://alice:secret@recued.example',
      LOCATION,
    )).toMatchObject({ ok: false });
  });
});

describe('secure access handoff surface', () => {
  it('separates the same-computer and another-device paths and wires exact navigation', () => {
    const fake = fakeHandoffDom();
    const replaceLocation = vi.fn();
    const reload = vi.fn();
    const host = mountSecureAccessHandoff({
      issue: INSECURE_ISSUE,
      location: LOCATION,
      replaceLocation,
      onReload: reload,
      document: fake.document,
    });

    expect(fake.html()).toContain(SECURE_ACCESS_HANDOFF_ATTR);
    expect(fake.html()).toContain('On the server computer');
    expect(fake.html()).toContain('On this or another device');
    expect(fake.html()).toContain('localhost points to that device');
    expect(fake.html()).toContain('keep it private');
    expect(fake.html()).toContain('Back will skip this blocked address');
    expect(fake.html()).not.toContain('https://192.168.1.42');
    expect(fake.localInput.value).toBe(host.localUrl);
    expect(fake.titleFocus).toHaveBeenCalledOnce();

    fake.fireClick(SECURE_ACCESS_LOCAL_OPEN_ATTR);
    expect(replaceLocation).toHaveBeenLastCalledWith(host.localUrl);

    fake.httpsInput.value = 'https://alice.recued.cloud';
    fake.fireSubmit();
    expect(replaceLocation).toHaveBeenLastCalledWith(
      `https://alice.recued.cloud/webclient/?url=https%3A%2F%2Falice.recued.cloud&code=PAIR%201234&${RESUME_QUERY}#chat/session/chat_1`,
    );

    fake.fireClick(SECURE_ACCESS_RELOAD_ATTR);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('copies with an insecure-context-compatible fallback and leaves a manual selection when copy fails', async () => {
    const success = fakeHandoffDom();
    const copied = vi.fn(async () => true);
    const successHost = mountSecureAccessHandoff({
      issue: INSECURE_ISSUE,
      location: LOCATION,
      copyText: copied,
      document: success.document,
    });
    await successHost.copyLocalhost();
    expect(copied).toHaveBeenCalledWith(successHost.localUrl);
    expect(success.localSelect).toHaveBeenCalledOnce();
    expect(success.copyFocus).toHaveBeenCalledOnce();
    expect(success.status.textContent).toContain('Localhost link copied');
    expect(success.status.textContent).toContain('Keep it private');

    const fallback = fakeHandoffDom();
    fallback.execCommand.mockReturnValue(false);
    const fallbackHost = mountSecureAccessHandoff({
      issue: INSECURE_ISSUE,
      location: LOCATION,
      document: fallback.document,
    });
    await fallbackHost.copyLocalhost();
    expect(fallback.localFocus).toHaveBeenCalledOnce();
    expect(fallback.localSelect).toHaveBeenCalledOnce();
    expect(fallback.status.textContent).toContain('link is selected');
  });

  it('keeps an invalid or non-HTTPS address in place with an accessible error', () => {
    const fake = fakeHandoffDom();
    const replaceLocation = vi.fn();
    const host = mountSecureAccessHandoff({
      issue: INSECURE_ISSUE,
      location: LOCATION,
      replaceLocation,
      document: fake.document,
    });
    fake.httpsInput.value = 'http://alice.recued.cloud';
    host.openSecureAddress();

    expect(replaceLocation).not.toHaveBeenCalled();
    expect(fake.status.textContent).toBe(
      'Use a trusted address that starts with https://.',
    );
    expect(fake.status.getAttribute('role')).toBe('alert');
    expect(fake.status.classList.contains('is-error')).toBe(true);
    expect(fake.httpsInput.getAttribute('aria-invalid')).toBe('true');
    expect(fake.httpsInput.getAttribute('aria-errormessage')).toBe(
      'webclient-secure-access-status',
    );
    expect(fake.httpsFocus).toHaveBeenCalledOnce();

    fake.httpsInput.value = 'https://alice.recued.cloud';
    fake.fireInput(SECURE_ACCESS_HTTPS_INPUT_ATTR);
    expect(fake.httpsInput.getAttribute('aria-invalid')).toBeNull();
    expect(fake.httpsInput.getAttribute('aria-errormessage')).toBeNull();
    expect(fake.status.textContent).toBe('');
    host.openSecureAddress();
    expect(replaceLocation).toHaveBeenCalledOnce();
  });

  it('gives a secure-origin browser without Web Crypto a distinct update path', () => {
    const fake = fakeHandoffDom();
    const reload = vi.fn();
    const host = mountSecureAccessHandoff({
      issue: {
        kind: 'webcrypto_missing',
        message: WEBCRYPTO_MISSING_SPLASH_MESSAGE,
      },
      location: { ...LOCATION, protocol: 'https:' },
      onReload: reload,
      document: fake.document,
    });

    expect(host.localUrl).toBeNull();
    expect(fake.html()).toContain('Use a browser with Web Crypto');
    expect(fake.html()).not.toContain('Use the localhost link');
    host.reload();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not offer a broken localhost action for a non-HTTP origin', () => {
    const fake = fakeHandoffDom();
    const host = mountSecureAccessHandoff({
      issue: INSECURE_ISSUE,
      location: {
        ...LOCATION,
        protocol: 'file:',
        hostname: '',
        port: '',
      },
      document: fake.document,
    });

    expect(host.localUrl).toBeNull();
    expect(fake.html()).not.toContain(SECURE_ACCESS_LOCAL_OPEN_ATTR);
    expect(fake.html()).not.toContain('Use the localhost link');
    expect(fake.html()).toContain('from an address the browser does not trust');
    expect(fake.html()).toContain('Use a trusted HTTPS address');
  });
});

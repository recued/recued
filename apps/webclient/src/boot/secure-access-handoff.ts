/** Guided boot handoff from an insecure HTTP origin to a usable Recued URL.
 *
 * A LAN-IP HTTP page cannot use Web Crypto, so pairing and saved-browser
 * access must stop before boot. This surface gives the owner two honest paths:
 * use the exact localhost URL on the server computer, or enter a trusted HTTPS
 * base address for this or another device. Both paths retain the current path,
 * query (including a one-time pairing code), and hash return target, then let
 * the secure arrival reuse its own origin in the pairing form. The handoff
 * replaces the blocked entry instead of pushing a new one, so Back cannot
 * expose the insecure page or its still-unconsumed pairing query again. */

import type { SecureContextIssue } from './secure-context-guard.js';
import {
  isLoopbackHostname,
  markSecureAccessResume,
} from './secure-access-resume.js';

export const SECURE_ACCESS_HANDOFF_ATTR =
  'data-recued-secure-access-handoff';
export const SECURE_ACCESS_LOCAL_URL_ATTR =
  'data-recued-secure-access-local-url';
export const SECURE_ACCESS_LOCAL_OPEN_ATTR =
  'data-recued-secure-access-local-open';
export const SECURE_ACCESS_LOCAL_COPY_ATTR =
  'data-recued-secure-access-local-copy';
export const SECURE_ACCESS_HTTPS_FORM_ATTR =
  'data-recued-secure-access-https-form';
export const SECURE_ACCESS_HTTPS_INPUT_ATTR =
  'data-recued-secure-access-https-input';
export const SECURE_ACCESS_HTTPS_OPEN_ATTR =
  'data-recued-secure-access-https-open';
export const SECURE_ACCESS_RELOAD_ATTR =
  'data-recued-secure-access-reload';
export const SECURE_ACCESS_STATUS_ATTR =
  'data-recued-secure-access-status';

const TITLE_ID = 'webclient-secure-access-title';
const LOCAL_NOTE_ID = 'webclient-secure-access-local-note';
const HTTPS_NOTE_ID = 'webclient-secure-access-https-note';
const STATUS_ID = 'webclient-secure-access-status';
const STYLES_MARKER = 'data-recued-secure-access-styles';
const BOOT_SPLASH_MESSAGE_ID = 'webclient-boot-splash-message';

export interface SecureAccessLocation {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/** Replace only the origin host with localhost. Never manufacture an HTTPS
 * URL: changing the scheme cannot create a certificate or reverse proxy. */
export const buildLocalhostAccessUrl = (
  location: SecureAccessLocation,
): string | null => {
  if (
    location.protocol !== 'http:'
    || location.hostname.length === 0
    || isLoopbackHostname(location.hostname)
    || !/^\d*$/.test(location.port)
  ) {
    return null;
  }
  const port = location.port.length > 0 ? `:${location.port}` : '';
  const target = new URL(`http://localhost${port}`);
  target.pathname = location.pathname || '/';
  target.search = location.search;
  target.hash = location.hash;
  markSecureAccessResume(target);
  return target.toString();
};

export type SecureAccessUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly message: string };

/** Cross-origin secure access is a continuation of the current boot, not a
 * new page in the user's journey. Replace the blocked entry so Back returns to
 * the page before Recued instead of reopening HTTP with a pairing code. */
export const replaceSecureAccessHistoryEntry = (
  url: string,
  location: { replace?: (target: string) => void } | undefined =
    (globalThis as { location?: { replace?: (target: string) => void } })
      .location,
): void => {
  if (typeof location?.replace !== 'function') {
    throw new Error('browser replacement navigation is unavailable');
  }
  location.replace(url);
};

/** Validate an owner-supplied trusted base and carry the exact current page
 * over to it. Credentials are rejected so pairing details cannot be placed in
 * a confusing user-info URL. */
export const resolveSecureAccessUrl = (
  rawBaseAddress: string,
  location: SecureAccessLocation,
): SecureAccessUrlResult => {
  const trimmed = rawBaseAddress.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      message: 'Enter your trusted Recued HTTPS address first.',
    };
  }
  let target: URL;
  try {
    target = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message: 'Enter a complete address, such as https://recued.example.com.',
    };
  }
  if (target.protocol !== 'https:') {
    return {
      ok: false,
      message: 'Use a trusted address that starts with https://.',
    };
  }
  if (target.username.length > 0 || target.password.length > 0) {
    return {
      ok: false,
      message: 'Use a Recued HTTPS address without a username or password.',
    };
  }
  target.pathname = location.pathname || '/';
  target.search = location.search;
  target.hash = location.hash;
  markSecureAccessResume(target);
  return { ok: true, url: target.toString() };
};

const STYLES = `
#webclient-boot-splash {
  box-sizing: border-box;
  justify-content: flex-start;
  min-height: 100dvh;
  padding: 18px 0;
  overflow-y: auto;
}
.secure-access-handoff {
  box-sizing: border-box;
  width: min(720px, calc(100vw - 32px));
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 16px 40px color-mix(in srgb, var(--fg) 10%, transparent);
  text-align: left;
}
.secure-access-kicker,
.secure-access-choice-kicker {
  margin: 0 0 5px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.secure-access-handoff h2 {
  margin: 0;
  color: var(--fg);
  font-size: 22px;
  line-height: 1.2;
}
.secure-access-handoff h2:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 38%, transparent);
  outline-offset: 4px;
}
.secure-access-summary {
  margin: 10px 0 0;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.55;
}
.secure-access-safe {
  margin: 16px 0;
  padding: 12px 13px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  font-size: 12.5px;
  line-height: 1.5;
}
.secure-access-safe strong {
  display: block;
  margin-bottom: 3px;
  color: var(--fg);
}
.secure-access-choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.secure-access-choices.is-single {
  grid-template-columns: minmax(0, 1fr);
}
.secure-access-choice {
  min-width: 0;
  padding: 15px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 94%, var(--bg));
}
.secure-access-choice h3 {
  margin: 0;
  color: var(--fg);
  font-size: 15px;
  line-height: 1.35;
}
.secure-access-choice-copy,
.secure-access-note {
  margin: 7px 0 0;
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.5;
}
.secure-access-field-label {
  display: block;
  margin: 13px 0 6px;
  color: var(--fg);
  font-size: 12px;
  font-weight: 650;
}
.secure-access-handoff input {
  box-sizing: border-box;
  width: 100%;
  min-height: 42px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
}
.secure-access-handoff input[readonly] {
  color: var(--fg-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.secure-access-handoff input:focus-visible,
.secure-access-handoff button:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 38%, transparent);
  outline-offset: 2px;
}
.secure-access-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.secure-access-handoff button {
  min-height: 44px;
  border-radius: 8px;
  padding: 9px 12px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 650;
  cursor: pointer;
}
.secure-access-primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--on-accent, #fff);
}
.secure-access-secondary {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg-muted);
}
.secure-access-reload-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.45;
}
.secure-access-status {
  min-height: 18px;
  margin: 12px 0 0;
  color: var(--fg-muted);
  font-size: 12.5px;
  line-height: 1.45;
}
.secure-access-status.is-error {
  color: var(--danger, #b42318);
}
@media (max-width: 640px) {
  .secure-access-handoff { width: calc(100vw - 24px); }
  .secure-access-choices { grid-template-columns: 1fr; }
}
@media (max-width: 360px) {
  #webclient-boot-splash { padding: 10px 0; }
  .secure-access-handoff {
    width: calc(100vw - 16px);
    padding: 16px 14px;
  }
  .secure-access-choice { padding: 13px 12px; }
  .secure-access-actions,
  .secure-access-reload-row {
    align-items: stretch;
    flex-direction: column;
  }
  .secure-access-handoff button { width: 100%; }
}
`;

export interface MountedSecureAccessHandoff {
  readonly localUrl: string | null;
  readonly openLocalhost: () => void;
  readonly copyLocalhost: () => Promise<void>;
  readonly openSecureAddress: () => void;
  readonly reload: () => void;
  readonly dispose: () => void;
}

export interface MountSecureAccessHandoffOptions {
  readonly issue: SecureContextIssue;
  readonly location: SecureAccessLocation;
  /** Replacement-navigation seam for deterministic or embedded hosts. It must
   * replace the current entry rather than push another history entry. */
  readonly replaceLocation?: (url: string) => void;
  readonly onReload?: () => void;
  readonly copyText?: (text: string) => boolean | Promise<boolean>;
  readonly splashElement?: HTMLElement;
  readonly document?: Document;
}

const resolveDocument = (document?: Document): Document | undefined =>
  document ?? (globalThis as { document?: Document }).document;

const injectStyles = (document: Document): void => {
  if (document.head.querySelector(`[${STYLES_MARKER}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLES_MARKER, '');
  style.textContent = STYLES;
  document.head.appendChild(style);
};

const localhostChoiceMarkup = (): string => `
  <section class="secure-access-choice" aria-labelledby="webclient-secure-access-local-title">
    <p class="secure-access-choice-kicker">On the server computer</p>
    <h3 id="webclient-secure-access-local-title">Use the localhost link</h3>
    <p class="secure-access-choice-copy">If this browser is on the computer running Recued, localhost works securely without setting up HTTPS.</p>
    <label class="secure-access-field-label" for="webclient-secure-access-local-url">Exact link for that computer</label>
    <input id="webclient-secure-access-local-url" ${SECURE_ACCESS_LOCAL_URL_ATTR} readonly aria-describedby="${LOCAL_NOTE_ID}" />
    <div class="secure-access-actions">
      <button type="button" class="secure-access-primary" ${SECURE_ACCESS_LOCAL_OPEN_ATTR} aria-describedby="${LOCAL_NOTE_ID}">This is the server computer</button>
      <button type="button" class="secure-access-secondary" ${SECURE_ACCESS_LOCAL_COPY_ATTR} aria-describedby="${LOCAL_NOTE_ID}">Copy link</button>
    </div>
    <p class="secure-access-note" id="${LOCAL_NOTE_ID}">On a phone or another computer, localhost points to that device—not your Recued server. This link may include a one-time pairing code; keep it private.</p>
  </section>
`;

const insecureContextMarkup = (
  localhostAvailable: boolean,
  arrivedOverHttp: boolean,
): string => `
  <section class="secure-access-handoff" ${SECURE_ACCESS_HANDOFF_ATTR} role="region" aria-labelledby="${TITLE_ID}">
    <p class="secure-access-kicker">Secure access needed</p>
    <h2 id="${TITLE_ID}" tabindex="-1">Choose where you want to continue</h2>
    <p class="secure-access-summary">This page arrived ${arrivedOverHttp ? 'over plain HTTP' : 'from an address the browser does not trust'}, so the browser blocked the encryption Recued needs for pairing and saved access.</p>
    <div class="secure-access-safe">
      <strong>Recued stopped before changing anything.</strong>
      <span>Continue below without losing this page, its pairing details, or its return target. Back will skip this blocked address.</span>
    </div>
    <div class="secure-access-choices${localhostAvailable ? '' : ' is-single'}">
      ${localhostAvailable ? localhostChoiceMarkup() : ''}
      <section class="secure-access-choice" aria-labelledby="webclient-secure-access-https-title">
        <p class="secure-access-choice-kicker">On this or another device</p>
        <h3 id="webclient-secure-access-https-title">Use a trusted HTTPS address</h3>
        <p class="secure-access-choice-copy">Enter the base address from Recued Pro or your own certificate and reverse proxy. Recued carries over the exact page and fills that secure address into pairing.</p>
        <form ${SECURE_ACCESS_HTTPS_FORM_ATTR} novalidate>
          <label class="secure-access-field-label" for="webclient-secure-access-https-url">Your Recued HTTPS address</label>
          <input id="webclient-secure-access-https-url" ${SECURE_ACCESS_HTTPS_INPUT_ATTR} type="url" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://recued.example.com" aria-describedby="${HTTPS_NOTE_ID}" />
          <div class="secure-access-actions">
            <button type="submit" class="secure-access-primary" ${SECURE_ACCESS_HTTPS_OPEN_ATTR}>Open secure page</button>
          </div>
        </form>
        <p class="secure-access-note" id="${HTTPS_NOTE_ID}">Enter only an address you trust for this Recued server. On arrival, Recued uses that page's own address—not a URL inside this link. This page may include a one-time pairing code.</p>
      </section>
    </div>
    ${arrivedOverHttp ? `
      <div class="secure-access-reload-row">
        <span>Already configured this HTTP address to redirect to HTTPS?</span>
        <button type="button" class="secure-access-secondary" ${SECURE_ACCESS_RELOAD_ATTR}>Reload this address</button>
      </div>
    ` : ''}
    <p class="secure-access-status" id="${STATUS_ID}" ${SECURE_ACCESS_STATUS_ATTR} aria-live="polite"></p>
  </section>
`;

const missingWebCryptoMarkup = (): string => `
  <section class="secure-access-handoff" ${SECURE_ACCESS_HANDOFF_ATTR} role="region" aria-labelledby="${TITLE_ID}">
    <p class="secure-access-kicker">Browser update needed</p>
    <h2 id="${TITLE_ID}" tabindex="-1">Use a browser with Web Crypto</h2>
    <p class="secure-access-summary">This address is secure, but this browser does not provide the encryption Recued needs for pairing and saved access. Update it or open this same page in a current version of Chrome, Firefox, Safari, or Edge.</p>
    <div class="secure-access-safe">
      <strong>Recued stopped before changing anything.</strong>
      <span>Updating or switching browsers does not change data on your server.</span>
    </div>
    <div class="secure-access-actions">
      <button type="button" class="secure-access-primary" ${SECURE_ACCESS_RELOAD_ATTR}>Reload after updating</button>
    </div>
    <p class="secure-access-status" id="${STATUS_ID}" ${SECURE_ACCESS_STATUS_ATTR} aria-live="polite"></p>
  </section>
`;

/** Mount the guided handoff inside the existing boot splash. */
export const mountSecureAccessHandoff = (
  options: MountSecureAccessHandoffOptions,
): MountedSecureAccessHandoff => {
  const document = resolveDocument(options.document);
  const splash = options.splashElement
    ?? document?.getElementById(BOOT_SPLASH_MESSAGE_ID)
    ?? null;
  if (document === undefined || splash === null) {
    throw new Error('secure access handoff requires the boot splash');
  }
  injectStyles(document);

  const localUrl = options.issue.kind === 'insecure_context'
    ? buildLocalhostAccessUrl(options.location)
    : null;
  splash.innerHTML = options.issue.kind === 'insecure_context'
    ? insecureContextMarkup(
      localUrl !== null,
      options.location.protocol === 'http:',
    )
    : missingWebCryptoMarkup();

  const title = splash.querySelector<HTMLElement>(`#${TITLE_ID}`);
  const localInput = splash.querySelector<HTMLInputElement>(
    `[${SECURE_ACCESS_LOCAL_URL_ATTR}]`,
  );
  const copyButton = splash.querySelector<HTMLButtonElement>(
    `[${SECURE_ACCESS_LOCAL_COPY_ATTR}]`,
  );
  const httpsInput = splash.querySelector<HTMLInputElement>(
    `[${SECURE_ACCESS_HTTPS_INPUT_ATTR}]`,
  );
  const status = splash.querySelector<HTMLElement>(
    `[${SECURE_ACCESS_STATUS_ATTR}]`,
  );
  if (localInput !== null) {
    localInput.value = localUrl ?? 'Open Recued from its trusted HTTPS address.';
  }

  let disposed = false;
  const setStatus = (message: string, isError = false): void => {
    if (disposed || status === null) return;
    status.textContent = message;
    status.classList.toggle('is-error', isError);
    status.setAttribute('role', isError ? 'alert' : 'status');
  };
  const navigate = (url: string): void => {
    if (options.replaceLocation !== undefined) {
      options.replaceLocation(url);
      return;
    }
    replaceSecureAccessHistoryEntry(url);
  };

  const openLocalhost = (): void => {
    if (disposed) return;
    if (localUrl === null) {
      setStatus(
        'A localhost link could not be built for this address. Use your trusted HTTPS address instead.',
        true,
      );
      return;
    }
    setStatus('Opening this exact page through localhost…');
    try {
      navigate(localUrl);
    } catch {
      setStatus(
        'This browser could not open localhost. Copy the link and open it on the server computer.',
        true,
      );
    }
  };

  const copyLocalhost = async (): Promise<void> => {
    if (disposed || localUrl === null || localInput === null) return;
    localInput.focus();
    localInput.select();
    let copied = false;
    try {
      copied = options.copyText !== undefined
        ? await options.copyText(localUrl)
        : document.execCommand('copy');
    } catch {
      copied = false;
    }
    if (copied) {
      setStatus(
        'Localhost link copied. Keep it private and open it on the computer running Recued.',
      );
      copyButton?.focus();
      return;
    }
    setStatus(
      'Automatic copy is unavailable here. The localhost link is selected; copy it, then open it on the server computer.',
    );
  };

  const openSecureAddress = (): void => {
    if (disposed || httpsInput === null) return;
    const result = resolveSecureAccessUrl(httpsInput.value, options.location);
    if (!result.ok) {
      httpsInput.setAttribute('aria-invalid', 'true');
      httpsInput.setAttribute('aria-errormessage', STATUS_ID);
      setStatus(result.message, true);
      httpsInput.focus();
      return;
    }
    httpsInput.removeAttribute('aria-invalid');
    httpsInput.removeAttribute('aria-errormessage');
    setStatus('Opening this exact page through your secure address…');
    try {
      navigate(result.url);
    } catch {
      setStatus(
        'This browser could not open that address. Check it and try again.',
        true,
      );
      httpsInput.focus();
    }
  };

  const reload = (): void => {
    if (disposed) return;
    setStatus('Reloading this address to check secure access…');
    try {
      if (options.onReload !== undefined) {
        options.onReload();
        return;
      }
      const liveLocation = (globalThis as {
        location?: { reload?: () => void };
      }).location;
      if (typeof liveLocation?.reload !== 'function') {
        throw new Error('browser reload is unavailable');
      }
      liveLocation.reload();
    } catch {
      setStatus('This browser could not reload the page. Refresh it manually.', true);
    }
  };

  const onClick = (event: Event): void => {
    const target = event.target as Element | null;
    if (target?.closest(`[${SECURE_ACCESS_LOCAL_OPEN_ATTR}]`)) {
      event.preventDefault();
      openLocalhost();
      return;
    }
    if (target?.closest(`[${SECURE_ACCESS_LOCAL_COPY_ATTR}]`)) {
      event.preventDefault();
      void copyLocalhost();
      return;
    }
    if (target?.closest(`[${SECURE_ACCESS_RELOAD_ATTR}]`)) {
      event.preventDefault();
      reload();
    }
  };
  const onSubmit = (event: Event): void => {
    const target = event.target as Element | null;
    if (!target?.closest(`[${SECURE_ACCESS_HTTPS_FORM_ATTR}]`)) return;
    event.preventDefault();
    openSecureAddress();
  };
  const onInput = (event: Event): void => {
    const target = event.target as Element | null;
    if (
      !target?.closest(`[${SECURE_ACCESS_HTTPS_INPUT_ATTR}]`)
      || httpsInput?.getAttribute('aria-invalid') !== 'true'
    ) return;
    httpsInput.removeAttribute('aria-invalid');
    httpsInput.removeAttribute('aria-errormessage');
    setStatus('');
  };

  splash.addEventListener('click', onClick);
  splash.addEventListener('submit', onSubmit);
  splash.addEventListener('input', onInput);
  title?.focus();

  return {
    localUrl,
    openLocalhost,
    copyLocalhost,
    openSecureAddress,
    reload,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      splash.removeEventListener('click', onClick);
      splash.removeEventListener('submit', onSubmit);
      splash.removeEventListener('input', onInput);
      splash.innerHTML = '';
    },
  };
};

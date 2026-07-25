/** D-174/D-175 — webclient auth-Worker client for account binding.
 *
 *  The webclient never receives GoTrue/session material. It detects the
 *  HttpOnly-cookie session through `/v1/auth/session`, keeps only the
 *  CSRF token in memory, then mints a short-lived binding token for
 *  relay over the paired server RPC (`account.bind`).
 */

export interface AccountBindingAuthUser {
  id: string;
  email: string;
}

export interface AccountBindingAuthSession {
  authenticated: boolean;
  user: AccountBindingAuthUser | null;
  expiresAt: number;
  csrfToken: string;
}

interface SessionWire {
  authenticated?: unknown;
  user?: unknown;
  expiresAt?: unknown;
  csrfToken?: unknown;
}

interface BindingTokenWire {
  binding_token?: unknown;
  expires_at?: unknown;
}

export interface BindingTokenMintResponse {
  binding_token: string;
  expires_at: number;
}

export type AccountBindingFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AccountBindingAuthClient {
  getSession(): Promise<AccountBindingAuthSession>;
  mintBindingToken(args?: { server_fingerprint?: string }): Promise<BindingTokenMintResponse>;
  /** Clears the recued.com `__Host-` cookie session on THIS browser only
   *  (the Worker `/v1/auth/signout` local scope). The webclient↔server
   *  pairing is untouched — this is a session sign-out, not an
   *  `account.unbind`. */
  signOut(): Promise<void>;
}

export interface CreateAccountBindingAuthClientOptions {
  workerUrl?: string;
  fetch?: AccountBindingFetch;
}

const currentHost = (): string => {
  const locationLike = (globalThis as { location?: { hostname?: unknown } }).location;
  return typeof locationLike?.hostname === 'string' ? locationLike.hostname : '';
};

export const resolveAccountBindingAuthWorkerUrl = (
  host = currentHost(),
): string => {
  if (host === 'staging-app.recued.com' || host.endsWith('.recued2.com')) {
    return 'https://auth.recued2.com';
  }
  return 'https://auth.recued.com';
};

export const resolveAccountBindingDashboardUrl = (
  host = currentHost(),
): string => {
  if (host === 'staging-app.recued.com' || host.endsWith('.recued2.com')) {
    return 'https://dashboard.recued2.com/';
  }
  return 'https://dashboard.recued.com/';
};

const normalizeError = (data: unknown, fallback: string): string => {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const error = record.error && typeof record.error === 'object'
      ? record.error as Record<string, unknown>
      : null;
    const message = error?.message ?? record.message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim();
    }
  }
  return fallback;
};

const readJson = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};

const parseUser = (value: unknown): AccountBindingAuthUser | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.email !== 'string') {
    return null;
  }
  return {
    id: record.id,
    email: record.email,
  };
};

const parseSession = (wire: SessionWire): AccountBindingAuthSession => {
  const authenticated = wire.authenticated === true;
  const user = authenticated ? parseUser(wire.user) : null;
  return {
    authenticated: authenticated && user !== null,
    user,
    expiresAt: typeof wire.expiresAt === 'number' ? wire.expiresAt : 0,
    csrfToken: typeof wire.csrfToken === 'string' ? wire.csrfToken : '',
  };
};

const parseToken = (wire: BindingTokenWire): BindingTokenMintResponse => {
  if (typeof wire.binding_token !== 'string' || wire.binding_token.length === 0) {
    throw new Error('Binding token response was missing binding_token.');
  }
  if (typeof wire.expires_at !== 'number' || !Number.isFinite(wire.expires_at)) {
    throw new Error('Binding token response was missing expires_at.');
  }
  return {
    binding_token: wire.binding_token,
    expires_at: wire.expires_at,
  };
};

const resolveFetch = (override?: AccountBindingFetch): AccountBindingFetch => {
  if (override !== undefined) return override;
  const fetchLike = (globalThis as { fetch?: AccountBindingFetch }).fetch;
  if (typeof fetchLike !== 'function') {
    throw new Error('Account binding auth client requires fetch.');
  }
  return fetchLike.bind(globalThis);
};

export const createAccountBindingAuthClient = (
  options: CreateAccountBindingAuthClientOptions = {},
): AccountBindingAuthClient => {
  const workerUrl = (options.workerUrl ?? resolveAccountBindingAuthWorkerUrl()).replace(/\/$/, '');
  const fetcher = resolveFetch(options.fetch);
  let csrfToken = '';
  let currentSession: AccountBindingAuthSession | null = null;

  const getSession = async (): Promise<AccountBindingAuthSession> => {
    const res = await fetcher(`${workerUrl}/v1/auth/session`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(normalizeError(data, 'Session check failed.'));
    const session = parseSession(data as SessionWire);
    csrfToken = session.csrfToken;
    currentSession = session;
    return session;
  };

  const mintBindingToken = async (
    args: { server_fingerprint?: string } = {},
  ): Promise<BindingTokenMintResponse> => {
    let loadedSessionThisCall = false;
    if (!csrfToken) {
      await getSession();
      loadedSessionThisCall = true;
    }
    if (!csrfToken) throw new Error('Auth form expired. Please retry.');
    if (currentSession?.authenticated !== true && !loadedSessionThisCall) {
      await getSession();
    }
    if (currentSession?.authenticated !== true) {
      throw new Error('Sign in required.');
    }

    const headers = new Headers({
      'Accept': 'application/json',
      'X-CSRF-Token': csrfToken,
    });
    const init: RequestInit = {
      method: 'POST',
      credentials: 'include',
      headers,
    };
    if (args.server_fingerprint !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify({ server_fingerprint: args.server_fingerprint });
    }

    const res = await fetcher(`${workerUrl}/v1/account/binding/token`, init);
    const data = await readJson(res);
    if (!res.ok) throw new Error(normalizeError(data, 'Could not mint binding token.'));
    return parseToken(data as BindingTokenWire);
  };

  const signOut = async (): Promise<void> => {
    // Local-scope sign-out: clear the recued.com session cookie on this
    // browser. CSRF is required while a session is live (the Worker calls
    // `requireCsrf`); ensure a token first, mirroring the dashboard client.
    if (!csrfToken) await getSession();
    const headers = new Headers({ 'Accept': 'application/json' });
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);

    const res = await fetcher(`${workerUrl}/v1/auth/signout`, {
      method: 'POST',
      credentials: 'include',
      headers,
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(normalizeError(data, 'Sign out failed.'));
    // The signout response carries a fresh csrfToken + `authenticated:false`;
    // adopt it so a later mint/sign-out reuses the rotated token.
    const session = parseSession(data as SessionWire);
    csrfToken = session.csrfToken;
    currentSession = session;
  };

  return {
    getSession,
    mintBindingToken,
    signOut,
  };
};

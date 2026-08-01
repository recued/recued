/** Provider-issued OAuth credential readiness.
 *
 * This is deliberately a projection over the live form: no credential value
 * leaves the caller, and no result is suitable for persistence. The renderer
 * and webclient click handler share it so the checklist, popup gate, error
 * copy, and corrective focus cannot disagree about what is missing.
 */

import {
  getVendorProvider,
  isValidOAuthEndpointUrl,
  type ConnectionKind,
} from '@recued/contracts';
import type { ConnectionFormValues } from '../connection-schemas/types.js';

export type ConnectionOAuthCredentialFieldKey =
  | 'auth.client_id'
  | 'auth.client_secret'
  | 'auth.token_endpoint'
  | 'auth.authorize_url';

export interface ConnectionOAuthCredentialRequirement {
  readonly fieldKey: ConnectionOAuthCredentialFieldKey;
  readonly label: string;
  readonly status: 'complete' | 'missing' | 'invalid' | 'optional';
}

export interface ConnectionOAuthCredentialIssue {
  readonly fieldKey: ConnectionOAuthCredentialFieldKey | null;
  readonly message: string;
}

export interface ConnectionOAuthCredentialReadiness {
  readonly providerLabel: string;
  readonly requirements: readonly ConnectionOAuthCredentialRequirement[];
  readonly issue: ConnectionOAuthCredentialIssue | null;
  /** The fields needed to use an already-issued refresh token are complete.
   *  This can be true for a generic provider whose optional Authorize URL is
   *  blank: saving a pasted token remains valid even though in-app (re)auth is
   *  not ready yet. */
  readonly refreshReady: boolean;
  readonly ready: boolean;
  readonly scopeCount: number;
}

/** Fields whose current value is consumed by an OAuth attempt or can be
 * authoritatively replaced by its result. Locking this shared set prevents a
 * returned token/instance URL from silently erasing edits made in the popup's
 * shadow. */
export const isConnectionOAuthLockedField = (fieldKey: string): boolean =>
  fieldKey.startsWith('auth.')
  || fieldKey === 'config.sandbox'
  || fieldKey === 'config.base_url';

/** Editing one of these fields after an in-app exchange breaks the binding
 * between the returned refresh token and the app/environment that issued it.
 * A directly replaced refresh token is a new credential instead, while base
 * URL edits do not change the OAuth app identity. */
export const invalidatesConnectionOAuthResult = (fieldKey: string): boolean =>
  (fieldKey.startsWith('auth.') && fieldKey !== 'auth.refresh_token')
  || fieldKey === 'config.sandbox';

const present = (values: ConnectionFormValues, key: string): boolean =>
  (values[key] ?? '').trim().length > 0;

export const connectionOAuthHttpsEndpointIssue = (
  values: ConnectionFormValues,
  fieldKey: 'auth.token_endpoint' | 'auth.authorize_url',
  label: string,
): ConnectionOAuthCredentialIssue | null => {
  const raw = (values[fieldKey] ?? '').trim();
  if (raw.length === 0) {
    return {
      fieldKey,
      message: `Enter the provider's ${label} before authorizing in Recued.`,
    };
  }
  if (!isValidOAuthEndpointUrl(raw)) {
    return {
      fieldKey,
      message: `${label} must be a complete HTTPS URL with no embedded username or password and no URL fragment.`,
    };
  }
  return null;
};

/** Return null outside an API OAuth-refresh form. For applicable forms the
 * first issue is also the exact field the host should focus before it opens a
 * popup. Registered-provider secret requirements come from the same provider
 * registry the server uses; generic providers keep the secret optional. */
export const connectionOAuthCredentialReadiness = (args: {
  readonly vendor: string | null;
  readonly kind: ConnectionKind | null;
  readonly values: ConnectionFormValues;
}): ConnectionOAuthCredentialReadiness | null => {
  if (args.kind !== 'api' || args.values['auth.type'] !== 'oauth2_refresh') {
    return null;
  }

  const provider = args.vendor === null ? null : getVendorProvider(args.vendor);
  const providerLabel = provider?.display_name
    ?? (args.vendor === null ? 'Provider' : args.vendor);
  const clientIdPresent = present(args.values, 'auth.client_id');
  const clientSecretPresent = present(args.values, 'auth.client_secret');
  const secretRequired = provider?.oauth.client_secret_required ?? false;
  const tokenEndpointIssue = args.vendor === null
    ? connectionOAuthHttpsEndpointIssue(args.values, 'auth.token_endpoint', 'Token Endpoint')
    : null;
  const authorizeUrlIssue = args.vendor === null
    ? connectionOAuthHttpsEndpointIssue(args.values, 'auth.authorize_url', 'Authorize URL')
    : null;
  const requirements: ConnectionOAuthCredentialRequirement[] = [
    {
      fieldKey: 'auth.client_id',
      label: 'Client ID',
      status: clientIdPresent ? 'complete' : 'missing',
    },
    {
      fieldKey: 'auth.client_secret',
      label: 'Client secret',
      status: clientSecretPresent
        ? 'complete'
        : secretRequired
          ? 'missing'
          : 'optional',
    },
  ];

  if (args.vendor === null) {
    requirements.push(
      {
        fieldKey: 'auth.token_endpoint',
        label: 'Token endpoint',
        status: !present(args.values, 'auth.token_endpoint')
          ? 'missing'
          : tokenEndpointIssue === null
            ? 'complete'
            : 'invalid',
      },
      {
        fieldKey: 'auth.authorize_url',
        label: 'Authorize URL',
        status: !present(args.values, 'auth.authorize_url')
          ? 'missing'
          : authorizeUrlIssue === null
            ? 'complete'
            : 'invalid',
      },
    );
  }

  let refreshIssue: ConnectionOAuthCredentialIssue | null = null;
  if (args.vendor !== null && provider === null) {
    refreshIssue = {
      fieldKey: null,
      message: 'Provider sign-in details are unavailable. Return to Connections and choose the provider again.',
    };
  } else if (!clientIdPresent) {
    refreshIssue = {
      fieldKey: 'auth.client_id',
      message:
        'Paste the provider-issued Client ID. Use the application or client ID—not a secret ID or secret value.',
    };
  } else if (secretRequired && !clientSecretPresent) {
    refreshIssue = {
      fieldKey: 'auth.client_secret',
      message: `${providerLabel} requires the client secret issued for this app before Recued can authorize or refresh this connection.`,
    };
  } else if (args.vendor === null) {
    refreshIssue = tokenEndpointIssue;
  }
  const issue = refreshIssue ?? (args.vendor === null ? authorizeUrlIssue : null);

  const scopeCount = (args.values['auth.scopes'] ?? '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .length;
  return {
    providerLabel,
    requirements,
    issue,
    refreshReady: refreshIssue === null,
    ready: issue === null,
    scopeCount,
  };
};

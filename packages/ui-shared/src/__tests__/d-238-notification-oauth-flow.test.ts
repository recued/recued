/** D-238 — a `notification` subtype can run the in-app OAuth dance.
 *
 *  ⛔⛔ The Teams card declared `oauth2_refresh`, and the enrol form rendered no
 *  Authorize button — because the generic BYO-OAuth accelerator was fenced to
 *  `kind === 'api'`. The card therefore asked for a refresh token the owner had
 *  no way to obtain, and the form blocked with nothing visible to fix. The card
 *  and the panel were each individually correct.
 *
 *  🔑 The fence was never about the KIND. It was about the FORM's shape: no
 *  registered vendor, `auth.type: 'oauth2_refresh'`. `api` was simply the only
 *  kind that had reached that shape before. */

import { describe, expect, it } from 'vitest';

import { MICROSOFT_AUTHORIZE_URL, MICROSOFT_TOKEN_URL } from '@recued/contracts';

import {
  connectionFormRunsOAuthDance,
  connectionOAuthCredentialReadiness,
} from '../connections/oauth-credentials.js';
import { notificationSchemas } from '../connection-schemas/notification.js';

const OAUTH = { 'auth.type': 'oauth2_refresh' };

describe('connectionFormRunsOAuthDance', () => {
  it('runs for a notification subtype declaring oauth2_refresh', () => {
    expect(connectionFormRunsOAuthDance({ kind: 'notification', values: OAUTH })).toBe(true);
  });

  it('still runs for the api form it was written for', () => {
    expect(connectionFormRunsOAuthDance({ kind: 'api', values: OAUTH })).toBe(true);
  });

  /** ⛔ The dance is for a REFRESHABLE credential. A bot-token form has nothing
   *  to authorize, and offering a button there would be noise at best. */
  it('does not run for a form with no refreshable credential', () => {
    expect(connectionFormRunsOAuthDance({
      kind: 'notification',
      values: { 'auth.type': 'bearer' },
    })).toBe(false);
    expect(connectionFormRunsOAuthDance({ kind: 'notification', values: {} })).toBe(false);
  });

  it('does not run for a kind that enrols no credential at all', () => {
    expect(connectionFormRunsOAuthDance({ kind: 'mcp', values: OAUTH })).toBe(false);
    expect(connectionFormRunsOAuthDance({ kind: null, values: OAUTH })).toBe(false);
  });
});

describe('the Teams card can actually complete', () => {
  const fields = notificationSchemas.teams.fields;
  const field = (key: string) => fields.find((f) => f.key === key);
  /** What the form holds the moment it opens.
   *
   *  ⚠ Mirrors `seedSchemaDefaults` — BOTH branches. A first draft modelled only
   *  `initial` and the readiness probe came back null, because `auth.type` is a
   *  single-option `select` seeded by the other branch. Modelling half the
   *  seeding is how a fixture proves a form is broken that is not. */
  const seeded: Record<string, string> = Object.fromEntries(
    fields.flatMap((f) => {
      if (f.initial !== undefined) return [[f.key, f.initial]];
      if (f.type === 'select' && !f.options_source && f.options?.length) {
        return [[f.key, f.options[0]!]];
      }
      return [];
    }),
  );

  /** ⛔ `initial`, not `placeholder`. A placeholder is grey text that projects
   *  as ABSENT, so a hidden fixed field carrying only one reaches the server
   *  empty — and the owner cannot fill what they cannot see. */
  it('seeds the fixed Microsoft endpoints as real values', () => {
    expect(seeded['auth.token_endpoint']).toBe(MICROSOFT_TOKEN_URL);
    expect(seeded['auth.authorize_url']).toBe(MICROSOFT_AUTHORIZE_URL);
  });

  /** ⛔ offline_access is what makes the credential renew itself. Without it the
   *  connection enrols, probes green, and stops delivering about an hour later —
   *  the precise failure the oauth lane was gated on for months. */
  it('requests offline_access, or the connection dies within the hour', () => {
    expect(seeded['auth.scopes']).toContain('offline_access');
  });

  it('requests the scopes it actually uses, and nothing admin-gated', () => {
    const scopes = (seeded['auth.scopes'] ?? '').split(/\s+/u);
    expect(scopes).toContain('ChatMessage.Send');
    expect(scopes).toContain('Chat.Read');
    // ⛔ Admin-consent territory. Asking for it would make a self-serve
    // enrolment impossible on a corporate tenant — the whole target user.
    expect(scopes).not.toContain('ChannelMessage.Read.All');
  });

  /** ⛔ THE JOIN. The predicate and the card can both be right while the seeded
   *  form still cannot authorize — a missing endpoint leaves readiness null and
   *  the button unrendered, with nothing saying why. */
  it('the seeded form is READY to authorize with nothing typed but the app credentials', () => {
    const readiness = connectionOAuthCredentialReadiness({
      vendor: null,
      kind: 'notification',
      values: {
        ...seeded,
        name: 'teams',
        display_name: 'Microsoft Teams',
        'auth.client_id': 'cid',
        'auth.client_secret': 'secret',
      },
    });
    expect(readiness).not.toBeNull();
    expect(readiness!.ready).toBe(true);
  });

  it('the refresh token is autofilled, never hand-typed', () => {
    expect(field('auth.refresh_token')?.autofilled).toBe(true);
  });

  /** A hand-editable approver field is itself the escalation this binds
   *  against, so it must be read-only as well as autofilled. */
  it('the approver is autofilled and read-only', () => {
    const approver = field('config.principal_id');
    expect(approver?.autofilled).toBe(true);
    expect(approver?.readonly).toBe(true);
  });
});

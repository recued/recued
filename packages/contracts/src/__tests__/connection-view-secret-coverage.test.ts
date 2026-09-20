/** ⛔⛔ THE RECIPE-VISIBLE CONNECTION VIEW IS PROTECTED BY A DENYLIST, AND
 *  NOTHING DERIVED ITS COMPLETENESS.
 *
 *  `connectionViewFromRow` builds the view from static identity fields and then
 *  SPREADS `config_json` — `ConnectionView` ends in `[k: string]: unknown`, so
 *  every config key lands on the view unless `CONNECTION_INBOUND_SECRET_FIELDS`
 *  names it. `auth_ciphertext` is excluded by construction and is not the
 *  concern; the concern is a credential that lives in CONFIG.
 *
 *  🔑 THE INVARIANT IS DERIVABLE, WHICH IS WHY IT SHOULD NOT BE HAND-WRITTEN.
 *  Every messenger vendor DECLARES `ingress.secret_field` — "the config key the
 *  verifier reads". That is exactly the set that must be stripped. Before this
 *  file the coverage was asserted three times, per-vendor, as literals:
 *
 *      expect(CONNECTION_INBOUND_SECRET_FIELDS).toContain('webhook_secret')
 *      expect(CONNECTION_INBOUND_SECRET_FIELDS).toContain('signing_secret')
 *
 *  — so a FIFTH vendor declaring `secret_field: 'bot_token'` would spread that
 *  credential onto the recipe-visible view and no test would notice. The
 *  denylist's own header says *"Adding a new field here is a one-line change —
 *  the projection check follows"*, and "follows" was a person remembering.
 *
 *  ⚠ ASSERTS THE OUTCOME, NOT THE MEMBERSHIP. Checking the field is in the list
 *  restates what the list says. This drives `connectionViewFromRow` with a row
 *  whose config holds every declared secret and asserts none survives — plus a
 *  positive control, because a projection that returned `{}` would satisfy the
 *  absence check perfectly.
 *
 *  ⚠ SCOPE: messenger vendor declarations. A credential introduced as a config
 *  key with no `secret_field` declaration is outside what this can derive. */

import { describe, expect, it } from 'vitest';
import {
  CONNECTION_INBOUND_SECRET_FIELDS,
  connectionViewFromRow,
  type ConnectionRow,
} from '../connection.js';
import * as messengerVendors from '../messenger-vendors.js';

/** Every `ingress.secret_field` declared anywhere in the vendor module. Walked
 *  rather than read off one export, so a declaration added under a new export
 *  is still seen. */
const declaredSecretFields = (): Map<string, string> => {
  const found = new Map<string, string>();
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (typeof o.secret_field === 'string') found.set(path, o.secret_field);
    for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  };
  for (const [name, value] of Object.entries(messengerVendors)) walk(value, name);
  return found;
};

const rowWith = (config: Record<string, unknown>): ConnectionRow => ({
  pk: 'notification:acme',
  kind: 'notification',
  name: 'acme',
  display_name: 'Acme',
  config_json: JSON.stringify(config),
  auth_ciphertext: 'AEAD-CIPHERTEXT',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
});

describe('no declared credential reaches the recipe-visible view', () => {
  const declared = declaredSecretFields();

  it('the walk finds the declarations at all', () => {
    // ⛔ A walker that found nothing would pass every assertion below.
    expect(declared.size).toBeGreaterThanOrEqual(4);
  });

  it('every declared `secret_field` is on the denylist', () => {
    const uncovered = [...declared]
      .filter(([, field]) => !CONNECTION_INBOUND_SECRET_FIELDS.includes(field))
      .map(([where, field]) => `  ${field} — declared at ${where}`);
    expect(
      uncovered,
      'a vendor declares a config key its verifier reads as a credential, and '
        + `CONNECTION_INBOUND_SECRET_FIELDS does not strip it:\n${uncovered.join('\n')}`,
    ).toEqual([]);
  });

  it('OUTCOME: a row holding every declared secret projects none of them', () => {
    const config: Record<string, unknown> = { base_url: 'https://acme.example' };
    for (const field of new Set(declared.values())) config[field] = `SECRET-${field}`;
    const view = connectionViewFromRow(rowWith(config));

    const leaked = Object.entries(view)
      .filter(([, v]) => typeof v === 'string' && v.startsWith('SECRET-'))
      .map(([k]) => k);
    expect(leaked, `projected to the recipe-visible view: ${leaked.join(', ')}`).toEqual([]);
    expect('auth_ciphertext' in view).toBe(false);
  });

  it('CONTROL: a NON-secret config field does reach the view', () => {
    // ⛔ Without this, a projection that returned `{}` — or dropped config
    //   entirely — would satisfy the absence assertion above perfectly.
    const view = connectionViewFromRow(rowWith({ base_url: 'https://acme.example' }));
    expect(view.base_url).toBe('https://acme.example');
    expect(view.name).toBe('acme');
  });

  it('MUTATION: an uncovered declaration is detected', () => {
    // ⚠ Pins the check itself: the same derivation over a planted declaration
    //   must report it. This is the fifth-vendor case the literals could not see.
    const planted = { ingress: { secret_field: 'bot_token', id_field: 'x' } };
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (typeof o.secret_field === 'string') found.push(o.secret_field);
      for (const v of Object.values(o)) walk(v);
    };
    walk(planted);
    expect(found).toEqual(['bot_token']);
    expect(CONNECTION_INBOUND_SECRET_FIELDS).not.toContain('bot_token');
    // …and the projection would indeed carry it today.
    const view = connectionViewFromRow(rowWith({ bot_token: 'SECRET-bot_token' }));
    expect(view.bot_token).toBe('SECRET-bot_token');
  });
});

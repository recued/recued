/** D-238 — the Teams card tells the truth about WHO can set this up.
 *
 *  ⛔⛔ THE FAILURE THIS EXISTS FOR, found by a live drive and nothing else.
 *  The card's original steps told EVERY office user to open Entra and register
 *  their own app. That is the BYO-OAuth shape every other vendor here uses, and
 *  it is right for a solo owner who is their own admin — but D-238's stated
 *  target user is someone in an M365 office, where registering an app and
 *  consenting to it are both usually blocked. The owner driving it hit exactly
 *  that: "Grant admin consent" greyed out, no way forward, and a card that had
 *  implied the whole thing was self-serve.
 *
 *  🔑 The fix is not a mechanism, it is honesty. Setup is TWO jobs with two
 *  owners — an administrator registers ONE app for the organisation, everyone
 *  else connects with the values they publish. A card that says so lets a
 *  blocked user recognise the wall and forward the page, instead of concluding
 *  Recued is broken.
 *
 *  These assertions are deliberately about MEANING rather than wording: each
 *  one names a fact a person needs before they can finish, and every one of
 *  them was absent or wrong before this. */

import { describe, expect, it } from 'vitest';

import { notificationSchemas } from '../connection-schemas/notification.js';

const teams = notificationSchemas.teams;
const guide = teams.onboarding!.guides[0]!;
const steps = guide.steps ?? [];
const prose = [
  teams.description ?? '',
  guide.description ?? '',
  ...steps.flatMap((s) => [s.title, s.detail ?? '']),
].join('\n');
const field = (key: string) => teams.fields.find((f) => f.key === key);

describe('the card names the account type before anything else', () => {
  /** ⛔ Graph's `/me` SUPPORTS a personal Microsoft account while every Teams
   *  messaging API is work-or-school only, so a consumer account gets all the
   *  way through consent before failing. Enrolment refuses it — but a refusal
   *  after ten minutes of Entra work is a bad way to learn a prerequisite. */
  it('says a work or school account is required', () => {
    expect(prose).toMatch(/work or school/i);
  });

  it('names the personal-account domains that will not work', () => {
    expect(prose).toMatch(/outlook\.com/i);
    expect(prose).toMatch(/hotmail\.com|live\.com/i);
  });

  it('leads with it — the prerequisite is step 1, not a footnote', () => {
    expect(steps[0]!.detail ?? '').toMatch(/work or school/i);
  });
});

describe('the card names who can do the setup', () => {
  /** The four Entra roles that can register an app AND consent for the tenant.
   *  A user who holds none of them needs to know that by NAME, so they can find
   *  the person who does. "Ask your admin" is not actionable; these are. */
  it('names the administrator roles that can register and consent', () => {
    for (const role of [
      /Global Administrator/i,
      /Application Administrator/i,
      /Cloud Application Administrator/i,
      /Privileged Role Administrator/i,
    ]) {
      expect(prose).toMatch(role);
    }
  });

  /** ⛔ THE ONE THAT MATTERS MOST. The owner's drive ended at a greyed-out
   *  "Grant admin consent" button with no idea whether it was their mistake,
   *  a Recued bug, or policy. Saying so converts a dead end into a handoff. */
  it('explains that greyed-out buttons are tenant policy, not a Recued fault', () => {
    expect(prose).toMatch(/greyed out|grey(ed)?-out/i);
    expect(prose).toMatch(/tenant’s policy|tenant policy|your tenant/i);
  });

  it('says the registration is ONCE for the organisation, not once per person', () => {
    expect(prose).toMatch(/once/i);
    expect(prose).toMatch(/not once per person|whole organisation/i);
  });

  /** Every step is owned by exactly one of the two roles, and says which. */
  it('marks each step ADMIN or YOU', () => {
    const owned = steps.filter((s) => /ADMIN|YOU/u.test(s.title));
    // Step 1 is the account-type check, which belongs to neither.
    expect(owned.length).toBe(steps.length - 1);
    expect(steps.some((s) => s.title.includes('ADMIN'))).toBe(true);
    expect(steps.some((s) => s.title.includes('YOU'))).toBe(true);
  });
});

describe('the permissions story is accurate, not reassuring', () => {
  /** ⛔ The card used to end the scopes help with "None needs an administrator."
   *  True per PERMISSION and false per TENANT: each of the four is
   *  user-consentable, but a tenant that disables user consent overrides that
   *  entirely — which is precisely the tenant the owner was driving on. The
   *  reassuring half-truth is what made the wall look like a bug. */
  it('does not claim that no administrator is needed', () => {
    const scopes = field('auth.scopes')?.help ?? '';
    expect(scopes).not.toMatch(/None needs an administrator\.?$/u);
    // It must carry BOTH halves: not admin-only, yet an admin is often required.
    expect(scopes).toMatch(/admin-only/i);
    expect(scopes).toMatch(/user consent/i);
  });

  /** Delegated, never Application — the difference between "acts as you, within
   *  what you could already reach" and a tenant-wide read of everyone's chats.
   *  An admin skimming step 4 must not pick the wrong column. */
  it('asks for DELEGATED permissions and says so explicitly', () => {
    expect(prose).toMatch(/Delegated permissions \(NOT Application permissions\)/u);
  });

  it('explains offline_access, the one whose absence fails an hour later', () => {
    expect(prose).toMatch(/offline_access/u);
    expect(prose).toMatch(/hour/i);
  });

  /** The secret is published to colleagues, so the card owes them its blast
   *  radius: it identifies the APP, and with delegated-only permissions opens
   *  nothing without that individual's own sign-in. */
  it('says what the shared client secret does and does not grant', () => {
    const help = field('auth.client_secret')?.help ?? '';
    expect(help).toMatch(/identifies the APP/u);
    expect(help).toMatch(/your own sign-in|still requires/i);
  });
});

describe('the tenant endpoints are reachable and move together', () => {
  const authorize = field('auth.authorize_url')!;
  const token = field('auth.token_endpoint')!;

  /** ⛔ Both were `hidden: true` while step 3 tells the admin to register the
   *  app "this organizational directory only" — and a single-tenant app REFUSES
   *  the seeded `/common/` endpoint with AADSTS50194. The card's own
   *  instructions could not be completed, and the fix named a field that was
   *  not on screen. */
  it('are visible, because the setup steps ask the owner to edit them', () => {
    expect(authorize.hidden).not.toBe(true);
    expect(token.hidden).not.toBe(true);
  });

  /** ⛔⛔ THE COMPOSITION CHECK, not two shape checks. Each field is
   *  individually valid with any tenant in it; only the PAIR can be wrong. A
   *  tenant-specific authorize with a `/common/` token endpoint carries the
   *  owner all the way through consent and then dies at the exchange — the
   *  most expensive place to discover a typo. */
  it('seed the SAME tenant segment, or sign-in breaks after consent', () => {
    const tenantOf = (url: string) =>
      /login\.microsoftonline\.com\/([^/]+)\//u.exec(url)?.[1];
    expect(tenantOf(authorize.initial!)).toBeDefined();
    expect(tenantOf(authorize.initial!)).toBe(tenantOf(token.initial!));
  });

  it('warn on BOTH fields that the pair must be edited together', () => {
    expect(authorize.help ?? '').toMatch(/Token Endpoint/u);
    expect(token.help ?? '').toMatch(/SAME Directory \(tenant\) ID/u);
  });

  it('name the error a single-tenant app actually returns', () => {
    expect(prose).toMatch(/AADSTS50194/u);
  });
});

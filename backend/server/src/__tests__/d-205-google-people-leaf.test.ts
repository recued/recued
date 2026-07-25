/** D-205 #4c — the Google People leaf.
 *
 *  ## What is actually being tested
 *
 *  Two things, and they are different in kind:
 *
 *  1. **The DISPATCH is a pack operation, not an HTTP call.** The leaf sends
 *     `contact.connections.list` through `runSourceMirrorFetch` → the catalog
 *     gateway, so it is admitted against the connection's grant and audited like any
 *     recipe's call. There is no vendor client in this tree, and these tests stub the
 *     dispatcher rather than a network.
 *
 *  2. **The SHAPE-WRANGLING is the whole reason a leaf exists.** People is
 *     multi-valued and primary-flagged; a contact is not flat. This is the §0 "only
 *     what can't generalize" half, and every subtle bug in this file is here:
 *     the placeholder avatar, the half address, the ingestion-vs-event clock, and the
 *     supplies promise. */

import { describe, expect, it, vi } from 'vitest';

import { getContactSourceDeclaration, type ContactSourceDeclaration } from '@recued/contracts';

// The dispatcher is the seam. Mock it BEFORE importing the leaf.
const runSourceMirrorFetch = vi.fn();
vi.mock('../source-mirror/fetch.js', () => ({
  runSourceMirrorFetch: (...args: unknown[]) => runSourceMirrorFetch(...args),
}));

const { createGooglePeopleLeaf } = await import('../contact-source-adapters/google-people-leaf.js');

const GOOGLE = getContactSourceDeclaration('google') as ContactSourceDeclaration;

/** A minimal `SourceMirrorFetchDeps` — only the two lookups the leaf reaches for
 *  before dispatching (the fail-closed catalog-binding walk). */
const deps = (overrides: { profile?: unknown; manifest?: unknown } = {}) =>
  ({
    fetchDeps: {
      profiles: {
        get: () =>
          overrides.profile === undefined
            ? { catalog_slug: 'google-contacts' }
            : overrides.profile,
      },
      executorConfig: {
        manifests: {
          get: () =>
            overrides.manifest === undefined
              ? {
                  operations: {
                    'contact.connections.list': { result_path: 'connections' },
                  },
                }
              : overrides.manifest,
        },
      },
    },
    now: () => 5_000,
  }) as never;

const request = {
  source_id: 'google.personal.contact',
  connection_name: 'personal',
  vendor: 'google',
  declaration: GOOGLE,
};

/** The gateway hands back records keyed by `idField` — People's `resourceName`. */
const gatewayReturns = (people: readonly Record<string, unknown>[], complete = true): void => {
  runSourceMirrorFetch.mockResolvedValue({
    ok: true,
    records: new Map(people.map((p) => [String(p.resourceName), p])),
    truncated: !complete,
    complete,
    skipped_no_id: 0,
  });
};

describe('D-205 #4c — the leaf dispatches the PACK, not an HTTP client', () => {
  it('sends contact.connections.list, in raw mode, keyed on resourceName', async () => {
    gatewayReturns([]);
    await createGooglePeopleLeaf(deps())(request);

    expect(runSourceMirrorFetch).toHaveBeenCalledTimes(1);
    const [, req] = runSourceMirrorFetch.mock.calls[0]!;
    expect(req.operationKey).toBe('contact.connections.list');
    expect(req.idField).toBe('resourceName');
    expect(req.projectionTemplate).toBeNull(); // raw — the leaf owns the shape
    expect(req.resultPath).toBe('connections');
    // `personFields` is REQUIRED by the People API and selects what comes back.
    expect(req.args['query.personFields']).toContain('emailAddresses');
    expect(req.args['query.personFields']).toContain('metadata'); // → `as_of`

    // ⛔ pageSize / pageToken are the GATEWAY's to write — the pack declares the
    // pagination contract and the follower drives it. Setting them here would fight it.
    expect(req.args['query.pageSize']).toBeUndefined();
    expect(req.args['query.pageToken']).toBeUndefined();
  });

  it('🔑 passes the gateways completeness proof through UNCHANGED', async () => {
    // The delete diff is absence-based, so it is only as safe as this proof — and the
    // leaf CANNOT build one: `nextPageToken` lives at the response root, outside
    // `result_path`, so only the gateway's follower ever sees the cursor.
    gatewayReturns([], true);
    const ok = await createGooglePeopleLeaf(deps())(request);
    expect(ok.ok && ok.complete).toBe(true);

    // A truncated walk ⇒ complete:false ⇒ the runner disconnects NOTHING. Reading
    // `!truncated` as complete would tear the linkage off every contact past page one.
    gatewayReturns([], false);
    const partial = await createGooglePeopleLeaf(deps())(request);
    expect(partial.ok && partial.complete).toBe(false);
  });

  it('fails CLOSED on a broken catalog binding — never a silent empty list', async () => {
    // An empty list is not neutral: on a COMPLETE walk the runner reads it as "every
    // contact was deleted". So a config fault must say so.
    const noProfile = await createGooglePeopleLeaf(deps({ profile: null }))(request);
    expect(noProfile.ok).toBe(false);
    if (!noProfile.ok) expect(noProfile.kind).toBe('config');

    const noManifest = await createGooglePeopleLeaf(deps({ manifest: null }))(request);
    expect(noManifest.ok).toBe(false);
    if (!noManifest.ok) expect(noManifest.reason).toMatch(/not installed/i);

    const noOp = await createGooglePeopleLeaf(deps({ manifest: { operations: {} } }))(request);
    expect(noOp.ok).toBe(false);
    if (!noOp.ok) expect(noOp.reason).toMatch(/declares no 'contact\.connections\.list'/i);
  });
});

describe('D-205 #4c — People is multi-valued; a contact is not flat', () => {
  const person = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    resourceName: 'people/c1',
    names: [{ displayName: 'Bob Smith', metadata: { primary: true } }],
    emailAddresses: [{ value: 'bob@example.com', metadata: { primary: true } }],
    phoneNumbers: [],
    organizations: [],
    addresses: [],
    photos: [],
    metadata: { sources: [{ updateTime: '2026-07-01T00:00:00Z' }] },
    ...over,
  });

  const listOne = async (p: Record<string, unknown>) => {
    gatewayReturns([p]);
    const out = await createGooglePeopleLeaf(deps())(request);
    if (!out.ok) throw new Error('expected ok');
    return out.records[0]!;
  };

  it('emits EVERY supplied kind on every record — the anti-silence promise', async () => {
    const rec = await listOne(person());
    // `[]` / `null` = "I looked and this person has none". A MISSING key = "I never
    // looked", and the runner fails the record for it. That distinction is the whole
    // device: a leaf that quietly stopped emitting `address` would drain D-138's
    // blocking key rather than error.
    expect(Object.keys(rec.aliases).sort()).toEqual(['email_alias', 'phone_alias']);
    expect(Object.keys(rec.attributes).sort()).toEqual(['address', 'name', 'org', 'photo']);
    expect(rec.attributes.org).toBeNull();
    expect(rec.aliases.phone_alias).toEqual([]);
  });

  it('takes EVERY address, primary FIRST — a second address is still theirs', async () => {
    const rec = await listOne(
      person({
        emailAddresses: [
          { value: 'BOB@WORK.com' },
          { value: 'bob@personal.com', metadata: { primary: true } },
        ],
      }),
    );
    // Primary first, all canonicalized. (And #3.5b is what makes the extra one
    // readable in REVERSE, so a producer's reads for this contact actually span it.)
    expect(rec.aliases.email_alias).toEqual(['bob@personal.com', 'bob@work.com']);
  });

  it('prefers the E.164 canonicalForm over the digits the user typed', async () => {
    const rec = await listOne(
      person({
        phoneNumbers: [{ value: '(555) 010-0100', canonicalForm: '+15550100100' }],
      }),
    );
    expect(rec.aliases.phone_alias).toEqual(['+15550100100']);
  });

  it('⛔ SKIPS Googles placeholder avatar (`default: true`)', async () => {
    // It is the grey silhouette, not a photo OF anyone. Storing it renders a fake
    // face on the detail page and makes "has a photo" true for every contact Google
    // has ever heard of.
    const placeholder = await listOne(
      person({ photos: [{ url: 'https://…/default.png', default: true }] }),
    );
    expect(placeholder.attributes.photo).toBeNull();

    const real = await listOne(
      person({
        photos: [
          { url: 'https://…/default.png', default: true },
          { url: 'https://…/bob.jpg' },
        ],
      }),
    );
    expect(real.attributes.photo).toBe('https://…/bob.jpg');
  });

  it('🔑 a HALF address contributes NOTHING — it would poison the blocking key', async () => {
    // `address` feeds D-138's `address_zip_country_key`. A partial address yields a
    // blocking key that matches the WRONG people — worse than no key at all, which
    // merely produces no match.
    const half = await listOne(
      person({ addresses: [{ streetAddress: '1 Main St', city: 'Springfield' }] }), // no zip/country
    );
    expect(half.attributes.address).toBeNull();

    const whole = await listOne(
      person({
        addresses: [
          {
            streetAddress: '1 Main St',
            city: 'Springfield',
            region: 'IL',
            postalCode: '62704',
            country: 'United States',
          },
        ],
      }),
    );
    expect(whole.attributes.address).toMatchObject({ city: 'springfield', zip: '62704' });
  });

  it('🔑 `as_of` is the records own updateTime — EVENT time, not the clock', async () => {
    // It drives the C-2a recency tiebreak between two same-rung sources. Reading the
    // clock here would silently turn freshest-wins into last-SYNCED-wins.
    const rec = await listOne(person());
    expect(rec.as_of).toBe(Date.parse('2026-07-01T00:00:00Z'));
    expect(rec.as_of).not.toBe(5_000); // ← the injected `now`

    // Absent ⇒ fall back to now, which is the honest upper bound, not a fabrication.
    const undated = await listOne(person({ metadata: {} }));
    expect(undated.as_of).toBe(5_000);
  });

  it('a record with no resourceName is emitted UNKEYABLE, never dropped', async () => {
    // An unkeyable row must reach the runner: it COUNTS it, and it fail-closes the
    // delete proof for the cycle (a record we cannot key is a record we cannot prove
    // absent). Dropping it here would hide that from the health surface.
    runSourceMirrorFetch.mockResolvedValue({
      ok: true,
      records: new Map([['', { names: [{ displayName: 'Ghost' }] }]]),
      truncated: false,
      complete: true,
      skipped_no_id: 0,
    });
    const out = await createGooglePeopleLeaf(deps())(request);
    if (!out.ok) throw new Error('expected ok');
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.remote_id).toBe('');
  });
});

describe('D-205 #4c — the declaration', () => {
  it('is the first full_import source, and it is NOT a CRM', () => {
    expect(GOOGLE.import_scope).toBe('full_import');
    expect(GOOGLE.rung).toBe('contact_book');
    // 🔑 NULL — a contact book has no platform record; it IS the record. This is what
    // makes the runner's step-1 bind gate (which reads the FROZEN
    // CONNECTION_VENDOR_ENTITIES) early-return instead of failing a CRM-shaped check
    // on a thing that is not a CRM.
    expect(GOOGLE.vendor_entity).toBeNull();
  });

  it('promises only what the pack can actually produce', () => {
    // `supplies` is a PROMISE the runner verifies per record — promising a field no
    // code emits fails EVERY record on the FIRST cycle. The People API carries
    // birthdays and job titles; the PACK's `entities.person` field map declares
    // neither, so neither is promised. A statement, not a gap.
    expect([...GOOGLE.supplies.attributes].sort()).toEqual(['address', 'name', 'org', 'photo']);
    expect(GOOGLE.supplies.attributes).not.toContain('birthday');
    expect(GOOGLE.supplies.attributes).not.toContain('title');

    // Phones are imported but are NOT a join key — the runner has no phone→contact
    // resolver and REFUSES a cycle keyed on one rather than match zero in silence.
    expect(GOOGLE.supplies.aliases).toContain('phone_alias');
    expect([...GOOGLE.match_on]).toEqual(['email_alias']);
  });
});

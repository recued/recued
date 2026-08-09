import { RISK_APPROVAL_FLOOR, type BulkPackManifest } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import {
  packPermissionPreviewModel,
  renderPackPermissionPreview,
  PACK_PERMISSION_PREVIEW_TIER_ATTR,
  PACK_PERMISSION_PREVIEW_CONNECTION_ATTR,
} from '../settings/pack-permission-preview.js';

/** ⛔⛔ THE DEFECT THIS COVERS IS AN ABSENCE, WHICH IS WHY IT NEEDED A TEST AT ALL.
 *  A not-yet-installed pack's Permissions tab rendered "this pack has no operation
 *  defaults to customize" — indistinguishable, to a reader, from "this pack needs no
 *  permissions". Nothing was broken; the screen simply told the owner the opposite of
 *  the truth for every marketplace pack, at the one moment the decision is still free.
 */
const manifest = (over: Partial<BulkPackManifest> = {}): BulkPackManifest => ({
  slug: 'demo',
  name: 'Demo',
  description: 'A pack',
  publisher: 'recued-core',
  version: 1,
  contents: [
    {
      type: 'composition',
      composition: {
        ingredients: [
          { slug: 'demo-api', kind: 'http', http: { connection: 'demo', base: 'https://x' } },
        ],
        operations: [
          { op: 'thing.read', ingredient: 'demo-api', risk: 'read', required_scopes: ['Files.Read'] },
          { op: 'thing.search', ingredient: 'demo-api', risk: 'read', required_scopes: ['Files.Read'] },
          { op: 'thing.write', ingredient: 'demo-api', risk: 'write', required_scopes: ['Files.ReadWrite'] },
          { op: 'thing.purge', ingredient: 'demo-api', risk: 'destructive', required_scopes: ['Files.ReadWrite'] },
        ],
      },
    },
  ],
  ...over,
} as unknown as BulkPackManifest);

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  setAttribute(k: string, v: string): void;
  appendChild(c: FakeEl): FakeEl;
}
const makeEl = (tagName: string): FakeEl => {
  const el: FakeEl = {
    tagName,
    className: '',
    textContent: '',
    attrs: new Map(),
    children: [],
    setAttribute(k, v) { el.attrs.set(k, v); },
    appendChild(c) { el.children.push(c); return c; },
  };
  return el;
};
const fakeDoc = { createElement: (t: string) => makeEl(t) } as unknown as Document;

const walk = (root: FakeEl, out: FakeEl[] = []): FakeEl[] => {
  out.push(root);
  for (const c of root.children) walk(c, out);
  return out;
};
const withAttr = (root: FakeEl, attr: string): FakeEl[] =>
  walk(root).filter((el) => el.attrs.has(attr));
const allText = (root: FakeEl): string => walk(root).map((el) => el.textContent).join(' ');

describe('pack permission preview — what installing WOULD allow', () => {
  it('⛔⛔ counts every declared operation by tier, worst-last', () => {
    const model = packPermissionPreviewModel(manifest());
    expect(model).not.toBeNull();
    expect(model!.operationCount).toBe(4);
    /** ⚠ Order is asserted, not just membership: the escalation must READ as an
     *  escalation, and a set comparison would pass with destructive listed first. */
    expect(model!.tiers).toEqual([
      { tier: 'read', count: 2 },
      { tier: 'write', count: 1 },
      { tier: 'destructive', count: 1 },
    ]);
    /** ⛔ A tier with nothing in it is OMITTED, never shown as zero — "admin: 0" invites
     *  reading a zero where there is simply nothing to read. */
    expect(model!.tiers.map((t) => t.tier)).not.toContain('admin');
  });

  it('⛔⛔ names the connection and the EXACT scopes the provider screen will show', () => {
    const model = packPermissionPreviewModel(manifest());
    expect(model!.connections).toEqual([
      { connection: 'demo', scopes: ['Files.Read', 'Files.ReadWrite'] },
    ]);
    /** ⚠ Verbatim, not paraphrased. These are the strings Microsoft/Google will display
     *  on their own consent screen; an owner comparing the two must find them identical,
     *  or a legitimate screen looks wrong and the honest one looks suspicious. */
    const el = renderPackPermissionPreview({ document: fakeDoc, manifest: manifest() });
    expect(allText(el as unknown as FakeEl)).toContain('Files.ReadWrite');
  });

  it('⛔⛔⛔ says NOTHING IS GRANTED YET — a preview must not read as current state', () => {
    /** THE ASSERTION THAT MATTERS MOST. Without this line the list is indistinguishable
     *  from a grant matrix showing what the pack ALREADY has — the same "display is not
     *  enforcement" confusion that made the connection operation-grant panel misleading
     *  enough to retire in D-233. */
    const el = renderPackPermissionPreview({ document: fakeDoc, manifest: manifest() });
    const text = allText(el as unknown as FakeEl);
    expect(text).toContain('Not installed');
    expect(text).toContain('nothing is granted yet');
  });

  it('⛔ the approval wording is DERIVED from RISK_APPROVAL_FLOOR, not restated', () => {
    /** A disclosure that overstates protection is worse than none. Pinning it to the
     *  floor means the promise on screen cannot drift from what the gateway enforces —
     *  and this test fails loudly if someone relaxes the floor without revisiting the
     *  copy, which is exactly when the sentence would start lying. */
    expect(RISK_APPROVAL_FLOOR.write, 'a write must ask').toBe('ask');
    expect(RISK_APPROVAL_FLOOR.destructive, 'destructive always asks').toBe('always');
    const el = renderPackPermissionPreview({ document: fakeDoc, manifest: manifest() });
    const rows = withAttr(el as unknown as FakeEl, PACK_PERMISSION_PREVIEW_TIER_ATTR);
    const byTier = new Map(rows.map((r) => [r.attrs.get('data-tier'), r.textContent]));
    expect(byTier.get('write')).toContain('asks before each action');
    expect(byTier.get('destructive')).toContain('always asks, every time');
    /** ⚠ And a READ row must not claim an approval it does not have — overstating here
     *  trains the owner to expect a prompt that never comes. */
    expect(byTier.get('read')).toContain('runs without asking');
  });

  it('⛔⛔ lists a bound account even when NO scopes are declared', () => {
    /** THE OBVIOUS IMPLEMENTATION DROPS THIS PACK. Enumerating
     *  `requiredScopesByConnection(manifest)` looks like the right source and is keyed
     *  by the scopes it found — so a connection whose operations declare none produces
     *  no entry, and the owner is never told the pack touches an account at all. That is
     *  the same shape as the defect this whole surface exists to fix: an absence reading
     *  as "nothing to see".
     *  🔑 Found by driving the real panel against a scope-less fixture, not by reading
     *  the function. The slots are derived from the INGREDIENTS; scopes are attached
     *  afterwards where they exist. */
    const scopeless = manifest({
      contents: [
        {
          type: 'composition',
          composition: {
            ingredients: [
              { slug: 'a', kind: 'http', http: { connection: 'quiet', base: 'https://x' } },
            ],
            operations: [{ op: 'x.read', ingredient: 'a', risk: 'read' }],
          },
        },
      ],
    } as Partial<BulkPackManifest>);
    const model = packPermissionPreviewModel(scopeless);
    expect(model!.connections, 'the account must be disclosed even with no scopes')
      .toEqual([{ connection: 'quiet', scopes: [] }]);
    const el = renderPackPermissionPreview({ document: fakeDoc, manifest: scopeless });
    expect(allText(el as unknown as FakeEl)).toContain('quiet');
    /** ⚠ And it says so honestly rather than implying scopes it does not request. */
    expect(allText(el as unknown as FakeEl)).toContain('no scopes declared');
  });

  it('⚠ a pack with nothing to disclose renders nothing, rather than an empty shell', () => {
    /** The one case where silence is honest: no operations AND no connection. Returning
     *  an empty section here would reintroduce the original defect in new markup. */
    const bare = manifest({ contents: [] } as Partial<BulkPackManifest>);
    expect(packPermissionPreviewModel(bare)).toBeNull();
    expect(renderPackPermissionPreview({ document: fakeDoc, manifest: bare })).toBeNull();
  });

  it('⚠ connection rows carry their slot, so a multi-account pack is legible', () => {
    const el = renderPackPermissionPreview({ document: fakeDoc, manifest: manifest() });
    const rows = withAttr(el as unknown as FakeEl, PACK_PERMISSION_PREVIEW_CONNECTION_ATTR);
    expect(rows).toHaveLength(1);
    expect(rows[0].attrs.get('data-connection')).toBe('demo');
  });
});

/** The shared install-offer component.
 *
 *  Two halves, and the extraction is the one that can fail quietly:
 *  `missingPacksFromError` decides whether a surface shows an OFFER or a plain
 *  error, so every way it can wrongly say "yes" puts a button in front of a user
 *  that cannot help them, and every way it wrongly says "no" hides the only
 *  action that would.
 */
import { describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';

import {
  PACK_INSTALL_OFFER_ATTR,
  PACK_INSTALL_OFFER_REF_ATTR,
  PACK_INSTALL_OFFER_STYLES,
  missingPacksFromError,
  renderPackInstallOffer,
} from '../shell/pack-install-offer.js';

const packError = (packs: unknown): RpcError =>
  new RpcError('pack_not_installed', 'needs packs', 400, undefined, { missing_packs: packs });

describe('missingPacksFromError', () => {
  it('reads the typed list off a pack_not_installed error', () => {
    expect(missingPacksFromError(packError(['recued-core.docling', 'recued-core.whisper'])))
      .toEqual(['recued-core.docling', 'recued-core.whisper']);
  });

  it('accepts a structurally-shaped error that crossed a module boundary', () => {
    // Same allowance `rpc-error-copy`'s own `codeOf` makes — an RpcError that
    // lost its prototype must not silently stop offering.
    expect(missingPacksFromError({
      code: 'pack_not_installed',
      details: { missing_packs: ['recued-core.ffmpeg'] },
    })).toEqual(['recued-core.ffmpeg']);
  });

  it('returns null for any other error', () => {
    expect(missingPacksFromError(new RpcError('bad_request', 'nope', 400))).toBeNull();
    expect(missingPacksFromError(new Error('plain'))).toBeNull();
    expect(missingPacksFromError(null)).toBeNull();
    expect(missingPacksFromError('a string')).toBeNull();
  });

  // ⛔ The code alone is not enough. An offer built from an empty or malformed
  // list renders a heading promising an install with no button under it — which
  // reads as a broken UI rather than as the plain error it actually is.
  it('returns null when the code is right but the list is unusable', () => {
    expect(missingPacksFromError(packError([]))).toBeNull();
    expect(missingPacksFromError(packError('recued-core.docling'))).toBeNull();
    expect(missingPacksFromError(packError([1, 2]))).toBeNull();
    expect(missingPacksFromError(packError(['', '  ']))).toEqual(['  ']); // non-empty strings only
    expect(missingPacksFromError(new RpcError('pack_not_installed', 'x', 400))).toBeNull();
  });

  // ⛔ NEVER the message. The server sets the typed field so no surface parses
  // prose; a fallback here would become the real contract the first time the
  // wording changed.
  it('does not mine the message when the typed field is absent', () => {
    expect(missingPacksFromError(
      new RpcError('pack_not_installed', 'pack not installed: recued-core.docling', 400),
    )).toBeNull();
  });
});

describe('renderPackInstallOffer', () => {
  it('renders one link per pack, addressing the real install flow', () => {
    const html = renderPackInstallOffer(['recued-core.docling', 'recued-core.whisper']);
    expect(html).toContain(PACK_INSTALL_OFFER_ATTR);
    expect(html.match(/<a /g)).toHaveLength(2);
    // The pack surface owns install + its consent dialog; this only points there.
    expect(html).toContain('href="#packs/docling"');
    expect(html).toContain('href="#packs/whisper"');
    // The full ref stays readable as data even though the user sees the slug.
    expect(html).toContain(`${PACK_INSTALL_OFFER_REF_ATTR}="recued-core.docling"`);
    expect(html).toContain('>Get docling</a>');
    // The link text is the only place the name is VISIBLE — a separate label
    // beside it printed the slug twice per row, which read as a duplicate.
    const visible = html.replace(/<[^>]*>/g, ' ');
    expect(visible.match(/docling/g)).toHaveLength(1);
  });

  // ⛔ THE PROPERTY THIS COMPONENT EXISTS TO KEEP. `packs.installBySlug` takes
  // `granted_permissions` + an `expected_manifest_hash` the consent dialog
  // produces. A button here would have to invent that consent — granting
  // whatever the pack asks because a run failed. So: no button, no rpc.
  it('never offers a one-click install that would bypass consent', () => {
    const html = renderPackInstallOffer(['recued-core.officecli']);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('installBySlug');
    expect(html).not.toContain('granted_permissions');
    // The only affordance is a link to the surface that DOES ask.
    expect(html).toContain('href="#packs/officecli"');
  });

  it('says "a pack" for one and "packs" for several', () => {
    expect(renderPackInstallOffer(['recued-core.docling']))
      .toMatch(/needs a pack .*Install it/s);
    expect(renderPackInstallOffer(['a.b', 'c.d']))
      .toMatch(/needs packs .*Install them/s);
  });

  it('renders nothing for an empty list', () => {
    expect(renderPackInstallOffer([])).toBe('');
  });

  it('escapes every interpolated value', () => {
    const html = renderPackInstallOffer(['x.<script>alert(1)</script>']);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // …including inside the href, where a raw quote or angle bracket would
    // break out of the attribute. `serializeShellRoute` percent-encodes the
    // segment and the result is escaped again on the way into the attribute.
    const href = /href="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(href.length).toBeGreaterThan(0);
    expect(href).not.toMatch(/[<>"']/);
  });

  it('uses canonical theme tokens so it reads in light and dark', () => {
    expect(PACK_INSTALL_OFFER_STYLES).toContain('var(--fg)');
    expect(PACK_INSTALL_OFFER_STYLES).toContain('var(--surface-sunk)');
    // The tokens this app does not define — a stylesheet naming one renders
    // unstyled in exactly one theme, which a render test cannot see.
    expect(PACK_INSTALL_OFFER_STYLES).not.toMatch(/--(?:text|text-muted|surface-2|radius)\b/);
  });
});

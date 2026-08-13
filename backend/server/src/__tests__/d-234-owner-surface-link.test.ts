/** D-234 § 234.3 — a recipe NAMES where its output is read; the HOST turns that
 *  name into an absolute link.
 *
 *  ⛔⛔ THE HALF THAT ALMOST SHIPPED SILENT. The message field is fine — every
 *  messenger channel appends `link_url` and the `/ask` landing renders it — but
 *  `handlePendingAsks` rebuilds each ask as a LITERAL, so the in-app card would
 *  have shown no link no matter what the raiser set. An enumerating copier is
 *  invisible: nothing fails, the field is simply not there. The projection test
 *  below is a ratchet against exactly that, and it is the reason this file
 *  reaches across the host boundary into the wire projection and the card.
 *
 *  What is asserted here, end to end minus the two live servers (the drive owns
 *  those): resolve → carry → project → render, plus every way to have NO link.
 */
import { describe, expect, it } from 'vitest';

import {
  buildAskLandingAnswerLink,
  buildOwnerSurfaceLink,
  resolveOwnerSurfaceUrl,
  resolvePublicBaseUrl,
} from '../ask-landing-answer-link.js';
import { buildPeerAdmissionAsk } from '../peer-admission-ask.js';
import { handlePendingAsks } from '../history-handler.js';

describe('D-234 § 234.3 — buildOwnerSurfaceLink', () => {
  it('is null on a server with no public base URL', () => {
    expect(buildOwnerSurfaceLink(null)).toBeNull();
  });

  it('has the SAME binary presence as the answer link', () => {
    // ⛔ THE PROPERTY, NOT A COINCIDENCE: an owner who can be ASKED on a channel
    // must also be able to READ from it. If one resolved and the other did not,
    // a deployment could send a decision card with no way to see the subject.
    for (const raw of [undefined, '', 'not a url', 'http://localhost:7777',
                       'https://alice.recued.app']) {
      const base = resolvePublicBaseUrl(raw);
      expect(buildOwnerSurfaceLink(base) === null)
        .toBe(buildAskLandingAnswerLink(base) === null);
    }
  });

  it('builds the webclient recipe route as an ABSOLUTE url', () => {
    const link = buildOwnerSurfaceLink(resolvePublicBaseUrl('https://alice.recued.app'));
    expect(link).not.toBeNull();
    // ⚠ Absolute, not a fragment: this string is appended raw into a Telegram
    // message and passed through `safeHttpUrl` at the landing, both of which a
    // bare '#recipes/...' would fail.
    expect(link!('show-federated-project'))
      .toBe('https://alice.recued.app/#recipes/show-federated-project');
  });

  it('encodes a publisher-qualified id rather than emitting a bare slash', () => {
    const link = buildOwnerSurfaceLink(resolvePublicBaseUrl('https://alice.recued.app'))!;
    expect(link('recued-core/show-federated-project'))
      .toBe('https://alice.recued.app/#recipes/recued-core%2Fshow-federated-project');
  });
});

describe('D-234 § 234.3 — the entry ask carries it', () => {
  const base = {
    admission_identity: 'idhash',
    recipe_id: 'peer-apply-project-update',
    contract_id: 'ctr_1',
    connection_name: 'peer-alice',
  };

  it('sets link_url when the host resolved one', () => {
    const { message } = buildPeerAdmissionAsk({
      ...base,
      owner_surface_url: 'https://bob.recued.app/#recipes/show-federated-project',
    });
    expect(message.link_url).toBe('https://bob.recued.app/#recipes/show-federated-project');
  });

  it('omits the field entirely when the host resolved none', () => {
    const { message } = buildPeerAdmissionAsk(base);
    expect('link_url' in message).toBe(false);
  });

  it('still puts NO peer content in the card', () => {
    // ⛔ The link exists so the content does NOT have to be here. The ask id is
    // a bearer capability; the link's destination sits behind pairing.
    const { message, handler } = buildPeerAdmissionAsk({
      ...base,
      owner_surface_url: 'https://bob.recued.app/#recipes/show-federated-project',
    });
    expect(message.text).not.toMatch(/https?:\/\//);
    expect(Object.keys(handler.payload).sort())
      .toEqual(['admission_identity', 'contract_id', 'recipe_id']);
  });
});

describe('D-234 § 234.3 — the wire projection is an enumerating copier', () => {
  const ask = (message: { text: string; link_url?: string }) => ({
    ask_id: 'ask_1',
    message,
    options: [{ id: 'accept', label: 'Accept' }],
    created_at: 1,
    status: 'open' as const,
  });

  it('forwards link_url to the in-app card', async () => {
    // ⛔⛔ THE RATCHET. `handlePendingAsks` names each field it copies, so a
    // message field nobody named is dropped between the raiser and the only
    // surface most owners look at. This assertion fails the moment that
    // literal stops naming `link_url` — the failure mode has no other tell.
    const res = await handlePendingAsks({
      listOpenAsks: async () => [
        ask({ text: 'a peer asked', link_url: 'https://bob.recued.app/#recipes/x' }),
      ],
    } as never);
    expect(res.asks[0]!.link_url).toBe('https://bob.recued.app/#recipes/x');
  });

  it('omits it when the ask had none', async () => {
    const res = await handlePendingAsks({
      listOpenAsks: async () => [ask({ text: 'a peer asked' })],
    } as never);
    expect('link_url' in res.asks[0]!).toBe(false);
  });
});

describe('D-234 § 234.3 — the three ways to have no link', () => {
  const link = buildOwnerSurfaceLink(resolvePublicBaseUrl('https://bob.recued.app'))!;
  const installed = (id: string) => id === 'show-federated-project';

  it('resolves when the surface is named, installed, and the server is public', () => {
    expect(resolveOwnerSurfaceUrl('show-federated-project', installed, link))
      .toBe('https://bob.recued.app/#recipes/show-federated-project');
  });

  it('1 · no name — the recipe declared no surface', () => {
    for (const absent of [undefined, '', null, 42, {}]) {
      expect(resolveOwnerSurfaceUrl(absent, installed, link)).toBeUndefined();
    }
  });

  it('2 · no public base URL — the host resolved no link builder', () => {
    expect(resolveOwnerSurfaceUrl('show-federated-project', installed, undefined))
      .toBeUndefined();
  });

  it('3 · NOT INSTALLED HERE — the name came from the sender, not this server', () => {
    // ⛔⛔ THE ONE A LIVE DRIVE CANNOT ARRANGE, because a drive ships both halves
    // of its own pack. The `owner_surface` name is authored by the SENDER's
    // recipe and resolved on the RECEIVER, so it can name a recipe this server
    // has never had — and the resulting dead link would land in the only
    // notification the owner gets, saying "nothing here" and "could not find it"
    // at the same time.
    expect(resolveOwnerSurfaceUrl('peer-review-pendng', installed, link))
      .toBeUndefined();
    expect(resolveOwnerSurfaceUrl('some-pack-i-never-installed', installed, link))
      .toBeUndefined();
  });

  it('checks installedness BEFORE building — never builds then discards', () => {
    // If the order inverted, a link would be minted for an uninstalled recipe
    // and only then thrown away — one refactor from being returned.
    const built: string[] = [];
    resolveOwnerSurfaceUrl('not-here', installed, (id) => { built.push(id); return id; });
    expect(built).toEqual([]);
  });
});

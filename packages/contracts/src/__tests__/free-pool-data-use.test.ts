/** T3-AUD-1 — the free-tier data-use disclosure.
 *
 *  These assertions are about a CLAIM WE MAKE TO THE OWNER about a third
 *  party's legal terms, so they pin the facts and the citation, not just the
 *  plumbing. A wrong reassurance here is worse than no surface at all. */

import { describe, expect, it } from 'vitest';
import {
  resolveFreePoolDataUse,
  freePoolDataUseNotice,
} from '../free-pool-data-use.js';

describe('T3-AUD-1 — resolveFreePoolDataUse', () => {
  it('knows Google via the NATIVE provider id, which carries no base_url', () => {
    // A `google` entry speaks Google's own API through the native adapter, so
    // the entry has no `base_url` to key on — the provider id is the only
    // handle, and missing that path would silently drop the one provider whose
    // terms actually restrict use.
    const use = resolveFreePoolDataUse({ provider: 'google' });
    expect(use.kind).toBe('known');
    if (use.kind !== 'known') return;
    expect(use.terms.trains_on_input).toBe(true);
    expect(use.terms.human_review).toBe(true);
    expect(use.terms.no_sensitive_data).toBe(true);
    expect(use.terms.geo_restricted).toEqual(['EEA', 'Switzerland', 'UK']);
    // The citation travels with the fact — terms change, and a stale claim
    // about someone else's legal terms is the failure mode here.
    expect(use.terms.source_url).toBe('https://ai.google.dev/gemini-api/terms');
    expect(use.terms.effective).toBe('2026-03-23');
    // Round-12 audit fix (T3 Q-1) — the check stamp travels too: `effective`
    // is the DOCUMENT's date and can stand while the document is revised
    // (observed: revision 2026-04-28 behind an unchanged effective date).
    expect(use.terms.checked_at).toBe('2026-08-19');
    expect(use.terms.doc_last_updated).toBe('2026-04-28');
  });

  it('knows the same provider reached as openai-compatible via its host', () => {
    // The same traffic, configured the other way round. Resolving one and not
    // the other would make the warning depend on how the owner happened to
    // wire it rather than on where their data goes.
    const use = resolveFreePoolDataUse({
      provider: 'openai-compatible',
      base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    });
    expect(use.kind).toBe('known');
  });

  it('treats a local endpoint as local — nothing leaves, so nothing to warn about', () => {
    for (const base_url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://192.168.1.50:11434/v1',
      'http://10.0.0.4:8080/v1',
      'http://172.16.0.9:8080/v1',
      'http://172.31.255.254:8080/v1',
      'http://studio.local:1234/v1',
    ]) {
      expect(resolveFreePoolDataUse({ provider: 'openai-compatible', base_url }).kind)
        .toBe('local');
    }
    expect(freePoolDataUseNotice({ kind: 'local' })).toBeUndefined();
  });

  it('⛔ 172.32 is NOT private — the boundary, because an off-by-one here reassures wrongly', () => {
    // 172.16.0.0–172.31.255.255 is the private block. 172.32.x is public
    // routable space, and calling it local would tell an owner their data
    // stays home when it does not.
    expect(resolveFreePoolDataUse({
      provider: 'openai-compatible', base_url: 'http://172.32.0.1:8080/v1',
    }).kind).toBe('unreviewed');
    expect(resolveFreePoolDataUse({
      provider: 'openai-compatible', base_url: 'http://172.15.0.1:8080/v1',
    }).kind).toBe('unreviewed');
  });

  it('says UNREVIEWED for a provider whose terms nobody read — never "fine"', () => {
    const use = resolveFreePoolDataUse({
      provider: 'openai-compatible', base_url: 'https://openrouter.ai/api/v1',
    });
    expect(use.kind).toBe('unreviewed');
    // And it SPEAKS. Silence would read as approval, which is the whole defect
    // this closes — the absence of a warning was taken as its absence of cause.
    expect(freePoolDataUseNotice(use)).toContain('not reviewed');
  });

  it('⛔ a malformed base_url is not a licence to guess', () => {
    // Substring-matching a provider name out of a broken URL is how a wrong
    // claim about someone else's terms gets shipped. Fall through instead.
    expect(resolveFreePoolDataUse({
      provider: 'openai-compatible', base_url: 'generativelanguage.googleapis.com',
    }).kind).toBe('unreviewed');
    expect(resolveFreePoolDataUse({ provider: 'openai-compatible', base_url: '' }).kind)
      .toBe('unreviewed');
    expect(resolveFreePoolDataUse({}).kind).toBe('unreviewed');
  });

  it('an explicit base_url WINS over the native provider id', () => {
    // A `google`-provider entry pointed at a local proxy is local. Reading the
    // provider first would warn about Google for traffic that never reaches it.
    expect(resolveFreePoolDataUse({
      provider: 'google', base_url: 'http://localhost:8080/v1',
    }).kind).toBe('local');
  });
});

describe('T3-AUD-1 — freePoolDataUseNotice', () => {
  it('states every clause the owner is actually agreeing to, and cites it', () => {
    const notice = freePoolDataUseNotice(resolveFreePoolDataUse({ provider: 'google' }));
    expect(notice).toBeDefined();
    const text = notice ?? '';
    expect(text).toContain('trains on what you send');
    expect(text).toContain('human reviewers may read it');
    expect(text).toContain('not to send sensitive or personal data');
    // The geo bar is the clause with legal teeth for a large part of the
    // sovereignty-motivated audience, so it is stated separately and plainly.
    expect(text).toContain('only PAID use');
    expect(text).toContain('EEA, Switzerland, UK');
    expect(text).toContain('https://ai.google.dev/gemini-api/terms');
    // Round-12 audit fix (T3 Q-1) — the notice distinguishes the document's
    // own date from when WE last verified it, so "still true" and "not looked
    // at since" stop reading identically to the owner.
    expect(text).toContain('effective 2026-03-23');
    expect(text).toContain('verified 2026-08-19');
  });

  it('⛔⛔ a HOSTNAME whose first labels look private is NOT local — and it SPEAKS', () => {
    // `isLocalHost` matched `h.startsWith('10.')` / `startsWith('192.168.')` /
    // `/^172\.(\d{1,2})\./`, so these ordinary DNS names — which resolve
    // wherever their owner points them — all classified `local`. Driven live.
    for (const base_url of [
      'https://10.evil.com/v1',
      'https://192.168.example.com/v1',
      'https://172.16.attacker.net/v1',
      'https://10.0.0.5.nip.io/v1',   // five labels, every one numeric
    ]) {
      const use = resolveFreePoolDataUse({ provider: 'openai-compatible', base_url });
      expect(use.kind, base_url).toBe('unreviewed');
      // 🔑 THE ASSERTION THAT MATTERS IS THE OWNER-VISIBLE ONE. `local` is the
      // one kind whose notice is `undefined`, and this suite's own words for
      // that silence are "nothing leaves, so nothing to warn about". Checking
      // only `.kind` would pass for any non-local kind; checking the notice
      // pins that the owner is actually TOLD something.
      expect(freePoolDataUseNotice(use), base_url).toContain('not reviewed');
    }
  });

  it('⛔ and the fix did not over-tighten — real private literals stay local', () => {
    // The failure mode of the repair is the mirror image: a parser strict
    // enough to reject `10.evil.com` must still accept `10.0.0.4`, or every
    // genuinely local endpoint starts nagging its owner and the notice gets
    // trained away. Boundary values included deliberately.
    for (const base_url of [
      'http://10.0.0.4:8080/v1',
      'http://10.255.255.255:8080/v1',
      'http://192.168.1.50:11434/v1',
      'http://172.16.0.9:8080/v1',
      'http://172.31.255.254:8080/v1',
    ]) {
      expect(resolveFreePoolDataUse({ provider: 'openai-compatible', base_url }).kind, base_url)
        .toBe('local');
    }
  });
});

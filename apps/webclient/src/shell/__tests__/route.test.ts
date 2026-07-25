/** §D.shell — the central `#surface/subview/item[/subtab]` router (R16).
 *
 *  Replaces the prior split scheme (`#surface` + a per-surface `?key=value`
 *  tail). These tests pin: surface resolution + the default fall-through, the
 *  decoded positional segment tail (incl. a `/`-bearing `publisher/name` id),
 *  serialize↔parse round-tripping, normalization, and the deep-link remount
 *  decision the shell's hash listener leans on.
 */
import { describe, expect, it } from 'vitest';
import {
  WEBCLIENT_DEFAULT_ROUTE,
  WEBCLIENT_DEEP_LINK_ROUTES,
  WEBCLIENT_ROUTE_IDS,
  kitchenEditRecipeId,
  kitchenNewRecipeSeed,
  kitchenPackDraftId,
  normalizeShellHash,
  parseRouteFromHash,
  parseShellRoute,
  serializeShellRoute,
  shellItem,
  shellSubtab,
  shellSubview,
  shouldRemountForSameRoute,
} from '../route.js';

describe('§D.shell — parseShellRoute', () => {
  it('resolves a bare surface with no segments', () => {
    expect(parseShellRoute('#logs')).toEqual({ surface: 'logs', segments: [] });
  });

  it('tolerates a missing `#`, a leading `/`, and a `#/` combo', () => {
    expect(parseShellRoute('logs').surface).toBe('logs');
    expect(parseShellRoute('/logs').surface).toBe('logs');
    expect(parseShellRoute('#/logs').surface).toBe('logs');
  });

  it('splits the positional segment tail after the surface', () => {
    expect(parseShellRoute('#contracts/abc/ops')).toEqual({
      surface: 'contracts',
      segments: ['abc', 'ops'],
    });
    expect(parseShellRoute('#connections/mail/acct-1')).toEqual({
      surface: 'connections',
      segments: ['mail', 'acct-1'],
    });
  });

  it('URL-decodes each segment (space + a `/`-bearing publisher/name id)', () => {
    expect(parseShellRoute('#logs/run%202').segments).toEqual(['run 2']);
    // A `publisher/name` recipe id encodes its slash as %2F so it stays ONE
    // segment rather than splitting into two.
    expect(parseShellRoute('#recipes/recued-core%2Fmail-post').segments).toEqual([
      'recued-core/mail-post',
    ]);
  });

  it('collapses empty segments (a trailing or doubled slash)', () => {
    expect(parseShellRoute('#logs//run-1/').segments).toEqual(['run-1']);
  });

  it('degrades an unknown surface to the default route', () => {
    expect(parseShellRoute('#bogus/x').surface).toBe(WEBCLIENT_DEFAULT_ROUTE);
    expect(parseShellRoute('').surface).toBe(WEBCLIENT_DEFAULT_ROUTE);
    expect(parseShellRoute('#').surface).toBe(WEBCLIENT_DEFAULT_ROUTE);
  });

  it('tolerates a legacy `?query` tail on the surface but DROPS the value', () => {
    // No compat shim (pre-launch): the surface still resolves, but the old
    // query value is not recovered as a segment.
    expect(parseShellRoute('#reception?foo=bar')).toEqual({
      surface: 'reception',
      segments: [],
    });
    expect(parseShellRoute('#logs?run_id=run-1')).toEqual({
      surface: 'logs',
      segments: [],
    });
  });

  it('never throws on a malformed percent-escape — returns it raw', () => {
    expect(parseShellRoute('#logs/%').segments).toEqual(['%']);
  });
});

describe('§D.shell — parseRouteFromHash (route discriminator)', () => {
  it('returns just the surface of a deep link', () => {
    expect(parseRouteFromHash('#logs/run-1')).toBe('logs');
    expect(parseRouteFromHash('#settings/ai-models')).toBe('settings');
    expect(parseRouteFromHash('#contracts/<id>/ops')).toBe('contracts');
  });

  it('falls back to the default for empty / unknown hashes', () => {
    expect(parseRouteFromHash('')).toBe(WEBCLIENT_DEFAULT_ROUTE);
    expect(parseRouteFromHash('#nope')).toBe(WEBCLIENT_DEFAULT_ROUTE);
  });
});

describe('§D.shell — segment aliases', () => {
  it('names segments 0/1/2 as subview/item/subtab', () => {
    const route = parseShellRoute('#contracts/c-1/entities/data.mail');
    expect(shellSubview(route)).toBe('c-1');
    expect(shellItem(route)).toBe('entities');
    expect(shellSubtab(route)).toBe('data.mail');
  });

  it('returns null for an absent segment', () => {
    const route = parseShellRoute('#logs');
    expect(shellSubview(route)).toBeNull();
    expect(shellItem(route)).toBeNull();
    expect(shellSubtab(route)).toBeNull();
  });
});

describe('§D.shell — kitchenEditRecipeId (Edit→Kitchen)', () => {
  it('resolves the recipe id from `#kitchen/recipe/<id>`', () => {
    expect(kitchenEditRecipeId(parseShellRoute('#kitchen/recipe/daily-brief'))).toBe(
      'daily-brief',
    );
    // Slash-bearing publisher/name ids survive the encoded round-trip.
    expect(
      kitchenEditRecipeId(parseShellRoute(serializeShellRoute('kitchen', 'recipe', 'recued-core/mail-post'))),
    ).toBe('recued-core/mail-post');
  });

  it('returns null for the pack editor + bare kitchen (→ pack editor falls through)', () => {
    expect(kitchenEditRecipeId(parseShellRoute('#kitchen'))).toBeNull();
    expect(kitchenEditRecipeId(parseShellRoute('#kitchen/pack'))).toBeNull();
    expect(kitchenEditRecipeId(parseShellRoute('#kitchen/pack/draft-1'))).toBeNull();
    // `#kitchen/recipe` with no id → null (malformed; degrades to pack editor).
    expect(kitchenEditRecipeId(parseShellRoute('#kitchen/recipe'))).toBeNull();
  });

  it('returns null when the surface is not kitchen', () => {
    expect(kitchenEditRecipeId(parseShellRoute('#recipes/recipe/x'))).toBeNull();
  });
});

describe('§D.shell — kitchenNewRecipeSeed', () => {
  it('resolves a form-response seed without confusing it with an installed recipe', () => {
    const hash = serializeShellRoute(
      'kitchen',
      'new',
      'form-response',
      'forms/client intake',
    );
    const route = parseShellRoute(hash);
    expect(kitchenNewRecipeSeed(route)).toEqual({
      kind: 'form_response',
      form_definition_id: 'forms/client intake',
    });
    expect(kitchenEditRecipeId(route)).toBeNull();
    expect(kitchenEditRecipeId(parseShellRoute('#kitchen/recipe/new'))).toBe('new');

    const paddedId = '  forms/client intake  ';
    expect(kitchenNewRecipeSeed(parseShellRoute(serializeShellRoute(
      'kitchen',
      'new',
      'form-response',
      paddedId,
    )))?.form_definition_id).toBe(paddedId);
  });

  it('fails closed for incomplete, unrelated, and empty seed routes', () => {
    expect(kitchenNewRecipeSeed(parseShellRoute('#kitchen/new'))).toBeNull();
    expect(kitchenNewRecipeSeed(parseShellRoute('#kitchen/new/form-response'))).toBeNull();
    expect(kitchenNewRecipeSeed(parseShellRoute('#kitchen/new/other/form-1'))).toBeNull();
    expect(
      kitchenNewRecipeSeed(parseShellRoute('#kitchen/new/form-response/form-1/extra')),
    ).toBeNull();
    expect(kitchenNewRecipeSeed(parseShellRoute('#recipes/new/form-response/form-1'))).toBeNull();
  });
});

describe('§D.shell — kitchenPackDraftId (Edit→Kitchen pack editor)', () => {
  it('resolves the draft id from `#kitchen/pack/<draft_id>`', () => {
    expect(kitchenPackDraftId(parseShellRoute('#kitchen/pack/draft-1'))).toBe('draft-1');
  });

  it('returns null for `#kitchen/pack` (fresh) and bare `#kitchen`', () => {
    expect(kitchenPackDraftId(parseShellRoute('#kitchen/pack'))).toBeNull();
    expect(kitchenPackDraftId(parseShellRoute('#kitchen'))).toBeNull();
  });

  it('does not treat the recipe-editor marker as a pack draft', () => {
    expect(kitchenPackDraftId(parseShellRoute('#kitchen/recipe/r-1'))).toBeNull();
  });

  it('returns null when the surface is not kitchen', () => {
    expect(kitchenPackDraftId(parseShellRoute('#packs/pack/x'))).toBeNull();
  });
});

describe('§D.shell — serializeShellRoute', () => {
  it('builds a bare-surface hash', () => {
    expect(serializeShellRoute('chat')).toBe('#chat');
  });

  it('joins an ordered segment tail', () => {
    expect(serializeShellRoute('settings', 'ai-models')).toBe('#settings/ai-models');
    expect(serializeShellRoute('contracts', 'c-1', 'ops')).toBe('#contracts/c-1/ops');
  });

  it('drops null / undefined / empty segments', () => {
    expect(serializeShellRoute('logs', null, undefined, '')).toBe('#logs');
    expect(serializeShellRoute('logs', 'run-1', undefined)).toBe('#logs/run-1');
  });

  it('URL-encodes segment values so a `/` or space survives the path', () => {
    expect(serializeShellRoute('recipes', 'recued-core/mail-post')).toBe(
      '#recipes/recued-core%2Fmail-post',
    );
    expect(serializeShellRoute('logs', 'run 2')).toBe('#logs/run%202');
  });

  it('round-trips parse(serialize(...)) for slash + space bearing ids', () => {
    for (const id of ['recued-core/mail-post', 'run 2', 'plain-id', 'a/b/c']) {
      const route = parseShellRoute(serializeShellRoute('recipes', id));
      expect(route).toEqual({ surface: 'recipes', segments: [id] });
    }
  });
});

describe('§D.shell — normalizeShellHash', () => {
  it('canonicalizes leading slash, query tail, and doubled slashes', () => {
    expect(normalizeShellHash('#/logs?run_id=x')).toBe('#logs');
    expect(normalizeShellHash('logs//run-1/')).toBe('#logs/run-1');
    expect(normalizeShellHash('#recipes/mail%2Fsend')).toBe('#recipes/mail%2Fsend');
  });
});

describe('§D.shell — shouldRemountForSameRoute', () => {
  it('re-mounts a deep-link surface when the segment changes', () => {
    expect(shouldRemountForSameRoute('logs', '#logs/a', '#logs/b')).toBe(true);
    // list → detail (no segment → a segment) also re-mounts.
    expect(shouldRemountForSameRoute('logs', '#logs', '#logs/a')).toBe(true);
    // R18 — Data is a deep-link surface (`#data/<tab>/<entity_id>`).
    expect(shouldRemountForSameRoute('data', '#data', '#data/mail')).toBe(true);
    expect(shouldRemountForSameRoute('data', '#data/mail', '#data/mail/m-1')).toBe(true);
    // Contracts list categories are addressable tabs on the same surface.
    expect(
      shouldRemountForSameRoute(
        'contracts',
        '#contracts/view/built-in',
        '#contracts/view/customer',
      ),
    ).toBe(true);
    // R22 — Packs is a deep-link surface (`#packs/<slug>`).
    expect(shouldRemountForSameRoute('packs', '#packs', '#packs/x')).toBe(true);
    // Edit→Kitchen — Kitchen re-mounts to swap the pack editor (`#kitchen`) for
    // the recipe editor (`#kitchen/recipe/<id>`) and back.
    expect(shouldRemountForSameRoute('kitchen', '#kitchen', '#kitchen/recipe/r-1')).toBe(true);
    expect(shouldRemountForSameRoute('kitchen', '#kitchen/recipe/r-1', '#kitchen')).toBe(true);
  });

  it('does NOT re-mount when the normalized hash is unchanged', () => {
    expect(shouldRemountForSameRoute('logs', '#logs/a', '#logs/a')).toBe(false);
    expect(shouldRemountForSameRoute('logs', '#logs/a', '#/logs/a')).toBe(false);
  });

  it('does NOT re-mount a non-deep-link surface even if the tail differs', () => {
    expect(shouldRemountForSameRoute('chat', '#chat', '#chat/x')).toBe(false);
  });

  it('re-mounts the connections surface when the lane tab changes', () => {
    expect(
      shouldRemountForSameRoute('connections', '#connections', '#connections/file'),
    ).toBe(true);
    expect(
      shouldRemountForSameRoute('connections', '#connections/mail', '#connections/mail'),
    ).toBe(false);
  });

  it('R19 — re-mounts the reception surface when the section changes', () => {
    expect(
      shouldRemountForSameRoute('reception', '#reception/inbox', '#reception/abuse'),
    ).toBe(true);
    expect(
      shouldRemountForSameRoute('reception', '#reception', '#reception/endpoints'),
    ).toBe(true);
    expect(
      shouldRemountForSameRoute('reception', '#reception/inbox', '#reception/inbox'),
    ).toBe(false);
  });
});

describe('§D.shell — registry invariants', () => {
  it('the default route is a known route id', () => {
    expect(WEBCLIENT_ROUTE_IDS).toContain(WEBCLIENT_DEFAULT_ROUTE);
  });

  it('every deep-link route is a known route id', () => {
    for (const route of WEBCLIENT_DEEP_LINK_ROUTES) {
      expect(WEBCLIENT_ROUTE_IDS).toContain(route);
    }
  });
});

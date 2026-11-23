/** D-402 slice H1 (§4.2 items 5 and 6) — a browser's lasting identity, and the name its owner gave it.
 *
 *  A browser's routing id (`bridge_id`, D-349) is its pairing token, which a credential rotation
 *  replaces. What lasts is the paired instance the token was issued to (`metadata.instance_id`, stamped
 *  at `/auth/pair`): a rotation's new token inherits it (`client-tokens.ts` `rotate`), and a fresh
 *  pairing mints a new one. So what is keyed by it (a recipe's `browser` setting, the browser a
 *  pre-approval holds, a saved password) stays with the browser through a rotation by construction,
 *  and a fresh pairing is a new browser (ruling 14). A token issued without an instance is its own
 *  identity.
 *
 *  The name is the owner's (`pair.rename` writes `paired_instances.display_name`), else the label the
 *  browser paired with ("Chrome on macOS"). Where two names still collide, the day each was paired is
 *  added, and where even that collides, its place in pairing order. */

export interface PairedBrowser {
  /** The lasting identity: the paired instance, else the token. */
  readonly browser_id: string;
  /** The current pairing token: the routing id (D-349). */
  readonly bridge_id: string;
  /** The owner's name for it, told apart from any other of the same name. */
  readonly name: string;
}

export interface BrowserIdentity {
  /** Every browser paired now, each under its current token and named, in pairing order. */
  list(): PairedBrowser[];
  /** A browser's current token, from its lasting id or from a current token of it. Undefined for a
   *  browser no longer paired (revoked, or replaced by a fresh pairing). */
  bridgeFor(id: string): string | undefined;
  /** D-402 slice H3 — the name a browser went by, to name one no longer paired where a recipe still
   *  names it: its owner's name for the paired instance, else the label its last pairing came with. */
  formerName(id: string): string | undefined;
}

export interface BrowserIdentityDeps {
  /** The Browser Bridge tokens (`client_kind: 'bridge'`), revoked ones included or not: included, a
   *  browser no longer paired keeps the name its pairing came with (`formerName`). */
  readonly tokens: () => ReadonlyArray<{
    readonly token_id: string;
    readonly client_label: string | null;
    readonly issued_at: number;
    readonly revoked_at: number | null;
    readonly metadata: Record<string, unknown> | null;
  }>;
  /** The paired instance a token was issued to (`paired_instances`), if it is known. */
  readonly instance: (instance_id: string) => { readonly display_name: string; readonly revoked_at: number | null } | null | undefined;
}

const instanceOf = (metadata: Record<string, unknown> | null): string | undefined => {
  const id = metadata?.['instance_id'];
  return typeof id === 'string' && id.trim() !== '' ? id : undefined;
};

/** "Nov 3": the day a browser was paired, to tell two of one name apart. */
const pairedDay = (at: number): string => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const createBrowserIdentity = (deps: BrowserIdentityDeps): BrowserIdentity => {
  const list = (): PairedBrowser[] => {
    const rows = deps.tokens()
      .filter((token) => token.revoked_at === null)
      .map((token) => {
        const instance_id = instanceOf(token.metadata);
        const instance = instance_id === undefined ? undefined : deps.instance(instance_id) ?? undefined;
        return { token, instance_id, instance };
      })
      // A token whose paired instance was revoked no longer names a browser.
      .filter((row) => row.instance?.revoked_at == null)
      .sort((a, b) => a.token.issued_at - b.token.issued_at);
    const named = rows.map((row) => ({
      browser_id: row.instance_id ?? row.token.token_id,
      bridge_id: row.token.token_id,
      base: row.instance?.display_name.trim() || row.token.client_label?.trim() || row.token.token_id,
      at: row.token.issued_at,
    }));
    const count = (names: readonly string[], name: string): number => names.filter((one) => one === name).length;
    const bases = named.map((row) => row.base);
    const dated = named.map((row) => (count(bases, row.base) > 1 ? `${row.base} (paired ${pairedDay(row.at)})` : row.base));
    return named.map((row, index) => {
      const name = dated[index]!;
      const same = dated.filter((one) => one === name).length;
      const place = dated.slice(0, index).filter((one) => one === name).length + 1;
      return { browser_id: row.browser_id, bridge_id: row.bridge_id, name: same > 1 ? `${name} #${String(place)}` : name };
    });
  };
  return {
    list,
    bridgeFor: (id) => list().find((browser) => browser.bridge_id === id || browser.browser_id === id)?.bridge_id,
    formerName: (id) => {
      const owners = deps.instance(id)?.display_name.trim();
      if (owners) return owners;
      const last = deps.tokens().filter((token) => token.token_id === id || instanceOf(token.metadata) === id)
        .sort((a, b) => b.issued_at - a.issued_at)[0];
      return last?.client_label?.trim() || undefined;
    },
  };
};

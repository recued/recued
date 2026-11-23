/** D-405 slice 4 — `?setup=demo`: the Set up page's reads as a new server answers them. No mailbox, a
 *  calendar of the owner's, no file source; Body signals installed with no Body; one hint set aside, kept
 *  in `window.__setupHints` so "Show it again" is seen to take it away. D-405 slice 9 — a mailbox connected
 *  elsewhere while the page is open: `window.__setupMailConnected`. */
interface HintSetAside { key: string; label: string; until: number }

export const setupRpc = (method: string, args: unknown): { result: unknown } | undefined => {
  const page = window as unknown as { __setupHints?: HintSetAside[]; __setupMailConnected?: boolean };
  if (method === 'chat.setup.features') {
    return { result: { features: [{ feature: 'mail', connected: page.__setupMailConnected === true }, { feature: 'calendar', connected: true },
      { feature: 'file', connected: false }] } };
  }
  if (method === 'packs.list') {
    return { result: { packs: [{ slug: 'body-signals', name: 'Body signals', installed: true, publisher: 'recued-core',
      missing_things: [{ type_id: 'body', type_name: 'Body' }] }] } };
  }
  if (method === 'packs.unrunnable') return { result: { findings: [] } };
  if (method === 'packs.tool_status') return { result: { packs: [] } };
  if (method === 'chat.hints.list') {
    page.__setupHints ??= [{ key: 'feature:file', label: 'Connect your files', until: Date.now() + 86_400_000 }];
    return { result: { not_now: page.__setupHints } };
  }
  if (method === 'chat.hints.restore') {
    const { key } = args as { key: string };
    const before = page.__setupHints ?? [];
    page.__setupHints = before.filter((hint) => hint.key !== key);
    return { result: { restored: page.__setupHints.length !== before.length } };
  }
  return undefined;
};

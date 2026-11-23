import type { BrowserControlLookup } from '@recued/contracts';
import { controlsSaid, type OutlineControl } from './page-outline.js';

/** Grounded choices only. Ordering does not authorize an action or broaden the
 * active interaction; background controls and invalid refs stay excluded. */
export const browserControlRecovery = (controls: readonly OutlineControl[],
  source: { page: string; url?: string } | undefined, partial: boolean): { lookup?: BrowserControlLookup; description: string } => {
  if (!source || source.page.length === 0 || source.page.length > 512) return { description: '' };
  const priority = (control: OutlineControl) => control.landmark === 'dialog' ? 0 : control.landmark === 'main' ? 1
    : control.landmark === 'navigation' ? 3 : 2;
  const available = controls.filter(control => !control.blocked);
  const named = available.filter(control => /^e\d{1,31}$/.test(control.ref))
    .sort((a, b) => priority(a) - priority(b));
  const choices = named.slice(0, 6);
  const complete = !partial && (available.length > 0 || controls.length === 0)
    && available.length === named.length && available.length <= 6
    && choices.every(control => (control.names[0] ?? '').length <= 160 && control.kind.length <= 48);
  const lookup: BrowserControlLookup = { source: 'page_read', scope: 'interaction', page: source.page,
    ...(source.url !== undefined && source.url.length <= 2_048 ? { url: source.url } : {}),
    complete, total: available.length,
    controls: choices.map(control => ({ ref: control.ref, kind: control.kind.slice(0, 48), name: (control.names[0] ?? '').slice(0, 160) })) };
  const description = choices.length ? `; observed controls${complete ? '' : ' (partial list)'}: `
    + controlsSaid(choices.map(control => ({ ...control, kind: control.kind.slice(0, 48), names: [(control.names[0] ?? '').slice(0, 160)] }))) : '';
  return { lookup, description };
};

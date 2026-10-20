import type { Asset, YoursAssetSummary } from '@recued/contracts';
import { assetObservationFieldName } from './asset-observation-editor.js';

export const mountAssetSummary = (host: HTMLElement, asset: Asset, summary?: YoursAssetSummary,
  recordFact?: (fact: YoursAssetSummary['missing'][number]) => void) => {
  const doc = host.ownerDocument; const node = doc.createElement('div'); node.dataset.yoursAssetSummary = asset.id; host.append(node);
  const line = (text: string) => { const p = doc.createElement('p'); p.textContent = text; node.append(p); return p; };
  if (asset.sync_state !== 'live') line('Source unavailable; these facts may be out of date.');
  if (!summary || summary.asset_id !== asset.id) { line('Summary unavailable. Open the asset for details.'); return; }
  line(summary.open_tasks ? `${summary.open_tasks} open task${summary.open_tasks === 1 ? '' : 's'}` : 'No open tasks');
  const due = summary.next_due;
  if (due) {
    const label = due.estimated ? 'Estimated due' : due.state === 'overdue' ? 'Overdue' : due.state === 'today' ? 'Due today' : 'Next due';
    line(`${label}: ${due.title} · ${due.on}${due.estimated && due.state !== 'upcoming' ? ` · ${due.state === 'today' ? 'today' : 'overdue'}` : ''}`);
  } else line(!['active', 'lent'].includes(asset.status) ? 'Rules inactive for this asset.' : !summary.active_rules ? 'No active rules.' : 'No due date known.');
  if (summary.missing.length) {
    line(`Missing facts (${summary.missing.length}):`);
    const facts = (parent: HTMLElement, rows: YoursAssetSummary['missing']) => {
      const list = doc.createElement('ul'); list.dataset.yoursMissingFacts = ''; parent.append(list);
      for (const fact of rows) {
        const [kind, field, extra] = fact.path.split('.'); const title = field ? assetObservationFieldName(field) : fact.path;
        const name = `${title}${kind === 'readings' ? ' reading' : kind === 'observations' ? ' condition' : ''}`;
        const text = fact.reason === 'unknown' ? name : `${fact.reason === 'future' ? 'Current' : 'Confirmed'} ${name[0]!.toLowerCase()}${name.slice(1)}`;
        const item = doc.createElement('li'); list.append(item);
        const map = kind === 'dates' ? asset.dates : kind === 'readings' ? asset.readings : kind === 'observations' ? asset.observations : undefined;
        if (recordFact && asset.sync_state === 'live' && asset.deleted_at == null && ['active', 'lent'].includes(asset.status)
          && map && field && !extra && Object.hasOwn(map, field)) {
          const button = doc.createElement('button'); button.type = 'button'; button.textContent = text;
          button.dataset.yoursFocus = `missing:${asset.id}:${fact.path}`;
          button.setAttribute('aria-label', `Record ${text[0]!.toLowerCase()}${text.slice(1)} for ${asset.name}`);
          button.addEventListener('click', () => recordFact(fact)); item.append(button);
        } else item.textContent = text;
      }
    };
    facts(node, summary.missing.slice(0, 3));
    if (summary.missing.length > 3) {
      const more = doc.createElement('details'); more.dataset.yoursMoreFacts = ''; node.append(more);
      const toggle = doc.createElement('summary'); const count = summary.missing.length - 3;
      toggle.textContent = `Show ${count} more missing fact${count === 1 ? '' : 's'}`; more.append(toggle);
      facts(more, summary.missing.slice(3));
    }
  }
};

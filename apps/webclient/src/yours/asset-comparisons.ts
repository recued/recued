import type { Asset, AssetReadingComparison, YoursSnapshot } from '@recued/contracts';

/** D-325 — display host calculations from this item's existing owner read.
 * Input links open the actual reading/rule; no AI or context walk is needed. */
export const renderAssetComparisons = (parent: HTMLElement, asset: Asset, packet: YoursSnapshot['reading_comparisons'], recordReading: (field: string, origin: HTMLButtonElement) => void): HTMLElement | undefined => {
  if (packet?.asset_id !== asset.id) return;
  const rows = asset.rules.flatMap(rule => {
    const saved = packet.rules.find(row => row.rule_id === rule.id);
    return rule.when.kind === 'objective' && saved ? [{ rule, when: rule.when, comparison: saved.comparison }] : [];
  });
  if (!rows.length) return;
  const doc = parent.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(host: HTMLElement, tag: K, text?: string) => {
    const item = doc.createElement(tag); if (text !== undefined) item.textContent = text; host.append(item); return item;
  };
  const section = node(parent, 'section'); section.className = 'yours-section'; section.dataset.yoursComparisons = '';
  node(section, 'h2', 'Saved comparisons');
  node(section, 'p', 'Readings alongside the targets you declared.').className = 'yours-muted';
  const grid = node(section, 'div'); grid.className = 'yours-grid';
  const base = `#yours/asset/${encodeURIComponent(asset.id)}/view`;
  for (const { rule, when, comparison } of rows) {
    const card = node(grid, 'article'); card.className = 'yours-card yours-comparison'; card.dataset.yoursComparison = rule.id; card.setAttribute('aria-label', `${rule.title} comparison`);
    const header = node(card, 'div'); header.className = 'yours-comparison-heading'; node(header, 'h3', rule.title);
    node(header, 'span', `${rule.enabled ? 'Enabled' : 'Disabled'}${rule.muted ? ' · muted' : ''}`).className = 'yours-comparison-state';
    node(card, 'p', comparisonHeadline(comparison)).className = 'yours-comparison-gap';
    if (comparison.kind === 'unavailable') node(card, 'p', unavailableWords[comparison.reason]);
    const inputs = node(card, 'dl'); inputs.className = 'yours-comparison-inputs';
    const reading = node(inputs, 'div'); const readingLabel = node(reading, 'dt');
    const value = asset.readings[when.field];
    if (Object.hasOwn(asset.readings, when.field)) inputLink(readingLabel, 'Saved reading', `${base}/overview/reading/${encodeURIComponent(when.field)}`, rule.id, 'reading');
    else node(readingLabel, 'span', 'Saved reading');
    node(reading, 'dd', value ? `${value.value} ${value.unit}` : 'Not recorded');
    if (value && Number.isSafeInteger(value.as_of) && Math.abs(value.as_of) <= 8.64e15) {
      const date = new Date(value.as_of); const caption = node(reading, 'small', 'Observed ');
      const time = node(caption, 'time', date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })); time.dateTime = date.toISOString();
    }
    const target = node(inputs, 'div'); inputLink(node(target, 'dt'), 'Declared target', `${base}/rules/rule/${encodeURIComponent(rule.id)}`, rule.id, 'rule');
    node(target, 'dd', `${when.target} ${when.unit}`); node(target, 'small', `${when.direction === 'rising' ? 'Rising' : 'Falling'} target`);
    if (!value) { const button = node(card, 'button', 'Record reading'); button.type = 'button'; button.dataset.yoursFocus = JSON.stringify(['comparison', rule.id, 'record']); button.addEventListener('click', () => recordReading(when.field, button)); }
    if (comparison.kind === 'compared' && comparison.difference === undefined) node(card, 'small', 'The exact gap is too long to display. No rounded gap is shown.');
    if (when.mode === 'usage' && when.every !== undefined) node(card, 'small', 'This is the stored declared target. Recurring or skipped targets have not been resolved.');
  }
  node(section, 'p', 'Saved numbers only. This does not establish present conditions, whether a rule should act, or a forecast.').className = 'yours-comparison-note';
  return section;
};

const inputLink = (parent: HTMLElement, label: string, href: string, ruleId: string, input: 'reading' | 'rule'): void => {
  const link = parent.ownerDocument.createElement('a'); link.textContent = label; link.href = href;
  link.dataset.yoursFocus = JSON.stringify(['comparison', ruleId, input]); parent.append(link);
};

const comparisonHeadline = (result: AssetReadingComparison): string => {
  if (result.kind === 'unavailable') return 'Not compared';
  if (result.relation === 'equal') return 'At target';
  return `${result.difference === undefined ? '' : `${result.difference} ${result.unit} `}${result.relation} target`;
};
const unavailableWords = {
  unreturned_input: 'The saved input is unavailable in this view.', unknown: 'Record a reading to compare the saved numbers.',
  omitted: 'The reading was omitted from this view.', invalid_reading: 'A number, unit or observation date needs review.',
  unit_mismatch: 'The reading and target use different units. No conversion is assumed.', future: 'The observation is dated in the future. Check its date before comparing.',
};

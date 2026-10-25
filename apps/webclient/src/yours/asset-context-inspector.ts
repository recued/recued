import { assetFactRefKey, type AssetFactContext, type AssetFactContextRequest } from '@recued/contracts';
import { assetSourceWords } from './asset-provenance.js';
import { yoursActions, yoursEmpty } from './yours-view.js';
import { assetRuleWhenWords } from './asset-rule-editor.js';

/** A read-only inspector. Neither opening it nor following a relationship enrolls
 * tracking or grants an automatic writer authority over a field. */
export const mountAssetContextInspector = (host: HTMLElement, request: AssetFactContextRequest, options: {
  read(input: AssetFactContextRequest): Promise<AssetFactContext>;
  isCurrent(): boolean;
  close(): void;
  sourceLink(parent: HTMLElement, ref: { collection: string; id: string }): boolean;
}) => {
  const doc = host.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text?: string) => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; parent.append(element); return element;
  };
  const panel = node(host, 'section'); panel.className = 'yours-editor'; panel.dataset.yoursContext = '';
  const heading = node(panel, 'h2', request.root.kind === 'rule' ? 'Explain this rule' : 'Used by'); heading.tabIndex = -1; heading.dataset.yoursContextHeading = '';
  node(panel, 'p', 'Facts, rules, and supporting sources connected to this item. Values are read when you open or refresh this view.').className = 'yours-muted';
  const body = node(panel, 'div'); body.className = 'yours-content'; body.setAttribute('aria-live', 'polite');
  const actions = yoursActions(panel);
  const refresh = node(actions, 'button', 'Refresh context'); refresh.type = 'button'; refresh.dataset.yoursFocus = 'refresh-context';
  const close = node(actions, 'button', 'Close context'); close.type = 'button'; close.dataset.yoursFocus = 'close-context'; close.addEventListener('click', options.close);
  let loading = false;
  const current = () => options.isCurrent() && panel.isConnected;
  const load = async () => {
    if (loading || !current()) return;
    loading = true; refresh.disabled = true; body.replaceChildren(); body.setAttribute('aria-busy', 'true'); yoursEmpty(body, 'Loading context…');
    try {
      const result = await options.read(request);
      if (!current()) return;
      if (assetFactRefKey(result.root) !== assetFactRefKey(request.root)) throw new Error('This response belongs to another fact. Refresh context to retry.');
      body.replaceChildren();
      node(body, 'p', `Values on file · ${new Date(result.read_at).toLocaleString()}`).className = 'yours-muted';
      if (result.asset.status && ['sold', 'lost', 'retired'].includes(result.asset.status)) node(body, 'p', `This asset is ${result.asset.status}. These are its recorded relationships.`);
      if (result.asset.source_state === 'stale_unreachable') node(body, 'p', 'This source is unavailable. These are the last values on file.');
      if (result.completeness !== 'complete') node(body, 'p', 'Some context could not be included because of access, size, or source limits. This is a partial view.');
      if (result.missing.length) node(body, 'p', `Inputs needing review: ${result.missing.map(ref => ref.field.replaceAll('_', ' ')).join(', ')}.`);
      for (const item of result.nodes) {
        const row = node(body, 'article'); row.className = 'yours-card';
        if (item.kind === 'field') {
          node(row, 'h3', item.label);
          const value = item.value;
          if (item.value_omitted) node(row, 'p', 'Value omitted from this bounded view. Open the asset to review it.');
          else if (!item.known) node(row, 'p', 'Unknown');
          else if (value && typeof value === 'object' && 'value' in value && 'unit' in value) node(row, 'p', `${String(value.value)} ${String(value.unit)}`);
          else if (value && typeof value === 'object' && 'active' in value && 'certainty' in value) node(row, 'p', `${value.active ? 'Present' : 'Clear'} · ${String(value.certainty)}`);
          else node(row, 'p', typeof value === 'object' ? JSON.stringify(value) : String(value));
          if (value && typeof value === 'object' && 'as_of' in value && typeof value.as_of === 'number') node(row, 'small', `Observed ${new Date(value.as_of).toLocaleString()}`);
          if (item.future) node(row, 'p', 'This observation time is in the future. Verify it before relying on the value.');
          if (item.source) { const source = assetSourceWords(item.source); node(row, 'small', `${source.from}. ${source.rank}`); }
          if (item.source_restricted) node(row, 'small', 'Source details are limited by the current access.');
        } else if (item.kind === 'rule') {
          node(row, 'h3', item.title); node(row, 'p', `${assetRuleWhenWords(item.rule.when)} · ${item.rule.enabled ? 'enabled' : 'disabled'}${item.rule.muted ? ' · muted' : ''}`);
          const link = node(row, 'a', 'Open rule on asset'); link.href = `#yours/asset/${encodeURIComponent(item.ref.asset_id)}/view/rules`;
        } else if (item.kind === 'evidence') {
          node(row, 'h3', 'Supporting evidence');
          if (item.evidence.value !== undefined) node(row, 'p', `Recorded evidence: ${String(item.evidence.value)}`);
          if (!options.sourceLink(row, item.evidence)) node(row, 'p', `${item.evidence.collection} · ${item.evidence.id}`);
        } else { node(row, 'h3', item.name); node(row, 'p', item.enabled ? 'Authorized observation writer. Review its availability and handoff in Rules.' : 'Observation writer disabled.'); }
      }
      if (!result.edges.length && result.completeness === 'complete') yoursEmpty(body, 'No connected rules, evidence, or writers are recorded for this item.');
    } catch (error) {
      if (current()) { body.replaceChildren(); const message = node(body, 'p', error instanceof Error ? error.message : 'Context is unavailable. Refresh to retry.'); message.setAttribute('role', 'alert'); }
    } finally { loading = false; if (current()) { refresh.disabled = false; body.setAttribute('aria-busy', 'false'); } }
  };
  refresh.addEventListener('click', () => { void load(); });
  void load(); return { refresh: load };
};

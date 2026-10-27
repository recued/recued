import { assetFactRefKey, type AssetFactContext, type AssetFactContextRequest } from '@recued/contracts';
import { assetEvidenceText, renderAssetSource } from './asset-provenance.js';
import { yoursActions, yoursEmpty } from './yours-view.js';
import { assetRuleWhenWords } from './asset-rule-editor.js';
import { factName } from './fact-words.js';
import { yoursDateTime } from './yours-dates.js';

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
  node(panel, 'p', 'Saved inputs, connected rules and supporting sources. Read fresh when you open or refresh.').className = 'yours-muted';
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
      node(body, 'p', `${result.asset.name} · Values on file · ${yoursDateTime(result.read_at)}`).className = 'yours-muted';
      if (result.asset.status && ['sold', 'lost', 'retired'].includes(result.asset.status)) node(body, 'p', `This asset is ${result.asset.status}. These are its recorded relationships.`);
      if (result.asset.source_state === 'stale_unreachable') node(body, 'p', 'This source is unavailable. These are the last values on file.');
      if (result.completeness !== 'complete') node(body, 'p', 'Some context could not be included because of access, size, or source limits. This is a partial view.');
      if (result.missing.length) node(body, 'p', `Inputs needing review: ${result.missing.map(ref => ref.field.replaceAll('_', ' ')).join(', ')}.`);
      const registry = result.writer_check;
      if (registry && registry.status !== 'not_applicable') {
        const words = registry.status === 'complete'
          ? [registry.enabled_count === undefined ? '' : `${registry.enabled_count} enabled`, registry.disabled_count === undefined ? '' : `${registry.disabled_count} disabled`].filter(Boolean).join(' · ')
          : { partial: 'Only some writer registrations could be checked', restricted: 'Writer registrations are limited by your current access', unavailable: 'Writer registrations are unavailable' }[registry.status];
        if (words) node(body, 'p', `${words}${registry.status === 'complete' ? ' writer registrations' : ''}. Scheduling and current execution have not been checked here.`).className = 'yours-muted';
        if (registry.manual_priority) node(body, 'p', 'Your manual entry has priority.');
      }
      const byRef = new Map(result.nodes.map(item => [assetFactRefKey(item.ref), item]));
      const connections = node(body, 'div'); connections.className = 'yours-relationships';
      for (const edge of result.edges) {
        const from = byRef.get(assetFactRefKey(edge.from)); const to = byRef.get(assetFactRefKey(edge.to));
        if (edge.kind === 'uses' && from?.kind === 'rule' && to?.kind === 'field')
          node(connections, 'p', `${from.title} uses ${factName(to.label)}.`);
        else if (edge.kind === 'updated_by' && from?.kind === 'field' && to?.kind === 'writer')
          node(connections, 'p', `${factName(from.label)} has ${to.enabled ? 'an authorized' : 'a disabled'} writer: ${to.name}.`);
      }
      if (!connections.childElementCount) connections.remove();
      const groups = new Map<string, HTMLElement>();
      for (const item of [...result.nodes].sort((a, b) => ['field', 'rule', 'evidence', 'writer'].indexOf(a.kind) - ['field', 'rule', 'evidence', 'writer'].indexOf(b.kind))) {
        let group = groups.get(item.kind);
        if (!group) { group = node(body, 'section'); group.className = 'yours-context-group';
          node(group, 'h3', { field: 'Saved inputs', rule: 'Connected rules', evidence: 'Supporting evidence', writer: 'Automatic writers' }[item.kind]); groups.set(item.kind, group); }
        const row = node(group, 'article'); row.className = 'yours-card yours-context-row';
        if (item.kind === 'field') {
          node(row, 'h4', factName(item.label));
          const value = item.value;
          if (item.value_omitted) node(row, 'p', 'Value omitted from this bounded view. Open the asset to review it.');
          else if (!item.known) node(row, 'p', 'Unknown');
          else if (value && typeof value === 'object' && 'value' in value && 'unit' in value) node(row, 'p', `${String(value.value)} ${String(value.unit)}`);
          else if (value && typeof value === 'object' && 'active' in value && 'certainty' in value) node(row, 'p', `${value.active ? 'Present' : 'Clear'} · ${String(value.certainty)}`);
          else node(row, 'p', typeof value === 'object' ? JSON.stringify(value) : String(value));
          if (value && typeof value === 'object' && 'as_of' in value && typeof value.as_of === 'number') node(row, 'small', `Observed ${yoursDateTime(value.as_of)}`);
          if (item.future) node(row, 'p', 'This observation time is in the future. Verify it before relying on the value.');
          if (item.source) renderAssetSource(row, item.source, `context:${assetFactRefKey(item.ref)}`);
          if (item.source_restricted) node(row, 'small', 'Source details are limited by the current access.');
          const link = node(row, 'a', 'Open saved field');
          link.href = `#yours/asset/${encodeURIComponent(item.ref.asset_id)}/view/overview/${item.ref.group === 'readings' ? `reading/${encodeURIComponent(item.ref.field)}` : `field/${encodeURIComponent(`${item.ref.group}.${item.ref.field}`)}`}`;
        } else if (item.kind === 'rule') {
          node(row, 'h4', item.title); node(row, 'p', `${assetRuleWhenWords(item.rule.when)} · ${item.rule.enabled ? 'enabled' : 'disabled'}${item.rule.muted ? ' · muted' : ''}`);
          const link = node(row, 'a', 'Open rule on asset'); link.href = `#yours/asset/${encodeURIComponent(item.ref.asset_id)}/view/rules/rule/${encodeURIComponent(item.ref.rule_id)}`;
        } else if (item.kind === 'evidence') {
          node(row, 'h4', assetEvidenceText(item.evidence));
          if (item.evidence.value !== undefined) node(row, 'p', `Recorded evidence: ${String(item.evidence.value)}`);
          if (!options.sourceLink(row, item.evidence)) node(row, 'p', `${item.evidence.collection} · ${item.evidence.id}`);
        } else {
          node(row, 'h4', item.name); node(row, 'p', item.enabled ? 'Authorized observation writer. Review its availability and handoff in Rules.' : 'Observation writer disabled.');
          const delivery = item.delivery;
          if (delivery?.status === 'recorded') {
            const words = { accepted: 'Observation accepted', confirmed: 'Fresh observation confirmed', unchanged: 'No newer observation accepted',
              manual_priority: 'Kept your manual entry', protected_source: 'Kept the higher-priority source', before_handoff: 'Observation predates permission', older_observation: 'Older observation ignored' };
            node(row, 'p', `Last submission · ${yoursDateTime(delivery.last_submission.at)} · ${words[delivery.last_submission.outcome]}`);
            node(row, 'small', `Submitted observation dated ${yoursDateTime(delivery.last_submission.observation_at)}`);
            node(row, 'p', delivery.last_accepted ? `Last accepted · ${yoursDateTime(delivery.last_accepted.at)} · Observation dated ${yoursDateTime(delivery.last_accepted.observation_at)}` : 'No accepted submission receipt on file.');
            node(row, 'small', 'These are settled submissions for this field. Current running state and scheduling have not been checked.');
          } else node(row, 'small', delivery?.status === 'no_receipt' ? 'No submission receipt on file. This does not establish that the writer never ran.' : 'Submission evidence is unavailable.');
        }
      }
      if (!result.edges.length && result.completeness === 'complete') yoursEmpty(body, 'No connected items were returned in this view.');
    } catch (error) {
      if (current()) { body.replaceChildren(); const message = node(body, 'p', error instanceof Error ? error.message : 'Context is unavailable. Refresh to retry.'); message.setAttribute('role', 'alert'); }
    } finally { loading = false; if (current()) { refresh.disabled = false; body.setAttribute('aria-busy', 'false'); } }
  };
  refresh.addEventListener('click', () => { void load(); });
  void load(); return { refresh: load };
};

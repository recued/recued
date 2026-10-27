import type { Asset, AssetClassPreset, AssetRule, Occasion, ProactiveProposal } from '@recued/contracts';
import { assetRuleWhenWords, ruleOffsetWords } from './asset-rule-editor.js';
import { factName } from './fact-words.js';

const offset = ruleOffsetWords;
export const reminderTimingWords = (schedule: AssetRule['schedule'], expiry?: AssetRule['expiry_policy']) => {
  const parts = schedule.before.map(point => `${offset(point)} before`);
  if (schedule.on_day) parts.push('on the day');
  if (schedule.after && expiry === undefined) parts.push(`repeat requested every ${offset(schedule.after)}; review the saved expiry policy`);
  else if (schedule.after && expiry !== 'strict_expire') parts.push(`then every ${offset(schedule.after)}`);
  if (schedule.after && expiry === 'strict_expire') parts.push('ends on the due day');
  return parts.join('; ') || 'No reminder times selected';
};

/** Describe the supplied proposal without fetching or inventing missing context. */
export const proposalPreview = (proposal: ProactiveProposal, context: { assets: Asset[]; classes: AssetClassPreset[]; occasions: Occasion[] }) => {
  const payload = proposal.payload;
  const asset = context.assets.find(row => row.id === payload.asset_id);
  const occasion = context.occasions.find(row => row.id === payload.occasion_id);
  const subject = typeof payload.asset_id === 'string' ? { name: asset?.name ?? 'Open affected asset', href: `#yours/asset/${encodeURIComponent(payload.asset_id)}` }
    : typeof payload.occasion_id === 'string' ? { name: occasion?.title ?? 'Open affected occasion', href: `#yours/occasions/occasion/${encodeURIComponent(payload.occasion_id)}` } : undefined;
  const lines: string[] = [];
  const changes: Array<{ current_label: string; current: string; proposed_label: string; proposed: string }> = [];
  if (proposal.kind === 'rule' && payload.apply_class === true) {
    const preset = context.classes.find(row => row.id === payload.class_id);
    lines.push(`Apply template: ${preset?.name ?? 'the proposed class'}${payload.preset_version ? ` · version ${payload.preset_version}` : ''}`, 'Your edited facts and pinned rules stay yours.');
  } else if (proposal.kind === 'rule' || proposal.kind === 'schedule') {
    const original = (asset?.rules ?? occasion?.rules ?? []).find(row => row.id === payload.rule_id);
    const rule = proposal.kind === 'rule' ? payload.rule as AssetRule | undefined : original;
    try {
      if (rule) {
        lines.push(`Rule: ${rule.title}`, `When: ${assetRuleWhenWords(rule.when)}`);
        if (proposal.kind === 'rule') lines.push(`Creates: ${rule.reaction.occurrence === 'action' ? 'a task to complete' : rule.reaction.occurrence === 'notice' ? 'a notice' : 'no task or notice'}${rule.reaction.notify ? ' and sends reminders' : '; notifications off'}.`);
      } else if (typeof payload.rule_id === 'string') lines.push(`Rule: ${factName(payload.rule_id)}. Review its saved trigger before applying this timing change.`);
      const proposed = proposal.kind === 'schedule' ? payload.schedule as AssetRule['schedule'] : rule?.schedule;
      if (proposal.kind === 'schedule' && proposed) changes.push({ current_label: 'Current reminders',
        current: original ? reminderTimingWords(original.schedule, original.expiry_policy) : 'Not loaded. Review the saved rule before applying.',
        proposed_label: 'Proposed reminders', proposed: reminderTimingWords(proposed, rule?.expiry_policy) });
      else if (proposed) lines.push(`Proposed reminders: ${reminderTimingWords(proposed, rule?.expiry_policy)}`);
    } catch { lines.push('Review the full rule before applying this change.'); }
  } else if (proposal.kind === 'asset' && payload.asset && typeof payload.asset === 'object') {
    const draft = payload.asset as Partial<Asset>;
    if (draft.name) lines.push(`Create asset: ${draft.name}`);
    if (draft.class_id) lines.push(`Type: ${context.classes.find(row => row.id === draft.class_id)?.name ?? factName(draft.class_id)}`);
    for (const [key, value] of Object.entries(draft.dates ?? {}).slice(0, 3)) lines.push(`${factName(key)}: ${value ?? 'Unknown'}`);
  }
  return { subject, lines, changes };
};

import type { Commitment, CommitmentEvidenceEntry, CommitmentMailEvidenceSource } from '@recued/contracts';
import { e } from '../template.js';

const sources: Record<CommitmentMailEvidenceSource, string> = {
  mail: 'Email', calendar: 'Calendar', memory: 'Run activity', engagement_email: 'CRM email',
  engagement_meeting: 'CRM meeting', engagement_note: 'CRM note', engagement_call: 'CRM call',
  engagement_task: 'CRM task', engagement_event: 'CRM event', engagement_email_message: 'CRM email',
  engagement_voice_call: 'CRM voice call', engagement_call_history: 'CRM call history',
};

/** Stored source links are untrusted. A source tab must not replace this reader. */
export const commitmentEvidenceSourceUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^https?:\/\//iu.test(value) || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

const date = (value: number): string => {
  const stamp = new Date(value);
  if (!Number.isFinite(value) || !Number.isFinite(stamp.getTime())) return 'Date unavailable';
  return `<time datetime="${e(stamp.toISOString())}">${e(stamp.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }))}</time>`;
};
const meta = (label: string, value: string): string => `<div><dt>${e(label)}</dt><dd>${value}</dd></div>`;

const renderEntry = (entry: CommitmentEvidenceEntry, index: number): string => {
  let title: string, content: string, metadata = '';
  if (entry.kind === 'crm_field') {
    title = 'CRM field change';
    content = `<dl class="commitment-evidence-values">${meta('Field', e(entry.field))}
      ${meta('Previous value', entry.prev_value === undefined ? 'Not captured' : entry.prev_value === '' ? '(Empty)' : e(entry.prev_value))}
      ${meta('Captured value', e(entry.value))}</dl>`;
  } else if (entry.kind === 'mail') {
    title = `${sources[entry.source] ?? 'Source'} summary`;
    content = `<p class="commitment-evidence-kind">AI-generated summary, not a verbatim quotation.</p><p class="commitment-evidence-text">${e(entry.snippet)}</p>`;
    metadata = meta('Promise made by', e(entry.actor_email)) + meta('Source date', date(entry.source_at));
  } else if (entry.kind === 'message') {
    const summarized = entry.confidence !== undefined;
    title = summarized ? 'Message summary' : 'Message excerpt';
    content = `<p class="commitment-evidence-kind">${summarized ? 'AI-generated summary, not a verbatim quotation.' : 'Captured message text.'}</p>
      ${summarized ? `<p class="commitment-evidence-text">${e(entry.snippet)}</p>` : `<blockquote class="commitment-evidence-text">${e(entry.snippet)}</blockquote>`}`;
    metadata = meta('Messenger', e(entry.vendor)) + meta('Sent', date(entry.sent_at));
  } else {
    return '<li class="commitment-evidence-entry"><p>This saved evidence type cannot be displayed by this version.</p></li>';
  }
  const url = commitmentEvidenceSourceUrl(entry.vendor_url);
  return `<li class="commitment-evidence-entry" data-commitment-evidence-entry="${index}">
    <h3>${e(title)}</h3>${content}
    <dl class="commitment-evidence-meta">${metadata}${meta('Captured', date(entry.captured_at))}</dl>
    ${url ? `<a href="${e(url)}" target="_blank" rel="noopener noreferrer" data-commitment-focus="evidence-source:${index}">Open source <span>(new tab)</span></a>`
      : '<p class="commitment-evidence-unavailable">No source link is available.</p>'}
  </li>`;
};

export const renderCommitmentEvidence = (entity: Pick<Commitment, 'evidence_blob'>): string => {
  const entries = Array.isArray(entity.evidence_blob) ? entity.evidence_blob : [];
  return `<details class="work-entity-commitment-evidence" data-commitment-section="evidence">
    <summary>Why this commitment?${entries.length ? ` <span>${entries.length} ${entries.length === 1 ? 'source' : 'sources'}</span>` : ''}</summary>
    ${entries.length ? `<p class="commitment-evidence-kind">Saved evidence from when this commitment was captured. The original source may have changed.</p>
      <ol class="commitment-evidence-list">${entries.map(renderEntry).join('')}</ol>`
      : '<p>No captured source evidence is available for this commitment.</p>'}
  </details>`;
};

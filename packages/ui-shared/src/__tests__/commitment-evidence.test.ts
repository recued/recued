import { expect, it } from 'vitest';
import type { CommitmentEvidenceEntry } from '@recued/contracts';
import { commitmentEvidenceSourceUrl, renderCommitmentEvidence } from '../work-entity-page/commitment-evidence.js';

const captured = Date.parse('2026-11-20T20:00:00Z'), sourceAt = captured - 86_400_000;
const mail: CommitmentEvidenceEntry = { kind: 'mail', full_target_id: 'mail/source', captured_at: captured,
  source: 'mail', actor_email: 'riley@example.test', source_at: sourceAt, confidence: .8, snippet: 'Riley will send the proposal.' };

it('distinguishes AI summaries, quoted message excerpts and captured CRM values with their actual dates', () => {
  const html = renderCommitmentEvidence({ evidence_blob: [mail,
    { kind: 'message', full_target_id: 'slack/message', vendor: 'slack', actor_platform_id: 'person', captured_at: captured,
      sent_at: sourceAt - 1000, snippet: 'I will send it tomorrow.' },
    { kind: 'message', full_target_id: 'slack/summary', vendor: 'slack', actor_platform_id: 'person', captured_at: captured,
      sent_at: sourceAt, snippet: 'A summary of the message.', confidence: .9 },
    { kind: 'crm_field', full_target_id: 'crm/deal', captured_at: captured, field: 'next_step', prev_value: 'Call tomorrow', value: 'Send the proposal' },
  ] });
  expect(html).toContain('Email summary'); expect(html).toContain('Message excerpt'); expect(html).toContain('Message summary');
  expect(html.match(/AI-generated summary, not a verbatim quotation/g)).toHaveLength(2);
  expect(html).toContain('<blockquote class="commitment-evidence-text">I will send it tomorrow.</blockquote>');
  expect(html).not.toContain('<blockquote class="commitment-evidence-text">A summary');
  expect(html).toContain('CRM field change'); expect(html).toContain('<dt>Previous value</dt><dd>Call tomorrow</dd>');
  expect(html).toContain('<dt>Captured value</dt><dd>Send the proposal</dd>');
  expect(html).toContain('<dt>Source date</dt><dd><time datetime="2026-11-19T20:00:00.000Z"');
  expect(html).toContain('<dt>Sent</dt><dd><time datetime="2026-11-19T19:59:59.000Z"');
  expect(html).toContain('<dt>Captured</dt><dd><time datetime="2026-11-20T20:00:00.000Z"');
  expect(html).not.toContain('80%');
});

it('escapes all saved text and never interprets evidence as markup or embedded content', () => {
  const attack = '<img src="https://unwanted.test/tracker" onerror="alert(1)">&';
  const html = renderCommitmentEvidence({ evidence_blob: [
    { ...mail, snippet: attack, actor_email: attack },
    { kind: 'crm_field', full_target_id: attack, captured_at: captured, field: attack, prev_value: attack, value: attack },
    { kind: 'message', full_target_id: attack, captured_at: captured, sent_at: sourceAt, vendor: attack, actor_platform_id: attack, snippet: attack },
  ] });
  expect(html).toContain('&lt;img src='); expect(html).not.toMatch(/<(?:img|script|iframe|svg|object)\b/i);
  expect(html).not.toContain('href="https://unwanted.test');
});

it('offers only explicit web links in a separate tab without credentials, protocol tricks or opener access', () => {
  for (const raw of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', '//example.test/source',
    '#data/commitment/other', 'https://user:secret@example.test/source', 'https://example.test/\nsource', ' https://example.test/']) {
    expect(commitmentEvidenceSourceUrl(raw)).toBeNull();
    expect(renderCommitmentEvidence({ evidence_blob: [{ ...mail, vendor_url: raw }] })).not.toContain('<a ');
  }
  const html = renderCommitmentEvidence({ evidence_blob: [{ ...mail, vendor_url: 'https://example.test/source?a=1&b=2#quote' }] });
  expect(html).toContain('href="https://example.test/source?a=1&amp;b=2#quote"');
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(html).toContain('Open source <span>(new tab)</span>');
  expect(commitmentEvidenceSourceUrl('http://example.test/source')).toBe('http://example.test/source');
});

it('keeps missing evidence, missing previous values and unavailable dates honest', () => {
  expect(renderCommitmentEvidence({})).toContain('No captured source evidence is available');
  const html = renderCommitmentEvidence({ evidence_blob: [
    { kind: 'crm_field', full_target_id: 'crm/first', captured_at: 1e30, field: 'next_step', value: 'Call' },
    { kind: 'crm_field', full_target_id: 'crm/empty', captured_at: captured, field: 'next_step', value: 'Call', prev_value: '' },
  ] });
  expect(html).toContain('<dt>Previous value</dt><dd>Not captured</dd>');
  expect(html).toContain('<dt>Previous value</dt><dd>(Empty)</dd>');
  expect(html).toContain('Date unavailable'); expect(html).toContain('No source link is available');
});

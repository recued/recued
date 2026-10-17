import { describe, expect, it } from 'vitest';
import { isOAuthAppRenewalRequest, isOAuthAppRenewalReview, isOAuthAppRenewalVerification,
  type OAuthAppRenewalReview, type OAuthAppRenewalVerification } from '../oauth-app-renewal.js';
const review = (): OAuthAppRenewalReview => ({ id: 'a'.repeat(43), fingerprint: 'b'.repeat(64), expires_at: 2000,
  app: { id: 'default', issuer: 'google', label: 'Work', client_id: 'client', has_secret: true, revision: 2 }, incomplete: false,
  grants: [{ id: 'c'.repeat(64), revision: 'd'.repeat(64), label: 'Shared API', connections: ['one', 'two'], native_accounts: [], eligible: true }] });
const receipt = (): OAuthAppRenewalVerification => ({ id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'default', app_revision: 2,
  app_label: 'Work', status: 'completed', started_at: 1000, finished_at: 1500, incomplete: false, results: review().grants.map(g => ({ ...g, status: 'passed', current: 'yes' })) });
describe('OAuth app renewal wire boundary', () => {
  it.each(['issuer', 'status', 'reason', 'current', 'platform'] as const)('rejects an array-valued %s instead of accepting its string coercion', kind => {
    const v = receipt(); const result = v.results[0]!;
    if (kind === 'issuer') Object.assign(v, { issuer: ['google'] });
    if (kind === 'status') Object.assign(result, { status: ['failed'], reason: 'client_rejected' });
    if (kind === 'reason') Object.assign(result, { status: 'failed', reason: ['grant_rejected'] });
    if (kind === 'current') Object.assign(result, { current: ['no'] });
    if (kind === 'platform') Object.assign(result, { native_accounts: [{ platform: ['mail'], slug: 'work' }] });
    expect(isOAuthAppRenewalVerification(v)).toBe(false);
  });
  it('rejects coerced enums in preview requests and unchecked review reasons', () => {
    expect(isOAuthAppRenewalRequest({ action: 'renewal_preview', issuer: ['google'], id: 'default', expected_revision: 2 })).toBe(false);
    const v = review(); Object.assign(v.grants[0]!, { eligible: false, reason: ['unavailable'] });
    expect(isOAuthAppRenewalReview(v)).toBe(false);
  });
  it('accepts a local review, a renewal receipt, and either opaque status lookup', () => {
    expect(isOAuthAppRenewalReview(review())).toBe(true); expect(isOAuthAppRenewalVerification(receipt())).toBe(true);
    expect(isOAuthAppRenewalRequest({ action: 'renewal_status', id: receipt().id })).toBe(true);
    expect(isOAuthAppRenewalRequest({ action: 'renewal_status', attempt_id: 'a'.repeat(43) })).toBe(true);
    expect(isOAuthAppRenewalRequest({ action: 'renewal_status', id: receipt().id, attempt_id: 'a'.repeat(43) })).toBe(false);
  });
  it.each(['passed-reason', 'disabled-pass', 'finished-checking', 'unfinished-complete', 'duplicate-results', 'raw-revision'] as const)('refuses contradictory proof: %s', kind => {
    const v = receipt();
    if (kind === 'passed-reason') v.results[0]!.reason = 'not_checked';
    if (kind === 'disabled-pass') v.results[0]!.eligible = false;
    if (kind === 'finished-checking') v.status = 'checking';
    if (kind === 'unfinished-complete') { v.results[0]!.status = 'unconfirmed'; v.results[0]!.reason = 'not_checked'; }
    if (kind === 'duplicate-results') v.results.push(v.results[0]!);
    if (kind === 'raw-revision') v.results[0]!.revision = 'refresh-token';
    expect(isOAuthAppRenewalVerification(v)).toBe(false);
  });
  it('rejects duplicate or empty selections and unknown reasons', () => {
    const request = { action: 'renewal_run', review_id: review().id, fingerprint: review().fingerprint, attempt_id: 'a'.repeat(43), selected_ids: [review().grants[0]!.id] };
    expect(isOAuthAppRenewalRequest(request)).toBe(true); expect(isOAuthAppRenewalRequest({ ...request, selected_ids: [] })).toBe(false);
    expect(isOAuthAppRenewalRequest({ ...request, selected_ids: [...request.selected_ids, ...request.selected_ids] })).toBe(false);
    expect(isOAuthAppRenewalReview({ ...review(), grants: [{ ...review().grants[0], eligible: false, reason: 'raw-vendor-message' }] })).toBe(false);
  });
});

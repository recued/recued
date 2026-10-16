import { describe, expect, it } from 'vitest';
import { fileSourceOAuthProvider, isFileSourceAuthenticationPreview, managedOAuthDefaultVerificationUrl, managedOAuthProvidersForTarget,
  type FileSourceAuthenticationPreview } from '../index.js';
const preview = (): FileSourceAuthenticationPreview => ({ source_id: 'google.work.file', connection_name: 'work', provider: 'google', status: 'pending',
  expires_at: 1234, file_count: 0, current: { status: 'known', account_id: 'user' }, selections: ['Existing vendor root'] });
describe('File-source authentication wire boundary', () => {
  it.each([['google','https://www.googleapis.com/drive/v3/'],['onedrive','https://graph.microsoft.com/v1.0'],['sharepoint','https://graph.microsoft.com/v1.0'],['dropbox','https://api.dropboxapi.com'],['box','https://api.box.com/2.0']])('recognizes %s only at its authored file API', (vendor,base) => {
    expect(fileSourceOAuthProvider(vendor,base)).toBe(vendor);
    for (const changed of [base + '?token=private',base + '/other','https://user:secret@evil.invalid',base.replace('https:','http:')]) expect(fileSourceOAuthProvider(vendor,changed)).toBeUndefined();
  });
  it('does not classify another Google service, S3 or an unrelated API as an OAuth file source', () => {
    expect(fileSourceOAuthProvider('google','https://sheets.googleapis.com/v4')).toBeUndefined();
    expect(fileSourceOAuthProvider('s3','https://s3.amazonaws.com')).toBeUndefined();
    expect(fileSourceOAuthProvider('notion','https://api.notion.com/v1')).toBeUndefined();
  });
  it('requires verified account evidence and complete preview fields', () => {
    expect(isFileSourceAuthenticationPreview(preview())).toBe(true);
    expect(isFileSourceAuthenticationPreview({ ...preview(),status: 'verified',target: { status: 'known',account_id: 'user' } })).toBe(true);
    for (const change of [{ provider: 's3' },{ provider: ['google'] },{ status: ['pending'] },{ provider: { toString: 'google' } },{ file_count: -1 },{ file_count: NaN },{ status: 'verified' },{ current: { status: 'unknown' } },{ current: { status: 'known', account_id: ' ' } },{ selections: ['bad\nvalue'] },{ expires_at: 0 }]) {
      expect(isFileSourceAuthenticationPreview({ ...preview(),...change })).toBe(false);
    }
  });
  it('seeds the authored Box and Dropbox checks and Box broker integration mapping', () => {
    expect(managedOAuthDefaultVerificationUrl('https://api.box.com/2.0')).toBe('https://api.box.com/2.0/users/me');
    expect(managedOAuthDefaultVerificationUrl('https://api.dropboxapi.com')).toBe('https://api.dropboxapi.com/2/users/get_current_account');
    expect(managedOAuthProvidersForTarget('https://api.box.com/2.0')).toEqual(['box']);
  });
});

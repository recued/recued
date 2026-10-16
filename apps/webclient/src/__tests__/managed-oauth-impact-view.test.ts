/** D-322 §25 — distinct identities, side effects and safe rendering. */
import { describe, expect, it } from 'vitest';
import { isManagedOAuthImpactPreview, type ManagedOAuthImpactPreview } from '@recued/contracts';
import { renderManagedOAuthImpact } from '../settings/managed-oauth-impact-view.js';
const value = (): ManagedOAuthImpactPreview => ({ fingerprint: 'a'.repeat(64), phase: 'before_authorization', mode: 'switch', consent: 'request',
  current: { authentication: 'direct_oauth', identity: { status: 'unknown', reason: 'unavailable' } },
  target: { authentication: 'broker', broker: { id: 'cloud', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1 },
    integration_id: 'graph', connection_id: 'remote', identity: { status: 'known', account_id: 'user', email: 'owner@example.test' } },
  connections: [{ name: 'work', display_name: 'Work', effect: 'selected_connection', usage_available: false,
    uses: [{ kind: 'schedule', id: 'daily', label: 'Daily', paused: true, may_use: true }] }], warnings: [] });
describe('D-322 account and impact view', () => {
  it('shows the current and selected accounts without guessing missing vendor identity', () => {
    const html = renderManagedOAuthImpact(value());
    for (const copy of ['Current saved account', 'Selected account', 'Vendor email unknown', 'owner@example.test', 'Integration:', 'Broker account:']) expect(html).toContain(copy);
    expect(html).toContain('Some local use is unknown'); expect(html).toContain('(paused)'); expect(html).toContain('(can choose this account)');
  });
  it('escapes all identity and usage fields', () => {
    const v = value(); v.target.identity.display_name = '<img src=x>'; v.connections[0]!.uses[0]!.label = '<script>bad()</script>';
    expect(renderManagedOAuthImpact(v)).not.toMatch(/<img|<script>/); expect(renderManagedOAuthImpact(v)).toContain('&lt;img');
  });
  it('refuses inconsistent wire identities and malformed discriminators', () => {
    expect(isManagedOAuthImpactPreview(value())).toBe(true);
    for (const patch of [{ fingerprint: 'bad' }, { phase: ['before_save'] }, { target: { authentication: 'broker', identity: { status: 'unknown', email: 'bad@example.test' } } }]) {
      expect(isManagedOAuthImpactPreview({ ...value(), ...patch })).toBe(false);
    }
  });
});


describe('selected-file impact copy',()=>{
  it.each(['download','export','unchecked'] as const)('shows the exact %s proof and escapes file labels',mode=>{
    const v=value();v.file_source={source_id:'google.work.file',connection_name:'work',provider:'google',expires_at:Date.now()+1000,current:{status:'known',account_id:'same'},target:{status:'known',account_id:'same'},file_count:2,selections:['Existing root'],status:'verified',
      ...(mode!=='unchecked'?{download:{review_id:'a'.repeat(64),remote_id:'one',filename:'<img src=x>',output_filename:'<script>x</script>.docx',mode,mime_type:'application/pdf',comparison:mode==='download'?'same_bytes':'same_file_and_format',status:'verified',max_bytes:10485760}}:{})};
    const html=renderManagedOAuthImpact(v);expect(html).not.toMatch(/<img|<script>/);
    if(mode==='unchecked')expect(html).toContain('Metadata only. File download/export access was not checked.');
    else{expect(html).toContain('10 MiB');expect(html).not.toContain('data-file-download-unchecked');expect(html).toContain(mode==='download'?'Same file bytes verified':'Exported bytes can vary');}
  });
});

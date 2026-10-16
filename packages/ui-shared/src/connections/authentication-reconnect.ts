import type { ManagedOAuthConnectionUse } from '@recued/contracts';
const escape = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** API authentication changes do not silently repoint a collection. */
export const renderAuthenticationReconnect = (uses: readonly ManagedOAuthConnectionUse[] = []): string => {
  const collections = [...new Map(uses.filter(u => u.kind === 'mail' || u.kind === 'calendar').map(u => [u.kind + ':' + u.id, u])).values()];
  if (!collections.length) return '';
  return '<section data-authentication-reconnect><h4>Review linked Mail and Calendar</h4>'
    + '<p>Open each collection and choose Manage authentication, then Change authentication method. Recued verifies the same vendor account and access before keeping its name and sync state.</p><ul>'
    + collections.map(u => '<li><a href="#connections/' + u.kind + '/' + escape(encodeURIComponent(u.id)) + '">' + (u.kind === 'mail' ? 'Mail' : 'Calendar')
      + ': ' + escape(u.label) + '</a></li>').join('') + '</ul></section>';
};

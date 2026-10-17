import type { AuthenticationIncidentScope } from '@recued/contracts';

/** Only local identifiers enter the address, never authorization or vendor URLs. */
export const authenticationIncidentHistoryHref = (scope: AuthenticationIncidentScope = { kind: 'all' }): string => {
  const base = '#connections/others/incident-history';
  switch (scope.kind) {
    case 'all': return base;
    case 'group': return base + '/group/' + encodeURIComponent(scope.id);
    case 'connection': return base + '/connection/' + encodeURIComponent(scope.name);
    case 'collection': return base + '/collection/' + scope.platform + '/' + encodeURIComponent(scope.slug);
    case 'file_source': return base + '/file_source/' + encodeURIComponent(scope.source_id);
    case 'oauth_apps': return base + '/oauth_apps';
  }
};

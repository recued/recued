/** Human permission labels, with the vendor spelling available for review. */
import { escapeHtml as e } from '@recued/ui-shared';

export const scopeLabel = (scope: string): string => {
  const name = scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '').replace(/^https:\/\/graph\.microsoft\.com\//, '');
  const labels: Record<string, string> = { 'gmail.readonly': 'Read mail', 'gmail.send': 'Send mail', 'gmail.modify': 'Read and organize mail',
    calendar: 'Manage calendars and events', 'calendar.readonly': 'Read calendars and events', 'calendar.events': 'Create, edit and delete events',
    spreadsheets: 'Read and edit spreadsheets', 'spreadsheets.readonly': 'Read spreadsheets', drive: 'Manage Drive files', 'drive.readonly': 'Read Drive files',
    'Mail.Read': 'Read mail', 'Mail.ReadWrite': 'Read and change mail, including drafts', 'Mail.Send': 'Send mail', 'Calendars.Read': 'Read calendars and events',
    'Calendars.ReadWrite': 'Create, edit and delete events', 'Files.Read': 'Read OneDrive files', 'Files.ReadWrite': 'Change OneDrive files',
    'Sites.Read.All': 'Read SharePoint sites', 'Sites.ReadWrite.All': 'Change SharePoint sites', 'User.Read': 'Read your account profile',
    email: 'Read your account email address', offline_access: 'Keep access while you are away' };
  return Object.hasOwn(labels, name) ? labels[name]! : scope;
};
export const scopeDetail = (scope: string): string => scopeLabel(scope) === scope ? ''
  : '<details><summary>Vendor scope</summary><code>' + e(scope) + '</code></details>';
export const scopeListItem = (scope: string): string => '<li>' + (scopeLabel(scope) === scope ? '<code>' + e(scope) + '</code>' : e(scopeLabel(scope)) + scopeDetail(scope)) + '</li>';

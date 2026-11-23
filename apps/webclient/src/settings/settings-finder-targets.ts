import { parseShellRoute, serializeShellRoute } from '../shell/route.js';

export interface SettingsFinderTarget {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly location: string;
  readonly description: string;
  readonly keywords: string;
  readonly selector: string;
}

const target = (id: string, section: string, title: string, location: string,
  selector: string, keywords: string, description: string): SettingsFinderTarget =>
  ({ id, section, title, location, selector, keywords, description });

/** Search names and explanations, never the contents of editable fields.
 * A descriptor is offered only while its section and target actually exist.
 * Hidden tabs are still destinations; lazy sections are indexed by their host
 * and are opened through the route's normal activation callback. */
export const SETTINGS_FINDER_TARGETS: readonly SettingsFinderTarget[] = [
  target('account', 'account', 'Account', 'Account', '[data-recued-account-binding-panel]',
    'sign in billing subscription pro', 'Connect your account and manage your subscription.'),
  target('server-addresses', 'servers', 'Server addresses', 'Servers', '[data-server-address-panel]',
    'paired server url address connection', 'Change the addresses this browser uses to reach your servers.'),
  target('backup-restore', 'backup', 'Back up or restore', 'Backup & Recovery', '[data-backup-card="manual"]',
    'backup export import recovery archive restore passport', 'Save a backup or restore an archive.'),
  target('remote-backups', 'backup', 'Remote backups', 'Backup & Recovery', '[data-remote-backups]',
    'backup storage destination unattended schedule cloud s3', 'Choose backup storage and review saved backups.'),
  target('automatic-backups', 'backup', 'Automatic backups', 'Backup & Recovery → Schedule settings', '[data-unattended-backups] [data-backup-disclosure="schedule"]',
    'automatic unattended scheduled backup cadence retention', 'Choose when encrypted backups are saved automatically.'),
  target('default-model', 'ai-models', 'Default chat model', 'AI / Models → Preference', '[data-recued-ai-models-control="model_pref"]',
    'model preference default ai chat', 'Choose the model new chats use by default.'),
  target('chat-behaviour', 'ai-models', 'Chat behaviour', 'AI / Models → Preference', '[data-recued-ai-models-control="chat_behaviour"]',
    'behavior running note brief memory context install offers', 'Choose what Chat carries between turns.'),
  target('paid-models', 'ai-models', 'Your own paid keys', 'AI / Models → Providers', '[data-recued-ai-models-control="byok"]',
    'provider api key byok slot model openai anthropic endpoint chat tool catalog', 'Set up your paid model providers.'),
  target('free-models', 'ai-models', 'Free pool', 'AI / Models → Providers', '[data-recued-ai-models-control="free_pool"]',
    'free models providers api keys chat tool catalog', 'Manage the free models Recued tries first.'),
  target('embeddings', 'ai-models', 'Embeddings model', 'AI / Models → Providers', '[data-recued-ai-models-control="embeddings_slot"]',
    'embedding similarity vector model', 'Set the model used to find similar things.'),
  target('transcription', 'ai-models', 'Voice transcription', 'AI / Models → Providers', '[data-recued-ai-models-control="transcription_slot"]',
    'voice audio speech transcription language whisper microphone', 'Set the model and language used to turn speech into text.'),
  target('system-prompts', 'ai-models', 'System prompts', 'AI / Models → System prompts', '[data-recued-ai-models-tab-panel="prompts"]',
    'instructions prompt role', 'Review and edit the instructions your server uses.'),
  target('ai-policy', 'ai-models', 'How Recued may use AI', 'AI / Models → Usage & budget', '[data-recued-ai-models-control="ai_policy"]',
    'background paid keys pause stop ai', 'Control background AI and pause its use.'),
  target('ai-budget', 'ai-models', 'Daily spending limit', 'AI / Models → Usage & budget', '[data-recued-ai-models-control="budget"]',
    'budget spending tokens daily limit cost usage', 'Set the most AI may use in a day.'),
  target('ai-cache', 'ai-models', 'LLM result cache', 'AI / Models → Usage & budget', '[data-recued-ai-models-control="cache"]',
    'cache cached answers ai reuse result storage', 'Manage saved AI answers that can be reused.'),
  target('updates', 'updates', 'Updates', 'Updates', '[data-recued-updates-page]',
    'version upgrade rollback release automatic', 'Check for server updates and manage how they are installed.'),
  target('housekeeping', 'housekeeping', 'Housekeeping', 'Housekeeping', '[data-recued-housekeeping-panel-host]',
    'retention cleanup storage pruning tidy', 'Choose how long Recued keeps data and how it tidies up.'),
  target('transparency', 'privacy', 'Transparency', 'Privacy', '[data-recued-transparency-panel]',
    'thought stream reasoning disclosure', 'Choose which parts of the AI thought stream are shown.'),
  target('learning', 'privacy', 'Learning', 'Privacy', '[data-recued-learning-panel]',
    'feedback outcomes experience forget', 'Choose how Recued learns from completed work.'),
  target('last-time', 'privacy', 'Last time', 'Privacy → Learning', '[data-last-time]',
    'last time reminders learning past', 'Choose reminders based on what happened last time.'),
  target('this-browser', 'privacy', 'This browser', 'Privacy', '[data-recued-clear-this-browser-panel]',
    'clear browser local data forget device reset', 'Clear this browser’s saved pairing and local data.'),
  target('devices', 'devices', 'Devices', 'Devices', ':scope',
    'paired device revoke access pairing', 'Review paired devices and revoke their access.'),
  target('notification-channels', 'notifications', 'Notification channels', 'Approval & notifications', '[data-recued-notifications-panel]',
    'approval delivery notification slack telegram browser bridge', 'Choose where approvals and notifications reach you.'),
  target('reminder-policy', 'notifications', 'Reminder timing', 'Approval & notifications', '[data-recued-kind-policy-panel]',
    'reminder timing kinds offsets alert', 'Choose which reminders arrive and how far ahead.'),
  target('agenda', 'notifications', 'Agenda', 'Approval & notifications', '[data-situation-agenda]',
    'morning daily agenda email day', 'Choose when and where your day’s agenda arrives.'),
  target('close-day', 'notifications', 'Close the day', 'Approval & notifications', '[data-situation-close-day]',
    'evening closing day email review', 'Set up your evening review.'),
  target('coming-up', 'notifications', 'Coming up', 'Approval & notifications', '[data-situation-delivery]',
    'due today situation upcoming reminder', 'Choose how Recued tells you about what is coming up.'),
  target('quiet-hours', 'notifications', 'Quiet hours', 'Approval & notifications', '[data-recued-quiet-hours-panel]',
    'do not disturb dnd sleep silence mute notifications hours', 'Choose when reminders and approval requests stay quiet.'),
  target('household-delivery', 'notifications', 'Household delivery', 'Approval & notifications', '[data-household-delivery]',
    'family household telegram shared notification', 'Choose which messages also reach your household.'),
  target('email-chat', 'email-chat', 'Email chat', 'Email chat', ':scope',
    'email mail chat mailbox reply', 'Choose the mailbox you use to talk to Recued by email.'),
  target('connect-device', 'server', 'Connect a device', 'Server → Connect a device', '[data-recued-connect-device-panel]',
    'pair phone device remote reachability router port', 'Find how another device can reach this server.'),
  target('exposure', 'server', 'Exposure', 'Server → Exposure', '[data-recued-exposure-panel]',
    'public access mcp reception api internet', 'Choose which server doors are reachable.'),
  target('hostnames', 'server', 'Hostnames', 'Server → Hostnames', '[data-recued-hostnames-panel]',
    'hostname dns domain address', 'Manage the names used to reach your server.'),
  target('custom-domains', 'server', 'Custom domains', 'Server → Hostnames', '[data-recued-custom-domains]',
    'custom domain dns hostname', 'Connect a domain you own to this server.'),
  target('certificates', 'server', 'Certificates', 'Server → Certificates', '[data-recued-settings-subtab-panel="certificates"]',
    'tls https ssl certificate renew upload', 'Review certificates and manage HTTPS.'),
  target('timezone', 'server', 'Server timezone', 'Server → Timezone', '[data-recued-server-timezone-panel]',
    'timezone time zone clock daylight saving', 'Choose the clock schedules and quiet hours follow.'),
  target('key-health', 'server', 'Key Health', 'Server → Key Health', '[data-recued-key-health-panel]',
    'encryption rotate keys keyfile vault', 'Review encryption keys and their recovery options.'),
  target('maintenance', 'server', 'Maintenance', 'Server → Maintenance', '[data-recued-maintenance-panel-host]',
    'disk storage reclaim status housekeeping run now', 'Review server upkeep and reclaim storage.'),
];

const normalize = (value: string): string => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

export const searchSettingsTargets = (entries: readonly SettingsFinderTarget[], query: string): SettingsFinderTarget[] => {
  const phrase = normalize(query.trim()), terms = phrase.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length) return [];
  return entries.map(entry => {
    const title = normalize(entry.title);
    const text = normalize(`${entry.title} ${entry.location} ${entry.keywords} ${entry.description}`);
    const score = terms.every(term => text.includes(term))
      ? (title === phrase ? 100 : title.startsWith(phrase) ? 50 : title.includes(phrase) ? 25 : 0)
        + terms.filter(term => title.includes(term)).length
      : -1;
    return { entry, score };
  }).filter(hit => hit.score >= 0).sort((a, b) => b.score - a.score).map(hit => hit.entry);
};

export const settingsFinderHash = (entry: Pick<SettingsFinderTarget, 'section' | 'id'>): string =>
  serializeShellRoute('settings', entry.section, 'find', entry.id);

export const parseSettingsFinderHash = (hash: string): { section: string; id: string } | null => {
  const route = parseShellRoute(hash);
  return route.surface === 'settings' && route.segments.length === 3 && route.segments[1] === 'find'
    ? { section: route.segments[0]!, id: route.segments[2]! } : null;
};

export const locateSetting = (content: HTMLElement, entry: SettingsFinderTarget): HTMLElement | null => {
  const section = content.querySelector?.<HTMLElement>(`[data-recued-settings-section="${entry.section}"]`);
  const element = section === undefined || section === null ? null
    : entry.selector === ':scope' ? section : section.querySelector?.<HTMLElement>(entry.selector) ?? null;
  // Some server features keep a placeholder mounted but hidden until the
  // server advertises them. Inactive ARIA tabs are legitimate destinations.
  for (let ancestor = element; ancestor && ancestor !== content; ancestor = ancestor.parentElement) {
    if (ancestor.hidden && ancestor.getAttribute('role') !== 'tabpanel') return null;
  }
  return element;
};

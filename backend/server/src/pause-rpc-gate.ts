/** D-188 — the owner's own direct actions that reach outside the server, refused while paused.
 *
 *  ⛔ EVERY SERVER METHOD IS PLACED, in one of three: refused here, open on purpose although it
 *  reaches outside (`PAUSE_OPEN_OUTSIDE`, with why), or local (`PAUSE_LOCAL_METHODS`). The test
 *  fails for a method in none, so a new method that reaches outside cannot be added without
 *  someone deciding what the pause does with it. (It was a closed list of the first kind only:
 *  a new method was open during a pause unless someone remembered this file.)
 *
 *  The owner's ruling of 2026-11-08: the pause is the emergency stop. Nothing leaves this
 *  server and nothing comes in until Resume, the owner's own hands included. A recipe run is
 *  refused at its start (`handleExecute`) and every dispatch at the op-admission gate; what is
 *  listed here reaches an account or a third party some other way, straight from its rpc
 *  handler: a live read of a mailbox, a calendar or a cloud drive, a calendar change, a
 *  connection test or sign-in, an AI draft, a write to Home Assistant, a remote backup. While
 *  paused the dispatcher refuses them before the handler runs (`server_paused`, 409).
 *
 *  What stays: everything that only reads or changes what is stored here (looking around,
 *  settings, keys, recipes, schedules), Deny, Resume, and what keeps the owner connected
 *  (Recued's account and Pro, naming and certificates, updates and the marketplace, port
 *  mapping and exposure). Deliberately left open although they reach outside:
 *  - `notification.submitAnswer`: a Deny closes the prompt on the owner's own channels.
 *  - `webhook.ingress.disable` / `retire`: switching an integration off is what a stop is for;
 *    removing its endpoint at the vendor comes with it.
 *  - `chat.delivery.retry` / `skip`: they only mark the queue; its sender is held while paused.
 *  - `collection.mail.message.get` / `collection.calendar.event.get`: opening an email or an
 *    event. Refusing them hid what the server holds (the live pass of 2026-11-08: an open email
 *    showed only the refusal); while paused their handlers show the stored copy and hold the
 *    read at the account.
 *
 *  Its test pins every name to the server's method set, so a renamed method fails there
 *  instead of quietly dropping out, and fails for a new method nobody placed (above).
 *  Inventory: the 2026-11-08 map of owner rpcs that reach outside. */
import {
  OAUTH_APP_RENEWAL_ACTIONS,
  OAUTH_PERMISSION_CLEANUP_ACTIONS,
} from '@recued/contracts';

type Args = Readonly<Record<string, unknown>> | undefined;
/** `true`: refused whatever its arguments. A predicate: refused when its arguments reach out. */
type PauseRule = true | ((args: Args) => boolean);

const isRemoteFileRecord = (args: Args): boolean =>
  typeof args?.record_id === 'string' && args.record_id.startsWith('file:remote:');
const reprobes = (args: Args): boolean => args?.reprobe === true;
const sendsClaimEmail = (args: Args): boolean => args?.send_claim_email === true;
const OAUTH_APP_ACTIONS_OUTSIDE: ReadonlySet<string> = new Set([
  ...OAUTH_APP_RENEWAL_ACTIONS,
  ...OAUTH_PERMISSION_CLEANUP_ACTIONS,
]);

export const PAUSE_REFUSED_METHODS: ReadonlyMap<string, PauseRule> = new Map<string, PauseRule>([
  // Calendar: live reads, changes (which can notify guests), sign-ins and probes.
  ['collection.calendar.event.destinations', true],
  ['collection.calendar.event.create', true],
  ['collection.calendar.event.update', true],
  ['collection.calendar.event.respond', true],
  ['collection.calendar.event.delete', true],
  ['collection.calendar.event.checkDeletion', true],
  ['collection.calendar.enrollOAuth', true],
  ['collection.calendar.enrollManagedOAuth', true],
  ['collection.calendar.attachGraphGrant', true],
  ['collection.calendar.enrollBasic', true],
  ['collection.calendar.update', reprobes],
  ['collection.calendar.updateCredentials', true],
  // Mail: live reads, state pushed to the mailbox, sign-ins and checks.
  ['collection.mail.message.updateState', true],
  ['collection.mail.chat_door.check', true],
  ['collection.mail.enrollOAuth', true],
  ['collection.mail.enrollManagedOAuth', true],
  ['collection.mail.enrollSmtp', true],
  ['collection.mail.enrollImap', true],
  ['collection.mail.updateCredentials', true],
  ['preapproval.reconcile', true],
  ['mail_fact.email.read', true],
  ['mail_fact.template.preview', true],
  ['mail_fact.template.draft', true],
  ['mail_fact.backfill.start', true],
  // Any collection's resync starts its provider loop directly.
  ['collection.resync', true],
  ['collection.calendar.resync', true],
  ['collection.mail.resync', true],
  // Files: a remote record's bytes, cloud drives, a bucket's probe.
  ['data.file.read', isRemoteFileRecord],
  ['data.file.attachments.preview', isRemoteFileRecord],
  ['data.file.attachments.remote.list', true],
  ['data.file.attachments.import', true],
  ['collection.file.enroll', true],
  ['collection.file.update', reprobes],
  ['collection.file.resync', true],
  // Connections: tests, sign-ins, credential checks, the managed broker.
  ['collection.connection.probe', true],
  ['collection.connection.enroll', true],
  ['collection.connection.rotateCredentials', true],
  ['collection.connection.mcpPackPreview', true],
  ['collection.connection.mcpPackCommit', true],
  ['collection.connection.completeVendorOAuth', true],
  ['collection.connection.managedOAuth', true],
  ['collection.connection.reprobeEngagementCapabilities', true],
  ['collection.connection.suggestSetup', true],
  ['server.oauthApps', (args) => typeof args?.action === 'string' && OAUTH_APP_ACTIONS_OUTSIDE.has(args.action)],
  // A CRM's own records.
  ['upstream_merge.describe', true],
  ['upstream_merge.request', true],
  ['upstream_merge.retry', true],
  // A vendor's webhook endpoint.
  ['webhook.ingress.registration.reconcile', true],
  ['webhook.ingress.test.deliver', true],
  // Selling: a claim email to a customer; a provider's catalogue (also refused inside
  // `runGatedCatalogOperation`; here the owner reads why in plain words).
  ['server.seller.synchronizeStripeEntitlements', true],
  ['server.seller.synchronizeProviderTiers', true],
  ['server.seller.issueManualCustomer', sendsClaimEmail],
  ['server.seller.reissueManualCustomerToken', sendsClaimEmail],
  // Messengers and notifications.
  ['chat.messenger.connect', true],
  ['notification.send', true],
  // A model provider.
  ['server.probeLlmSource', true],
  ['chat.execution.draft_recipe', true],
  ['mail.work.review', true],
  ['reception.compose.propose', true],
  // Everything else outside: a connection's live preview, Home Assistant, remote backups, a
  // housekeeping task run by hand, the public metrics board.
  ['ingredient.preview', true],
  ['yours.household_lists', true],
  ['yours.writer.read', true],
  ['yours.writer.preview', true],
  ['yours.writer.change', true],
  ['yours.change', (args) => args?.action === 'household.home_assistant'],
  ['server.archive.export', (args) => args?.remote !== undefined && args.remote !== null],
  ['server.archive.backup.check', true],
  ['server.archive.backup.retrieve', true],
  ['server.archive.drill.start', true],
  ['housekeeping.task.run_now', true],
  ['metric.submit', true],
]);

/** Methods that reach outside the server and are left open on purpose, each with why. Every
 *  other method that is not refused above is local (`PAUSE_LOCAL_METHODS`). */
export const PAUSE_OPEN_OUTSIDE: ReadonlyMap<string, string> = new Map<string, string>([
  // What a stop needs.
  ['notification.submitAnswer', "a Deny closes the prompt on the owner's own channels"],
  ['webhook.ingress.disable', 'switching an integration off removes its endpoint at the vendor'],
  ['webhook.ingress.retire', 'switching an integration off removes its endpoint at the vendor'],
  ['chat.delivery.retry', 'it only marks the queue; the sender is held while paused'],
  ['chat.delivery.skip', 'it only marks the queue; the sender is held while paused'],
  ['chat.sessions.list', "a messenger bot's identity, checked at most once per token and cached"],
  ['chat.messenger.status', "a messenger bot's identity, checked at most once per token and cached"],
  ['chat.deliveries.list', "a messenger bot's identity, checked at most once per token and cached"],
  // Reading what the server holds: while paused these show the stored copy, and their handlers
  // hold the read at the account (`isServerPaused` in the collection handlers).
  ['collection.mail.message.get', 'opening an email shows the stored copy; reply, forward and its status wait for Resume'],
  ['collection.calendar.event.get', 'opening an event shows it as last synced, read-only; its calendar is not read'],
  // What keeps the owner connected: Recued's own account, naming, certificates, updates and
  // marketplace, and how the server is reached.
  ['account.bind', "Recued's own account"],
  ['account.unbind', "Recued's own account"],
  ['account.bindingStatus', "Recued's own account"],
  ['pro.authenticate', "Recued's own account"],
  ['pro.signOut', "Recued's own account"],
  ['pro.current', "Recued's own account"],
  ['pro_convenience.status', "Recued's own naming"],
  ['pro_acme.unbind', "Recued's own certificates"],
  ['ddns.status', "Recued's own naming"],
  ['ddns.setEnabled', "Recued's own naming"],
  ['tls.renew', 'the certificate the owner reaches the server with'],
  ['collection.hostname.verifyOwnership', 'the name the owner reaches the server at'],
  ['collection.hostname.preflight', 'the name the owner reaches the server at'],
  ['collection.hostname.issuanceReadiness', 'the name the owner reaches the server at'],
  ['network.port_mapping', 'how the server is reached'],
  ['update.check', "Recued's own updates"],
  ['update.apply', "Recued's own updates"],
  ['update.rollback', "Recued's own updates"],
  ['packs.install', "Recued's own marketplace"],
  ['packs.install_preview', "Recued's own marketplace"],
  ['packs.installBySlug', "Recued's own marketplace"],
  ['packs.resolveBySlug', "Recued's own marketplace"],
  ['recipe.installBySlug', "Recued's own marketplace"],
  ['packs.update.stage', "Recued's own marketplace"],
  ['packs.update.apply', "Recued's own marketplace"],
  ['passport.fetch', "Recued's own account"],
]);

/** Does the owner's pause refuse this call? Only a listed method, and for a predicate only when
 *  its arguments reach outside. */
export const pauseRefusesRpc = (method: string, args: Args): boolean => {
  const rule = PAUSE_REFUSED_METHODS.get(method);
  if (rule === undefined) return false;
  return rule === true ? true : rule(args);
};

/** What the owner reads when one is refused. */
export const PAUSED_RPC_REFUSAL = 'The server is paused. Resume it, then try this again.';

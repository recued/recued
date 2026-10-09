/** D-129 Phase 1 — Connection vendor provider registry.
 *
 *  Sibling registry to D-128's `CONNECTION_VENDOR_ENTITIES`. Where
 *  vendor entities describe per-`(vendor, entity)` reconciliation shape
 *  (`hubspot.deal`, `hubspot.contact`, …), vendor providers describe
 *  per-vendor enrollment shape: OAuth endpoints, scope set, webhook
 *  signature conventions, default base URLs.
 *
 *  D-129 ships exactly one entry — HubSpot. D-130 (Salesforce) appends
 *  one more. Post-launch certified-vendor program opens the registry
 *  to third parties (per D-128 close decision §8).
 *
 *  No runtime behavior at this module — pure constants + lookup
 *  helpers. The vendor-flavored connection schema
 *  (`packages/ui-shared/src/connection-schemas/vendors/<vendor>.ts`)
 *  reads these to pre-fill enrollment forms; the future OAuth
 *  code-exchange rpc (P1.2) reads `oauth.token_endpoint` to mint
 *  refresh tokens; the reconciler boot-wire (P2) matches connections
 *  via `config.vendor === '<vendor>'` against this list.
 *
 *  Spec: D-129 § A.1. */

// The Microsoft Graph OAuth substrate (authorize/token URLs + scopes) is
// shared with the foundational mail + calendar lanes, so the OneDrive vendor
// provider (D-192 file SOURCE family) reuses those canonical constants rather
// than re-declaring the endpoints. foundational-oauth.ts imports nothing, so
// this stays a clean one-way edge (no cycle).
import {
  GRAPH_FILES_READ_SCOPE,
  GRAPH_FILES_READWRITE_SCOPE,
  GRAPH_OFFLINE_SCOPE,
  GRAPH_SITES_READ_ALL_SCOPE,
  GRAPH_SITES_READWRITE_ALL_SCOPE,
  GRAPH_USER_READ_SCOPE,
  MICROSOFT_AUTHORIZE_URL,
  MICROSOFT_TOKEN_URL,
} from './foundational-oauth.js';
import { isValidOAuthEndpointUrl, type ConnectionAuthType } from './connection.js';

// ────────────────────────────────────────────────────────────────
// Cross-vendor sandbox-flag literal (D-130 — used as the
// `config.sandbox` field value on connection records for vendors
// with a sandbox/production split). The form ships these as the
// only two options of the sandbox `select` field; the OAuth
// resolver compares against `'sandbox'` to pick the sandbox URL
// pair off the provider entry. Vendors without a sandbox split
// (HubSpot) ignore this — `getVendorOAuthEndpoints` falls through
// to the production pair on an unset / `'production'` flag.
// ────────────────────────────────────────────────────────────────

export const CONNECTION_SANDBOX_FLAG_VALUES = ['production', 'sandbox'] as const;
export type ConnectionSandboxFlag = (typeof CONNECTION_SANDBOX_FLAG_VALUES)[number];

// ────────────────────────────────────────────────────────────────
// HubSpot constants (spec § Constants)
// ────────────────────────────────────────────────────────────────

/** HubSpot OAuth scopes requested at enrollment. Read-only set —
 *  write scopes (`crm.objects.{deals,contacts,companies}.write`) are
 *  reserved for a future `deal-update-hubspot` wrapper that requests
 *  them independently. The reconciler + topic producers only need
 *  read. */
export const HUBSPOT_OAUTH_SCOPES = [
  'crm.objects.deals.read',
  'crm.objects.contacts.read',
  'crm.objects.companies.read',
  'crm.schemas.deals.read',
  'crm.schemas.contacts.read',
  'crm.schemas.companies.read',
  'oauth',
] as const;

export const HUBSPOT_API_BASE = 'https://api.hubapi.com';
export const HUBSPOT_OAUTH_AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';
export const HUBSPOT_OAUTH_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
/** D-129 P1.2 — HubSpot access-token introspection endpoint. The
 *  token-exchange response intentionally omits `scope` (HubSpot deviates
 *  from RFC 6749 § 3.3 here); the granted-scope set is read by GETting
 *  `<HUBSPOT_OAUTH_INTROSPECT_URL>/<access_token>` post-exchange. The
 *  rpc handler appends `/<token>` at call time; the constant is the
 *  bare prefix without trailing slash. */
export const HUBSPOT_OAUTH_INTROSPECT_URL = 'https://api.hubapi.com/oauth/v1/access-tokens';
export const HUBSPOT_WEBHOOK_SIGNATURE_HEADER = 'X-HubSpot-Signature-v3';
export const HUBSPOT_DEFAULT_RECONCILIATION_CADENCE = '6h' as const;

// ────────────────────────────────────────────────────────────────
// Salesforce constants (D-130 spec § Constants)
//
// Salesforce splits OAuth + runtime base URLs across production
// (`login.salesforce.com`) and sandbox (`test.salesforce.com`).
// The connection record carries `config.sandbox: 'production' |
// 'sandbox'`; `resolveVendorOAuthEndpoints` reads the flag and
// picks the URL pair off the provider entry. The runtime base
// URL (`config.base_url`) is the per-org `instance_url` returned
// by the OAuth token response — captured server-side at enroll
// time, not user-typed.
// ────────────────────────────────────────────────────────────────

/** Salesforce REST API version pinned at D-130. Bumped per release
 *  alongside server upgrades; pinned here so SOQL search +
 *  describe + sobjects calls reference one canonical URL fragment. */
export const SALESFORCE_API_VERSION = 'v60.0' as const;

/** Production OAuth host (`login.salesforce.com`). Connected Apps
 *  registered against a production org use this for the
 *  authorize + token exchange round-trip. */
export const SALESFORCE_OAUTH_AUTHORIZE_URL_PRODUCTION =
  'https://login.salesforce.com/services/oauth2/authorize';
export const SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION =
  'https://login.salesforce.com/services/oauth2/token';

/** Sandbox OAuth host (`test.salesforce.com`). Connected Apps
 *  registered against a sandbox org use this — Salesforce locks
 *  the OAuth surface to whichever environment the Connected App
 *  was created in (a production app cannot mint tokens against a
 *  sandbox org and vice versa). */
export const SALESFORCE_OAUTH_AUTHORIZE_URL_SANDBOX =
  'https://test.salesforce.com/services/oauth2/authorize';
export const SALESFORCE_OAUTH_TOKEN_URL_SANDBOX =
  'https://test.salesforce.com/services/oauth2/token';

/** OAuth scopes requested at enrollment. Salesforce permission
 *  enforcement is profile-based at the user level, not scope-based
 *  per-entity (D-130 spec § decision 8) — `api` grants REST + SOQL
 *  access, `refresh_token` mints long-lived refresh tokens,
 *  `offline_access` is the spec-compliant alias some org
 *  configurations require alongside `refresh_token`. The
 *  granted-entities probe (P2 / per-`Object/describe` call)
 *  substitutes for HubSpot-style scope enumeration. */
export const SALESFORCE_OAUTH_SCOPES = [
  'api',
  'refresh_token',
  'offline_access',
] as const;

/** Default `config.base_url` placeholder rendered in the
 *  enrollment form before OAuth completes. The real per-org
 *  base comes from the OAuth token response's `instance_url`
 *  field (e.g. `https://mycompany.my.salesforce.com`); the
 *  placeholder makes the field look pre-filled in the Settings
 *  → Connections dialog at the contracts layer. The runtime
 *  adapter reads `config.base_url` for every REST call, so the
 *  enroll handler must overwrite this placeholder with the
 *  token-response `instance_url` once OAuth completes (P1.2). */
export const SALESFORCE_API_BASE_PLACEHOLDER = 'https://login.salesforce.com';

export const SALESFORCE_DEFAULT_RECONCILIATION_CADENCE = '6h' as const;

/** Salesforce Streaming API events arrive over CometD long-poll
 *  rather than a signed POST webhook (D-130 spec § A.4) — the
 *  funnel never receives an inbound request for Salesforce.
 *  The signature header field stays surfaced on the provider
 *  entry as a documentation marker (so the vendor-provider
 *  shape stays uniform); the `salesforce` `WebhookProcessor`
 *  (P5) bypasses the funnel-routing convention with a CometD
 *  subscription path. */
export const SALESFORCE_WEBHOOK_SIGNATURE_HEADER = 'X-Salesforce-Streaming-CometD';

/** D-130 P5 — canonical PushTopic names recued-server creates at first
 *  Salesforce connection enrollment (one per Sales Cloud entity). The
 *  CometD subscriber binds to `/topic/<name>` channels; the per-entity
 *  WebhookProcessor filters incoming events by the channel discriminator.
 *  Names are stable across orgs because PushTopics are per-org Recued-
 *  managed objects (idempotent on re-enrollment — server checks for
 *  existing PushTopics with these names before SOAP-creating).
 *
 *  Channel paths: `/topic/RecuedOpportunityFeed` /
 *  `/topic/RecuedContactFeed` / `/topic/RecuedAccountFeed`. */
export const SALESFORCE_PUSHTOPIC_NAMES = {
  opportunity: 'RecuedOpportunityFeed',
  contact: 'RecuedContactFeed',
  account: 'RecuedAccountFeed',
} as const;

/** D-130 P5 — supported Salesforce entity discriminator for the CometD
 *  channel router. Closed list — Marketing Cloud / Service Cloud entities
 *  are post-launch. */
export const SALESFORCE_ENTITY_NAMES = ['opportunity', 'contact', 'account'] as const;
export type SalesforceEntityName = (typeof SALESFORCE_ENTITY_NAMES)[number];

/** D-130 P5 — channel path prefix Salesforce CometD events arrive on.
 *  PushTopic events land on `/topic/<PushTopicName>`; ChangeDataCapture
 *  (post-launch) would land on `/data/<ObjectName>ChangeEvent`. The
 *  WebhookProcessor matches against the topic prefix only — its closed
 *  channel set is the three entries from `SALESFORCE_PUSHTOPIC_NAMES`. */
export const SALESFORCE_PUSHTOPIC_CHANNEL_PREFIX = '/topic/';

/** D-130 P5 — Salesforce Sales Cloud SObject Id prefix per entity.
 *  Salesforce assigns each SObject a 3-character id prefix that's
 *  stable across orgs: Opportunity = `006`, Contact = `003`,
 *  Account = `001`. The processor cross-validates the event's
 *  `sobject.Id` against the channel's declared prefix to catch
 *  channel-misrouted events (defence-in-depth — Salesforce's own
 *  routing already filters per-PushTopic, but the prefix check
 *  surfaces protocol-level corruption clearly). */
export const SALESFORCE_SOBJECT_ID_PREFIXES: Record<SalesforceEntityName, string> = {
  opportunity: '006',
  contact: '003',
  account: '001',
} as const;

/** D-130 P5.2 — CometD long-poll path appended to the per-org
 *  `instance_url`. The subscriber POSTs Bayeux messages to
 *  `<instance_url>${SALESFORCE_COMETD_PATH}` (which is
 *  `<instance_url>/cometd/<API_VERSION>/`). Trailing slash is
 *  load-bearing: Salesforce's CometD endpoint matches on the exact
 *  versioned path. */
export const SALESFORCE_COMETD_PATH = `/cometd/${SALESFORCE_API_VERSION}/` as const;

/** D-130 P5.2 — SOAP Partner endpoint path appended to the per-org
 *  `instance_url`. PushTopic auto-creation POSTs SOAP envelopes to
 *  `<instance_url>${SALESFORCE_SOAP_PARTNER_PATH}` (which is
 *  `<instance_url>/services/Soap/c/<API_VERSION>`). The Partner WSDL
 *  is the right endpoint for `create()` against standard SObjects
 *  like PushTopic. */
export const SALESFORCE_SOAP_PARTNER_PATH = `/services/Soap/c/${SALESFORCE_API_VERSION}` as const;

/** D-130 P5.2 — bare numeric API version stamped onto each PushTopic's
 *  `ApiVersion` SObject field at create-time. PushTopic's `ApiVersion`
 *  is the SOAP-API-shaped float (`60.0`), not the URL fragment with
 *  a `v` prefix (`v60.0`) that REST + CometD use. Keeping both
 *  surfaces consistent — every API-version bump touches both
 *  constants in sync. */
export const SALESFORCE_PUSHTOPIC_API_VERSION = SALESFORCE_API_VERSION.replace(/^v/, '');

// ────────────────────────────────────────────────────────────────
// Pipedrive constants
// ────────────────────────────────────────────────────────────────

export const PIPEDRIVE_OAUTH_SCOPES = [
  'base',
  'deals:read',
  'deals:full',
  'contacts:read',
] as const;
export const PIPEDRIVE_API_BASE = 'https://api.pipedrive.com';
export const PIPEDRIVE_OAUTH_AUTHORIZE_URL = 'https://oauth.pipedrive.com/oauth/authorize';
export const PIPEDRIVE_OAUTH_TOKEN_URL = 'https://oauth.pipedrive.com/oauth/token';
/** Pipedrive webhooks are commonly protected by optional HTTP basic auth rather
 *  than an HMAC signature. The provider registry shape still requires a header
 *  marker for the enrollment UI, so use the verification header rather than
 *  inventing a signature header. */
export const PIPEDRIVE_WEBHOOK_SIGNATURE_HEADER = 'Authorization';
export const PIPEDRIVE_DEFAULT_RECONCILIATION_CADENCE = '6h' as const;

// ────────────────────────────────────────────────────────────────
// D-139 P1b — Salesforce engagement entities
//
// Spec § A.2.1 + § A.3.1 + § Pass-5 R5.10 + R5.11. Parent SObjects
// (Task / Event / EmailMessage / VoiceCall / CallHistory) plus the
// three relationship objects (TaskRelation / EventRelation /
// EmailMessageRelation). Capability-detected at enrollment via
// `describeSObjects()` REST probe; per-channel CDC + PushTopic
// streamability probed separately per Pass-5 R5.10. CallHistory vs
// VoiceCall is dual-probed per Pass-5 R5.11 — VoiceCall preferred
// when both are available.
// ────────────────────────────────────────────────────────────────

/** D-139 P1b — Salesforce engagement entity discriminator. Closed
 *  list at v1; CallHistory + VoiceCall both appear here even though
 *  only one is registered per connection at enrollment time (the
 *  dual-probe per Pass-5 R5.11 picks the available one). */
export const SALESFORCE_ENGAGEMENT_ENTITY_NAMES = [
  'task',
  'event',
  'email_message',
  'voice_call',
  'call_history',
] as const;
export type SalesforceEngagementEntityName =
  (typeof SALESFORCE_ENGAGEMENT_ENTITY_NAMES)[number];

/** D-139 P1b — Salesforce relationship-object discriminator. Each
 *  relationship object is a junction table joining one parent
 *  SObject (Task/Event/EmailMessage) to a `WhoId` (Contact / Lead) +
 *  a `WhatId` (Account / Opportunity / etc.). Pass-3 R3.5 — many-to-
 *  many edges via these objects when the org permits; reconciler-only
 *  fallback to single-WhoId/single-WhatId emission with
 *  `coverage.sources_unavailable` note when probe shows the
 *  relationship object isn't enabled.
 *
 *  D-139 P1b Codex review fold #10 — relationship objects are
 *  SERVER-INTERNAL substrate constants. They are intentionally NOT
 *  registered in `CONNECTION_VENDOR_ENTITIES` because:
 *
 *    1. Relationship reconcilers emit `engagement_edges` rows ONLY
 *       (no `EngagementRow` writes; no `data_enrichment` rows).
 *    2. There is no meaningful `meta_field` projection — junction
 *       tables carry only parent_id + relation_id; nothing renders.
 *    3. The recipe-validator surface
 *       (`data.enrichment.connection.api.salesforce.task_relation.*`)
 *       is intentionally absent — relationship objects don't have
 *       enrichment scopes.
 *
 *  These constants drive the wire-shape only: PushTopic provisioning,
 *  CometD subscription channels, the engagement webhook processor's
 *  channel filter, and the relationship-reconcilers themselves.
 *  Recipe authors never reference relationship entities. */
export const SALESFORCE_RELATIONSHIP_ENTITY_NAMES = [
  'task_relation',
  'event_relation',
  'email_message_relation',
] as const;
export type SalesforceRelationshipEntityName =
  (typeof SALESFORCE_RELATIONSHIP_ENTITY_NAMES)[number];

/** D-139 P1b — combined Salesforce engagement discriminator (parents
 *  + relationships). Used by reconciler registration + capability
 *  probe + describeSObjects projection. */
export const SALESFORCE_ALL_ENGAGEMENT_ENTITIES = [
  ...SALESFORCE_ENGAGEMENT_ENTITY_NAMES,
  ...SALESFORCE_RELATIONSHIP_ENTITY_NAMES,
] as const;

/** D-139 P1b — Salesforce SObject API name per engagement entity. The
 *  describeSObjects probe + SOQL queries reference these strings;
 *  recued-side entity names are snake_case (`email_message`) but
 *  Salesforce wire shapes are PascalCase (`EmailMessage`). */
export const SALESFORCE_ENGAGEMENT_SOBJECT_NAMES: Record<
  SalesforceEngagementEntityName | SalesforceRelationshipEntityName,
  string
> = {
  task: 'Task',
  event: 'Event',
  email_message: 'EmailMessage',
  voice_call: 'VoiceCall',
  call_history: 'CallHistory',
  task_relation: 'TaskRelation',
  event_relation: 'EventRelation',
  email_message_relation: 'EmailMessageRelation',
} as const;

/** D-139 P1b — Salesforce SObject Id prefixes for engagement entities.
 *  3-character prefixes are stable across orgs; the webhook processor
 *  cross-validates the event's `sobject.Id` against the declared
 *  prefix as defence-in-depth (Pass-5 R5.10 — channel routing already
 *  filters per-PushTopic but prefix check surfaces protocol corruption).
 *
 *  Salesforce uses two prefixes for Tasks (`00T`) and Events (`00U`);
 *  EmailMessage is `02s`; VoiceCall is `0LQ` (Service Cloud Voice);
 *  CallHistory is `09I` (legacy Service Cloud); TaskRelation is `00G`
 *  (`AccountTeamMember` shares prefix — junction objects are stable
 *  by SObject not by id range alone, but the channel filter is the
 *  primary discriminator); EventRelation is `00U` (same as Event base
 *  prefix per Salesforce convention); EmailMessageRelation is `02n`. */
export const SALESFORCE_ENGAGEMENT_SOBJECT_ID_PREFIXES: Record<
  SalesforceEngagementEntityName | SalesforceRelationshipEntityName,
  string
> = {
  task: '00T',
  event: '00U',
  email_message: '02s',
  voice_call: '0LQ',
  call_history: '09I',
  task_relation: '00G',
  event_relation: '00U',
  email_message_relation: '02n',
} as const;

/** D-139 P1b — PushTopic names per engagement entity. CometD channel
 *  paths land at `/topic/<PushTopicName>`; the webhook funnel filters
 *  per-channel. SOAP `create()` at first enrollment (idempotent on
 *  re-enrollment per D-130 P5 pattern). */
export const SALESFORCE_ENGAGEMENT_PUSHTOPIC_NAMES: Record<
  SalesforceEngagementEntityName | SalesforceRelationshipEntityName,
  string
> = {
  task: 'RecuedTaskFeed',
  event: 'RecuedEventFeed',
  email_message: 'RecuedEmailMessageFeed',
  voice_call: 'RecuedVoiceCallFeed',
  call_history: 'RecuedCallHistoryFeed',
  task_relation: 'RecuedTaskRelationFeed',
  event_relation: 'RecuedEventRelationFeed',
  email_message_relation: 'RecuedEmailMessageRelationFeed',
} as const;

/** D-139 P1b — canonical Salesforce Task fields. Cursor field is
 *  `LastModifiedDate`; `ActivityDate` carries the due-date (date-only
 *  per Pass-5 R5.6 — local-day interval). `Status = 'Completed'` +
 *  `CompletedDateTime` populated drives the lifecycle flip; `WhoId` +
 *  `WhatId` are single-pointer fallback fields when TaskRelation is
 *  unavailable. `OwnerId` + `CreatedById` drive authorship; the
 *  Automated Process User CreatedById marks `'crm_automation'`
 *  per § A.3.2. */
export const SALESFORCE_TASK_FIELDS = [
  'Id',
  'Subject',
  'Status',
  'Priority',
  'ActivityDate',
  'CompletedDateTime',
  'OwnerId',
  'CreatedById',
  'CreatedDate',
  'LastModifiedDate',
  'SystemModstamp',
  'WhoId',
  'WhatId',
  'CallType',
  'TaskSubtype',
  'IsClosed',
  'IsRecurrence',
] as const;

/** D-139 P1b — canonical Salesforce Event fields. `StartDateTime` is
 *  the future-vs-past discriminator for `event_at` per § A.3.1.
 *  Past events promote `event_at = StartDateTime`; future events
 *  populate `scheduled_start_at` and leave `event_at = NULL`.
 *  EventRelation drives multi-attendee fan-out when available;
 *  `WhoId`/`WhatId` are the single-pointer fallback. */
export const SALESFORCE_EVENT_FIELDS = [
  'Id',
  'Subject',
  'Description',
  'StartDateTime',
  'EndDateTime',
  'ActivityDate',
  'DurationInMinutes',
  'Location',
  'IsAllDayEvent',
  'OwnerId',
  'CreatedById',
  'CreatedDate',
  'LastModifiedDate',
  'SystemModstamp',
  'WhoId',
  'WhatId',
  'EventSubtype',
] as const;

/** D-139 P1b — canonical Salesforce EmailMessage fields. `MessageDate`
 *  drives `event_at` per § A.3.1; `Incoming` boolean drives
 *  `direction` per § A.3.3 (`true` → `'inbound'`, `false` →
 *  `'outbound'`). `RelatedToId` + `WhoId` are pointers to the linked
 *  Account / Opportunity / Lead / Contact when EmailMessageRelation
 *  is unavailable. */
export const SALESFORCE_EMAIL_MESSAGE_FIELDS = [
  'Id',
  'Subject',
  'TextBody',
  'HtmlBody',
  'FromAddress',
  'FromName',
  'ToAddress',
  'CcAddress',
  'BccAddress',
  'MessageDate',
  'Status',
  'Incoming',
  'HasAttachment',
  'MessageIdentifier',
  'ThreadIdentifier',
  'RelatedToId',
  'CreatedById',
  'CreatedDate',
  'LastModifiedDate',
  'SystemModstamp',
] as const;

/** D-139 P1b — canonical Salesforce VoiceCall fields. Service Cloud
 *  Voice exposes VoiceCall as a first-class SObject. `CallStartDateTime`
 *  drives `event_at` per § A.3.1; `CallType` is `'INBOUND'` /
 *  `'OUTBOUND'` for direction; `OwnerId` is the rep who took/made
 *  the call. */
export const SALESFORCE_VOICE_CALL_FIELDS = [
  'Id',
  'CallStartDateTime',
  'CallEndDateTime',
  'CallDurationInSeconds',
  'CallType',
  'CallDisposition',
  'CallSubject',
  'CallObject',
  'OwnerId',
  'CreatedById',
  'CreatedDate',
  'LastModifiedDate',
  'SystemModstamp',
  'CallerNumber',
  'ContactId',
  'AccountId',
  'OpportunityId',
] as const;

/** D-139 P1b — canonical Salesforce CallHistory fields. Legacy
 *  Service Cloud uses CallHistory; not all orgs have it enabled (the
 *  capability probe falls back to VoiceCall when CallHistory is
 *  unavailable per Pass-5 R5.11). `CallStartDateTime` drives
 *  `event_at`; otherwise the field shape is similar to VoiceCall. */
export const SALESFORCE_CALL_HISTORY_FIELDS = [
  'Id',
  'CallStartDateTime',
  'CallDurationInSeconds',
  'CallType',
  'OwnerId',
  'CreatedById',
  'CreatedDate',
  'LastModifiedDate',
  'SystemModstamp',
] as const;

/** D-139 P1b — canonical Salesforce TaskRelation fields. Junction
 *  table joining Task → multiple WhoIds (Contact / Lead). The
 *  reconciler emits one `engagement_edges` row per junction row;
 *  `RelationId` is the WhoId; `IsWhat = false` for who-relations,
 *  `true` for what-relations. `TaskId` is the parent Task. */
export const SALESFORCE_TASK_RELATION_FIELDS = [
  'Id',
  'TaskId',
  'RelationId',
  'IsWhat',
  'IsDeleted',
  'CreatedDate',
  'LastModifiedDate',
  'SystemModstamp',
] as const;

/** D-139 P1b — canonical Salesforce EventRelation fields. Junction
 *  table joining Event → multiple attendees + linked records. Same
 *  shape as TaskRelation; `EventId` is the parent Event. */
export const SALESFORCE_EVENT_RELATION_FIELDS = [
  'Id',
  'EventId',
  'RelationId',
  'IsWhat',
  'IsParent',
  'IsInvitee',
  'Status',
  'Response',
  'IsDeleted',
  'CreatedDate',
  'LastModifiedDate',
  'SystemModstamp',
] as const;

/** D-139 P1b — canonical Salesforce EmailMessageRelation fields.
 *  Junction table joining EmailMessage → recipients + linked records.
 *  `RelationType` is `'FromAddress'` / `'ToAddress'` / `'CcAddress'`
 *  / `'BccAddress'` / `'OtherAddress'`. */
export const SALESFORCE_EMAIL_MESSAGE_RELATION_FIELDS = [
  'Id',
  'EmailMessageId',
  'RelationId',
  'RelationType',
  'RelationAddress',
  'RelationObjectType',
  'IsDeleted',
  'CreatedDate',
  'SystemModstamp',
] as const;

// ────────────────────────────────────────────────────────────────
// QuickBooks Online constants (SMB-finance wedge slice 1b)
//
// Reads LIVE-VERIFIED vs the QBO sandbox 2026-06-13. Unlike Salesforce,
// QBO SHARES one OAuth authorize/token URL across sandbox + production
// (no sandbox OAuth-URL split) and instead splits the *API base host*
// (sandbox-quickbooks vs quickbooks). The per-company `realmId` arrives
// on the OAuth CALLBACK query param (NOT the token response, unlike
// Salesforce's `instance_url`); the OAuth completion handler composes the
// runtime base `<host>/v3/company/<realmId>` from it via `realm_base`.
// ────────────────────────────────────────────────────────────────

export const QUICKBOOKS_OAUTH_SCOPES = ['com.intuit.quickbooks.accounting'] as const;
export const QUICKBOOKS_OAUTH_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const QUICKBOOKS_OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
/** Production REST API base host. */
export const QUICKBOOKS_API_BASE_PRODUCTION = 'https://quickbooks.api.intuit.com';
/** Sandbox REST API base host (Development keys connect sandbox companies). */
export const QUICKBOOKS_API_BASE_SANDBOX = 'https://sandbox-quickbooks.api.intuit.com';
/** Realm path suffix — the per-company id lands in the PATH. `{realm_id}`
 *  is filled by `composeRealmBaseUrl` from the OAuth-callback realmId. */
export const QUICKBOOKS_REALM_PATH_TEMPLATE = '/v3/company/{realm_id}';
/** `config.base_url` form prefill before OAuth composes the real per-company
 *  base (the realm segment is overwritten at OAuth completion). */
export const QUICKBOOKS_API_BASE_PLACEHOLDER = `${QUICKBOOKS_API_BASE_PRODUCTION}/v3/company/REALM_ID`;
/** Intuit webhook HMAC signature header (webhooks optional; documentation
 *  marker so the provider shape stays uniform). */
export const QUICKBOOKS_WEBHOOK_SIGNATURE_HEADER = 'intuit-signature';
export const QUICKBOOKS_DEFAULT_RECONCILIATION_CADENCE = '6h' as const;

// ────────────────────────────────────────────────────────────────
// Google Drive (SMB-finance wedge slice 3 — storage-gdrive)
// ────────────────────────────────────────────────────────────────
//
// Standard OAuth 2.0 authorization-code + refresh-token flow (no realm,
// no sandbox split). BYO Google Cloud OAuth app — the user supplies their
// own client_id/client_secret, mirroring the BYO-OAuth posture of HubSpot
// (D-129) and QuickBooks (slice 1b). Google echoes `scope` in the token
// response (RFC 6749 § 3.3-compliant) so granted scopes are read there —
// no introspection round-trip. The one Google quirk: a refresh token is
// issued ONLY when the authorize URL carries `access_type=offline` AND
// `prompt=consent`, so the provider declares those as `authorize_params`
// (the authorize-URL builder merges them in — `buildVendorAuthorizeUrl`).
//
// Scopes: `drive.readonly` covers list / metadata / download (the read,
// list, fetch surface); `drive.file` adds upload (the write/ask op) scoped
// to files the app itself creates — least-privilege for a storage lane that
// reads the user's folder and only ever writes back its own artifacts.

export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
] as const;
export const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Google Drive REST v3 API base. `path_template`s in the storage-gdrive
 *  pack are relative to it (e.g. `/files`, `/files/{{file_id}}`). */
export const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
/** Extra authorize-URL params Google requires to mint a refresh token.
 *  `access_type=offline` requests the refresh token; `prompt=consent`
 *  forces the consent screen every time so the refresh token is returned
 *  on re-enrollment (Google omits it on silent re-consent otherwise). */
export const GOOGLE_OAUTH_AUTHORIZE_PARAMS = {
  access_type: 'offline',
  prompt: 'consent',
} as const;
/** Google Drive push-notification (`watch`) channel signature header.
 *  Webhooks are optional depth (the storage-gdrive lane polls `files.list`);
 *  this keeps the provider shape uniform with the other vendors. */
export const GOOGLE_WEBHOOK_SIGNATURE_HEADER = 'x-goog-channel-token';
export const GOOGLE_DEFAULT_RECONCILIATION_CADENCE = '6h' as const;

// ── Dropbox (D-192 file SOURCE family — files-dropbox pack) ──────────
// A plain OAuth 2.0 vendor like Google: no realm, no sandbox split. File Source
// sync mirrors metadata only, while explicit reads resolve bytes lazily through
// Dropbox's content API. The defaults therefore include account + metadata
// reads and the narrow content-read scope; the `dropbox` app pack's write ops
// (folder/move/copy/share) union their own `required_scopes` at enroll.
export const DROPBOX_OAUTH_SCOPES = [
  'account_info.read',
  'files.metadata.read',
  'files.content.read',
] as const;
export const DROPBOX_OAUTH_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_OAUTH_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
/** Dropbox API root — the `dropbox` app pack's http ingredient base AND the
 *  file SOURCE leaf's `list_folder` host. */
export const DROPBOX_API_BASE = 'https://api.dropboxapi.com';
/** Extra authorize-URL param Dropbox requires to mint a refresh token —
 *  `token_access_type=offline` (Dropbox's equivalent of Google's
 *  `access_type=offline`). Without it Dropbox returns only a short-lived
 *  (~4h) access token, useless for a background metadata mirror. */
export const DROPBOX_OAUTH_AUTHORIZE_PARAMS = {
  token_access_type: 'offline',
} as const;
/** Dropbox webhook HMAC-SHA256 signature header. The file SOURCE family polls
 *  (`list_folder`); webhooks are unused — this keeps the provider shape
 *  uniform with the other vendors. */
export const DROPBOX_WEBHOOK_SIGNATURE_HEADER = 'X-Dropbox-Signature';
export const DROPBOX_DEFAULT_RECONCILIATION_CADENCE = '6h' as const;

// ── OneDrive (D-192 file SOURCE family — Microsoft Graph /delta) ─────
// A plain OAuth 2.0 vendor like Dropbox/Google: no realm, no sandbox split.
// The OAuth authorize + token URLs are the shared Microsoft `/common/` identity
// endpoints (imported from foundational-oauth). Unlike Dropbox/Google there is
// NO `authorize_params` — Microsoft mints a refresh token from the
// `offline_access` SCOPE, not an authorize query param. RFC 6749 § 3.3-compliant
// token response echoes `scope`, so no introspection endpoint. BYO Microsoft
// Entra app.
/** Microsoft Graph REST v1.0 root — the OneDrive file SOURCE leaf's
 *  `/me/drive/root/delta` host AND the connection's fixed `config.base_url`. */
export const MICROSOFT_GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
/** OneDrive OAuth scopes requested at enrollment. `Files.Read` covers the
 *  `/delta` metadata walk and lazy explicit byte reads, `Files.ReadWrite` makes the
 *  connection write-capable, `offline_access` mints the refresh token, and
 *  `User.Read` backs identity read-back.
 *
 *  ⚠⚠ `Files.ReadWrite` IS A DELIBERATE WIDENING OF THE DEFAULT (owner-ratified
 *  2026-08-07), not a correction. The D-192 file SOURCE family that this seed was
 *  written for is READ-ONLY — it mirrors metadata and lazily fetches bytes, and
 *  never mutates — so the seed asked for read alone, and the enroll form's
 *  `prefillVendorScopes` already UNIONED in `Files.ReadWrite` the moment a
 *  write-capable pack was installed. Measured before the change:
 *      seed alone     -> Files.Read offline_access User.Read
 *      pack installed -> Files.Read Files.ReadWrite User.Read offline_access
 *  So nothing was broken; the owner chose a write-capable connection BEFORE any
 *  pack is installed over a minimal one that widens on demand.
 *
 *  ⛔ THE COST, STATED PLAINLY: someone who wants only the read-only file mirror is
 *  now asked to grant file mutation they will never exercise, and the consent
 *  screen they see is correspondingly broader. Recued still gates every write at
 *  approval (`RISK_APPROVAL_FLOOR`), but the TOKEN itself now carries the
 *  authority. Reverting is this constant plus the paired assertion in
 *  `connection-scope-prefill-corpus.test.ts`. */
export const ONEDRIVE_OAUTH_SCOPES = [
  GRAPH_FILES_READ_SCOPE,
  GRAPH_FILES_READWRITE_SCOPE,
  GRAPH_OFFLINE_SCOPE,
  GRAPH_USER_READ_SCOPE,
] as const;
/** OneDrive "webhook signature header" — a PLACEHOLDER. Microsoft Graph change
 *  notifications validate via a `clientState` / `validationToken` in the
 *  notification body, not an HMAC header; the file SOURCE family polls `/delta`
 *  and uses no webhooks at all. Non-empty only to satisfy the uniform provider
 *  shape (the registry validator requires a non-empty string). */
export const ONEDRIVE_WEBHOOK_SIGNATURE_HEADER = 'X-OneDrive-Unused-Webhook-Signature';
export const ONEDRIVE_DEFAULT_RECONCILIATION_CADENCE = '6h' as const;

// ── Box (D-192 file SOURCE family — /2.0/events delta) ──────────────
// A plain OAuth 2.0 vendor. Box mints a refresh token by DEFAULT (no offline /
// consent authorize param) and ROTATES it single-use on each refresh — the
// file-source resolver's refresh gate captures + persists the rotated token
// (`refreshOAuth2` adopts a new `refresh_token` whenever the issuer returns one),
// so the background mirror survives rotation. Box's app permissions are set in
// the Box developer console; the authorize `scope` param optionally downscopes,
// so `root_readonly` covers the metadata walk and lazy explicit byte reads. No
// sandbox split. BYO Box app.
/** Box API v2 REST root — the Box file SOURCE leaf's `/2.0/folders/{id}/items`
 *  + `/2.0/events` host AND the connection's fixed `config.base_url` (mirrors the
 *  `box` app pack's http ingredient base). */
export const BOX_API_BASE = 'https://api.box.com/2.0';
/** Box OAuth scopes requested at enrollment. Box scopes are APP-level (set in the
 *  Box developer console); the authorize `scope` param optionally downscopes to a
 *  subset, so `root_readonly` is the read floor for the metadata walk. */
export const BOX_OAUTH_SCOPES = ['root_readonly'] as const;
export const BOX_OAUTH_AUTHORIZE_URL = 'https://account.box.com/api/oauth2/authorize';
export const BOX_OAUTH_TOKEN_URL = 'https://api.box.com/oauth2/token';
/** Box V2 webhook HMAC signature header. The file SOURCE family polls
 *  `/2.0/events` (no webhooks); non-empty only to satisfy the uniform provider
 *  shape (the registry validator requires a non-empty string). */
export const BOX_WEBHOOK_SIGNATURE_HEADER = 'Box-Signature-Primary';
export const BOX_DEFAULT_RECONCILIATION_CADENCE = '6h' as const;

// ── SharePoint (D-192 file SOURCE family — Microsoft Graph document library) ──
// Not a new adapter: SharePoint document libraries ARE Microsoft Graph drives,
// so a SharePoint connection rides the SAME OneDrive `/delta` leaf via
// `config.drive_id` (which targets `/drives/{drive_id}/root/delta`) — the
// enrollment is the only thing that differs. Same shared Microsoft `/common/`
// identity endpoints, same fixed Graph REST base, no `authorize_params`
// (`offline_access` mints the refresh token), no introspection (RFC 6749 § 3.3),
// BYO Microsoft Entra app. The ONE deviation from OneDrive is the read scope:
// `Files.Read` only reaches the user's own OneDrive, so SharePoint requests
// `Sites.Read.All` to enumerate a document library drive.
/** SharePoint OAuth scopes requested at enrollment. `Sites.Read.All` is the
 *  metadata-read floor for a SharePoint document library drive (a `Files.Read`
 *  grant is scoped to the user's own OneDrive and 403s on a site drive — which
 *  the leaf surfaces as a graceful `policy` outcome). `offline_access` mints the
 *  refresh token, `User.Read` backs the `/me` identity read-back.
 *
 *  ⚠⚠ `Sites.ReadWrite.All` IS A DELIBERATE WIDENING (owner-ratified 2026-08-07) —
 *  see the OneDrive block above for the full rationale and the measured before/after.
 *  A document-library drive is NOT reachable by `Files.ReadWrite` (which is scoped to
 *  the user's own OneDrive), which is why the write pair splits exactly as the read
 *  pair does. The D-192 Source sync itself still only mirrors metadata and fetches
 *  bytes on an explicit read — it does not write; the connection is simply now
 *  capable of it before a pack asks. */
export const SHAREPOINT_OAUTH_SCOPES = [
  GRAPH_SITES_READ_ALL_SCOPE,
  GRAPH_SITES_READWRITE_ALL_SCOPE,
  GRAPH_OFFLINE_SCOPE,
  GRAPH_USER_READ_SCOPE,
] as const;
/** SharePoint "webhook signature header" — a PLACEHOLDER, like OneDrive's. The
 *  file SOURCE family polls `/delta` and uses no webhooks; non-empty only to
 *  satisfy the uniform provider shape (the registry validator requires a
 *  non-empty string). */
export const SHAREPOINT_WEBHOOK_SIGNATURE_HEADER = 'X-SharePoint-Unused-Webhook-Signature';
export const SHAREPOINT_DEFAULT_RECONCILIATION_CADENCE = '6h' as const;

// ────────────────────────────────────────────────────────────────
// Type
// ────────────────────────────────────────────────────────────────

/** Runtime API-base composition for vendors that carry a per-company /
 *  realm id in the URL PATH (rather than receiving a full per-org base via
 *  the token response's `instance_url`, like Salesforce). QuickBooks Online
 *  is the first: the `realmId` arrives on the OAuth callback and
 *  `<host>/v3/company/<realmId>` becomes `config.base_url`. `production` /
 *  `sandbox` are API hosts; the sandbox host is selected by the connection's
 *  sandbox flag (QBO shares OAuth URLs and splits only the API host). */
export interface RealmBaseConfig {
  production: string;
  sandbox: string;
  /** Path suffix appended to the host; MUST contain the literal
   *  `{realm_id}` placeholder. */
  path_template: string;
}

/** A tenant-specific API origin carried by a vendor's OAuth token response.
 *
 * This is deliberately opt-in per registered vendor. OAuth responses are
 * otherwise untrusted JSON, and an unexpected `instance_url` / `api_domain`
 * must never become the destination for the bearer token minted beside it.
 * Host suffixes are registry authority (not response data), and the resolved
 * value is an HTTPS origin only: no path, query, fragment, credentials, or
 * non-default port. */
export interface VendorOAuthRuntimeBaseConfig {
  token_response_field: 'instance_url' | 'api_domain';
  allowed_hostname_suffixes: ReadonlyArray<string>;
}

export type VendorOAuthRuntimeBaseResolution =
  | { status: 'not_expected' }
  | { status: 'missing'; field: 'instance_url' | 'api_domain' }
  | {
      status: 'invalid';
      field: 'instance_url' | 'api_domain';
      reason: string;
    }
  | {
      status: 'valid';
      field: 'instance_url' | 'api_domain';
      base_url: string;
    };

/** OAuth metadata for a vendor that uses the standard OAuth 2.0
 *  authorization-code + refresh-token flow. Fields map directly into
 *  the `auth: { type: 'oauth2_refresh', ... }` connection-record auth
 *  shape — `token_endpoint` lands as-is, `scopes` get joined into the
 *  authorize-URL `scope` query parameter. */
export interface VendorOAuthConfig {
  /** Authorization URL the user is redirected to during enrollment.
   *  Vendor-specific consent UI lives here. */
  authorize_url: string;
  /** Token exchange + refresh endpoint. Reused for both
   *  `grant_type=authorization_code` (initial exchange) and
   *  `grant_type=refresh_token` (every subsequent refresh).
   *  Lands directly on `ConnectionAuth.oauth2_refresh.token_endpoint`. */
  token_endpoint: string;
  /** Scope set requested at enrollment. The vendor may grant a
   *  subset; granted scopes persist alongside the connection record
   *  (P1.2) so reconcilers can register conditionally. */
  scopes: ReadonlyArray<string>;
  /** Whether the vendor requires a `client_secret` at token
   *  exchange. PKCE-only public clients set this false; HubSpot
   *  requires it (true). */
  client_secret_required: boolean;
  /** How the OAuth client credentials are sent to the token endpoint.
   *  Omitted means the legacy form-body style (`client_secret` field in the
   *  x-www-form-urlencoded body). Pipedrive requires HTTP Basic auth. */
  token_auth_style?: 'body' | 'basic';
  /** D-129 P1.2 — optional access-token introspection endpoint for
   *  vendors that do NOT echo `scope` in the token-exchange response
   *  (HubSpot is the canonical example — it deviates from RFC 6749
   *  § 3.3). When set, the `completeVendorOAuth` rpc GETs
   *  `<access_token_introspect_url>/<access_token>` after exchange to
   *  read the granted-scope list from the response body's `scopes`
   *  field. When unset, granted scopes are read from the token
   *  response's `scope` field per RFC. */
  access_token_introspect_url?: string;
  /** D-130 — sandbox-mode authorize URL. When set alongside
   *  `sandbox_token_endpoint`, the connection's `config.sandbox`
   *  flag selects this pair at OAuth time (Salesforce splits
   *  `login.salesforce.com` for production from
   *  `test.salesforce.com` for sandbox). When unset, the vendor
   *  has no sandbox split (HubSpot) and the production
   *  `authorize_url` / `token_endpoint` are used regardless of
   *  any sandbox flag the form might smuggle through. Both
   *  sandbox fields must be set together — the validator rejects
   *  one without the other. */
  sandbox_authorize_url?: string;
  /** D-130 — sandbox-mode token endpoint. See
   *  `sandbox_authorize_url` for the pairing rule. */
  sandbox_token_endpoint?: string;
  /** SMB-finance slice 3 — extra static query params merged into the
   *  authorize URL (`buildVendorAuthorizeUrl`) beyond the standard
   *  `response_type` / `client_id` / `redirect_uri` / `scope` / `state`.
   *  Google needs `access_type=offline` + `prompt=consent` to issue a
   *  refresh token; vendors without the need leave this unset. The
   *  reserved standard keys cannot be overridden (the builder applies
   *  these first, then the standard set wins). */
  authorize_params?: Readonly<Record<string, string>>;
  /** Whether the vendor supports PKCE (RFC 7636, S256). When true, the
   *  OAuth-start builder appends `code_challenge` + `code_challenge_method=
   *  S256` to the authorize URL and stores the `code_verifier` in the flow
   *  record; `/oauth/complete` sends the verifier at token exchange. This
   *  binds the authorization code to the flow the user actually started,
   *  closing the authorization-code-injection vector (an attacker who
   *  captures a valid state can't redeem THEIR code against the user's flow —
   *  the provider rejects a code_verifier that doesn't match the challenge
   *  their code was issued against).
   *
   *  Per-vendor because support varies. Verification basis (desk, via provider
   *  docs + their official OSS clients — no live accounts):
   *    - Salesforce — ON. Docs explicitly recommend PKCE WITH the consumer
   *      secret for private clients (confidential-client + PKCE together).
   *    - Google — ON. Web-server (confidential) apps send BOTH client_secret
   *      AND code_verifier at the token endpoint.
   *    - QuickBooks (Intuit) — OFF. Intuit's own OAuth clients don't implement
   *      PKCE and its authorize docs omit code_challenge; sending it risks a
   *      param rejection. Re-enable only after a live authorize check.
   *    - HubSpot — OFF. Server-side OAuth doesn't implement PKCE at all.
   *  When unset (falsy) the flow stays exactly as before (no challenge, no
   *  verifier). */
  supports_pkce?: boolean;
  /** Optional tenant API origin returned by the token endpoint. When present,
   * initial exchange requires the declared field and refresh may atomically
   * update `config.base_url`. Unregistered response fields stay inert. */
  runtime_base?: VendorOAuthRuntimeBaseConfig;
}

// ────────────────────────────────────────────────────────────────
// Sandbox-aware endpoint resolver (D-130)
// ────────────────────────────────────────────────────────────────

/** Resolve the OAuth authorize + token URLs to use for a given
 *  vendor + sandbox-flag combination. Returns the production pair
 *  for vendors without a sandbox split (HubSpot), and either pair
 *  for vendors that ship both (Salesforce). The resolver is
 *  call-site agnostic — both the `authorize_url` (consumed by
 *  the dialog to construct the consent redirect) and the
 *  `token_endpoint` (consumed by the OAuth code-exchange helper
 *  + the runtime refresh adapter) come from one lookup so the
 *  dialog, the rpc, and the adapter never disagree about which
 *  environment the user picked. */
export const resolveVendorOAuthEndpoints = (
  provider: ConnectionVendorProvider,
  opts: { sandbox?: boolean | ConnectionSandboxFlag } = {},
): { authorize_url: string; token_endpoint: string } => {
  const flag = opts.sandbox;
  const isSandbox =
    flag === true ||
    flag === 'sandbox';
  if (
    isSandbox &&
    provider.oauth.sandbox_authorize_url &&
    provider.oauth.sandbox_token_endpoint
  ) {
    return {
      authorize_url: provider.oauth.sandbox_authorize_url,
      token_endpoint: provider.oauth.sandbox_token_endpoint,
    };
  }
  return {
    authorize_url: provider.oauth.authorize_url,
    token_endpoint: provider.oauth.token_endpoint,
  };
};

/** The scopes a registered vendor's sign-in asks for: the vendor's own
 *  `oauth.scopes` verbatim first — the floor that carries its essentials
 *  (`oauth` / `refresh_token` / `offline_access`), so trimming one from the
 *  form changes nothing — then the pack scopes beyond it, deduped, in the
 *  order given. No pack scopes ⇒ exactly the vendor's list.
 *
 *  Shared by the server's start (`startVendorOAuth`) and the loopback dance the
 *  browser drives itself, so the two ask for the same set. */
export const vendorOAuthRequestedScopes = (
  provider: ConnectionVendorProvider,
  packScopes: ReadonlyArray<string>,
): string[] => [...new Set([...provider.oauth.scopes, ...packScopes])];

/** Build the vendor authorize URL the user's browser is sent to.
 *  `URLSearchParams` percent-encodes every value. `client_secret` is NEVER
 *  placed here — it is used only at token exchange. Sandbox selects the
 *  sandbox authorize URL when the provider declares one (Salesforce).
 *
 *  Pure, and shared: the server's start embeds its signed `state`; the loopback
 *  dance (a PWA on `localhost`, which has no public address for that start)
 *  embeds the `frelay_` state it minted. One builder, so a registered vendor's
 *  address, extra params and PKCE cannot differ between the two. */
export const buildVendorAuthorizeUrl = (opts: {
  provider: ConnectionVendorProvider;
  client_id: string;
  redirect_uri: string;
  sandbox: boolean;
  state: string;
  /** PKCE S256 challenge — present only for `supports_pkce` providers. When
   *  set, the builder adds `code_challenge` + `code_challenge_method=S256`
   *  (reserved keys a vendor's authorize_params can't override). */
  code_challenge?: string;
}): string => {
  const { authorize_url } = resolveVendorOAuthEndpoints(opts.provider, {
    sandbox: opts.sandbox,
  });
  const params = new URLSearchParams();
  // Vendor extra params first (Google's `access_type=offline` +
  // `prompt=consent` to mint a refresh token); the standard keys are set
  // after so they win — a vendor can never override `state`/`scope`/etc.
  // (the provider validator already rejects reserved keys, this is the
  // defense-in-depth ordering).
  for (const [k, v] of Object.entries(opts.provider.oauth.authorize_params ?? {})) {
    params.set(k, v);
  }
  params.set('response_type', 'code');
  params.set('client_id', opts.client_id);
  params.set('redirect_uri', opts.redirect_uri);
  params.set('scope', opts.provider.oauth.scopes.join(' '));
  params.set('state', opts.state);
  if (opts.code_challenge !== undefined) {
    params.set('code_challenge', opts.code_challenge);
    params.set('code_challenge_method', 'S256');
  }
  return `${authorize_url}?${params.toString()}`;
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Resolve and validate a provider-declared tenant API origin from a token
 * response. This function never guesses from arbitrary response fields: only a
 * registry entry carrying `oauth.runtime_base` can produce a URL. */
export const resolveVendorOAuthRuntimeBase = (
  provider: ConnectionVendorProvider,
  tokenResponse: Readonly<Record<string, unknown>>,
): VendorOAuthRuntimeBaseResolution => {
  const rule = provider.oauth.runtime_base;
  if (rule === undefined) return { status: 'not_expected' };

  const field = rule.token_response_field;
  if (!hasOwn(tokenResponse, field)) return { status: 'missing', field };
  const raw = tokenResponse[field];
  if (typeof raw !== 'string' || raw.length === 0) {
    return {
      status: 'invalid',
      field,
      reason: 'must be a non-empty string',
    };
  }
  if (raw.trim() !== raw) {
    return { status: 'invalid', field, reason: 'must not contain surrounding whitespace' };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { status: 'invalid', field, reason: 'must be a complete URL' };
  }
  if (url.protocol !== 'https:') {
    return { status: 'invalid', field, reason: 'must use HTTPS' };
  }
  if (url.username !== '' || url.password !== '') {
    return { status: 'invalid', field, reason: 'must not contain credentials' };
  }
  if (url.port !== '') {
    return { status: 'invalid', field, reason: 'must not use a non-default port' };
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return { status: 'invalid', field, reason: 'must be an origin with no path, query, or fragment' };
  }

  const hostname = url.hostname.toLowerCase();
  const allowed = rule.allowed_hostname_suffixes.some((rawSuffix) => {
    const suffix = rawSuffix.toLowerCase();
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
  if (!allowed) {
    return { status: 'invalid', field, reason: 'host is outside the provider allowlist' };
  }
  return { status: 'valid', field, base_url: url.origin };
};

/** D-129 P1 — vendor provider entry. One per first-party vendor.
 *  D-129 ships HubSpot; D-130 ships Salesforce; certified-vendor
 *  program post-launch opens the registry to third parties. */
export interface ConnectionVendorProvider {
  /** Vendor segment matching the `connection.api.<vendor>.<entity>`
   *  enrichment scope shape (D-128) and the `config.vendor` field on
   *  the connection record. Lowercase, `[a-z][a-z0-9_]*`. */
  vendor: string;
  /** User-visible label shown in the kind picker + form header. */
  display_name: string;
  /** One-liner shown under the picker option. */
  description: string;
  /** Default `config.base_url` value pre-filled into the enrollment
   *  form. User can override (e.g. EU instances). */
  default_base_url: string;
  oauth: VendorOAuthConfig;
  /** Auth types a connection may hold INSTEAD of this vendor's OAuth app and
   *  still serve its API, because the vendor takes them exactly as it takes an
   *  OAuth access token. HubSpot's Service Key is a `bearer` sent as
   *  `Authorization: Bearer`, so a pack that requires HubSpot is offered a
   *  Service Key connection at install (`findEndpointCandidates`), not only one
   *  made through an app. Absent ⇒ only the requirement's own auth type serves. */
  also_accepts_auth?: readonly ConnectionAuthType[];
  /** Webhook HMAC signature header name. Per-vendor — HubSpot uses
   *  `X-HubSpot-Signature-v3`. The webhook funnel (D-128 P3) reads
   *  this from the per-vendor `WebhookProcessor.signature_header` at
   *  call time; this duplicate copy on the provider lets the
   *  enrollment surface render a "Webhook URL: …" hint without
   *  pulling the runtime processor into UI code. */
  webhook_signature_header: string;
  /** Default reconciliation cadence per D-128's `ReconciliationCadence`
   *  union. `'6h'` is the platform-wide default; vendors with tighter
   *  webhook coverage can lower. Surfaced in the enrollment form's
   *  "Reconciliation cadence" picker (P1.3) for user override. */
  default_cadence: '1h' | '6h' | '24h';
  /** Optional — present for vendors that compose their runtime API base
   *  from an OAuth-callback realm/company id (QuickBooks). When set, the
   *  OAuth completion handler composes `instance_url` =
   *  `composeRealmBaseUrl(provider, realmId, sandbox)` so the existing
   *  `instance_url` → `config.base_url` persistence path carries it. */
  realm_base?: RealmBaseConfig;
}

/** Compose the runtime API base for a realm-path vendor (QuickBooks) from
 *  the OAuth-callback realm id + the sandbox flag. Returns `null` when the
 *  provider has no `realm_base` or `realmId` is empty. The result lands on
 *  `config.base_url` (via the `instance_url` plumbing); REST `path_template`s
 *  in the pack are relative to it (e.g. `/query`, `/invoice/{{id}}`). */
export const composeRealmBaseUrl = (
  provider: ConnectionVendorProvider,
  realmId: string,
  sandbox?: boolean,
): string | null => {
  const rb = provider.realm_base;
  if (!rb || typeof realmId !== 'string' || realmId.length === 0) return null;
  const host = sandbox ? rb.sandbox : rb.production;
  return host + rb.path_template.replace('{realm_id}', encodeURIComponent(realmId));
};

/** The reserved `vendor` slug for a FORM-SUPPLIED (non-registry) OAuth
 *  connection — a generic BYO OAuth app whose authorize/token URLs + scopes
 *  the user typed into the connection form rather than picking a registered
 *  vendor. The OAuth-start / complete handlers branch on the PRESENCE of
 *  form-supplied endpoints, not on this slug, and `getVendorProvider` only
 *  matches real registry entries — so this never collides with one. */
export const GENERIC_OAUTH_VENDOR = 'custom';

/** Synthesize a minimal {@link ConnectionVendorProvider} for a form-supplied
 *  OAuth connection (R14 — the generic "Add API connection" flow runs the
 *  in-app consent dance for ANY vendor, not just the ~4 registered ones).
 *  Only `oauth.{authorize_url, token_endpoint, scopes}` are load-bearing —
 *  they feed `buildVendorAuthorizeUrl` (the consent request) and
 *  `resolveVendorOAuthEndpoints` (the token exchange). The UI-only fields
 *  carry inert placeholders; no sandbox split, no PKCE, no introspection, no
 *  realm-base, so a generic vendor echoes its granted scopes per RFC 6749
 *  § 3.3. `client_secret_required: false` — BYO public clients enroll without
 *  a secret (one is still sent at exchange when supplied). This object is used
 *  ONLY by the OAuth-start/complete dance; it never enters the registry or
 *  any reconciler/webhook path, so the empty placeholders are unreachable. */
export const buildGenericVendorProvider = (config: {
  authorize_url: string;
  token_endpoint: string;
  scopes: ReadonlyArray<string>;
  /** Slug stamped onto the flow record + the optional signed-state hint.
   *  Defaults to {@link GENERIC_OAUTH_VENDOR}. */
  vendor?: string;
}): ConnectionVendorProvider => ({
  vendor: config.vendor ?? GENERIC_OAUTH_VENDOR,
  display_name: '',
  description: '',
  default_base_url: '',
  webhook_signature_header: '',
  default_cadence: '6h',
  oauth: {
    authorize_url: config.authorize_url,
    token_endpoint: config.token_endpoint,
    scopes: config.scopes,
    client_secret_required: false,
  },
});

// ────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────

const VENDOR_REGEX = /^[a-z][a-z0-9_]*$/;

const HUBSPOT_PROVIDER: ConnectionVendorProvider = {
  vendor: 'hubspot',
  display_name: 'HubSpot',
  description: 'CRM platform — deals, contacts, companies. A Service Key, or your own OAuth app.',
  default_base_url: HUBSPOT_API_BASE,
  // A Service Key (the form's default) authenticates exactly like an OAuth
  // access token; the reconcilers and catalog read either
  // (`resolveBearerAccessToken`).
  also_accepts_auth: ['bearer'],
  oauth: {
    authorize_url: HUBSPOT_OAUTH_AUTHORIZE_URL,
    token_endpoint: HUBSPOT_OAUTH_TOKEN_URL,
    scopes: HUBSPOT_OAUTH_SCOPES,
    client_secret_required: true,
    access_token_introspect_url: HUBSPOT_OAUTH_INTROSPECT_URL,
  },
  webhook_signature_header: HUBSPOT_WEBHOOK_SIGNATURE_HEADER,
  default_cadence: HUBSPOT_DEFAULT_RECONCILIATION_CADENCE,
};

const SALESFORCE_PROVIDER: ConnectionVendorProvider = {
  vendor: 'salesforce',
  display_name: 'Salesforce',
  description:
    'CRM platform — opportunities, contacts, accounts. OAuth + CometD streaming acceleration. Sandbox + production orgs.',
  default_base_url: SALESFORCE_API_BASE_PLACEHOLDER,
  oauth: {
    authorize_url: SALESFORCE_OAUTH_AUTHORIZE_URL_PRODUCTION,
    token_endpoint: SALESFORCE_OAUTH_TOKEN_URL_PRODUCTION,
    sandbox_authorize_url: SALESFORCE_OAUTH_AUTHORIZE_URL_SANDBOX,
    sandbox_token_endpoint: SALESFORCE_OAUTH_TOKEN_URL_SANDBOX,
    scopes: SALESFORCE_OAUTH_SCOPES,
    client_secret_required: true,
    // Salesforce supports PKCE (web server flow). Binds the code to the flow.
    supports_pkce: true,
    runtime_base: {
      token_response_field: 'instance_url',
      allowed_hostname_suffixes: ['salesforce.com'],
    },
    // Salesforce is RFC 6749 § 3.3-compliant — the token-exchange
    // response echoes `scope` so the granted-scope set is read
    // there, no introspection round-trip needed. (The
    // permission-profile-based per-entity readability check is a
    // P2 concern — describe-call probes after enrollment, not at
    // OAuth time.)
  },
  webhook_signature_header: SALESFORCE_WEBHOOK_SIGNATURE_HEADER,
  default_cadence: SALESFORCE_DEFAULT_RECONCILIATION_CADENCE,
};

/** Pipedrive CRM. OAuth is the normal first-party path; Pipedrive also supports
 *  API-token auth at the catalog surface for users who enroll a generic API-key
 *  connection. Webhook acceleration is not modeled here: the marker header is
 *  only the optional basic-auth verification header used by Pipedrive webhooks. */
const PIPEDRIVE_PROVIDER: ConnectionVendorProvider = {
  vendor: 'pipedrive',
  display_name: 'Pipedrive',
  description:
    'CRM platform — deals, people, and organizations. OAuth 2.0 via your own Pipedrive app; catalog-backed reads and approval-gated deal creation.',
  default_base_url: PIPEDRIVE_API_BASE,
  oauth: {
    authorize_url: PIPEDRIVE_OAUTH_AUTHORIZE_URL,
    token_endpoint: PIPEDRIVE_OAUTH_TOKEN_URL,
    scopes: PIPEDRIVE_OAUTH_SCOPES,
    client_secret_required: true,
    token_auth_style: 'basic',
    runtime_base: {
      token_response_field: 'api_domain',
      allowed_hostname_suffixes: ['pipedrive.com'],
    },
  },
  webhook_signature_header: PIPEDRIVE_WEBHOOK_SIGNATURE_HEADER,
  default_cadence: PIPEDRIVE_DEFAULT_RECONCILIATION_CADENCE,
};

/** SMB-finance wedge slice 1b — QuickBooks Online. Shares one OAuth
 *  authorize/token URL across sandbox + production (no sandbox OAuth-URL
 *  split, so no `sandbox_*` endpoints); the sandbox split is the API base
 *  HOST, carried by `realm_base` + the connection's sandbox flag. The
 *  per-company `realmId` arrives on the OAuth callback, not the token
 *  response — the completion handler composes `config.base_url` from it. */
const QUICKBOOKS_PROVIDER: ConnectionVendorProvider = {
  vendor: 'quickbooks',
  display_name: 'QuickBooks Online',
  description:
    'Accounting & bookkeeping — invoices, bills, expenses, payments, customers, vendors, chart of accounts. OAuth 2.0 via your own Intuit app; per-company realm. Reads live-verified (sandbox).',
  default_base_url: QUICKBOOKS_API_BASE_PLACEHOLDER,
  oauth: {
    authorize_url: QUICKBOOKS_OAUTH_AUTHORIZE_URL,
    token_endpoint: QUICKBOOKS_OAUTH_TOKEN_URL,
    scopes: QUICKBOOKS_OAUTH_SCOPES,
    client_secret_required: true,
    // PKCE deliberately OFF: Intuit's own OAuth clients (intuit/oauth-jsclient,
    // oauth-rubyclient) don't implement PKCE and Intuit's authorize docs list
    // only client_id/scope/redirect_uri/response_type/state — no code_challenge.
    // Sending it risks an authorize-param rejection (broken enrollment). Leave
    // unset until live-verified that the authorize endpoint accepts the
    // challenge; the redirect-pin + claim_secret still bound token theft.
    // No sandbox_authorize_url/token — QBO shares OAuth URLs across
    // environments; the sandbox split is the API host (realm_base).
  },
  realm_base: {
    production: QUICKBOOKS_API_BASE_PRODUCTION,
    sandbox: QUICKBOOKS_API_BASE_SANDBOX,
    path_template: QUICKBOOKS_REALM_PATH_TEMPLATE,
  },
  webhook_signature_header: QUICKBOOKS_WEBHOOK_SIGNATURE_HEADER,
  default_cadence: QUICKBOOKS_DEFAULT_RECONCILIATION_CADENCE,
};

/** SMB-finance wedge slice 3 — Google Drive (storage-gdrive pack). A plain
 *  OAuth 2.0 vendor: no realm, no sandbox split. The only deviation from
 *  HubSpot is `authorize_params` — Google needs `access_type=offline` +
 *  `prompt=consent` to return a refresh token (the builder merges them).
 *  RFC 6749 § 3.3-compliant token response echoes `scope`, so no
 *  introspection endpoint. BYO Google Cloud OAuth app. */
const GOOGLE_PROVIDER: ConnectionVendorProvider = {
  vendor: 'google',
  display_name: 'Google Drive',
  description:
    'Cloud file storage — list, read, and download documents from a Drive folder (e.g. a receipts/invoices folder); uploads ask. OAuth 2.0 via your own Google Cloud app.',
  default_base_url: GOOGLE_DRIVE_API_BASE,
  oauth: {
    authorize_url: GOOGLE_OAUTH_AUTHORIZE_URL,
    token_endpoint: GOOGLE_OAUTH_TOKEN_URL,
    scopes: GOOGLE_OAUTH_SCOPES,
    client_secret_required: true,
    authorize_params: GOOGLE_OAUTH_AUTHORIZE_PARAMS,
    // Google supports PKCE on the authorization-code flow.
    supports_pkce: true,
    // Google is RFC 6749 § 3.3-compliant — the token response echoes
    // `scope`, so granted scopes are read there (no introspection).
  },
  webhook_signature_header: GOOGLE_WEBHOOK_SIGNATURE_HEADER,
  default_cadence: GOOGLE_DEFAULT_RECONCILIATION_CADENCE,
};

/** D-192 file SOURCE family — Dropbox (files-dropbox pack). A plain OAuth 2.0
 *  vendor like Google: no realm, no sandbox split. The only deviation is
 *  `authorize_params` — Dropbox mints a refresh token only when the authorize
 *  URL carries `token_access_type=offline` (the builder merges it in). RFC
 *  6749 § 3.3-compliant token response echoes `scope`, so no introspection
 *  endpoint. BYO Dropbox app. */
const DROPBOX_PROVIDER: ConnectionVendorProvider = {
  vendor: 'dropbox',
  display_name: 'Dropbox',
  description:
    'Cloud file storage — mirror file/folder metadata into your warehouse; file bytes stay remote and are fetched only for an explicit read. The app pack adds approval-gated organize actions. OAuth 2.0 via your own Dropbox app.',
  default_base_url: DROPBOX_API_BASE,
  oauth: {
    authorize_url: DROPBOX_OAUTH_AUTHORIZE_URL,
    token_endpoint: DROPBOX_OAUTH_TOKEN_URL,
    scopes: DROPBOX_OAUTH_SCOPES,
    client_secret_required: true,
    authorize_params: DROPBOX_OAUTH_AUTHORIZE_PARAMS,
    // Dropbox supports PKCE on the authorization-code flow.
    supports_pkce: true,
    // Dropbox is RFC 6749 § 3.3-compliant — the token response echoes
    // `scope`, so granted scopes are read there (no introspection).
  },
  webhook_signature_header: DROPBOX_WEBHOOK_SIGNATURE_HEADER,
  default_cadence: DROPBOX_DEFAULT_RECONCILIATION_CADENCE,
};

/** D-192 file SOURCE family — OneDrive (Microsoft Graph). A plain OAuth 2.0
 *  vendor like Dropbox; the OneDrive adapter leaf mirrors file METADATA via the
 *  `/delta` changes feed, while explicit reads fetch bytes lazily. The deviation from Dropbox/
 *  Google: NO `authorize_params` — Microsoft mints the refresh token from the
 *  `offline_access` SCOPE, not an authorize param. RFC 6749 § 3.3-compliant
 *  token response echoes `scope`, so no introspection endpoint. BYO Microsoft
 *  Entra app. */
const ONEDRIVE_PROVIDER: ConnectionVendorProvider = {
  vendor: 'onedrive',
  display_name: 'OneDrive',
  description:
    'Cloud file storage — mirror file/folder metadata into your warehouse via Microsoft Graph; file bytes stay remote and are fetched only for an explicit read. OAuth 2.0 via your own Microsoft Entra app.',
  default_base_url: MICROSOFT_GRAPH_API_BASE,
  oauth: {
    authorize_url: MICROSOFT_AUTHORIZE_URL,
    token_endpoint: MICROSOFT_TOKEN_URL,
    scopes: ONEDRIVE_OAUTH_SCOPES,
    client_secret_required: true,
    // Microsoft supports PKCE (S256) on the authorization-code flow.
    supports_pkce: true,
    // No authorize_params — the refresh token comes from the `offline_access`
    // scope, not a `token_access_type` / `access_type` authorize query param.
    // Microsoft is RFC 6749 § 3.3-compliant — the token response echoes
    // `scope`, so granted scopes are read there (no introspection).
  },
  webhook_signature_header: ONEDRIVE_WEBHOOK_SIGNATURE_HEADER,
  default_cadence: ONEDRIVE_DEFAULT_RECONCILIATION_CADENCE,
};

/** D-192 file SOURCE family — Box. A plain OAuth 2.0 vendor; the Box adapter leaf
 *  mirrors file METADATA via the `/2.0/events` delta feed + a `/2.0/folders`
 *  tree walk, while explicit reads fetch bytes lazily. The deviation from Dropbox/Google: NO
 *  `authorize_params` — Box returns a refresh token by default (and rotates it
 *  single-use). Box's read scope is app-level (`root_readonly` downscopes the
 *  authorize request). BYO Box app. */
const BOX_PROVIDER: ConnectionVendorProvider = {
  vendor: 'box',
  display_name: 'Box',
  description:
    'Cloud file storage — mirror file/folder metadata into your warehouse via the Box events + folders API; file bytes stay remote and are fetched only for an explicit read. OAuth 2.0 via your own Box app.',
  default_base_url: BOX_API_BASE,
  oauth: {
    authorize_url: BOX_OAUTH_AUTHORIZE_URL,
    token_endpoint: BOX_OAUTH_TOKEN_URL,
    scopes: BOX_OAUTH_SCOPES,
    client_secret_required: true,
    // No authorize_params — Box mints a refresh token by default (no
    // `token_access_type` / `access_type` / offline param), rotated single-use.
    // Box supports PKCE (S256) on the authorization-code flow.
    supports_pkce: true,
  },
  webhook_signature_header: BOX_WEBHOOK_SIGNATURE_HEADER,
  default_cadence: BOX_DEFAULT_RECONCILIATION_CADENCE,
};

/** D-192 file SOURCE family — SharePoint (Microsoft Graph document library). An
 *  enrollment variant of OneDrive, NOT a new adapter: a SharePoint document
 *  library is a Graph drive, so the connection rides the OneDrive `/delta` leaf
 *  via `config.drive_id`. Same shared Microsoft OAuth endpoints + fixed Graph
 *  base + no `authorize_params` as OneDrive; the ONE difference is the read
 *  scope — `Sites.Read.All` (vs OneDrive's `Files.Read`) to reach a site drive.
 *  BYO Microsoft Entra app. */
const SHAREPOINT_PROVIDER: ConnectionVendorProvider = {
  vendor: 'sharepoint',
  display_name: 'SharePoint',
  description:
    'SharePoint document libraries — mirror file/folder metadata into your warehouse via Microsoft Graph; file bytes stay remote and are fetched only for an explicit read. Point it at a document library drive. OAuth 2.0 via your own Microsoft Entra app.',
  default_base_url: MICROSOFT_GRAPH_API_BASE,
  oauth: {
    authorize_url: MICROSOFT_AUTHORIZE_URL,
    token_endpoint: MICROSOFT_TOKEN_URL,
    scopes: SHAREPOINT_OAUTH_SCOPES,
    client_secret_required: true,
    // Microsoft supports PKCE (S256) on the authorization-code flow.
    supports_pkce: true,
    // No authorize_params — the refresh token comes from the `offline_access`
    // scope, not a query param. Microsoft is RFC 6749 § 3.3-compliant — the
    // token response echoes `scope`, so granted scopes are read there.
  },
  webhook_signature_header: SHAREPOINT_WEBHOOK_SIGNATURE_HEADER,
  default_cadence: SHAREPOINT_DEFAULT_RECONCILIATION_CADENCE,
};

/** D-129 — closed list of first-party vendor providers. Append-only
 *  during pre-launch (D-129 HubSpot, D-130 Salesforce, SMB-finance
 *  QuickBooks + Google Drive, D-192 file SOURCE Dropbox + OneDrive).
 *  Post-launch certified-vendor program adds entries via a separate
 *  review path. */
export const CONNECTION_VENDOR_PROVIDERS: ReadonlyArray<ConnectionVendorProvider> = [
  HUBSPOT_PROVIDER,
  SALESFORCE_PROVIDER,
  PIPEDRIVE_PROVIDER,
  QUICKBOOKS_PROVIDER,
  GOOGLE_PROVIDER,
  DROPBOX_PROVIDER,
  ONEDRIVE_PROVIDER,
  BOX_PROVIDER,
  SHAREPOINT_PROVIDER,
];

/** Look up a vendor provider by canonical vendor segment. Returns
 *  `null` for unknown vendors — callers surface a "vendor not
 *  registered" error rather than failing silently. */
export const getVendorProvider = (
  vendor: string,
  registry: ReadonlyArray<ConnectionVendorProvider> = CONNECTION_VENDOR_PROVIDERS,
): ConnectionVendorProvider | null => {
  for (const p of registry) {
    if (p.vendor === vendor) return p;
  }
  return null;
};

/** Every registered vendor segment in insertion order. Drives the
 *  Settings → Connections "+ Add <Vendor>" picker rendering. */
export const listVendorProviders = (
  registry: ReadonlyArray<ConnectionVendorProvider> = CONNECTION_VENDOR_PROVIDERS,
): ReadonlyArray<ConnectionVendorProvider> => registry;

// ────────────────────────────────────────────────────────────────
// Validators (mirror connection-vendors.ts pattern)
// ────────────────────────────────────────────────────────────────

/** Shape-validate a single provider entry. Returns a list of issues
 *  (empty when shape is valid). */
export const assertConnectionVendorProviderShape = (
  entry: ConnectionVendorProvider,
): string[] => {
  const issues: string[] = [];
  if (!VENDOR_REGEX.test(entry.vendor)) {
    issues.push(`vendor must match /^[a-z][a-z0-9_]*$/: '${entry.vendor}'`);
  }
  if (typeof entry.display_name !== 'string' || entry.display_name.length === 0) {
    issues.push(`display_name must be non-empty`);
  }
  if (typeof entry.description !== 'string' || entry.description.length === 0) {
    issues.push(`description must be non-empty`);
  }
  if (!entry.default_base_url.startsWith('https://')) {
    issues.push(`default_base_url must be https://: '${entry.default_base_url}'`);
  }
  if (!isValidOAuthEndpointUrl(entry.oauth.authorize_url)) {
    issues.push('oauth.authorize_url must be a complete HTTPS URL with no embedded username or password and no URL fragment');
  }
  if (!isValidOAuthEndpointUrl(entry.oauth.token_endpoint)) {
    issues.push('oauth.token_endpoint must be a complete HTTPS URL with no embedded username or password and no URL fragment');
  }
  if (entry.oauth.scopes.length === 0) {
    issues.push(`oauth.scopes must be non-empty`);
  }
  for (const s of entry.oauth.scopes) {
    if (typeof s !== 'string' || s.length === 0) {
      issues.push(`oauth.scopes entries must be non-empty strings`);
      break;
    }
  }
  if (
    entry.oauth.access_token_introspect_url !== undefined &&
    !isValidOAuthEndpointUrl(entry.oauth.access_token_introspect_url)
  ) {
    issues.push('oauth.access_token_introspect_url must be a complete HTTPS URL with no embedded username or password and no URL fragment');
  }
  if (
    entry.oauth.token_auth_style !== undefined &&
    entry.oauth.token_auth_style !== 'body' &&
    entry.oauth.token_auth_style !== 'basic'
  ) {
    issues.push(`oauth.token_auth_style must be 'body' | 'basic': '${entry.oauth.token_auth_style}'`);
  }
  // D-130 — sandbox URL pair must be set together (both or neither);
  // each must be https:// when present. Vendors with no sandbox
  // split (HubSpot) leave both unset and fall through to the
  // production pair via `resolveVendorOAuthEndpoints`.
  const hasSandboxAuth = entry.oauth.sandbox_authorize_url !== undefined;
  const hasSandboxToken = entry.oauth.sandbox_token_endpoint !== undefined;
  if (hasSandboxAuth !== hasSandboxToken) {
    issues.push(
      `oauth.sandbox_authorize_url and oauth.sandbox_token_endpoint must be set together (both or neither)`,
    );
  }
  if (
    entry.oauth.sandbox_authorize_url !== undefined &&
    !isValidOAuthEndpointUrl(entry.oauth.sandbox_authorize_url)
  ) {
    issues.push('oauth.sandbox_authorize_url must be a complete HTTPS URL with no embedded username or password and no URL fragment');
  }
  if (
    entry.oauth.sandbox_token_endpoint !== undefined &&
    !isValidOAuthEndpointUrl(entry.oauth.sandbox_token_endpoint)
  ) {
    issues.push('oauth.sandbox_token_endpoint must be a complete HTTPS URL with no embedded username or password and no URL fragment');
  }
  if (entry.oauth.runtime_base !== undefined) {
    const runtimeBase = entry.oauth.runtime_base;
    if (
      runtimeBase.token_response_field !== 'instance_url'
      && runtimeBase.token_response_field !== 'api_domain'
    ) {
      issues.push("oauth.runtime_base.token_response_field must be 'instance_url' | 'api_domain'");
    }
    if (
      !Array.isArray(runtimeBase.allowed_hostname_suffixes)
      || runtimeBase.allowed_hostname_suffixes.length === 0
    ) {
      issues.push('oauth.runtime_base.allowed_hostname_suffixes must be a non-empty array');
    } else {
      const seen = new Set<string>();
      for (const suffix of runtimeBase.allowed_hostname_suffixes) {
        if (
          typeof suffix !== 'string'
          || suffix !== suffix.toLowerCase()
          || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(suffix)
          || suffix.includes('..')
        ) {
          issues.push('oauth.runtime_base.allowed_hostname_suffixes entries must be lowercase DNS suffixes');
          break;
        }
        if (seen.has(suffix)) {
          issues.push('oauth.runtime_base.allowed_hostname_suffixes entries must be unique');
          break;
        }
        seen.add(suffix);
      }
    }
  }
  if (entry.webhook_signature_header.length === 0) {
    issues.push(`webhook_signature_header must be non-empty`);
  }
  if (entry.default_cadence !== '1h' && entry.default_cadence !== '6h' && entry.default_cadence !== '24h') {
    issues.push(`default_cadence must be one of '1h' | '6h' | '24h': '${entry.default_cadence}'`);
  }
  if (entry.realm_base !== undefined) {
    const rb = entry.realm_base;
    if (typeof rb.production !== 'string' || !rb.production.startsWith('https://')) {
      issues.push(`realm_base.production must be https://: '${rb.production}'`);
    }
    if (typeof rb.sandbox !== 'string' || !rb.sandbox.startsWith('https://')) {
      issues.push(`realm_base.sandbox must be https://: '${rb.sandbox}'`);
    }
    if (typeof rb.path_template !== 'string' || !rb.path_template.includes('{realm_id}')) {
      issues.push(`realm_base.path_template must contain the {realm_id} placeholder: '${rb.path_template}'`);
    }
  }
  // SMB-finance slice 3 — extra authorize params (Google `access_type` /
  // `prompt`) may not collide with the standard OAuth-start keys the builder
  // owns: a vendor must not be able to smuggle in its own `state` / scope /
  // redirect via this hatch.
  if (entry.oauth.authorize_params !== undefined) {
    for (const [k, v] of Object.entries(entry.oauth.authorize_params)) {
      if (AUTHORIZE_PARAM_RESERVED_KEYS.has(k)) {
        issues.push(`oauth.authorize_params may not override the reserved key '${k}'`);
      }
      if (typeof v !== 'string' || v.length === 0) {
        issues.push(`oauth.authorize_params['${k}'] must be a non-empty string`);
      }
    }
  }
  return issues;
};

/** The authorize-URL keys `buildVendorAuthorizeUrl` owns — a vendor's
 *  `authorize_params` may not override any of them. */
export const AUTHORIZE_PARAM_RESERVED_KEYS: ReadonlySet<string> = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  // PKCE params the builder owns when the vendor supports it — a vendor's
  // authorize_params can never override the challenge.
  'code_challenge',
  'code_challenge_method',
]);

/** Throw on a malformed provider entry. Used by builder callers
 *  (none today — the registry is hand-written) + boot validation. */
export const assertConnectionVendorProviderValid = (
  entry: ConnectionVendorProvider,
): void => {
  const issues = assertConnectionVendorProviderShape(entry);
  if (issues.length > 0) {
    throw new Error(
      `invalid ConnectionVendorProvider for '${entry.vendor}': ${issues.join('; ')}`,
    );
  }
};

/** Shape-validate the entire registry. Boot-time check — duplicate
 *  vendor segments + per-entry shape issues both surface here.
 *  Returns a list of issues (empty when registry is valid). */
export const assertConnectionVendorProviderRegistry = (
  registry: ReadonlyArray<ConnectionVendorProvider>,
): string[] => {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const entry of registry) {
    const entryIssues = assertConnectionVendorProviderShape(entry);
    for (const i of entryIssues) {
      issues.push(`${entry.vendor}: ${i}`);
    }
    if (seen.has(entry.vendor)) {
      issues.push(`duplicate vendor segment: '${entry.vendor}'`);
    } else {
      seen.add(entry.vendor);
    }
  }
  return issues;
};

// Boot-time guarantee: the bundled registry is structurally valid.
const _bootIssues = assertConnectionVendorProviderRegistry(CONNECTION_VENDOR_PROVIDERS);
if (_bootIssues.length > 0) {
  throw new Error(
    `CONNECTION_VENDOR_PROVIDERS boot validation failed: ${_bootIssues.join('; ')}`,
  );
}

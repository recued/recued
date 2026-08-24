/** D-201 Slices 8J + 9BQ — trusted owner-facing settings for webhook profiles.
 *
 * These values are presentation and bounded form schema, not execution
 * authority. They let Settings render every installed profile without knowing
 * vendor ids. Verification, decoding, connection resolution, registration I/O,
 * and target canonicalization remain code-backed server responsibilities.
 */

import {
  WEBHOOK_PROFILE_IDS,
  WEBHOOK_PROFILE_REGISTRY,
  type WebhookEnvironment,
  type WebhookProfileId,
  type WebhookRegistrationMode,
} from './webhook-profiles.js';

export interface WebhookOwnerEnvironmentText {
  default: string;
  test?: string;
  live?: string;
  custom?: string;
}

export interface WebhookOwnerRegistrationTargetKind {
  value: string;
  label: string;
  key_placeholder: string;
}

export interface WebhookOwnerRegistrationTargetSettings {
  modes: readonly WebhookRegistrationMode[];
  kind_label: string;
  key_label: string;
  key_normalization: 'preserve' | 'lowercase';
  required_message: string;
  kinds: readonly WebhookOwnerRegistrationTargetKind[];
}

export interface WebhookOwnerProfileSettings {
  profile_id: WebhookProfileId;
  label: string;
  connection_placeholder: string;
  registration_target: WebhookOwnerRegistrationTargetSettings | null;
  create_instructions: Readonly<Partial<Record<
    WebhookRegistrationMode,
    WebhookOwnerEnvironmentText
  >>>;
  manual_confirmation_instructions: WebhookOwnerEnvironmentText;
  managed_reconciliation_instructions: WebhookOwnerEnvironmentText;
  generated_credential_instructions: string | null;
  credential_rotation_instructions: string | null;
  external_test_guidance: WebhookOwnerEnvironmentText;
  test_delivery_boundary: string;
  manual_retirement_instructions: string;
  connection_rebind_instructions: string;
}

const GENERIC_MANUAL_CREATE = Object.freeze({
  default: 'The server creates an opaque endpoint. After saving, add that URL and the selected credentials in the vendor dashboard, then confirm registration here.',
});
const GENERIC_MANUAL_CONFIRM = Object.freeze({
  default: 'Register or update the endpoint above in the vendor dashboard for {{events}}. Configure the profile-declared authentication fields, then confirm below.',
});
const GENERIC_MANAGED_CREATE = Object.freeze({
  default: 'After creation, use Register provider endpoint. Trusted core uses only the paired connection, canonical endpoint, profile-approved events, and locked registration-driver settings; packs and recipes cannot read credentials or change provider request authority.',
});
const GENERIC_MANAGED_RECONCILE = Object.freeze({
  default: 'Trusted core registers and reads back this exact endpoint through the paired connection. The provider request, connection credential, idempotency material, and any returned signing secret are never exposed to packs or recipes.',
});
const GENERIC_OPERATION_BOUND_CREATE = Object.freeze({
  default: 'Trusted core attaches the opaque callback URL only during the declared provider operation. The recipe cannot receive or override it; the exact paired connection must own both the resource operation and this ingress.',
});
const GENERIC_EXTERNAL_TEST = Object.freeze({
  default: 'Use a separate test-environment ingress.',
  test: 'Use the provider or an external sender.',
});
const GENERIC_TEST_BOUNDARY =
  'The Recued test uses the current credential and canonical public endpoint. It is admitted like any other delivery and may run recipes bound to this test ingress. It does not prove the vendor dashboard is configured or that a third party can reach the endpoint.';
const GENERIC_RETIREMENT =
  'Retirement is permanent: intake stays closed and all active credentials are retired. Remote vendor endpoint cleanup may still be required.';
const GENERIC_REBIND =
  'Core validates the replacement connection and provider ownership before changing local authority. If safe continuity cannot be proved, intake stays closed and no replacement endpoint is created implicitly.';

const defaultCreateInstructions = (
  profileId: WebhookProfileId,
): WebhookOwnerProfileSettings['create_instructions'] => Object.fromEntries(
  WEBHOOK_PROFILE_REGISTRY[profileId].registration_modes.map((mode) => [
    mode,
    mode === 'manual'
      ? GENERIC_MANUAL_CREATE
      : mode === 'managed_endpoint'
        ? GENERIC_MANAGED_CREATE
        : GENERIC_OPERATION_BOUND_CREATE,
  ]),
) as WebhookOwnerProfileSettings['create_instructions'];

const genericSettings = (
  profile_id: WebhookProfileId,
  label: string,
  overrides: Partial<Omit<WebhookOwnerProfileSettings, 'profile_id' | 'label'>> = {},
): WebhookOwnerProfileSettings => ({
  profile_id,
  label,
  connection_placeholder: 'provider-connection',
  registration_target: null,
  create_instructions: defaultCreateInstructions(profile_id),
  manual_confirmation_instructions: GENERIC_MANUAL_CONFIRM,
  managed_reconciliation_instructions: GENERIC_MANAGED_RECONCILE,
  generated_credential_instructions: null,
  credential_rotation_instructions: null,
  external_test_guidance: GENERIC_EXTERNAL_TEST,
  test_delivery_boundary: GENERIC_TEST_BOUNDARY,
  manual_retirement_instructions: GENERIC_RETIREMENT,
  connection_rebind_instructions: GENERIC_REBIND,
  ...overrides,
});

const SETTINGS_LIST: readonly WebhookOwnerProfileSettings[] = [
  genericSettings('stripe.event.v1', 'Stripe events', {
    connection_placeholder: 'stripe-live',
    create_instructions: {
      manual: {
        default: 'Create the local ingress first. Register its displayed URL and selected events in Stripe, store the returned endpoint signing secret with Add credentials, confirm registration, and enable intake explicitly.',
      },
      managed_endpoint: {
        default: 'After creation, use Register provider endpoint. Trusted core creates the Stripe endpoint through the paired connection and captures its one-time signing secret; packs and recipes cannot read it.',
      },
    },
    manual_confirmation_instructions: {
      default: 'Register or update the endpoint above in Stripe for {{events}}. After the vendor returns the Endpoint signing secret, use Add credentials here, then confirm below.',
    },
    managed_reconciliation_instructions: {
      default: 'Trusted core registers and reads back this exact Stripe endpoint through the paired connection. The API credential, provider request, idempotency key, and returned signing secret are never exposed to packs or recipes.',
    },
    connection_rebind_instructions: 'Core first proves compatible Stripe access. Same-account credentials keep the endpoint live; a different account closes intake, removes and confirms the old endpoint, then leaves the replacement disabled for explicit registration.',
  }),
  genericSettings('paddle.notification.v1', 'Paddle notifications', {
    connection_placeholder: 'paddle-sandbox',
    create_instructions: {
      manual: {
        default: 'Create the local ingress first. Then use the matching Paddle Sandbox account for test or Paddle Live account for live to create an active URL notification destination for the displayed endpoint and selected events. Store that destination\'s Endpoint secret key with Add credentials, confirm the saved destination, and enable intake explicitly.',
      },
      managed_endpoint: {
        default: 'Pair a Paddle API connection containing a modern Sandbox key for test or Live key for live. After creation, use Register provider endpoint. Trusted core searches that account, refuses ambiguous destinations, fixes every notification-setting field, captures the provider-generated endpoint secret, and reads the destination back before registration completes.',
      },
    },
    manual_confirmation_instructions: {
      default: 'This Paddle ingress has an unsupported environment. Keep intake closed and replace it; do not register this endpoint in Paddle.',
      test: 'In the matching Paddle Sandbox account, open Developer tools > Notifications > New destination. Choose URL, set the URL to the endpoint above, API version to 1, and Usage type to Platform and simulation. Leave sensitive fields excluded unless the consuming pack explicitly requires them, subscribe to exactly these event types: {{events}}, keep the destination active, and save it. Open that destination\'s overflow menu > Edit destination, then copy its Endpoint secret key into Add credentials here. Confirm below only after the saved destination matches, then enable intake. After enablement, use Developer tools > Simulations > New simulation and choose this simulation-enabled destination; Recued does not synthesize Paddle deliveries.',
      live: 'In the matching Paddle Live account, open Developer tools > Notifications > New destination. Choose URL, set the URL to the endpoint above, API version to 1, and Usage type to Platform. Leave sensitive fields excluded unless the consuming pack explicitly requires them, subscribe to exactly these event types: {{events}}, keep the destination active, and save it. Open that destination\'s overflow menu > Edit destination, then copy its Endpoint secret key into Add credentials here. Confirm below only after the saved destination matches, then enable intake. Test separately with a Paddle Sandbox account and a test ingress; do not route simulation traffic to this live ingress.',
    },
    managed_reconciliation_instructions: {
      default: 'Trusted core refuses unsupported Paddle environments and leaves intake closed.',
      test: 'Trusted core exhaustively searches the matching Paddle Sandbox account, refuses description or URL collisions, creates an active URL destination with API version 1, sensitive fields excluded, platform and simulation traffic, and exactly the selected events, then encrypts the provider-generated endpoint secret and reads every field back. The API key and endpoint secret are never exposed to packs or recipes.',
      live: 'Trusted core exhaustively searches the matching Paddle Live account, refuses description or URL collisions, creates an active URL destination with API version 1, sensitive fields excluded, platform-only traffic, and exactly the selected events, then encrypts the provider-generated endpoint secret and reads every field back. The API key and endpoint secret are never exposed to packs or recipes.',
    },
    credential_rotation_instructions: 'Paddle endpoint secret keys do not rotate in place. For overlap-safe rotation, create a second active URL destination in the same Paddle account with the same endpoint, API version, Usage type, sensitive-field choice, and selected events. Paddle allows at most 10 active destinations; if that limit is full, deactivate a different unused destination first, never the old destination still protecting this ingress. Add the new destination\'s Endpoint secret key as the second credential version here, then obtain an accepted delivery signed by that version. Only after it is shown as verified should you deactivate the old Paddle destination and retire the older local credential; deactivation preserves Paddle delivery logs.',
    external_test_guidance: {
      default: 'Use a separate test-environment ingress.',
      test: 'Use Paddle simulator after enablement.',
      live: 'Use a separate test-environment ingress.',
    },
    manual_retirement_instructions: 'Before confirming, deactivate this notification destination in Paddle so delivery stops while its logs remain available. Local retirement is permanent: intake stays closed and all active credentials are retired; Recued cannot verify or perform the remote deactivation.',
    connection_rebind_instructions: 'Core verifies that the replacement is a modern Paddle key for the same environment and searches that account before changing authority. An alias for the same destination keeps it live; otherwise intake closes, the old destination is removed and confirmed absent, and registration on the replacement remains explicit.',
  }),
  genericSettings('lemonsqueezy.webhook.v1', 'Lemon Squeezy webhooks', {
    create_instructions: {
      manual: {
        default: 'Create the local ingress first. In the matching Lemon Squeezy test or live store, open Settings > Webhooks, create a webhook for the displayed callback URL and selected events, choose a strong signing secret, then enter that exact secret with Add credentials before confirming registration and enabling intake.',
      },
    },
    manual_confirmation_instructions: {
      default: 'In the matching Lemon Squeezy environment, save one webhook whose callback URL is the exact endpoint above, whose subscribed events are exactly {{events}}, and whose signing secret exactly matches the active signing_secret entered with Add credentials. Confirm below only after saving that remote webhook, then enable intake explicitly.',
      test: 'In Lemon Squeezy test mode, save one webhook whose callback URL is the exact endpoint above, whose subscribed events are exactly {{events}}, and whose signing secret exactly matches the active signing_secret entered with Add credentials. Confirm below only after saving that remote webhook, then enable intake and use a test-mode simulation or dashboard resend.',
      live: 'In Lemon Squeezy live mode, save one webhook whose callback URL is the exact endpoint above, whose subscribed events are exactly {{events}}, and whose signing secret exactly matches the active signing_secret entered with Add credentials. Confirm below only after saving that remote webhook, then enable intake. Validate separately with a test ingress rather than routing test traffic here.',
    },
    credential_rotation_instructions: 'Add the replacement signing_secret as a second local credential version, update this same Lemon Squeezy webhook to the replacement secret, and obtain an accepted delivery verified by the new version. Only then retire the older local credential.',
    external_test_guidance: {
      default: 'Use Lemon Squeezy test mode or resend a recent webhook from its dashboard after intake is enabled.',
      test: 'Use a Lemon Squeezy test-mode simulation or resend a recent test webhook after intake is enabled.',
      live: 'Use a separate Lemon Squeezy test-mode ingress; do not send test traffic to this live ingress.',
    },
    test_delivery_boundary: 'No Recued-originated test delivery is available for this profile. Use Lemon Squeezy test mode or its dashboard resend after enabling intake; that proves vendor delivery while recipe effects remain asynchronous.',
    manual_retirement_instructions: 'Delete or disable the matching webhook in Lemon Squeezy before confirming local retirement. Local retirement is permanent: intake stays closed and all active credentials are retired; Recued cannot verify or perform the remote cleanup.',
  }),
  genericSettings('slack.request.v0', 'Slack requests', {
    connection_placeholder: 'slack-api',
    manual_confirmation_instructions: {
      default: 'Register or update the endpoint above in the Slack app configuration for {{events}}, store the app signing secret with Add credentials, and confirm below.',
    },
  }),
  genericSettings('slack.slash-command.v1', 'Slack slash commands', {
    connection_placeholder: 'slack-app',
    create_instructions: {
      manual: {
        default: 'Create a separate ingress for Slack slash commands. This v1 profile covers Slack apps with public distribution disabled. After saving, open Features > Slash Commands in the Slack app, create or edit every intended command, set each Request URL to the displayed endpoint, and copy the app Signing Secret from Basic Information into Add credentials.',
      },
    },
    manual_confirmation_instructions: {
      default: 'Under Features > Slash Commands in the Slack app, set every intended command\'s Request URL to the exact endpoint above and copy that app\'s Signing Secret from Basic Information into Add credentials. Confirm only after every intended command uses this endpoint. Slash commands do not use the Events API url_verification challenge, so this profile becomes registration-ready from this manual confirmation. Do not use this v1 profile while public distribution is active because its ssl_check request is not supported. After enabling intake, invoke one configured command to test it. Recued returns an empty 200 acknowledgement and triggers the bound recipe; it withholds response_url and the deprecated token field and does not send a command response.',
    },
    external_test_guidance: {
      default: 'After enabling intake, invoke a configured slash command in Slack. This profile has no Recued-originated delivery simulator.',
      test: 'After enabling intake, invoke a configured slash command in a test workspace or test app.',
    },
    test_delivery_boundary: 'No Recued-originated test delivery is available for this profile. Invoke the configured command in Slack after enabling intake; the empty acknowledgement proves receipt only, while recipe effects remain asynchronous.',
  }),
  genericSettings('telegram.bot-webhook.v1', 'Telegram bot updates', {
    connection_placeholder: 'telegram-bot-backup',
    create_instructions: {
      manual: {
        default: 'Create the local ingress to mint a one-time Webhook secret token. Then call Telegram Bot API setWebhook with the displayed URL, secret_token, and selected allowed_updates before confirming registration here.',
      },
      managed_endpoint: {
        default: 'After creation, use Register provider endpoint. Trusted core verifies the bot has no conflicting webhook, sets its singleton URL and allowed updates, and stores a generated secret token that packs and recipes cannot read.',
      },
    },
    manual_confirmation_instructions: {
      default: 'Call Telegram Bot API setWebhook with the endpoint above as url, the one-time Webhook secret token generated here as secret_token, and {{events}} as allowed_updates. If the token is no longer available, rotate credentials to mint a replacement, then confirm below.',
    },
    managed_reconciliation_instructions: {
      default: 'Trusted core reads the bot webhook before every mutation, refuses a conflicting URL, preserves the encrypted generated token across updates, and confirms the exact URL and allowed updates afterward. The bot token and webhook secret are never exposed to packs or recipes.',
    },
    generated_credential_instructions: 'Call Telegram Bot API setWebhook with the endpoint above as url, this generated value as secret_token, and {{events}} as allowed_updates. Telegram accepts only one webhook per bot, so update the bot before retiring an older local credential.',
    connection_rebind_instructions: 'Core first reads the replacement bot without changing it. Another connection for the same bot keeps the singleton live; a different empty bot closes intake, removes and confirms the old webhook, then leaves the replacement disabled for explicit registration. A bot with any conflicting webhook is refused.',
  }),
  genericSettings('github.webhook.v1', 'GitHub webhooks', {
    connection_placeholder: 'github-api-backup',
    registration_target: {
      modes: ['managed_endpoint'],
      kind_label: 'GitHub target type',
      key_label: 'GitHub target (required)',
      key_normalization: 'lowercase',
      required_message: 'Choose a GitHub repository or organization target before creating this webhook.',
      kinds: [
        { value: 'repository', label: 'Repository', key_placeholder: 'owner/repository' },
        { value: 'organization', label: 'Organization', key_placeholder: 'organization' },
      ],
    },
    create_instructions: {
      manual: {
        default: 'Create the local ingress to mint a one-time Webhook secret. Then open the repository or organization Settings > Webhooks in GitHub: use the displayed Payload URL, set Content type to application/json, paste the secret, keep SSL verification enabled, choose Let me select individual events, subscribe to exactly the selected events, leave Active selected, and confirm registration here. GitHub sends an immediate ping while Recued intake is still closed; after confirming and enabling, redeliver that ping or trigger a selected event.',
      },
      managed_endpoint: {
        default: 'Choose one repository or organization and pair a GitHub API connection containing a personal access token. Trusted core fixes every REST path and field, verifies access to that exact target, generates the webhook secret, and reads the hook back before registration completes.',
      },
    },
    manual_confirmation_instructions: {
      default: 'In GitHub repository or organization Settings > Webhooks, set Payload URL to the endpoint above, Content type to application/json, Secret to the one-time Webhook secret generated here, keep SSL verification enabled, choose Let me select individual events, subscribe to exactly these event types: {{events}}, and leave Active selected. If the secret is no longer available, rotate credentials to mint a replacement. Confirm below only after that exact hook configuration is saved in GitHub, then enable intake here and use GitHub Recent deliveries to Redeliver the initial ping or trigger a selected event. GitHub does not automatically redeliver failed deliveries.',
    },
    managed_reconciliation_instructions: {
      default: 'Trusted core searches only the selected {{target_kind}} {{target_key}}, refuses ambiguous or foreign hooks, generates and encrypts the signing secret, and reads the exact URL, events, active state, JSON content type, and SSL verification back. The personal access token and webhook secret are never exposed to packs or recipes. GitHub sends its immediate setup ping before intake is enabled and will not retry that failure automatically; after registration, enable intake and use Recent deliveries to redeliver that ping or trigger a selected event.',
    },
    generated_credential_instructions: 'In GitHub repository or organization Settings > Webhooks, set Payload URL to the endpoint above, Content type to application/json, Secret to this generated webhook_secret, keep SSL verification enabled, choose Let me select individual events, subscribe to exactly these event types: {{events}}, and leave Active selected. GitHub sends an immediate ping while Recued intake is still closed and does not automatically redeliver a failure; after confirming and enabling here, open Recent deliveries and Redeliver that ping or trigger a selected event. For rotation, update this same GitHub hook to the new secret, obtain an accepted delivery verified by the new credential, and only then retire the older local version.',
    credential_rotation_instructions: 'Saving mints a new Webhook secret credential version and shows its plaintext once. GitHub accepts one secret for a hook: update that same hook first, obtain an accepted delivery verified by the new credential, and only then retire the older local version.',
    test_delivery_boundary: 'The Recued test uses the canonical public endpoint and may run recipes bound to this test ingress. During a two-secret rotation it deliberately signs with the older active credential, so it cannot verify the replacement or unlock retirement of the older version. It does not prove the GitHub dashboard is configured or that GitHub can reach the endpoint.',
    connection_rebind_instructions: 'Core verifies the replacement personal access token against the same repository or organization before changing authority. If target continuity cannot be proved, intake stays closed and no foreign hook is mutated.',
  }),
  genericSettings('cal.webhook.v1', 'Cal.com booking and meeting webhooks', {
    connection_placeholder: 'calcom',
    create_instructions: {
      manual: {
        default: 'Enter a strong signing secret to create the Recued webhook address. Then add that address in Cal.com, use the same secret, and select exactly the event types requested by the installed recipe before confirming setup here.',
      },
    },
    manual_confirmation_instructions: {
      default: 'In Cal.com Settings > Developer > Webhooks, paste the Recued address above, enter the same signing secret, and select only {{events}}. Confirm below after saving.',
    },
    external_test_guidance: {
      default: 'Trigger one of the selected Cal.com events with a test booking. For transcript events, complete a Cal Video meeting with transcription enabled.',
    },
    test_delivery_boundary: 'The Recued test confirms that this address accepts a correctly signed Cal.com-style event of the selected type. It cannot confirm that Cal.com saved the webhook; trigger the selected event with a test booking to prove the external connection.',
    credential_rotation_instructions: 'Add the replacement secret in Recued, update the same Cal.com webhook to that secret, obtain one accepted delivery, and only then retire the older local credential.',
  }),
  genericSettings('generic.static-header-token.v1', 'Static header token'),
  genericSettings('generic.raw-body-hmac-sha256.v1', 'Raw-body HMAC SHA-256'),
  genericSettings(
    'generic.timestamped-raw-body-hmac-sha256.v1',
    'Timestamped raw-body HMAC SHA-256',
  ),
  genericSettings('generic.http-basic.v1', 'HTTP Basic'),
  // SPIKE — the peer profile's owner surface. Every other entry instructs an
  // owner on configuring SOMEONE ELSE'S console; here the far side is another
  // Recued server, so the instruction is an exchange between two owners.
  genericSettings('recued-peer.exchange.v1', 'Recued peer exchange', {
    connection_placeholder: 'peer-server',
    generated_credential_instructions: 'Recued generates this signing secret. Give it to the peer owner over a channel you both already trust; they store it on their outbound connection to you, and it is what their deliveries are signed with. The secret authenticates the PEER, not the person who sent it to you — treat a leaked value as a peer impersonation and rotate. Rotation overlaps: add the new secret, have the peer switch, confirm one accepted delivery verified by the new version, then retire the old one.',
    credential_rotation_instructions: 'Add the replacement before the peer switches. Two versions verify at once, so an in-flight delivery signed with either is accepted; retire the older only after an accepted delivery proves the new one is live.',
  }),
];

const freezeEnvironmentText = (
  value: WebhookOwnerEnvironmentText,
): WebhookOwnerEnvironmentText => Object.freeze({ ...value });

const freezeSettings = (
  value: WebhookOwnerProfileSettings,
): WebhookOwnerProfileSettings => Object.freeze({
  ...value,
  registration_target: value.registration_target === null
    ? null
    : Object.freeze({
        ...value.registration_target,
        modes: Object.freeze([...value.registration_target.modes]),
        kinds: Object.freeze(value.registration_target.kinds.map((kind) =>
          Object.freeze({ ...kind }))),
      }),
  create_instructions: Object.freeze(Object.fromEntries(
    Object.entries(value.create_instructions).map(([mode, text]) => [
      mode,
      freezeEnvironmentText(text),
    ]),
  )),
  manual_confirmation_instructions: freezeEnvironmentText(
    value.manual_confirmation_instructions,
  ),
  managed_reconciliation_instructions: freezeEnvironmentText(
    value.managed_reconciliation_instructions,
  ),
  external_test_guidance: freezeEnvironmentText(value.external_test_guidance),
});

const OWNER_TEMPLATE_TOKEN_RE = /{{([a-z_]+)}}/g;
const OWNER_TEMPLATE_TOKENS = new Set([
  'events',
  'environment',
  'target_kind',
  'target_key',
]);

const validateSerializableOwnerValue = (
  profileId: WebhookProfileId,
  value: unknown,
): void => {
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > 16_384) {
      throw new Error(`Invalid webhook owner settings text '${profileId}'`);
    }
    const withoutTokens = value.replace(OWNER_TEMPLATE_TOKEN_RE, (_match, token: string) => {
      if (!OWNER_TEMPLATE_TOKENS.has(token)) {
        throw new Error(`Unknown webhook owner template token '${token}'`);
      }
      return '';
    });
    if (withoutTokens.includes('{{') || withoutTokens.includes('}}')) {
      throw new Error(`Malformed webhook owner template token '${profileId}'`);
    }
    return;
  }
  if (value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) validateSerializableOwnerValue(profileId, entry);
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`Webhook owner settings '${profileId}' are not serializable`);
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    validateSerializableOwnerValue(profileId, entry);
  }
};

const validateSettings = (value: WebhookOwnerProfileSettings): void => {
  const descriptor = WEBHOOK_PROFILE_REGISTRY[value.profile_id];
  validateSerializableOwnerValue(value.profile_id, value);
  const instructionModes = Object.keys(
    value.create_instructions,
  ) as WebhookRegistrationMode[];
  for (const mode of instructionModes) {
    if (!descriptor.registration_modes.includes(mode)) {
      throw new Error(
        `Webhook owner settings '${value.profile_id}' describe undeclared mode '${mode}'`,
      );
    }
  }
  if (instructionModes.length !== descriptor.registration_modes.length
    || descriptor.registration_modes.some((mode) =>
      !Object.prototype.hasOwnProperty.call(value.create_instructions, mode))) {
    throw new Error(
      `Webhook owner settings '${value.profile_id}' do not cover every declared mode`,
    );
  }
  const target = value.registration_target;
  if (target === null) return;
  if (target.kinds.length === 0
    || new Set(target.kinds.map((kind) => kind.value)).size !== target.kinds.length
    || target.kinds.some((kind) => !/^[a-z][a-z0-9_-]{0,63}$/.test(kind.value))
    || target.modes.length === 0
    || new Set(target.modes).size !== target.modes.length
    || target.modes.some((mode) => !descriptor.registration_modes.includes(mode))) {
    throw new Error(`Invalid webhook owner registration-target settings '${value.profile_id}'`);
  }
};

const mutableSettings = Object.create(null) as Record<
  WebhookProfileId,
  WebhookOwnerProfileSettings
>;
for (const value of SETTINGS_LIST) {
  validateSettings(value);
  if (Object.prototype.hasOwnProperty.call(mutableSettings, value.profile_id)) {
    throw new Error(`Duplicate webhook owner settings '${value.profile_id}'`);
  }
  mutableSettings[value.profile_id] = freezeSettings(value);
}
for (const profileId of WEBHOOK_PROFILE_IDS) {
  if (!Object.prototype.hasOwnProperty.call(mutableSettings, profileId)) {
    throw new Error(`Missing webhook owner settings '${profileId}'`);
  }
}

export const WEBHOOK_OWNER_PROFILE_SETTINGS: Readonly<Record<
  WebhookProfileId,
  WebhookOwnerProfileSettings
>> = Object.freeze(mutableSettings);

export const webhookOwnerProfileSettings = (
  profileId: WebhookProfileId,
): WebhookOwnerProfileSettings => WEBHOOK_OWNER_PROFILE_SETTINGS[profileId];

export const webhookOwnerTextForEnvironment = (
  value: WebhookOwnerEnvironmentText,
  environment: WebhookEnvironment,
): string => value[environment] ?? value.default;

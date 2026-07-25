/** D-145 PB1 — golden capacity-walk fixtures (§ N.15).
 *
 *  Reusable fixtures consumed by PB1 tests + future PB3/PB7/PB17
 *  consumers. Each fixture is a `CapacitySpec` paired with a
 *  human-readable label. */

import type { CapacitySpec } from '@recued/contracts';

export interface CapacitySpecFixture {
  id: string;
  label: string;
  spec: CapacitySpec;
}

/** F1 — social.facebook.lookup: bridge_online + ingredient_installed
 *  + logged_in + annotation. Exercises every gap path. */
export const F1_SOCIAL_FACEBOOK_LOOKUP: CapacitySpecFixture = {
  id: 'F1',
  label: 'social.facebook.lookup',
  spec: {
    capacities: [
      { kind: 'bridge_online' },
      { kind: 'ingredient_installed', slug: 'facebook-profile-reader' },
      { kind: 'logged_in', site: 'facebook.com' },
      { kind: 'annotation', ref: 'data.contact.contact-pii-7f3e.aliases.facebook' },
    ],
    remediations: {
      bridge_online: {
        action: 'show_bridge_install_prompt',
        user_facing_copy: 'Install Bridge to look up Facebook.',
      },
      'ingredient_installed:facebook-profile-reader': {
        action: 'offer_install',
        user_facing_copy: 'Install the Facebook reader ingredient.',
      },
      'logged_in:facebook.com': {
        action: 'open_login_tab',
        user_facing_copy: 'Sign in to Facebook.',
      },
      'annotation:data.contact.contact-pii-7f3e.aliases.facebook': {
        action: 'lazy_ask_user',
        user_facing_copy: 'Recued needs the contact’s Facebook handle.',
      },
    },
  },
};

/** F2 — bridge.dom-lookup: a five-capacity bridge/DOM happy path
 *  (bridge_online + ingredient_installed + selector_freshness + logged_in
 *  + annotation_not_required). Neutral test data — the ai-webchat ingredient
 *  this originally modeled was retired; the walker is ingredient-agnostic so
 *  this exercises the full bridge-capacity path for any future bridge reader. */
export const F2_BRIDGE_DOM_LOOKUP: CapacitySpecFixture = {
  id: 'F2',
  label: 'bridge.dom-lookup',
  spec: {
    capacities: [
      { kind: 'bridge_online' },
      { kind: 'ingredient_installed', slug: 'web-page-reader' },
      { kind: 'selector_freshness', slug: 'web-page-reader' },
      { kind: 'logged_in', site: 'example.com' },
      { kind: 'annotation_not_required' },
    ],
    remediations: {
      bridge_online: {
        action: 'show_bridge_install_prompt',
        user_facing_copy: 'Install Bridge to read the page.',
      },
      'ingredient_installed:web-page-reader': {
        action: 'offer_install',
        user_facing_copy: 'Install the web page reader ingredient.',
      },
      'selector_freshness:web-page-reader': {
        action: 'mark_ingredient_degraded',
        user_facing_copy: 'The page reader is temporarily unavailable.',
      },
      'logged_in:example.com': {
        action: 'open_login_tab',
        user_facing_copy: 'Sign in to example.com.',
      },
      annotation_not_required: { action: 'noop', user_facing_copy: '' },
    },
  },
};

/** F3 — enrichment.connection-backed (HubSpot deal). */
export const F3_ENRICHMENT_CONNECTION_BACKED: CapacitySpecFixture = {
  id: 'F3',
  label: 'enrichment.connection-backed',
  spec: {
    capacities: [
      { kind: 'connection_active', vendor: 'hubspot', entity: 'deal' },
    ],
    remediations: {
      'connection_active:hubspot:deal': {
        action: 'enroll_connection',
        user_facing_copy: 'Enroll HubSpot in Settings → Connections.',
      },
    },
  },
};

/** F4 — bridge-offline-anywhere (single capacity). */
export const F4_BRIDGE_OFFLINE_ANYWHERE: CapacitySpecFixture = {
  id: 'F4',
  label: 'bridge-offline-anywhere',
  spec: {
    capacities: [{ kind: 'bridge_online' }],
    remediations: {
      bridge_online: {
        action: 'show_bridge_install_prompt',
        user_facing_copy: 'Install Bridge to continue.',
      },
    },
  },
};

/** F5 — source-disabled-pa11-join: connection_active for hubspot:task. */
export const F5_SOURCE_DISABLED_PA11_JOIN: CapacitySpecFixture = {
  id: 'F5',
  label: 'source-disabled-pa11-join',
  spec: {
    capacities: [
      { kind: 'connection_active', vendor: 'hubspot', entity: 'task' },
    ],
    remediations: {
      'connection_active:hubspot:task': {
        action: 'enroll_connection',
        user_facing_copy: 'Enroll HubSpot Task source.',
      },
    },
  },
};

/** F6 — quota-exhausted (free pool). */
export const F6_QUOTA_EXHAUSTED: CapacitySpecFixture = {
  id: 'F6',
  label: 'quota-exhausted',
  spec: {
    capacities: [{ kind: 'pool_quota_available', pool: 'free' }],
    remediations: {
      'pool_quota_available:free': {
        action: 'check_pool_quota',
        user_facing_copy: 'Free quota exhausted. Add a BYOK key.',
      },
    },
  },
};

/** F7 — duplicate-ingredient-requirements: exercises § N.3 per-key
 *  remediation lookup with two ingredient_installed reqs. */
export const F7_DUPLICATE_INGREDIENT_REQUIREMENTS: CapacitySpecFixture = {
  id: 'F7',
  label: 'duplicate-ingredient-requirements',
  spec: {
    capacities: [
      { kind: 'ingredient_installed', slug: 'calendar-reader' },
      { kind: 'ingredient_installed', slug: 'crm-contact-reader' },
    ],
    remediations: {
      'ingredient_installed:calendar-reader': {
        action: 'offer_install',
        user_facing_copy: 'Install Calendar reader.',
      },
      'ingredient_installed:crm-contact-reader': {
        action: 'offer_install',
        user_facing_copy: 'Install CRM contact reader.',
      },
    },
  },
};

/** F8 — probe-error-path: bridge_online (with throwing probe stub). */
export const F8_PROBE_ERROR_PATH: CapacitySpecFixture = {
  id: 'F8',
  label: 'probe-error-path',
  spec: {
    capacities: [{ kind: 'bridge_online' }],
    remediations: {
      bridge_online: {
        action: 'show_bridge_install_prompt',
        user_facing_copy: 'Install Bridge.',
      },
    },
  },
};

export const ALL_FIXTURES: ReadonlyArray<CapacitySpecFixture> = [
  F1_SOCIAL_FACEBOOK_LOOKUP,
  F2_BRIDGE_DOM_LOOKUP,
  F3_ENRICHMENT_CONNECTION_BACKED,
  F4_BRIDGE_OFFLINE_ANYWHERE,
  F5_SOURCE_DISABLED_PA11_JOIN,
  F6_QUOTA_EXHAUSTED,
  F7_DUPLICATE_INGREDIENT_REQUIREMENTS,
  F8_PROBE_ERROR_PATH,
];

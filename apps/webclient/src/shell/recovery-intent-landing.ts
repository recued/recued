/** Route-owned focus landing for the recovery-return receipt.
 *
 * A server switch intentionally retains only a broad route and a closed-list
 * intent. Once that route has completed its own authoritative read, this
 * module uses stable presentation hooks to put the person at the useful part
 * of the *new* view. It never reads labels, record ids, field values, or other
 * source-owned detail from either the old or new route.
 */

import type { WebclientRouteId } from './route.js';

export type RecoveryLandingIntent = 'continue' | 'choose_again' | 'review';

export const RECOVERY_INTENT_CUE_ATTR =
  'data-recued-recovery-intent-cue';
export const RECOVERY_INTENT_ANNOUNCER_ATTR =
  'data-recued-recovery-intent-announcer';
export const RECOVERY_INTENT_CUE_DURATION_MS = 4_500;
export const RECOVERY_INTENT_RESUME_WINDOW_MS = 30_000;

const RECOVERY_INTENT_CUE_COPY: Record<RecoveryLandingIntent, string> = {
  continue: 'Continue here.',
  choose_again: 'Choose again here.',
  review: 'Review this status before continuing.',
};
const RECOVERY_INTENT_INVALIDATED_COPY =
  'This changed. Review this status before continuing.';
const RECOVERY_INTENT_RESUMED_COPY: Record<
  Exclude<RecoveryLandingIntent, 'review'>,
  string
> = {
  continue: 'Ready again. Continue here.',
  choose_again: 'Ready again. Choose again here.',
};

type LandingFocus = 'self' | 'first_control' | 'active_control';

interface LandingTarget {
  readonly attr?: string;
  readonly tag?: string;
  readonly role?: 'alert' | 'status';
  readonly active?: boolean;
  readonly focus?: LandingFocus;
}

type RouteLandingPolicy = Record<
  RecoveryLandingIntent,
  readonly LandingTarget[]
>;

interface LandingInvalidationTarget {
  readonly attr: string;
  readonly value?: string;
  readonly qualifierAttr?: string;
  readonly qualifierValue?: string;
  readonly scopeAttrs?: readonly string[];
  readonly requiresLandingTargetLoss?: boolean;
}

const self = (attr: string): LandingTarget => ({ attr, focus: 'self' });
const control = (attr: string): LandingTarget => ({
  attr,
  focus: 'first_control',
});
const activeControl = (attr: string): LandingTarget => ({
  attr,
  focus: 'active_control',
});
const activeSelf = (attr: string): LandingTarget => ({
  attr,
  active: true,
  focus: 'self',
});
const heading = (attr: string): LandingTarget => ({ attr, focus: 'self' });

const alertTarget: LandingTarget = { role: 'alert', focus: 'self' };
const statusTarget: LandingTarget = { role: 'status', focus: 'self' };
const h1Target: LandingTarget = { tag: 'H1', focus: 'self' };
const h2Target: LandingTarget = { tag: 'H2', focus: 'self' };

const invalidation = (
  attr: string,
  value?: string,
): LandingInvalidationTarget => ({
  attr,
  ...(value !== undefined ? { value } : {}),
});
const scopedInvalidation = (
  attr: string,
  value: string | undefined,
  scopeAttrs: readonly string[],
): LandingInvalidationTarget => ({
  attr,
  ...(value !== undefined ? { value } : {}),
  scopeAttrs,
});
const qualifiedScopedInvalidation = (
  attr: string,
  qualifierAttr: string,
  qualifierValue: string,
  scopeAttrs: readonly string[],
): LandingInvalidationTarget => ({
  attr,
  qualifierAttr,
  qualifierValue,
  scopeAttrs,
});
const invalidationAfterLandingTargetLoss = (
  attr: string,
): LandingInvalidationTarget => ({
  attr,
  requiresLandingTargetLoss: true,
});

/**
 * Attribute names are duplicated here deliberately: the shell may inspect a
 * mounted route's public presentation hooks, but importing every route module
 * would make this small focus helper depend on the entire application graph.
 */
const ROUTE_LANDING_POLICIES: Record<WebclientRouteId, RouteLandingPolicy> = {
  reception: {
    choose_again: [
      activeControl('data-recued-reception-route-tabs'),
      activeSelf('data-recued-reception-records-lens'),
      control('data-recued-reception-records-section'),
      h1Target,
    ],
    continue: [
      control('data-recued-reception-route-content'),
      activeControl('data-recued-reception-route-tabs'),
      h1Target,
    ],
    review: [
      self('data-recued-reception-response-error'),
      self('data-recued-reception-records-error'),
      self('data-recued-reception-inbox-reason'),
      alertTarget,
      statusTarget,
      h1Target,
    ],
  },
  settings: {
    choose_again: [
      activeSelf('data-recued-settings-subtab'),
      activeSelf('data-recued-settings-nav-item'),
      control('data-recued-settings-nav'),
      h1Target,
    ],
    continue: [
      {
        attr: 'data-recued-settings-subtab-panel',
        active: true,
        focus: 'first_control',
      },
      {
        attr: 'data-recued-settings-section',
        active: true,
        focus: 'first_control',
      },
      activeSelf('data-recued-settings-nav-item'),
      h1Target,
    ],
    review: [
      self('data-recued-updates-error'),
      self('data-recued-owner-operation-error'),
      alertTarget,
      statusTarget,
      {
        attr: 'data-recued-settings-section',
        active: true,
        focus: 'self',
      },
      h1Target,
    ],
  },
  approvals: {
    choose_again: [
      control('data-recued-approvals-focus'),
      control('data-recued-approvals-list'),
      heading('data-recued-approvals-heading'),
    ],
    continue: [
      control('data-recued-approvals-focus'),
      control('data-recued-approvals-plan-resolution'),
      control('data-recued-approvals-list'),
      heading('data-recued-approvals-heading'),
    ],
    review: [
      self('data-recued-approvals-error'),
      self('data-recued-approvals-plan-resolution'),
      self('data-recued-approvals-loading'),
      self('data-recued-approvals-empty'),
      alertTarget,
      statusTarget,
      heading('data-recued-approvals-heading'),
    ],
  },
  kitchen: {
    choose_again: [
      activeControl('data-recued-kitchen-route-tabs'),
      control('data-recued-kitchen-route-content'),
      h1Target,
      h2Target,
    ],
    continue: [
      control('data-recued-kitchen-route-content'),
      activeControl('data-recued-kitchen-route-tabs'),
      h1Target,
      h2Target,
    ],
    review: [
      self('data-recued-recipe-editor-issues'),
      self('data-recued-recipe-editor-status'),
      alertTarget,
      statusTarget,
      h1Target,
      h2Target,
      activeControl('data-recued-kitchen-route-tabs'),
    ],
  },
  contracts: {
    choose_again: [
      {
        attr: 'data-recued-contracts-list-tab',
        active: true,
        focus: 'self',
      },
      control('data-recued-contracts-list-panel'),
      heading('data-recued-contracts-route-heading'),
    ],
    continue: [
      control('data-recued-contracts-row'),
      control('data-recued-contracts-new'),
      {
        attr: 'data-recued-contracts-list-tab',
        active: true,
        focus: 'self',
      },
      control('data-recued-contracts-detail'),
      heading('data-recued-contracts-route-heading'),
    ],
    review: [
      self('data-recued-contracts-error'),
      self('data-recued-contracts-head-error'),
      self('data-recued-contracts-unavailable'),
      self('data-recued-contracts-loading'),
      alertTarget,
      statusTarget,
      heading('data-recued-contracts-route-heading'),
    ],
  },
  connections: {
    choose_again: [
      activeControl('data-recued-connections-route-tabs'),
      control('data-recued-connections-route-content'),
      heading('data-recued-connections-route-heading'),
    ],
    continue: [
      control('data-recued-connections-route-content'),
      activeControl('data-recued-connections-route-tabs'),
      heading('data-recued-connections-route-heading'),
    ],
    review: [
      self('data-recued-connections-route-unavailable'),
      alertTarget,
      statusTarget,
      heading('data-recued-connections-route-heading'),
    ],
  },
  packs: {
    choose_again: [
      control('data-recued-discover-search'),
      control('data-recued-discover-filters'),
      control('data-recued-discover-card'),
      control('data-recued-packs-surface-add-input'),
      heading('data-recued-packs-route-heading'),
    ],
    continue: [
      control('data-recued-packs-surface-detail'),
      control('data-recued-discover-action'),
      control('data-recued-discover-card'),
      control('data-recued-discover-search'),
      control('data-recued-packs-surface-add-input'),
      heading('data-recued-packs-route-heading'),
    ],
    review: [
      self('data-recued-packs-list-error'),
      self('data-recued-packs-detail-resolve-error'),
      self('data-recued-packs-surface-add-error'),
      self('data-recued-packs-route-unavailable'),
      self('data-recued-discover-notice'),
      self('data-recued-discover-status'),
      alertTarget,
      statusTarget,
      heading('data-recued-packs-route-heading'),
    ],
  },
  recipes: {
    choose_again: [
      control('data-recued-recipes-search'),
      control('data-recued-recipes-filters'),
      control('data-recued-recipes-card'),
      heading('data-recued-recipes-route-heading'),
    ],
    continue: [
      control('data-recued-recipes-run-button'),
      control('data-recued-recipes-card'),
      control('data-recued-recipes-search'),
      heading('data-recued-recipes-route-heading'),
    ],
    review: [
      self('data-recued-recipes-source-error'),
      self('data-recued-recipes-unavailable'),
      self('data-recued-recipes-runnability'),
      alertTarget,
      statusTarget,
      heading('data-recued-recipes-route-heading'),
    ],
  },
  automation: {
    choose_again: [
      {
        attr: 'data-recued-automation-subnav',
        active: true,
        focus: 'self',
      },
      control('data-recued-automation-row'),
      control('data-recued-automation-section'),
      heading('data-recued-automation-heading'),
    ],
    continue: [
      control('data-recued-automation-row'),
      control('data-recued-automation-add'),
      {
        attr: 'data-recued-automation-subnav',
        active: true,
        focus: 'self',
      },
      heading('data-recued-automation-heading'),
    ],
    review: [
      self('data-recued-automation-error'),
      self('data-recued-automation-state'),
      self('data-recued-automation-empty'),
      alertTarget,
      statusTarget,
      heading('data-recued-automation-heading'),
    ],
  },
  data: {
    choose_again: [
      {
        attr: 'data-recued-data-route-tab',
        active: true,
        focus: 'self',
      },
      control('data-recued-data-file-sources'),
      control('data-recued-data-contact-row'),
      control('data-recued-data-form-response-row'),
      heading('data-recued-data-route-heading'),
    ],
    continue: [
      control('data-recued-data-contact-row'),
      control('data-recued-data-form-response-row'),
      control('data-recued-data-file-source-link'),
      {
        attr: 'data-recued-data-route-tab',
        active: true,
        focus: 'self',
      },
      heading('data-recued-data-route-heading'),
    ],
    review: [
      self('data-recued-data-source-error'),
      self('data-recued-data-unavailable'),
      alertTarget,
      statusTarget,
      heading('data-recued-data-route-heading'),
    ],
  },
  // D-250 § D7 — Stats is a READ-ONLY display surface: no rows to re-select, no
  // filters, no detail pane. The heading is the only stable landing target, and that is
  // the honest policy rather than borrowing Logs' row anchors for controls that do not
  // exist (a landing target that never resolves silently drops focus to the document).
  stats: {
    choose_again: [heading('data-recued-stats-route-heading')],
    continue: [heading('data-recued-stats-route-heading')],
    review: [heading('data-recued-stats-route-heading')],
  },
  logs: {
    choose_again: [
      control('data-recued-logs-filter'),
      control('data-recued-logs-row'),
      heading('data-recued-logs-route-heading'),
    ],
    continue: [
      control('data-recued-logs-active-row'),
      control('data-recued-logs-row'),
      control('data-recued-logs-detail'),
      control('data-recued-logs-filter'),
      heading('data-recued-logs-route-heading'),
    ],
    review: [
      self('data-recued-logs-error'),
      self('data-recued-logs-degraded'),
      self('data-recued-logs-status'),
      alertTarget,
      statusTarget,
      heading('data-recued-logs-route-heading'),
    ],
  },
  chat: {
    choose_again: [
      control('data-recued-chat-route-history-search'),
      control('data-recued-chat-route-session-list'),
      control('data-recued-chat-route-new-session'),
      heading('data-recued-chat-route-heading'),
    ],
    continue: [
      control('data-recued-chat-route-input'),
      control('data-recued-chat-route-history-continue'),
      control('data-recued-chat-route-new-session'),
      control('data-recued-chat-route-session-row'),
      heading('data-recued-chat-route-heading'),
    ],
    review: [
      self('data-recued-chat-route-error'),
      self('data-recued-chat-route-turn-failure'),
      self('data-recued-chat-route-ai-unavailable'),
      self('data-recued-chat-route-return-missing'),
      self('data-recued-chat-route-plan-target-missing'),
      self('data-recued-chat-route-history-draft-guard'),
      alertTarget,
      statusTarget,
      heading('data-recued-chat-route-heading'),
    ],
  },
  // D-145 PA7 / D-172 P2 — the compose host. The landing targets are the
  // Compose button and the heading; the dialog itself is transient and is not
  // a landing target (recovering INTO a half-written draft would present a
  // message the person did not just write as one they were about to send).
  mail: {
    choose_again: [
      control('data-recued-mail-compose'),
      heading('data-recued-mail-route'),
    ],
    continue: [
      control('data-recued-mail-compose'),
      heading('data-recued-mail-route'),
    ],
    review: [
      self('data-recued-mail-empty'),
      alertTarget,
      statusTarget,
      heading('data-recued-mail-route'),
    ],
  },
};

/**
 * Closed, presentation-only conditions that make an actionable recovery
 * intent stale after landing. These hooks expose state classes, never labels,
 * ids, field values, or source content. Loading and ordinary informational
 * statuses are deliberately absent: only a settled condition that needs the
 * person's attention may promote Continue / Choose again to Review.
 */
const ROUTE_LANDING_INVALIDATIONS: Record<
  WebclientRouteId,
  readonly LandingInvalidationTarget[]
> = {
  reception: [
    invalidation('data-recued-reception-response-error'),
    invalidation('data-recued-reception-records-error'),
  ],
  settings: [
    invalidation('data-recued-updates-error'),
    invalidation('data-recued-owner-operation-error'),
  ],
  approvals: [
    invalidation('data-recued-approvals-error'),
    invalidation('data-recued-approvals-plan-resolution'),
    invalidation('data-recued-approvals-empty'),
  ],
  kitchen: [
    invalidation('data-recued-recipe-editor-issues'),
  ],
  contracts: [
    invalidation('data-recued-contracts-error'),
    invalidation('data-recued-contracts-head-error'),
    invalidation('data-recued-contracts-unavailable'),
  ],
  connections: [
    invalidation('data-recued-connections-route-unavailable'),
  ],
  packs: [
    invalidation('data-recued-packs-list-error'),
    invalidation('data-recued-packs-detail-resolve-error'),
    invalidation('data-recued-packs-surface-add-error'),
    invalidation('data-recued-packs-route-unavailable'),
  ],
  recipes: [
    invalidation('data-recued-recipes-source-error'),
    invalidation('data-recued-recipes-unavailable'),
    scopedInvalidation(
      'data-recued-recipes-runnability',
      'blocked',
      [
        'data-recued-recipes-card',
        'data-recued-recipes-detail',
      ],
    ),
  ],
  automation: [
    invalidation('data-recued-automation-error'),
    qualifiedScopedInvalidation(
      'data-recued-automation-state',
      'data-armed',
      'tripped',
      ['data-recued-automation-row'],
    ),
  ],
  data: [
    invalidation('data-recued-data-source-error'),
    invalidation('data-recued-data-unavailable'),
  ],
  // D-250 § D7 — one section, one error surface; nothing to scope against a sibling.
  stats: [],
  logs: [
    // Runs renders History, Active, Active passes, and detail status beside
    // each other. Keep a still-valid landing inside its own section so an
    // unrelated sibling refresh error cannot steal focus.
    scopedInvalidation(
      'data-recued-logs-error',
      undefined,
      [
        'data-recued-logs-active',
        'data-recued-logs-peek',
        'data-recued-logs-passes',
        'data-recued-logs-detail',
      ],
    ),
    // The History feed has no public section hook. Its error replaces the
    // landed row, so route-wide fallback is safe only after that target is
    // gone; while the row remains, another section owns any global match.
    invalidationAfterLandingTargetLoss('data-recued-logs-error'),
    scopedInvalidation(
      'data-recued-logs-degraded',
      undefined,
      [
        'data-recued-logs-active-row',
        'data-recued-logs-detail',
        'data-recued-logs-row',
      ],
    ),
    ...[
      'failed',
      'cancelled',
      'killed',
      'in_doubt',
    ].map((status) => scopedInvalidation(
      'data-recued-logs-status',
      status,
      [
        'data-recued-logs-active-row',
        'data-recued-logs-detail',
        'data-recued-logs-row',
      ],
    )),
  ],
  chat: [
    invalidation('data-recued-chat-route-error'),
    invalidation('data-recued-chat-route-ai-unavailable'),
    invalidation('data-recued-chat-route-return-missing'),
    invalidation('data-recued-chat-route-plan-target-missing'),
    invalidation('data-recued-chat-route-history-draft-guard'),
  ],
  // A mail route with no send-capable account is a settled condition that
  // needs the person's attention — the Compose button is disabled and the
  // reason is on screen — so it promotes Continue / Choose again to Review.
  mail: [invalidation('data-recued-mail-empty')],
};

const RECOVERY_INTENT_OBSERVED_ROUTE_ATTRIBUTES = [
  ...new Set(
    [
      ...Object.values(ROUTE_LANDING_POLICIES).flatMap((policy) =>
        Object.values(policy).flatMap((targets) =>
          targets.flatMap((target) =>
            target.attr === undefined ? [] : [target.attr]))),
      ...Object.values(ROUTE_LANDING_INVALIDATIONS).flatMap((invalidators) =>
        invalidators.flatMap((invalidator) => [
          invalidator.attr,
          ...(invalidator.qualifierAttr !== undefined
            ? [invalidator.qualifierAttr]
            : []),
        ])),
    ],
  ),
];

const isHidden = (element: HTMLElement): boolean =>
  element.hasAttribute('hidden')
  || element.hasAttribute('inert')
  || element.getAttribute('aria-hidden') === 'true'
  || element.getAttribute('data-active') === 'false'
  || (element as HTMLElement & { hidden?: boolean }).hidden === true;

const isActive = (element: HTMLElement): boolean =>
  element.getAttribute('aria-current') === 'page'
  || element.getAttribute('aria-selected') === 'true'
  || element.getAttribute('data-active') === 'true';

const isEnabled = (element: HTMLElement): boolean =>
  !element.hasAttribute('disabled')
  && element.getAttribute('aria-disabled') !== 'true'
  && (element as HTMLElement & { disabled?: boolean }).disabled !== true;

const isFocusableControl = (element: HTMLElement): boolean => {
  if (!isEnabled(element) || isHidden(element)) return false;
  if (element.hasAttribute('tabindex')) return true;
  if (element.getAttribute('contenteditable') === 'true') return true;
  switch (element.tagName.toUpperCase()) {
    case 'A':
    case 'AREA':
      return element.hasAttribute('href');
    case 'BUTTON':
    case 'SELECT':
    case 'TEXTAREA':
    case 'SUMMARY':
      return true;
    case 'INPUT':
      return element.getAttribute('type') !== 'hidden';
    default:
      return false;
  }
};

const isStableRouteTarget = (
  root: HTMLElement,
  target: HTMLElement,
): boolean => {
  let current: HTMLElement | null = target;
  while (current !== null) {
    if (isHidden(current)) return false;
    if (current === root) return isEnabled(target);
    current = current.parentElement;
  }
  return false;
};

const isMountedVisibleRouteTarget = (
  root: HTMLElement,
  target: HTMLElement,
): boolean => {
  let current: HTMLElement | null = target;
  while (current !== null) {
    if (isHidden(current)) return false;
    if (current === root) return true;
    current = current.parentElement;
  }
  return false;
};

const isReadyRouteTarget = (
  root: HTMLElement,
  target: HTMLElement,
): boolean => {
  if (!isStableRouteTarget(root, target)) return false;
  let current: HTMLElement | null = target;
  while (current !== null) {
    if (current.getAttribute('aria-busy') === 'true') return false;
    if (current === root) return true;
    current = current.parentElement;
  }
  return false;
};

const childrenOf = (element: HTMLElement): HTMLElement[] =>
  Array.from(element.children) as HTMLElement[];

const findVisible = (
  root: HTMLElement,
  predicate: (element: HTMLElement) => boolean,
): HTMLElement | null => {
  if (isHidden(root)) return null;
  if (predicate(root)) return root;
  for (const child of childrenOf(root)) {
    const match = findVisible(child, predicate);
    if (match !== null) return match;
  }
  return null;
};

const findAllVisible = (
  root: HTMLElement,
  predicate: (element: HTMLElement) => boolean,
  matches: HTMLElement[] = [],
): HTMLElement[] => {
  if (isHidden(root)) return matches;
  if (predicate(root)) matches.push(root);
  for (const child of childrenOf(root)) {
    findAllVisible(child, predicate, matches);
  }
  return matches;
};

const matchesInvalidationTarget = (
  element: HTMLElement,
  invalidator: LandingInvalidationTarget,
): boolean =>
  element.hasAttribute(invalidator.attr)
  && (
    invalidator.value === undefined
    || element.getAttribute(invalidator.attr) === invalidator.value
  )
  && (
    invalidator.qualifierAttr === undefined
    || element.getAttribute(invalidator.qualifierAttr)
      === invalidator.qualifierValue
  );

const findInvalidationScope = (
  root: HTMLElement,
  landingTarget: HTMLElement | null,
  scopeAttrs: readonly string[],
): HTMLElement | null => {
  let scope = landingTarget;
  while (
    scope !== null
    && !scopeAttrs.some((attr) => scope?.hasAttribute(attr))
  ) {
    if (scope === root) return null;
    scope = scope.parentElement;
  }
  return scope;
};

const findIntentInvalidationTarget = (
  root: HTMLElement,
  route: WebclientRouteId,
  landingTarget: HTMLElement | null,
  landingTargetPresent: boolean,
): HTMLElement | null => {
  const invalidators = ROUTE_LANDING_INVALIDATIONS[route];
  if (
    landingTarget !== null
    && isEnabled(landingTarget)
    && invalidators.some((invalidator) =>
      matchesInvalidationTarget(landingTarget, invalidator)
      && (
        invalidator.scopeAttrs === undefined
        || findInvalidationScope(
          root,
          landingTarget,
          invalidator.scopeAttrs,
        ) !== null
      ))
  ) {
    // Keep an already-focused condition stable while it remains authoritative;
    // a later sibling condition must not reorder the person's current Review.
    return landingTarget;
  }
  for (const invalidator of invalidators) {
    if (
      invalidator.requiresLandingTargetLoss === true
      && landingTargetPresent
      && (
        landingTarget === null
        || !matchesInvalidationTarget(landingTarget, invalidator)
      )
    ) {
      continue;
    }
    let searchRoot = root;
    if (invalidator.scopeAttrs !== undefined) {
      const scope = findInvalidationScope(
        root,
        landingTarget,
        invalidator.scopeAttrs,
      );
      if (scope === null) continue;
      searchRoot = scope;
    }
    const match = findVisible(searchRoot, (element) =>
      matchesInvalidationTarget(element, invalidator));
    if (match !== null && isEnabled(match)) return match;
  }
  return null;
};

const matchesTarget = (
  element: HTMLElement,
  target: LandingTarget,
): boolean => {
  if (target.attr !== undefined && !element.hasAttribute(target.attr)) {
    return false;
  }
  if (target.tag !== undefined && element.tagName.toUpperCase() !== target.tag) {
    return false;
  }
  if (target.role !== undefined && element.getAttribute('role') !== target.role) {
    return false;
  }
  return target.active !== true || isActive(element);
};

const resolveFocusTarget = (
  candidate: HTMLElement,
  mode: LandingFocus,
): HTMLElement | null => {
  if (mode === 'self') return isEnabled(candidate) ? candidate : null;
  if (mode === 'active_control') {
    const active = findVisible(
      candidate,
      (element) => isActive(element) && isFocusableControl(element),
    );
    if (active !== null) return active;
  }
  return findVisible(candidate, isFocusableControl)
    ?? (isEnabled(candidate) ? candidate : null);
};

const focusTarget = (target: HTMLElement): boolean => {
  const focus = (target as HTMLElement & {
    focus?: (options?: FocusOptions) => void;
  }).focus;
  if (typeof focus !== 'function') return false;
  if (!isFocusableControl(target) && !target.hasAttribute('tabindex')) {
    target.setAttribute('tabindex', '-1');
  }
  try {
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    focus.call(target, { preventScroll: true });
    return true;
  } catch {
    try {
      focus.call(target);
      return true;
    } catch {
      return false;
    }
  }
};

const resolveRecoveryIntentLandingTargets = (input: {
  readonly root: HTMLElement;
  readonly route: WebclientRouteId;
  readonly intent: RecoveryLandingIntent;
}): HTMLElement[] => {
  const resolved: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const targets = ROUTE_LANDING_POLICIES[input.route][input.intent];
  for (const target of targets) {
    const candidates = findAllVisible(
      input.root,
      (element) => matchesTarget(element, target),
    );
    for (const candidate of candidates) {
      const focusable = resolveFocusTarget(candidate, target.focus ?? 'self');
      if (focusable !== null && !seen.has(focusable)) {
        seen.add(focusable);
        resolved.push(focusable);
      }
    }
  }
  return resolved;
};

const isWithin = (
  candidate: HTMLElement,
  target: HTMLElement,
): boolean => {
  let current: HTMLElement | null = target;
  while (current !== null) {
    if (current === candidate) return true;
    current = current.parentElement;
  }
  return false;
};

const isRecoveryIntentTargetCandidate = (input: {
  readonly root: HTMLElement;
  readonly route: WebclientRouteId;
  readonly intent: Exclude<RecoveryLandingIntent, 'review'>;
  readonly target: HTMLElement;
}): boolean => {
  for (const policyTarget of ROUTE_LANDING_POLICIES[input.route][input.intent]) {
    const candidates = findAllVisible(
      input.root,
      (element) => matchesTarget(element, policyTarget),
    );
    for (const candidate of candidates) {
      if (candidate === input.target) return true;
      if (
        (policyTarget.focus ?? 'self') !== 'self'
        && isWithin(candidate, input.target)
      ) {
        return true;
      }
    }
  }
  return false;
};

const focusFirstAvailableTarget = (
  targets: readonly HTMLElement[],
): HTMLElement | null => {
  for (const target of targets) {
    if (focusTarget(target)) return target;
  }
  return null;
};

const isExactRecoveryIntentTarget = (input: {
  readonly root: HTMLElement;
  readonly route: WebclientRouteId;
  readonly intent: Exclude<RecoveryLandingIntent, 'review'>;
  readonly target: HTMLElement;
}): boolean =>
  isReadyRouteTarget(input.root, input.target)
  && resolveRecoveryIntentLandingTargets(input).includes(input.target);

/**
 * Focus the best route-owned target for a recovery intent. Returns the exact
 * element focused, or `null` when the mounted route has no usable target.
 */
export const focusRecoveryIntentLanding = (input: {
  readonly root: HTMLElement;
  readonly route: WebclientRouteId;
  readonly intent: RecoveryLandingIntent;
}): HTMLElement | null => {
  return focusFirstAvailableTarget(resolveRecoveryIntentLandingTargets(input));
};

export interface RecoveryIntentOrientationMount {
  /** Replace any prior cue with one privacy-safe, intent-only orientation. */
  orient(input: {
    readonly target: HTMLElement;
    readonly intent: RecoveryLandingIntent;
    readonly route: WebclientRouteId;
  }): void;
  /** Retire the current visual and spoken cue without removing the mount. */
  clear(): void;
  /** Remove listeners, timers, and the persistent empty live region. */
  dispose(): void;
}

export interface RecoveryIntentResumeWindowExpired {
  readonly route: WebclientRouteId;
  readonly intent: Exclude<RecoveryLandingIntent, 'review'>;
}

/**
 * Ephemeral orientation layered onto a successful route-specific focus.
 *
 * The live region is mounted empty before any announcement so assistive
 * technology observes a later text mutation reliably. Cue state is DOM-only:
 * it never enters storage, history, or a route address, and pagehide clears it
 * before a BFCache snapshot can revive the one-shot handoff.
 */
export const mountRecoveryIntentOrientation = (opts: {
  readonly root: HTMLElement;
  readonly statusHost: HTMLElement;
  readonly document?: Document;
  readonly durationMs?: number;
  readonly resumeWindowMs?: number;
  readonly setTimer?: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly observeMutations?: (
    root: HTMLElement,
    onMutation: () => void,
  ) => () => void;
  /** Called only when an invalidated action exhausts its passive resume window.
   * The payload is closed-list route vocabulary; no DOM target or route-owned
   * identity crosses into the durable Attention handoff. */
  readonly onResumeWindowExpired?: (
    input: RecoveryIntentResumeWindowExpired,
  ) => void;
  /** A deliberate pointer, keyboard, input, or external focus move owns the
   * current route and may retire any older quiet continuation. */
  readonly onUserOwnership?: () => void;
}): RecoveryIntentOrientationMount => {
  const resolvedDocument = opts.document
    ?? (globalThis as { document?: Document }).document;
  if (resolvedDocument === undefined) {
    throw new Error(
      'mountRecoveryIntentOrientation: no document available — pass `document` for non-browser environments',
    );
  }
  const doc: Document = resolvedDocument;
  const setTimer = opts.setTimer
    ?? ((handler: () => void, delayMs: number): unknown =>
      globalThis.setTimeout(handler, delayMs));
  const clearTimer = opts.clearTimer
    ?? ((handle: unknown): void =>
      globalThis.clearTimeout(
        handle as ReturnType<typeof globalThis.setTimeout>,
      ));
  const durationMs = opts.durationMs ?? RECOVERY_INTENT_CUE_DURATION_MS;
  const resumeWindowMs =
    opts.resumeWindowMs ?? RECOVERY_INTENT_RESUME_WINDOW_MS;
  const observeMutations = opts.observeMutations
    ?? ((root: HTMLElement, onMutation: () => void): (() => void) => {
      const Observer = doc.defaultView?.MutationObserver
        ?? (globalThis as {
          MutationObserver?: typeof MutationObserver;
        }).MutationObserver;
      if (Observer === undefined) return () => undefined;
      const observer = new Observer(() => onMutation());
      observer.observe(root, {
        attributes: true,
        attributeFilter: [
          'aria-busy',
          'aria-current',
          'aria-disabled',
          'aria-hidden',
          'aria-selected',
          'contenteditable',
          'data-active',
          ...RECOVERY_INTENT_OBSERVED_ROUTE_ATTRIBUTES,
          'disabled',
          'hidden',
          'href',
          'inert',
          'tabindex',
          'type',
        ],
        childList: true,
        subtree: true,
      });
      return () => observer.disconnect();
    });

  const announcer = doc.createElement('span');
  announcer.setAttribute(RECOVERY_INTENT_ANNOUNCER_ATTR, '');
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');
  opts.statusHost.appendChild(announcer);

  let target: HTMLElement | null = null;
  let timer: {
    readonly handle: unknown;
    readonly kind: 'cue' | 'resume_window';
  } | null = null;
  let disposed = false;
  let listenersActive = false;
  let stopObservingMutations: (() => void) | null = null;
  let activeRoute: WebclientRouteId | null = null;
  let activeIntent: RecoveryLandingIntent | null = null;
  let landingIntent: RecoveryLandingIntent | null = null;
  let resumeTarget: HTMLElement | null = null;
  let intentInvalidated = false;
  let intentResumed = false;
  let cueVisible = false;
  let refocusingAfterMutation = false;

  const interactionEvents = [
    'pointerdown',
    'click',
    'keydown',
    'input',
  ] as const;
  const pageEvents = doc.defaultView as unknown as {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  } | null;

  const cancelTimer = (): void => {
    if (timer === null) return;
    clearTimer(timer.handle);
    timer = null;
  };

  function detachListeners(): void {
    if (!listenersActive) return;
    listenersActive = false;
    for (const type of interactionEvents) {
      doc.removeEventListener(type, onInteraction, true);
    }
    doc.removeEventListener('focusin', onFocusIn, true);
    pageEvents?.removeEventListener?.('pagehide', clear);
    stopObservingMutations?.();
    stopObservingMutations = null;
  }

  function clear(): void {
    cancelTimer();
    target?.removeAttribute(RECOVERY_INTENT_CUE_ATTR);
    cueVisible = false;
    target = null;
    announcer.textContent = '';
    activeRoute = null;
    activeIntent = null;
    landingIntent = null;
    resumeTarget = null;
    intentInvalidated = false;
    intentResumed = false;
    detachListeners();
  }

  const notifyUserOwnership = (): void => {
    try {
      opts.onUserOwnership?.();
    } catch {
      // Presentation cleanup must not depend on a best-effort continuity sink.
    }
  };

  function onInteraction(): void {
    notifyUserOwnership();
    clear();
  }

  function onFocusIn(event: Event): void {
    if (refocusingAfterMutation || event.target === target) return;
    // A route may deliberately focus a fresh status or control after a live
    // update without a pointer/key event. Respect that ownership change so a
    // later repaint cannot pull focus back to the recovery landing.
    notifyUserOwnership();
    clear();
  }

  function onRouteMutation(): void {
    const staleTarget = target;
    const route = activeRoute;
    const intent = activeIntent;
    if (staleTarget === null || route === null || intent === null) {
      clear();
      return;
    }
    const targetStable = isStableRouteTarget(opts.root, staleTarget);
    const staleTargetPresent = isMountedVisibleRouteTarget(
      opts.root,
      staleTarget,
    );
    if (intentResumed) {
      const resumedInvalidation = findIntentInvalidationTarget(
        opts.root,
        route,
        staleTarget,
        staleTargetPresent,
      );
      if (
        intent === 'review'
        || !isExactRecoveryIntentTarget({
          root: opts.root,
          route,
          intent,
          target: staleTarget,
        })
        || resumedInvalidation !== null
      ) {
        // A resumed cue is deliberately one-shot. If readiness regresses or
        // its exact target changes, retire instead of starting a focus loop.
        clear();
      }
      return;
    }
    if (
      intentInvalidated
      && (
        resumeTarget === null
        || !isMountedVisibleRouteTarget(opts.root, resumeTarget)
      )
    ) {
      // The original target is the only privacy-safe item identity retained.
      // Once it is gone, another row/card must never inherit this handoff.
      clear();
      return;
    }
    const routeTargets = intentInvalidated
      ? (resumeTarget === null ? [] : [resumeTarget])
      : targetStable
      ? [staleTarget]
      : resolveRecoveryIntentLandingTargets({
          root: opts.root,
          route,
          intent,
        });
    const routeTarget = routeTargets[0] ?? null;
    const invalidationLandingTarget = staleTargetPresent
      ? staleTarget
      : routeTarget;
    const invalidationTarget =
      intent !== 'review' || intentInvalidated
        ? findIntentInvalidationTarget(
            opts.root,
            route,
            invalidationLandingTarget,
            intentInvalidated
              ? invalidationLandingTarget !== null
              : staleTargetPresent,
          )
        : null;
    if (intentInvalidated && invalidationTarget === null) {
      const originalIntent = landingIntent;
      const exactResumeTarget = resumeTarget;
      if (
        originalIntent === null
        || originalIntent === 'review'
        || exactResumeTarget === null
        || !isRecoveryIntentTargetCandidate({
          root: opts.root,
          route,
          intent: originalIntent,
          target: exactResumeTarget,
        })
      ) {
        clear();
        return;
      }

      if (!isExactRecoveryIntentTarget({
        root: opts.root,
        route,
        intent: originalIntent,
        target: exactResumeTarget,
      })) {
        if (isReadyRouteTarget(opts.root, exactResumeTarget)) {
          // The node still exists but is no longer the route policy's exact
          // target. It may have been repurposed or displaced by fresher work.
          clear();
          return;
        }
        // The condition is gone, but the exact original action is still busy
        // or disabled. Hide the stale Review cue and wait for that same node's
        // public readiness markers; no focus or readiness claim happens yet.
        staleTarget.removeAttribute(RECOVERY_INTENT_CUE_ATTR);
        cancelTimer();
        target = exactResumeTarget;
        cueVisible = false;
        announcer.textContent = '';
        armResumeWindow();
        return;
      }

      staleTarget.removeAttribute(RECOVERY_INTENT_CUE_ATTR);
      let resumedTarget: HTMLElement | null = null;
      refocusingAfterMutation = true;
      try {
        resumedTarget = focusTarget(exactResumeTarget)
          ? exactResumeTarget
          : null;
      } finally {
        refocusingAfterMutation = false;
      }
      if (
        resumedTarget === null
        || !isExactRecoveryIntentTarget({
          root: opts.root,
          route,
          intent: originalIntent,
          target: resumedTarget,
        })
        || findIntentInvalidationTarget(
            opts.root,
            route,
            resumedTarget,
            true,
          ) !== null
        || target !== staleTarget
        || activeRoute !== route
        || activeIntent !== intent
      ) {
        clear();
        return;
      }

      target = resumedTarget;
      activeIntent = originalIntent;
      resumeTarget = null;
      intentInvalidated = false;
      intentResumed = true;
      cueVisible = true;
      resumedTarget.setAttribute(RECOVERY_INTENT_CUE_ATTR, originalIntent);
      announcer.textContent = RECOVERY_INTENT_RESUMED_COPY[originalIntent];
      armTimer();
      return;
    }
    const intentChanged = intent !== 'review' && invalidationTarget !== null;
    if (
      !intentChanged
      && targetStable
      && (!intentInvalidated || invalidationTarget === staleTarget)
    ) {
      return;
    }

    staleTarget.removeAttribute(RECOVERY_INTENT_CUE_ATTR);
    const nextIntent: RecoveryLandingIntent = intentChanged
      ? 'review'
      : intent;
    let successor: HTMLElement | null = null;
    refocusingAfterMutation = true;
    try {
      if (invalidationTarget !== null) {
        successor = intentInvalidated && !cueVisible
          ? invalidationTarget
          : focusTarget(invalidationTarget)
            ? invalidationTarget
            : null;
      } else {
        successor = focusFirstAvailableTarget(routeTargets);
      }
    } finally {
      refocusingAfterMutation = false;
    }
    if (
      successor === null
      || !isStableRouteTarget(opts.root, successor)
      || target !== staleTarget
      || activeRoute !== route
      || activeIntent !== intent
    ) {
      clear();
      return;
    }
    // Ordinary replacement churn moves the cue without touching its timer or
    // live copy. A semantic invalidation below gets one fresh generic
    // announcement/deadline; neither path replays the recovery receipt.
    target = successor;
    activeIntent = nextIntent;
    if (cueVisible) {
      successor.setAttribute(RECOVERY_INTENT_CUE_ATTR, nextIntent);
    }
    if (intentChanged) {
      resumeTarget = staleTargetPresent ? staleTarget : null;
      intentInvalidated = true;
      intentResumed = false;
      cueVisible = true;
      announcer.textContent = RECOVERY_INTENT_INVALIDATED_COPY;
      armTimer(true);
    }
  }

  function armTimer(retainInvalidatedState = false): void {
    cancelTimer();
    if (durationMs <= 0) return;
    const handle = setTimer(() => {
      timer = null;
      if (retainInvalidatedState && intentInvalidated) {
        target?.removeAttribute(RECOVERY_INTENT_CUE_ATTR);
        cueVisible = false;
        announcer.textContent = '';
        armResumeWindow();
        return;
      }
      clear();
    }, durationMs);
    timer = { handle, kind: 'cue' };
  }

  function armResumeWindow(): void {
    if (timer?.kind === 'resume_window') return;
    cancelTimer();
    if (resumeWindowMs <= 0) {
      expireResumeWindow();
      return;
    }
    let handle: unknown;
    handle = setTimer(() => {
      if (timer?.kind !== 'resume_window' || timer.handle !== handle) return;
      timer = null;
      expireResumeWindow();
    }, resumeWindowMs);
    timer = { handle, kind: 'resume_window' };
  }

  function expireResumeWindow(): void {
    const route = activeRoute;
    const originalIntent = landingIntent;
    const exactResumeTarget = resumeTarget;
    if (
      intentInvalidated
      && route !== null
      && originalIntent !== null
      && originalIntent !== 'review'
      && exactResumeTarget !== null
      && isRecoveryIntentTargetCandidate({
        root: opts.root,
        route,
        intent: originalIntent,
        target: exactResumeTarget,
      })
    ) {
      try {
        opts.onResumeWindowExpired?.({
          route,
          intent: originalIntent,
        });
      } catch {
        // Expiration remains focus-safe even if the optional Attention sink fails.
      }
    }
    clear();
  }

  function attachListeners(): void {
    if (listenersActive) return;
    listenersActive = true;
    // Capture at the document boundary: moving into Account, Attention, or
    // another persistent shell control means the landing cue is no longer the
    // person's active context, even though that control sits outside the route.
    for (const type of interactionEvents) {
      doc.addEventListener(type, onInteraction, true);
    }
    doc.addEventListener('focusin', onFocusIn, true);
    pageEvents?.addEventListener?.('pagehide', clear);
    stopObservingMutations = observeMutations(
      opts.root,
      onRouteMutation,
    );
  }

  return {
    orient: ({ target: nextTarget, intent, route }): void => {
      if (disposed) return;
      clear();
      target = nextTarget;
      activeRoute = route;
      activeIntent = intent;
      landingIntent = intent;
      resumeTarget = null;
      intentInvalidated = false;
      intentResumed = false;
      cueVisible = true;
      target.setAttribute(RECOVERY_INTENT_CUE_ATTR, intent);
      announcer.textContent = RECOVERY_INTENT_CUE_COPY[intent];
      attachListeners();
      armTimer();
      // The authoritative read may have settled into a blocking state before
      // this one-shot orientation mounted. Classify the already-rendered DOM
      // immediately; waiting for a later mutation could falsely cue Continue.
      onRouteMutation();
    },
    clear,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      clear();
      announcer.remove();
    },
  };
};

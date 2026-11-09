/** Owner-facing guidance for retained failure codes, never raw error text. */
import { confirmedErrorMetadata, type BridgeConfirmedErrorCode, type BridgeConfirmedOutcome } from '../idempotency/cache.js';

interface FailureGuidance {
  cause: string;
  next_step: string;
}

const guidance: Record<BridgeConfirmedErrorCode, FailureGuidance> = {
  capacity_gap_logged_in: {
    cause: 'The required sign-in session was unavailable.',
    next_step: 'Sign in to the required site in this browser, then check the recipe run.',
  },
  capacity_gap_tab_unavailable: {
    cause: 'No matching browser tab was available.',
    next_step: 'Open the required page in this browser and check that it is ready.',
  },
  capacity_gap_permission_missing: {
    cause: 'A browser permission needed for this action was unavailable.',
    next_step: 'Review the Bridge site permissions for the required page.',
  },
  selector_not_found: {
    cause: 'The expected page element could not be found.',
    next_step: 'Check that the page is ready and the recipe still targets the correct element.',
  },
  authority_invalid: {
    cause: 'The action’s authorization could not be verified.',
    next_step: 'Review the recipe run’s authorization before starting another action.',
  },
  authority_expired: {
    cause: 'The action’s authorization had expired.',
    next_step: 'Start a new approved action from the recipe run.',
  },
  authority_invalid_grant_scope: {
    cause: 'The action is not covered by the ingredient’s site permissions.',
    next_step: 'Review the ingredient’s allowed sites and your Bridge site grants.',
  },
  ingredient_domain_signature_invalid: {
    cause: 'The ingredient’s allowed-site information could not be verified.',
    next_step: 'Check the ingredient’s publisher and version before installing a trusted update.',
  },
  tab_navigation_blocked: {
    cause: 'The requested page access was blocked.',
    next_step: 'Review the current page again and check the recipe’s target and site permissions.',
  },
  value_not_applied: {
    cause: 'The page element did not keep the value the recipe entered.',
    next_step: 'Check the field on the page, and that the recipe’s value fits it, before trying again.',
  },
  field_protected: {
    cause: 'The recipe tried to read a password, hidden, sign-in code or payment card field, which the Bridge never reads.',
    next_step: 'Change the recipe to read a different element.',
  },
  idempotency_violation: {
    cause: 'A retry did not match the original command identity.',
    next_step: 'Review the original command and recipe run before starting another action.',
  },
  queue_full: {
    cause: 'The bridge’s command queue was full.',
    next_step: 'Let queued commands finish, then check the recipe run for its retry status.',
  },
  unknown: {
    cause: 'The bridge reported an error without a specific cause.',
    next_step: 'Open the recipe run details and check the page before starting another action.',
  },
};

const unavailable: FailureGuidance = {
  cause: 'No recognized error code was saved for this outcome.',
  next_step: 'Open the recipe run details and check the page before starting another action.',
};

export const confirmedOutcomeGuidance = (
  outcome: Pick<BridgeConfirmedOutcome, 'status' | 'error_code'>,
): (FailureGuidance & { error_code?: BridgeConfirmedErrorCode }) | null => {
  if (outcome.status === 'ok') return null;
  const metadata = confirmedErrorMetadata(outcome.status, outcome.error_code);
  return { ...(metadata.error_code ? guidance[metadata.error_code] : unavailable), ...metadata };
};

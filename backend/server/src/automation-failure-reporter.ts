/** D-268 — the seam that turns a recorded unattended failure into something the
 *  owner actually hears, and decides when the automation disarms itself.
 *
 *  🔑 THE WHOLE ENTRY IN ONE LINE: every unattended failure was ALREADY
 *  recorded and NONE of them was ever reported. All three paths — cron
 *  (`scheduler.ts`), auto-run (`auto-run-scheduler.ts`) and event triggers
 *  (`triggers/dispatcher.ts`) — already call `presentAutomationFailure` and
 *  write `last_status` / `last_error`. Not one of them holds a notifier. The row
 *  is a PULL surface you must already suspect something to open, which is how a
 *  broken automation stays broken for weeks while reporting success.
 *
 *  ⛔ NOTIFY EARLY, STOP LATE — and they are two decisions, not one. A
 *  notification is cheap and reversible, so it fires on the FIRST failure of an
 *  episode; waiting for the breaker leaves a daily schedule dead for five days
 *  before anyone hears. Disarming is costly and re-arming is manual, so a
 *  transient blip must not switch off an automation the owner then has to notice
 *  — which is the same silent loss this entry exists to end, arriving from the
 *  other side. {@link classifyAutomationFailure} decides which failures earn the
 *  wait.
 *
 *  ⛔⛔ ONE NOTIFICATION PER EPISODE, NOT PER FAILURE. An episode opens on the
 *  first failure after a success and closes on the next success or on the
 *  disarm; failures in between are silent. Without this a five-minute reactive
 *  rule pages the owner 288 times a day, and the feature becomes the thing
 *  people turn off first.
 *
 *  ⚠ RECOVERY IS SILENT, DELIBERATELY. A successful run closes the episode and
 *  sends nothing. The owner who reconnected the account performed the fix;
 *  telling them it worked is a notification whose only subject is themselves.
 *
 *  Gate posture: `core.notification.send` is `read`-tier (`c64baa25d`) on the
 *  standing ruling that one must never make the owner authorize an act whose
 *  only subject is themselves — and the approval ask would arrive on the same
 *  channel as the notice it gates. Nothing here asks.
 *
 *  Modelled on `update/owner-alert.ts`: a pure describe + a thin best-effort
 *  deliver, bound through `notify` alone so a slow owner channel can never delay
 *  a scheduler tick.
 *
 *  Spec: D-268. */

import { classifyAutomationFailure, type AutomationFailureBasis } from '@recued/contracts';
import type { NotificationBlock, NotificationMessage } from '@recued/notification';

/** Which automation kind failed. The three unattended dispatch paths. */
export type AutomationUnitKind = 'schedule' | 'auto_run' | 'trigger';

export interface AutomationUnitRef {
  readonly kind: AutomationUnitKind;
  /** `schedule_id` / `recipe_id` / `trigger_id` — the row that disarms. */
  readonly id: string;
  /** Always present: every unit runs exactly one recipe, and the deep link is
   *  built from this rather than from a section token. */
  readonly recipe_id: string;
  /** Display name when the caller could resolve one; falls back to `recipe_id`. */
  readonly name?: string | undefined;
}

/** What the caller must do after a failed unattended run. */
export interface AutomationFailureReport {
  /** The unit's failure counter AFTER this run. Unchanged when the run was not
   *  a failure at all. The caller persists it in whichever store it already
   *  owns — this module holds no state. */
  readonly consecutive_failures: number;
  /** Disarm the unit now (`enabled: false` / `auto_disabled: true`). */
  readonly disarm: boolean;
  /** Present ⇒ deliver exactly this. Absent ⇒ stay silent. */
  readonly notice?: NotificationMessage;
  /** Which classification rule produced this. Carried so a surface, an audit row
   *  or a test can say WHY rather than re-derive it. Absent for a non-failure. */
  readonly basis?: AutomationFailureBasis;
  /** ⛔ True ⇒ the run was NOT a failure (a guard tripped and was right to). The
   *  caller must not increment anything, must not disarm, and must not treat the
   *  run as an error on its status row. */
  readonly not_a_failure: boolean;
}

/** `#automation/<recipe-id>` — the legacy deep link the Recipes detail already
 *  uses, which narrows the Automation view to that recipe's rules.
 *
 *  🔑 DELIBERATELY NOT `#automation/<section>/<id>`. The richer form needs a
 *  section token (`auto-run` / `triggers` / `schedules` / `dishes`) whose closed
 *  list lives in the WEBCLIENT, which `backend/` cannot import. Mirroring it
 *  here would be a hand-copied constant that rots silently the day someone
 *  renames a token — the link would 404 with nothing red. The recipe form needs
 *  no mirror and lands on the same rules. */
export const automationRuleLink = (unit: AutomationUnitRef): string =>
  `#automation/${encodeURIComponent(unit.recipe_id)}`;

const unitLabel = (unit: AutomationUnitRef): string =>
  unit.name !== undefined && unit.name !== '' ? unit.name : unit.recipe_id;

/** The one-line reason, trimmed so a phone notification stays readable. A long
 *  provider message is a document and belongs behind the link. */
const REASON_MAX = 240;
const trimReason = (message: string): string => {
  const flat = message.replace(/\s+/g, ' ').trim();
  if (flat.length <= REASON_MAX) return flat;
  return `${flat.slice(0, REASON_MAX - 1)}…`;
};

/** ⛔ THE NOTICE STATES A FACT AND NEVER A DIAGNOSIS. This module knows that a
 *  run failed and what the failure said; it does not know that a token expired,
 *  that a provider is down, or what the owner should do about it. An
 *  assurance-shaped guess reads as authoritative and is worse than the fact. */
export const describeAutomationFailureNotice = (input: {
  readonly unit: AutomationUnitRef;
  readonly reason: string;
  readonly consecutive_failures: number;
  readonly stopped: boolean;
  readonly threshold: number;
}): NotificationMessage => {
  const label = unitLabel(input.unit);
  const reason = trimReason(input.reason);
  if (input.stopped) {
    const times = input.consecutive_failures === 1
      ? 'after one failure'
      : `after ${input.consecutive_failures} failures`;
    return {
      title: `${label} has stopped`,
      text:
        `Recued turned this automation off ${times}. ${reason} `
        + 'It will not run again until you re-arm it.',
      link_url: automationRuleLink(input.unit),
    };
  }
  return {
    title: `${label} failed`,
    text: `${reason} Recued will stop this automation if it fails ${input.threshold} times.`,
    link_url: automationRuleLink(input.unit),
  };
};

/** Decide what a just-failed unattended run means. Pure.
 *
 *  ⚠ `prior_consecutive_failures` is the count BEFORE this run — each caller
 *  reads it from the store it already owns (`circuitStore` for auto-run, the
 *  24h error counter for triggers, a new column for schedules), so this module
 *  never becomes a fourth place failure state lives. */
export const decideAutomationFailure = (input: {
  readonly unit: AutomationUnitRef;
  /** The failing run's first error code, when it reported one. */
  readonly code?: string | undefined;
  /** D-237 — `items_failed === items_total > 0` on a run reporting success. */
  readonly total_refusal?: boolean | undefined;
  /** `presentAutomationFailure(...).userMessage` — already redaction-safe.
   *  ⛔ The notice must carry the PRESENTED text, never the internal one: the
   *  presenter exists to keep server-defect detail out of owner-facing surfaces,
   *  and a notification is the most owner-facing surface there is. */
  readonly reason: string;
  readonly prior_consecutive_failures: number;
  readonly threshold: number;
}): AutomationFailureReport => {
  const disposition = classifyAutomationFailure({
    code: input.code,
    total_refusal: input.total_refusal,
  });
  if (disposition.kind === 'not_a_failure') {
    return {
      consecutive_failures: input.prior_consecutive_failures,
      disarm: false,
      not_a_failure: true,
    };
  }
  const consecutive_failures = input.prior_consecutive_failures + 1;
  const disarm = disposition.stop === 'first_failure'
    || consecutive_failures >= input.threshold;
  // One per episode: the first failure after a success opens it, the disarm
  // closes it. A `first_failure` disposition is both at once and must send ONE
  // notice — the stopped one, which is the more informative of the two.
  const notify = disarm || consecutive_failures === 1;
  return {
    consecutive_failures,
    disarm,
    basis: disposition.basis,
    not_a_failure: false,
    ...(notify
      ? {
        notice: describeAutomationFailureNotice({
          unit: input.unit,
          reason: input.reason,
          consecutive_failures,
          stopped: disarm,
          threshold: input.threshold,
        }),
      }
      : {}),
  };
};

/** Deliver one best-effort notice. Returns false only when the transport itself
 *  refused; a scheduler tick must never depend on this result, and an owner
 *  channel that is down must never turn a recorded failure into an unhandled
 *  rejection. */
export const deliverAutomationFailureNotice = async (
  notice: NotificationMessage,
  notify: Pick<NotificationBlock, 'notify'>['notify'],
): Promise<boolean> => {
  try {
    await notify(notice);
    return true;
  } catch {
    return false;
  }
};

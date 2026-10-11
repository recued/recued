/** A recipe's "Send from" setting: the variable a mail send takes its mailbox
 *  from (owner, 2026-10-10: with one mailbox that can send, Chat should not
 *  have to ask which).
 *
 *  🔑 NAMED BY THE RECIPE'S OWN WIRING, NOT BY THE VARIABLE'S NAME. Of the 39
 *  shipped recipes that send mail (measured 2026-10-10), 12 give
 *  `core.mail.send` its mailbox straight from a setting
 *  (`{{config.sender_mail_instance}}`), 11 through one `trim` step over a
 *  setting, and 16 from somewhere else: a stored record (a job's, a photo
 *  set's), a list item, or a step that works it out. Only the first two leave
 *  the send nothing to fall back on when the setting is empty, so an empty one
 *  can only fail the run, and that is what makes filling it safe. A setting the
 *  send reads through anything else may have a fallback behind it, which a
 *  filled value would override, so it is not matched.
 *
 *  One reader for both halves: the owner's catalog (the setting is optional
 *  there, and says why) and the run (`execute-handler.ts`: an owner's run with
 *  it empty sends from the only mailbox that can, and is refused with the
 *  mailboxes' names otherwise). The two cannot disagree about which setting
 *  it is. */

import type { RecipeDefinition } from '@recued/contracts';

const CONFIG_REF = /^\{\{config\.([A-Za-z0-9_-]+)\}\}$/;
const STEP_REF = /^\{\{step\.([A-Za-z0-9_-]+)\}\}$/;

/** A step that sends one email: the canonical op, or the kernel ingredient it
 *  lowers to. */
const isMailSend = (step: Record<string, unknown>): boolean =>
  step.op === 'core.mail.send' || step.ingredient === 'mail-send';

/** The declared variables this recipe sends mail from. Empty for a recipe that
 *  sends none, or takes its mailbox from anywhere else. */
export const mailSenderSettings = (recipe: RecipeDefinition): ReadonlySet<string> => {
  const steps = [
    ...((recipe.prefetch_steps ?? []) as unknown as Array<Record<string, unknown>>),
    ...((recipe.steps ?? []) as unknown as Array<Record<string, unknown>>),
  ];
  const byId = new Map<string, Record<string, unknown>>();
  for (const step of steps) if (typeof step.id === 'string') byId.set(step.id, step);
  const variables = recipe.variables ?? {};
  const settings = new Set<string>();
  for (const step of steps) {
    if (!isMailSend(step)) continue;
    const payload = step.op !== undefined ? step.args : step.input;
    const sender = payload !== null && typeof payload === 'object'
      ? (payload as Record<string, unknown>).sender_mail_instance
      : undefined;
    if (typeof sender !== 'string') continue;
    let variable = CONFIG_REF.exec(sender)?.[1];
    if (variable === undefined) {
      // One `trim` step between the setting and the send: the shipped idiom.
      const hop = byId.get(STEP_REF.exec(sender)?.[1] ?? '');
      if (hop?.transform === 'trim' && typeof hop.input === 'string') {
        variable = CONFIG_REF.exec(hop.input)?.[1];
      }
    }
    if (variable !== undefined && Object.hasOwn(variables, variable)) settings.add(variable);
  }
  return settings;
};

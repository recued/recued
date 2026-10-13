/** Which of a recipe's settings name one of the owner's mailboxes or calendars,
 *  read from how the recipe's steps use them. The screens offer a list of the
 *  owner's mailboxes (or calendars) for these settings, where they offered a
 *  text box.
 *
 *  A mailbox is already a connection of its own: set up under Connections →
 *  Mail, read as `data.mail.<name>`, and named by every mail operation (`slug`
 *  to read it, `sender_mail_instance` to send from it). Records keep the
 *  mailbox they came from. What was missing was the choosing. A recipe asks for
 *  the name in a plain setting ("Mail account slug", "Mailbox to read"), the
 *  settings form had no list, and the owner typed the name as the Connections
 *  page shows it. Measured over the shipped recipes on 2026-10-12: 34 of the 40
 *  steps that send mail and 45 of the 106 that read mail or a calendar take the
 *  name from a setting.
 *
 *  🔑 NAMED BY THE RECIPE'S WIRING, NOT BY THE SETTING'S NAME OR TYPE. The same
 *  thing is called `sender_mail_instance`, `mail_slug`, `calendar_slug` and
 *  `sender_mail`, and the seller recipes declare theirs as a notification
 *  connection while passing it to the send as a mailbox. What decides is where
 *  the value goes: a mail or calendar operation's mailbox argument, straight or
 *  through steps that pass a setting on unchanged when it is set (`trim`,
 *  `default`, `defaults`, `coalesce`). Anything else (a template, a filter, a
 *  record's field) may make something else of the value, so it is not followed.
 *
 *  Projected onto `recipe.list` rows by the server (`mailbox_settings`): the
 *  steps it reads are not on a list row, and the webclient may not import the
 *  engine. One definition for both ends. */

import { KERNEL_OP_REGISTRY } from './kernel-op-registry.js';

/** What a setting names: a mailbox (`data.mail.<name>`) or a calendar
 *  (`data.calendar.<name>`). */
export type MailboxCollection = 'mail' | 'calendar';

/** A setting whose value is the name of one of the owner's mailboxes or
 *  calendars. */
export interface MailboxSetting {
  /** The setting's key in the recipe's `variables`. */
  readonly key: string;
  readonly collection: MailboxCollection;
  /** A step sends mail from it, so only a mailbox that can send will do. */
  readonly sends: boolean;
}

interface MailboxArgument {
  readonly collection: MailboxCollection;
  /** The argument that names the mailbox or calendar. */
  readonly arg: string;
  readonly sends: boolean;
}

const mailRead = (arg: string): MailboxArgument => ({ collection: 'mail', arg, sends: false });
const mailSend: MailboxArgument = { collection: 'mail', arg: 'sender_mail_instance', sends: true };
const calendar: MailboxArgument = { collection: 'calendar', arg: 'slug', sends: false };

/** Every kernel operation whose argument names one mailbox or calendar, and
 *  which argument. The others in those domains name none: a mail fact, a
 *  reconciliation id, a draft id. A test holds each id to the kernel registry,
 *  so a renamed operation fails there rather than silently dropping out. */
export const MAILBOX_ARGUMENT_OPS: Readonly<Record<string, MailboxArgument>> = {
  'core.mail.get': mailRead('slug'),
  'core.mail.body-read': mailRead('slug'),
  'core.mail.thread-read': mailRead('slug'),
  'core.mail.email.get': mailRead('slug'),
  'core.mail.email.list': mailRead('slug'),
  'core.mail.email.search': mailRead('slug'),
  'core.mail.mark': mailRead('slug'),
  'core.mail.flag': mailRead('slug'),
  'core.mail.move': mailRead('slug'),
  'core.mail.delete': mailRead('slug'),
  'core.mail.send': mailSend,
  'core.mail.notify-booking-visitor': mailSend,
  'core.data.calendar.get': calendar,
  'core.data.calendar.list': calendar,
  'core.data.calendar.search': calendar,
  'core.data.calendar.stat': calendar,
  'core.data.calendar.create': calendar,
  'core.data.calendar.update': calendar,
  'core.data.calendar.delete': calendar,
  'core.data.calendar.rsvp': calendar,
};

/** The time watcher names its collection and instance separately: `instance`
 *  is a calendar's (or a mailbox's) name when `collection` says so. */
const TIME_RELATIVE_WATCH = 'core.watch.time-relative';
const WATCHED_COLLECTIONS: Readonly<Record<string, MailboxCollection>> = {
  'data.calendar': 'calendar',
  calendar: 'calendar',
  'data.mail': 'mail',
  mail: 'mail',
};

/** An installed recipe can hold its kernel steps lowered onto their backing
 *  ingredients (`{ ingredient: 'mail-send', input }`), so each operation is
 *  also known by its backing slug. */
const opOfIngredient: ReadonlyMap<string, string> = new Map(
  KERNEL_OP_REGISTRY
    .filter((entry) => entry.backing_slug !== undefined
      && (entry.op in MAILBOX_ARGUMENT_OPS || entry.op === TIME_RELATIVE_WATCH))
    .map((entry) => [entry.backing_slug!, entry.op]),
);

type Step = Record<string, unknown>;

const CONFIG_REF = /^\{\{config\.([A-Za-z0-9_-]+)\}\}$/;
const STEP_REF = /^\{\{step\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?\}\}$/;
/** How many pass-through steps a value is followed through. The shipped
 *  recipes need one; a longer chain is most likely not a plain hand-on. */
const MAX_HOPS = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The settings a value comes from, followed through the steps that hand a
 *  setting on unchanged when it is set. */
const settingsBehind = (
  value: unknown,
  steps: ReadonlyMap<string, Step>,
  hops: number,
): string[] => {
  if (typeof value !== 'string') return [];
  const setting = CONFIG_REF.exec(value);
  if (setting !== null) return [setting[1]!];
  const ref = STEP_REF.exec(value);
  if (ref === null || hops >= MAX_HOPS) return [];
  const step = steps.get(ref[1]!);
  if (step === undefined) return [];
  const field = ref[2];
  const next = (inner: unknown): string[] => settingsBehind(inner, steps, hops + 1);
  // `defaults` is read a field at a time (`{{step.<id>.<field>}}`); every other
  // step here is read whole.
  if (step.transform === 'defaults') {
    const entry = field !== undefined && isRecord(step.fields) ? step.fields[field] : undefined;
    return isRecord(entry) ? [...next(entry.value), ...next(entry.fallback)] : [];
  }
  if (field !== undefined) return [];
  switch (step.transform) {
    case 'trim':
      return next(step.input);
    case 'default':
      return [...next(step.value), ...next(step.fallback)];
    case 'coalesce':
      return Array.isArray(step.values) ? step.values.flatMap(next) : [];
    default:
      return [];
  }
};

/** A step's operation, by its id or by the ingredient it was lowered onto, and
 *  the arguments it is given. */
const operationOf = (step: Step): { op: string; args: Record<string, unknown> } | null => {
  if (typeof step.op === 'string') {
    return { op: step.op, args: isRecord(step.args) ? step.args : {} };
  }
  if (typeof step.ingredient === 'string') {
    const op = opOfIngredient.get(step.ingredient);
    if (op !== undefined) return { op, args: isRecord(step.input) ? step.input : {} };
  }
  return null;
};

/** The mailbox or calendar a step names, and the value that names it. */
const mailboxArgumentOf = (
  step: Step,
): { readonly use: Omit<MailboxArgument, 'arg'>; readonly value: unknown } | null => {
  const operation = operationOf(step);
  if (operation === null) return null;
  if (operation.op === TIME_RELATIVE_WATCH) {
    const watched = operation.args.collection;
    const collection = typeof watched === 'string' ? WATCHED_COLLECTIONS[watched] : undefined;
    return collection === undefined
      ? null
      : { use: { collection, sends: false }, value: operation.args.instance };
  }
  const argument = MAILBOX_ARGUMENT_OPS[operation.op];
  return argument === undefined
    ? null
    : { use: { collection: argument.collection, sends: argument.sends }, value: operation.args[argument.arg] };
};

/** A declaration that holds a name typed or chosen as text: no value (`null`),
 *  a text default, or a hint of a text type. A setting of any other type (a
 *  choice of the author's, a number, a template) keeps its own control. */
const holdsText = (declaration: unknown): boolean => {
  if (declaration === null || typeof declaration === 'string') return true;
  if (!isRecord(declaration)) return false;
  const type = declaration.type;
  return type === undefined || type === 'string' || type === 'text' || type === 'connection';
};

/** The settings of `recipe` that name one of the owner's mailboxes or
 *  calendars, in the order the recipe declares them. A setting that names a
 *  mailbox in one step and a calendar in another names neither: it is left
 *  out. One that a step sends from `sends`, wherever else it is read. */
export const recipeMailboxSettings = (recipe: unknown): MailboxSetting[] => {
  if (!isRecord(recipe)) return [];
  const variables = isRecord(recipe.variables) ? recipe.variables : {};
  const steps: Step[] = (['prefetch_steps', 'steps', 'trigger_steps'] as const)
    .flatMap((list) => (Array.isArray(recipe[list]) ? recipe[list] as unknown[] : []))
    .filter(isRecord);
  const byId = new Map<string, Step>();
  for (const step of steps) if (typeof step.id === 'string') byId.set(step.id, step);

  const uses = new Map<string, { collections: Set<MailboxCollection>; sends: boolean }>();
  for (const step of steps) {
    const named = mailboxArgumentOf(step);
    if (named === null) continue;
    for (const key of settingsBehind(named.value, byId, 0)) {
      if (!Object.hasOwn(variables, key) || !holdsText(variables[key])) continue;
      const use = uses.get(key) ?? { collections: new Set<MailboxCollection>(), sends: false };
      use.collections.add(named.use.collection);
      use.sends ||= named.use.sends;
      uses.set(key, use);
    }
  }
  const settings: MailboxSetting[] = [];
  for (const key of Object.keys(variables)) {
    const use = uses.get(key);
    if (use === undefined || use.collections.size !== 1) continue;
    const [collection] = use.collections;
    settings.push({ key, collection: collection!, sends: collection === 'mail' && use.sends });
  }
  return settings;
};

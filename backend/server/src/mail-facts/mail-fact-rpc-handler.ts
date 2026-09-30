/**
 * D-315 — the owner's control plane over what is read from their mail, over
 * the paired-owner rpc: the templates (§4, §6.1), the standards pass's
 * per-type switches (§7.1, ruling 10), and the reads behind the screens (§6):
 * the facts list (§6.4) and what the mail detail view needs for its actions.
 *
 * Both decide what is read from the owner's mail, so only a registered paired
 * client may change them, and the whole `mail_fact.` family is reserved out of
 * MCP. A saved template or switch applies to NEW mail; past mail changes only
 * through a backfill (§6.3), so no change here touches facts already read.
 *
 *   - A definition is checked against its type before it is stored, and every
 *     problem comes back in `details.problems`.
 *   - Of one type and one set of conditions, only one template is active
 *     (ruling 31): activating a second answers `conflict`, naming the first.
 */

import {
  getMailFactBuiltinType,
  isMailFactStandardsType,
  MAIL_FACT_BUILTIN_TYPES,
  MAIL_FACT_EMAIL_CONTENT_MAX_CHARS,
  MAIL_FACT_ROWS_DEFAULT_EMAILS,
  MAIL_FACT_ROWS_MAX_EMAILS,
  MAIL_FACT_SENDERS_DEFAULT_LIMIT,
  MAIL_FACT_SENDERS_MAX_LIMIT,
  MAIL_FACT_STANDARDS_TYPES,
  MAIL_TEMPLATE_PREVIEW_DEFAULT_LIMIT,
  MAIL_TEMPLATE_PREVIEW_MAX_LIMIT,
  MAIL_TEMPLATE_SAMPLE_MAX_CHARS,
  RpcError,
  mailTemplateDefinitionOf,
  mailTemplateStarterProblems,
  validateMailFactCustomType,
  validateMailFactTypeChange,
  validateMailTemplateDefinition,
  type CollectionRecord,
  type HandlerSlice,
  type MailFactEmailRef,
  type MailFactEmailSummary,
  type MailFactRow,
  type MailFactRowsCursor,
  type MailFactRun,
  type MailFactThing,
  type MailFactTypeSpec,
  type MailTemplate,
  type MailTemplateDefinition,
  type RunAnchorStatus,
  type ServerRpcRegistry,
  mailFactEventPattern,
  type EventTrigger,
} from '@recued/contracts';

import type { MailFactPageQuery, MailFactRunLink, MailFactStore } from '../storage/mail-fact-store.js';
import type { WsClient } from '../ws-server.js';
import { looksLikeSecurityNotice, looksLikeSecurityNoticeText } from './security-notice.js';
import { MailFactBackfillError, type MailFactBackfill } from './backfill.js';
import { listSendersWithoutTemplate } from './senders.js';
import { readStoredEmail } from './stored-email.js';
import {
  MailPreviewSecurityNotice,
  previewTemplate,
  sampleEmail,
  summaryOf,
  type PreviewSource,
  type TemplatePreviewDeps,
} from './template-preview.js';
import { mailFactAiFailure, type MailFactAiCall } from './ai-pass.js';
import { draftMailTemplate, MailTemplateDraftError } from './template-draft.js';
import { conditionSetAsRead, type MailFactSourceEmail } from './rules-pass.js';
import type { RecipeMailTemplates } from './recipe-templates.js';

const DAY_MS = 86_400_000;

/** The stored mail, as the screens need it. */
export interface MailFactMailAccess {
  /** The stored email, or `null` once it is gone (or its mailbox is). */
  get(slug: string, record_id: string): CollectionRecord | null;
  /** Its body text, inline or from the blob store; `null` when unreadable. */
  body(record: CollectionRecord): Promise<string | null>;
  /** The days its mailbox keeps mail (§5.3); `null` when the mailbox is gone. */
  retentionDays(slug: string): number | null;
}

export interface MailFactRpcDeps {
  readonly store: MailFactStore;
  /** Absent ⇒ list rows carry no email, and `mail_fact.email.get` answers
   *  `not_configured`. */
  readonly mail?: MailFactMailAccess;
  /** A run's status now, from the run log; `null` once it is gone. */
  readonly runStatusOf?: (run_id: string) => Promise<RunAnchorStatus | null>;
  /** An installed recipe's name. */
  readonly recipeNameOf?: (recipe_id: string) => string | null;
  /** A template or a standards switch changed: every paired Templates view
   *  refreshes. Must not throw. */
  readonly onTemplatesChanged?: () => void;
  /** Facts went outside the writer (a deleted kind of email took its own):
   *  every paired Facts view refreshes. Must not throw. */
  readonly onFactsChanged?: () => void;
  /** The template editor's reads (§6.1, §6.2) and Senders without a template
   *  (§6.5), over the mailboxes. Absent ⇒ they answer `not_configured`. */
  readonly editor?: TemplatePreviewDeps;
  readonly now?: () => number;
  /** Backfill (§6.3). Absent ⇒ its calls answer `not_configured`. */
  readonly backfill?: MailFactBackfill;
  /** Draft with AI (§6.1): one model call through the chat's privacy layer.
   *  Absent ⇒ it answers `not_configured`. */
  readonly draftCall?: MailFactAiCall;
  /** Switch off the rows made on this server that `match` names: a trigger
   *  narrowed to a template or kind that was deleted could never fire. */
  readonly switchOffTriggers?: (match: (trigger: EventTrigger) => boolean) => Promise<number>;
  /** §5.2 — the templates recipes bring: "Duplicate to edit" re-points the
   *  recipe settings that held the original. Absent ⇒ it answers
   *  `not_configured`. */
  readonly recipeTemplates?: Pick<RecipeMailTemplates, 'duplicate'>;
}

type Methods =
  | 'mail_fact.template.list'
  | 'mail_fact.template.get'
  | 'mail_fact.template.create'
  | 'mail_fact.template.update'
  | 'mail_fact.template.delete'
  | 'mail_fact.template.duplicate'
  | 'mail_fact.template.starter'
  | 'mail_fact.standards.get'
  | 'mail_fact.standards.set'
  | 'mail_fact.facts.list'
  | 'mail_fact.email.get'
  | 'mail_fact.email.read'
  | 'mail_fact.template.preview'
  | 'mail_fact.template.draft'
  | 'mail_fact.type.list'
  | 'mail_fact.type.create'
  | 'mail_fact.type.update'
  | 'mail_fact.type.delete'
  | 'mail_fact.senders.list'
  | 'mail_fact.senders.dismiss'
  | 'mail_fact.backfill.start'
  | 'mail_fact.backfill.get'
  | 'mail_fact.backfill.cancel';

/** The screens' methods read email bodies, send an email to the AI and change
 *  what every email is read for: the owner's webclient only, as recipe tests
 *  and pre-approvals are — never a Bridge, the CLI or MCP. */
const requireClient = (client: WsClient): void => {
  if (!client.instance_id || client.client_kind !== 'webclient') {
    throw new RpcError('unauthorized', 'Mail templates require a paired webclient.', 401);
  }
};

const requireTemplateId = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RpcError('bad_request', 'template_id is required', 400);
  }
  return value.trim();
};

/** §4.5 — an owner type as sent, rebuilt from the fields a type has: nothing
 *  else is stored. The shape is then checked by `validateMailFactCustomType`. */
const typeSpecFrom = (raw: unknown): MailFactTypeSpec => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcError('bad_request', 'spec is the kind of email to save', 400);
  }
  const r = raw as Record<string, unknown>;
  // An entry of the wrong shape is a problem to name, never one to drop: a
  // kind saved without it would not be the kind the owner made.
  const problems: string[] = [];
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const list = (value: unknown, at: string): unknown[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      problems.push(`${at} must be a list`);
      return [];
    }
    return value;
  };
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const words = (value: unknown, at: string): string[] => list(value, at).flatMap((item, i) => {
    if (typeof item === 'string') return [item];
    problems.push(`${at}[${i}] must be a word`);
    return [];
  });
  const optionalText = (value: unknown, at: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      problems.push(`${at} must be text`);
      return undefined;
    }
    return value.trim().length > 0 ? value.trim() : undefined;
  };
  const variables = list(r.variables, 'variables').flatMap((variable, i) => {
    const at = `variables[${i}]`;
    if (!isRecord(variable) || typeof variable.name !== 'string' || typeof variable.kind !== 'string'
      || typeof variable.required !== 'boolean') {
      problems.push(`${at} must have a name, a kind and whether it is needed`);
      return [];
    }
    const description = optionalText(variable.description, `${at}.description`);
    return [{
      name: variable.name,
      kind: variable.kind as MailFactTypeSpec['variables'][number]['kind'],
      required: variable.required,
      ...(variable.values !== undefined ? { values: words(variable.values, `${at}.values`) } : {}),
      ...(description !== undefined ? { description } : {}),
    }];
  });
  const identity = list(r.identity, 'identity').flatMap((alternative, i) => {
    const names = words(alternative, `identity[${i}]`);
    if (names.length === 0) {
      problems.push(`identity[${i}] must name at least one variable`);
      return [];
    }
    return [names];
  });
  const dataFields = r.data_fields === undefined ? undefined : list(r.data_fields, 'data_fields').flatMap((field, i) => {
    const at = `data_fields[${i}]`;
    if (!isRecord(field) || typeof field.path !== 'string' || typeof field.kind !== 'string') {
      problems.push(`${at} must have a path and a kind`);
      return [];
    }
    const description = optionalText(field.description, `${at}.description`);
    return [{
      path: field.path,
      kind: field.kind as NonNullable<MailFactTypeSpec['data_fields']>[number]['kind'],
      ...(description !== undefined ? { description } : {}),
    }];
  });
  const spec: MailFactTypeSpec = {
    id: text(r.id) as MailFactTypeSpec['id'],
    name: text(r.name).trim(),
    description: text(r.description).trim(),
    variables,
    states: words(r.states, 'states'),
    notices: words(r.notices, 'notices'),
    identity,
    ...(dataFields !== undefined ? { data_fields: dataFields } : {}),
  };
  if (problems.length > 0) {
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
    throw new RpcError('bad_request', `The kind cannot be saved: ${problems[0]}${more}`, 400, undefined, { problems });
  }
  return spec;
};

/** A name another kind of email already has, built-in or the owner's. */
const nameTaken = (store: MailFactStore, spec: MailFactTypeSpec): string | null => {
  const wanted = spec.name.trim().toLowerCase();
  const other = [...MAIL_FACT_BUILTIN_TYPES, ...store.listCustomTypes()]
    .find((type) => type.id !== spec.id && type.name.trim().toLowerCase() === wanted);
  return other === undefined ? null : other.name;
};

const specOf = (store: MailFactStore, type: unknown): MailFactTypeSpec | undefined =>
  typeof type === 'string' ? getMailFactBuiltinType(type) ?? store.getCustomType(type) ?? undefined : undefined;

/** The definition, checked against its type. */
const checkedDefinition = (store: MailFactStore, definition: unknown): MailTemplateDefinition => {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new RpcError('bad_request', 'definition must be an object', 400);
  }
  const candidate = definition as MailTemplateDefinition;
  const spec = specOf(store, candidate.type);
  const problems = validateMailTemplateDefinition(candidate, spec);
  if (problems.length > 0) {
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
    throw new RpcError('bad_request', `The template cannot be saved: ${problems[0]}${more}`, 400, undefined, {
      problems,
    });
  }
  // Only what a template has, at any depth: a client's extra keys are not stored.
  return mailTemplateDefinitionOf(candidate);
};

/** Ruling 31: refuse to make a second active template of one type and one set
 *  of conditions. */
const assertNoActiveTwin = (
  store: MailFactStore,
  definition: MailTemplateDefinition,
  self: string | null,
): void => {
  const key = conditionSetAsRead(definition.entrance.conditions);
  const twin = store
    .listTemplates({ type: definition.type, active: true })
    .find((template: MailTemplate) =>
      template.template_id !== self && conditionSetAsRead(template.entrance.conditions) === key);
  if (twin !== undefined) {
    throw new RpcError(
      'conflict',
      `'${twin.name}' already reads ${definition.type} facts from mail with these conditions — switch it off first, or change the conditions`,
      409,
      undefined,
      { template_id: twin.template_id },
    );
  }
};

/** §5.2 — what a template a recipe brought lets its owner change: whether the
 *  AI is on, and its pool. The rest is the recipe's, re-applied by its updates. */
const recipeOwnedPart = (definition: MailTemplateDefinition): string => {
  const { ai, ...rest } = mailTemplateDefinitionOf(definition);
  return JSON.stringify({ ...rest, ai: { prompt: ai.prompt ?? null, slots: ai.slots ?? null } });
};

/** §5.2 — a sender the owner knows, whom a starter must not name: someone in
 *  their family, work or social network (`NETWORK_DOMAINS`). A shop is none. */
const PERSONAL_RELATIONSHIPS: ReadonlySet<string> = new Set(['family', 'work', 'social']);

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const emailRefOf = (value: unknown, name: string): MailFactEmailRef => {
  const ref = value as { slug?: unknown; record_id?: unknown } | null | undefined;
  if (ref === null || typeof ref !== 'object' || !nonEmptyString(ref.slug) || !nonEmptyString(ref.record_id)) {
    throw new RpcError('bad_request', `${name} needs a mailbox slug and a record_id`, 400);
  }
  return { slug: ref.slug, record_id: ref.record_id };
};

const cursorOf = (value: unknown): MailFactRowsCursor => {
  const cursor = value as { email_at?: unknown; slug?: unknown; record_id?: unknown } | null;
  if (
    cursor === null
    || typeof cursor !== 'object'
    || typeof cursor.email_at !== 'number'
    || !Number.isFinite(cursor.email_at)
    || !nonEmptyString(cursor.slug)
    || !nonEmptyString(cursor.record_id)
  ) {
    throw new RpcError('bad_request', 'before must be the next_cursor of the page before', 400);
  }
  return { email_at: cursor.email_at, slug: cursor.slug, record_id: cursor.record_id };
};

/** `mail_fact.facts.list`'s arguments, checked. */
const pageQueryOf = (args: unknown): MailFactPageQuery => {
  if (args === undefined || args === null) return { limit: MAIL_FACT_ROWS_DEFAULT_EMAILS };
  if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError('bad_request', 'the query must be an object', 400);
  const raw = args as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (!nonEmptyString(value)) throw new RpcError('bad_request', `${key} must be a non-empty string`, 400);
    return value;
  };
  const flag = (key: string): boolean | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new RpcError('bad_request', `${key} must be true or false`, 400);
    return value;
  };
  let limit = MAIL_FACT_ROWS_DEFAULT_EMAILS;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1) {
      throw new RpcError('bad_request', 'limit must be a positive whole number', 400);
    }
    limit = Math.min(raw.limit, MAIL_FACT_ROWS_MAX_EMAILS);
  }
  const templateId = raw.template_id === null ? null : text('template_id');
  const type = text('type');
  const state = text('state');
  const notice = text('notice');
  const complete = flag('complete');
  const unpaired = flag('unpaired');
  const hasRun = flag('has_run');
  return {
    limit,
    ...(type !== undefined ? { type } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(notice !== undefined ? { notice } : {}),
    ...(templateId !== undefined ? { template_id: templateId } : {}),
    ...(complete !== undefined ? { complete } : {}),
    ...(unpaired !== undefined ? { unpaired } : {}),
    ...(hasRun !== undefined ? { has_run: hasRun } : {}),
    ...(raw.email !== undefined ? { email: emailRefOf(raw.email, 'email') } : {}),
    ...(raw.before !== undefined ? { before: cursorOf(raw.before) } : {}),
  };
};

/** A preview's source: a stored email, or a pasted sample within its bounds. */
const previewSourceOf = (value: unknown): PreviewSource | undefined => {
  if (value === undefined || value === null) return undefined;
  const raw = value as { email?: unknown; sample?: unknown };
  if (typeof raw !== 'object') throw new RpcError('bad_request', 'source is an email or a sample', 400);
  if (raw.email !== undefined) return { email: emailRefOf(raw.email, 'source.email') };
  const sample = raw.sample as Record<string, unknown> | undefined;
  if (sample === undefined || sample === null || typeof sample !== 'object') {
    throw new RpcError('bad_request', 'source is an email or a sample', 400);
  }
  const part = (key: 'from' | 'subject' | 'body' | 'html', max: number, required: boolean): string | undefined => {
    const text = sample[key];
    if (text === undefined && !required) return undefined;
    if (typeof text !== 'string') throw new RpcError('bad_request', `sample.${key} must be text`, 400);
    if (text.length > max) throw new RpcError('bad_request', `sample.${key} is longer than ${max} characters`, 400);
    return text;
  };
  const html = part('html', MAIL_TEMPLATE_SAMPLE_MAX_CHARS.html, false);
  return {
    sample: {
      from: part('from', 1_000, true)!,
      subject: part('subject', MAIL_TEMPLATE_SAMPLE_MAX_CHARS.subject, true)!,
      body: part('body', MAIL_TEMPLATE_SAMPLE_MAX_CHARS.body, true)!,
      ...(html !== undefined ? { html } : {}),
    },
  };
};

const hotText = (record: CollectionRecord, key: string): string => {
  const value = record.hot_fields[key];
  return typeof value === 'string' ? value : '';
};

export const makeMailFactRpcHandlers = (
  deps: MailFactRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, Methods, WsClient> | undefined => {
  if (deps === undefined) return undefined;
  const { store } = deps;

  const templatesChanged = (): void => {
    try {
      deps.onTemplatesChanged?.();
    } catch {
      /* best-effort: the change is stored */
    }
  };

  const requireBackfill = (): MailFactBackfill => {
    if (deps.backfill === undefined) throw new RpcError('not_configured', 'Mail is not set up on this server.', 503);
    return deps.backfill;
  };

  const requireEditor = (): TemplatePreviewDeps => {
    if (deps.editor === undefined) throw new RpcError('not_configured', 'Mail is not set up on this server.', 503);
    return deps.editor;
  };

  const emailSummaryOf = (ref: MailFactEmailRef): MailFactEmailSummary | null => {
    const record = deps.mail?.get(ref.slug, ref.record_id) ?? null;
    if (record === null) return null;
    const days = deps.mail?.retentionDays(ref.slug) ?? null;
    return {
      slug: ref.slug,
      record_id: ref.record_id,
      from: hotText(record, 'from'),
      subject: hotText(record, 'subject'),
      at: record.received_at,
      ...(days !== null && days > 0 ? { goes_at: record.received_at + days * DAY_MS } : {}),
    };
  };

  /** Each page read looks a run's status and a recipe's name up once. */
  const runReader = () => {
    const statuses = new Map<string, Promise<RunAnchorStatus | null>>();
    const names = new Map<string, string | null>();
    return async (link: MailFactRunLink): Promise<MailFactRun> => {
      if (!names.has(link.recipe_id)) names.set(link.recipe_id, deps.recipeNameOf?.(link.recipe_id) ?? null);
      const name = names.get(link.recipe_id) ?? null;
      let status: RunAnchorStatus | null = null;
      if (link.run_id !== undefined && deps.runStatusOf !== undefined) {
        const runId = link.run_id;
        if (!statuses.has(runId)) statuses.set(runId, deps.runStatusOf(runId).catch(() => null));
        status = await statuses.get(runId)!;
      }
      return {
        trigger_id: link.trigger_id,
        recipe_id: link.recipe_id,
        ...(name !== null ? { recipe_name: name } : {}),
        ...(link.run_id !== undefined ? { run_id: link.run_id } : {}),
        outcome: link.outcome,
        ...(status !== null ? { status } : {}),
        at: link.at,
      };
    };
  };

  return {
    methods: [
      'mail_fact.template.list',
      'mail_fact.template.get',
      'mail_fact.template.create',
      'mail_fact.template.update',
      'mail_fact.template.delete',
      'mail_fact.template.duplicate',
      'mail_fact.template.starter',
      'mail_fact.standards.get',
      'mail_fact.standards.set',
      'mail_fact.facts.list',
      'mail_fact.email.get',
      'mail_fact.email.read',
      'mail_fact.template.preview',
      'mail_fact.template.draft',
      'mail_fact.type.list',
      'mail_fact.type.create',
      'mail_fact.type.update',
      'mail_fact.type.delete',
      'mail_fact.senders.list',
      'mail_fact.senders.dismiss',
      'mail_fact.backfill.start',
      'mail_fact.backfill.get',
      'mail_fact.backfill.cancel',
    ],
    handlers: {
      'mail_fact.template.list': async (args, client) => {
        requireClient(client);
        const type = args?.type;
        if (type !== undefined && (typeof type !== 'string' || type.length === 0)) {
          throw new RpcError('bad_request', 'type must be a mail fact type', 400);
        }
        return { templates: store.listTemplates(type !== undefined ? { type } : {}) };
      },
      'mail_fact.template.get': async (args, client) => {
        requireClient(client);
        return { template: store.getTemplate(requireTemplateId(args?.template_id)) };
      },
      'mail_fact.template.create': async (args, client) => {
        requireClient(client);
        const definition = checkedDefinition(store, args?.definition);
        const active = args?.active ?? true;
        if (typeof active !== 'boolean') throw new RpcError('bad_request', 'active must be true or false', 400);
        if (active) assertNoActiveTwin(store, definition, null);
        const template = store.createTemplate({ definition, origin: { kind: 'owner' }, active });
        templatesChanged();
        return { template };
      },
      'mail_fact.template.update': async (args, client) => {
        requireClient(client);
        const templateId = requireTemplateId(args?.template_id);
        const existing = store.getTemplate(templateId);
        if (existing === null) throw new RpcError('not_found', `No mail template '${templateId}'.`, 404);
        const definition = args?.definition === undefined ? undefined : checkedDefinition(store, args.definition);
        if (definition !== undefined && definition.type !== existing.type) {
          throw new RpcError('bad_request', 'A template keeps its type — make a new template for another type', 400);
        }
        // §5.2 — a recipe's template: its rules are the recipe's, re-applied by
        // each update; the owner switches it and its AI on or off, and picks the pool.
        if (definition !== undefined && existing.origin.kind === 'recipe'
          && recipeOwnedPart(definition) !== recipeOwnedPart(existing)) {
          const recipe = deps.recipeNameOf?.(existing.origin.recipe) ?? existing.origin.recipe;
          throw new RpcError(
            'conflict',
            `“${existing.name}” comes with the recipe ${recipe}: its rules update with the recipe. Duplicate it to edit.`,
            409,
            undefined,
            { recipe_id: existing.origin.recipe },
          );
        }
        const active = args?.active;
        if (active !== undefined && typeof active !== 'boolean') {
          throw new RpcError('bad_request', 'active must be true or false', 400);
        }
        const willBeActive = active ?? existing.active;
        if (willBeActive) assertNoActiveTwin(store, definition ?? existing, templateId);
        const updated = store.updateTemplate(templateId, {
          ...(definition !== undefined ? { definition } : {}),
          ...(active !== undefined ? { active } : {}),
        });
        if (updated === null) throw new RpcError('not_found', `No mail template '${templateId}'.`, 404);
        templatesChanged();
        return { template: updated };
      },
      'mail_fact.template.delete': async (args, client) => {
        requireClient(client);
        const templateId = requireTemplateId(args?.template_id);
        const existing = store.getTemplate(templateId);
        if (existing?.origin.kind === 'recipe') {
          const recipe = deps.recipeNameOf?.(existing.origin.recipe) ?? existing.origin.recipe;
          throw new RpcError(
            'conflict',
            `“${existing.name}” comes with the recipe ${recipe} and goes with it. Switch it off instead, or uninstall the recipe.`,
            409,
            undefined,
            { recipe_id: existing.origin.recipe },
          );
        }
        const deleted = store.deleteTemplate(templateId);
        if (deleted) {
          templatesChanged();
          // A "Then run…" row narrowed to it would wait forever.
          await deps.switchOffTriggers?.((trigger) => trigger.filter?.['record.template'] === templateId);
        }
        return { deleted };
      },
      'mail_fact.template.duplicate': async (args, client) => {
        requireClient(client);
        const templateId = requireTemplateId(args?.template_id);
        if (deps.recipeTemplates === undefined) {
          throw new RpcError('not_configured', 'Recipes are not set up on this server.', 503);
        }
        const template = deps.recipeTemplates.duplicate(templateId);
        if (template === null) throw new RpcError('not_found', `No mail template '${templateId}'.`, 404);
        return { template };
      },
      'mail_fact.template.starter': async (args, client) => {
        requireClient(client);
        const templateId = requireTemplateId(args?.template_id);
        const template = store.getTemplate(templateId);
        if (template === null) throw new RpcError('not_found', `No mail template '${templateId}'.`, 404);
        // Only what a template is: its ids, health and times stay here.
        const starter = mailTemplateDefinitionOf(template);
        // What only this server knows: the owner's own addresses, and the
        // senders they know (someone in their family, work or social network).
        const words = (deps.editor?.mailboxes() ?? [])
          .map((mailbox) => mailbox.accountEmail)
          .filter((address) => address.trim().length > 0);
        const knows = (address: string): boolean =>
          (deps.editor?.relationshipsOf?.(address.trim().toLowerCase()) ?? [])
            .some((relationship) => PERSONAL_RELATIONSHIPS.has(relationship));
        const senders = starter.entrance.conditions
          .filter((condition) => condition.field === 'from' && condition.op === 'is' && knows(condition.value))
          .map((condition) => condition.value);
        const problems = mailTemplateStarterProblems(starter, { words, senders });
        if (problems.length > 0) {
          const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
          throw new RpcError('bad_request', `This template cannot travel in a recipe: ${problems[0]}${more}`, 400, undefined, {
            problems,
          });
        }
        return { starter };
      },
      'mail_fact.type.list': async (_args, client) => {
        requireClient(client);
        return { types: store.listCustomTypes() };
      },
      'mail_fact.type.create': async (args, client) => {
        requireClient(client);
        const spec = typeSpecFrom(args?.spec);
        const problems = validateMailFactCustomType(spec);
        if (problems.length > 0) {
          throw new RpcError('bad_request', `The kind of email cannot be saved: ${problems[0]}`, 400, undefined, { problems });
        }
        if (store.getCustomType(spec.id) !== null) {
          throw new RpcError('conflict', `A kind of email with the id '${spec.id}' exists; give it another name.`, 409);
        }
        const taken = nameTaken(store, spec);
        if (taken !== null) throw new RpcError('conflict', `A kind of email is already called “${taken}”.`, 409);
        store.saveCustomType(spec);
        templatesChanged();
        return { type: store.getCustomType(spec.id)! };
      },
      'mail_fact.type.update': async (args, client) => {
        requireClient(client);
        const spec = typeSpecFrom(args?.spec);
        const before = store.getCustomType(spec.id);
        if (before === null) throw new RpcError('not_found', 'That kind of email no longer exists.', 404);
        const kept = new Set(before.variables.map((variable) => variable.name));
        const problems = [...validateMailFactCustomType(spec, { kept }), ...validateMailFactTypeChange(before, spec)];
        if (problems.length > 0) {
          throw new RpcError('bad_request', `The kind of email cannot be saved: ${problems[0]}`, 400, undefined, { problems });
        }
        const taken = nameTaken(store, spec);
        if (taken !== null) throw new RpcError('conflict', `A kind of email is already called “${taken}”.`, 409);
        // What tells one thing from another cannot change, and one sent in
        // another order is the same (checked above): it is kept as saved,
        // since a thing's keys name its variables in that order.
        store.saveCustomType({ ...spec, identity: before.identity });
        templatesChanged();
        return { type: store.getCustomType(spec.id)! };
      },
      'mail_fact.type.delete': async (args, client) => {
        requireClient(client);
        const typeId = typeof args?.type_id === 'string' ? args.type_id : '';
        if (store.getCustomType(typeId) === null) throw new RpcError('not_found', 'That kind of email no longer exists.', 404);
        const readers = store.listTemplates({ type: typeId });
        if (readers.length > 0) {
          throw new RpcError(
            'conflict',
            `Templates still read this kind of email: ${readers.map((template) => `“${template.name}”`).join(', ')}. Delete them first.`,
            409,
          );
        }
        const deleted = store.deleteCustomType(typeId);
        templatesChanged();
        // A row on this kind alone would wake again if a kind of that id came back.
        await deps.switchOffTriggers?.((trigger) => trigger.pattern === mailFactEventPattern(typeId));
        try {
          deps.onFactsChanged?.();
        } catch {
          /* best-effort: the type is gone */
        }
        return { deleted };
      },
      'mail_fact.standards.get': async (_args, client) => {
        requireClient(client);
        const off = store.standardsOff();
        return { standards: MAIL_FACT_STANDARDS_TYPES.map((type) => ({ type, on: !off.has(type) })) };
      },
      'mail_fact.standards.set': async (args, client) => {
        requireClient(client);
        const type = args?.type;
        if (!isMailFactStandardsType(type)) {
          throw new RpcError('bad_request', `type is one of ${MAIL_FACT_STANDARDS_TYPES.join(', ')}`, 400);
        }
        if (typeof args?.on !== 'boolean') throw new RpcError('bad_request', 'on must be true or false', 400);
        store.setStandardsOn(type, args.on);
        templatesChanged();
        return { type, on: args.on };
      },
      'mail_fact.facts.list': async (args, client) => {
        requireClient(client);
        const page = store.listFactPage(pageQueryOf(args));
        const things = new Map<string, MailFactThing | null>();
        const thingOf = (thing_id: string): MailFactThing | null => {
          if (!things.has(thing_id)) things.set(thing_id, store.getThing(thing_id));
          return things.get(thing_id) ?? null;
        };
        const readRun = runReader();
        const rows: MailFactRow[] = [];
        for (const { email, facts } of page.emails) {
          // "1 of 3 from this email" counts every fact of it, filtered or not.
          const all = store.factsForEmail(email);
          const place = new Map(all.map((fact, index) => [fact.fact_id, index + 1]));
          const links = store.runsForEmail(email);
          const summary = emailSummaryOf(email);
          const removed = summary === null && deps.mail !== undefined && deps.mail.retentionDays(email.slug) === null;
          for (const fact of facts) {
            const runs = fact.thing_id === null
              ? []
              : await Promise.all(links.filter((link) => link.thing_id === fact.thing_id).map(readRun));
            rows.push({
              fact,
              email: summary,
              ...(removed ? { mailbox_removed: true as const } : {}),
              thing: fact.thing_id === null ? null : thingOf(fact.thing_id),
              of_email: { index: place.get(fact.fact_id) ?? 1, count: Math.max(all.length, 1) },
              runs,
            });
          }
        }
        const last = page.emails[page.emails.length - 1];
        return {
          rows,
          ...(page.more && last !== undefined
            ? { next_cursor: { email_at: last.email_at, slug: last.email.slug, record_id: last.email.record_id } }
            : {}),
        };
      },
      'mail_fact.email.get': async (args, client) => {
        requireClient(client);
        const email = emailRefOf(args, 'The email');
        if (deps.mail === undefined) {
          throw new RpcError('not_configured', 'Mail is not set up on this server.', 503);
        }
        const record = deps.mail.get(email.slug, email.record_id);
        if (record === null) {
          throw new RpcError(
            'not_found',
            deps.mail.retentionDays(email.slug) === null
              ? 'That email’s mailbox was removed from this server.'
              : 'That email is no longer stored.',
            404,
          );
        }
        const body = (await deps.mail.body(record)) ?? '';
        return {
          fact_count: store.factsForEmail(email).length,
          security_notice: looksLikeSecurityNoticeText(hotText(record, 'subject'), body),
        };
      },
      'mail_fact.email.read': async (args, client) => {
        requireClient(client);
        const ref = emailRefOf(args, 'The email');
        const editor = requireEditor();
        const mailbox = editor.mailboxes().find((candidate) => candidate.slug === ref.slug);
        const stored = mailbox === undefined ? null : await readStoredEmail(editor, mailbox, ref.record_id);
        if (stored === null) throw new RpcError('not_found', 'That email is no longer stored.', 404);
        if (looksLikeSecurityNotice(stored.email)) {
          throw new RpcError(
            'forbidden',
            'This email looks like a security notice (a sign-in code or a password reset). Recued reads nothing from those.',
            403,
          );
        }
        const max = MAIL_FACT_EMAIL_CONTENT_MAX_CHARS;
        const { email } = stored;
        const truncated = email.body_text.length > max || (email.html?.length ?? 0) > max;
        return {
          email: summaryOf(editor, ref.slug, stored.record),
          from_name: email.from_name,
          body_text: email.body_text.slice(0, max),
          ...(email.html !== null ? { html: email.html.slice(0, max) } : {}),
          labels: email.labels,
          attachments: email.attachments.map(({ filename, mime_type }) => ({ filename, mime_type })),
          read: stored.read,
          ...(truncated ? { truncated: true as const } : {}),
        };
      },
      'mail_fact.template.preview': async (args, client) => {
        requireClient(client);
        const definition = checkedDefinition(store, args?.definition);
        const spec = specOf(store, definition.type);
        if (spec === undefined) throw new RpcError('bad_request', `'${definition.type}' is not a mail fact type`, 400);
        const source = previewSourceOf(args?.source);
        let limit = MAIL_TEMPLATE_PREVIEW_DEFAULT_LIMIT;
        if (args?.limit !== undefined) {
          if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 0) {
            throw new RpcError('bad_request', 'limit must be a whole number, 0 or more', 400);
          }
          limit = Math.min(args.limit, MAIL_TEMPLATE_PREVIEW_MAX_LIMIT);
        }
        try {
          return await previewTemplate(requireEditor(), definition, spec, source, limit);
        } catch (error) {
          if (error instanceof MailPreviewSecurityNotice) throw new RpcError('forbidden', error.message, 403);
          throw error;
        }
      },
      'mail_fact.template.draft': async (args, client) => {
        requireClient(client);
        if (deps.draftCall === undefined) {
          throw new RpcError('not_configured', 'Drafting with AI is not set up on this server.', 503);
        }
        const source = previewSourceOf(args?.source);
        if (source === undefined) throw new RpcError('bad_request', 'source is the email to draft from', 400);
        let type: MailFactTypeSpec | undefined;
        if (args?.type !== undefined) {
          type = specOf(store, args.type);
          if (type === undefined) throw new RpcError('bad_request', `'${String(args.type)}' is not a mail fact type`, 400);
        }
        const editor = requireEditor();
        let email: MailFactSourceEmail;
        if ('sample' in source) {
          email = sampleEmail(editor, source.sample);
        } else {
          const mailbox = editor.mailboxes().find((candidate) => candidate.slug === source.email.slug);
          const stored = mailbox === undefined ? null : await readStoredEmail(editor, mailbox, source.email.record_id);
          if (stored === null) throw new RpcError('not_found', 'That email is no longer stored.', 404);
          email = stored.email;
        }
        if (looksLikeSecurityNotice(email)) {
          throw new RpcError(
            'forbidden',
            'This email looks like a security notice (a sign-in code or a password reset). Recued reads nothing from those.',
            403,
          );
        }
        try {
          return await draftMailTemplate(
            deps.draftCall,
            { email, ...(type !== undefined ? { type } : { types: [...MAIL_FACT_BUILTIN_TYPES, ...store.listCustomTypes()] }) },
            (candidate) => specOf(store, candidate),
            (deps.now ?? Date.now)(),
          );
        } catch (error) {
          if (error instanceof MailTemplateDraftError) throw new RpcError('unprocessable', error.message, 422);
          throw new RpcError('unavailable', `The AI could not draft it: ${mailFactAiFailure(error)}.`, 503);
        }
      },
      'mail_fact.senders.list': async (args, client) => {
        requireClient(client);
        let limit = MAIL_FACT_SENDERS_DEFAULT_LIMIT;
        if (args?.limit !== undefined) {
          if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1) {
            throw new RpcError('bad_request', 'limit must be a positive whole number', 400);
          }
          limit = Math.min(args.limit, MAIL_FACT_SENDERS_MAX_LIMIT);
        }
        const editor = requireEditor();
        return listSendersWithoutTemplate({ ...editor, store, now: deps.now ?? Date.now }, limit);
      },
      'mail_fact.senders.dismiss': async (args, client) => {
        requireClient(client);
        const address = typeof args?.address === 'string' ? args.address.trim().toLowerCase() : '';
        if (address.length === 0 || address.length > 320) {
          throw new RpcError('bad_request', 'address is the sender to dismiss', 400);
        }
        if (typeof args?.dismissed !== 'boolean') throw new RpcError('bad_request', 'dismissed must be true or false', 400);
        store.setSenderDismissed(address, args.dismissed);
        templatesChanged();
        return { address, dismissed: args.dismissed };
      },
      'mail_fact.backfill.start': async (args, client) => {
        requireClient(client);
        const backfill = requireBackfill();
        const templateId = requireTemplateId(args?.template_id);
        if (typeof args?.days !== 'number') throw new RpcError('bad_request', 'days is how far back to read', 400);
        if (args.run_recipes !== undefined && typeof args.run_recipes !== 'boolean') {
          throw new RpcError('bad_request', 'run_recipes must be true or false', 400);
        }
        try {
          return backfill.start({
            template_id: templateId,
            days: args.days,
            ...(args.run_recipes !== undefined ? { run_recipes: args.run_recipes } : {}),
          });
        } catch (error) {
          if (!(error instanceof MailFactBackfillError)) throw error;
          throw new RpcError(error.code, error.message, error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400);
        }
      },
      'mail_fact.backfill.get': async (_args, client) => {
        requireClient(client);
        return requireBackfill().state();
      },
      'mail_fact.backfill.cancel': async (args, client) => {
        requireClient(client);
        const jobId = typeof args?.job_id === 'string' ? args.job_id : '';
        const job = requireBackfill().cancel(jobId);
        if (job === null) throw new RpcError('not_found', 'No such backfill.', 404);
        return job;
      },
    },
  };
};

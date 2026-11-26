import type { IngredientDraftSummary, KitchenImportDraft, KitchenWorkBase, KitchenWorkItem, RecipeDefinition } from '@recued/contracts';
import { validateRecipe } from '@recued/recipes';
import { validatePack } from '@recued/ingredient-authoring';

/** The source an AI app hands over, written out rather than read from `community/`: this folder
 *  ships with the public repo, which carries none of the marketplace, and the public export
 *  refuses a `community/` import from anything but a test. The recipe is the shipped
 *  `send-composed-mail` (public as a foundation recipe); the pack is invented, shaped like a
 *  mail pack. */
const recipe = {
  recipe_id: 'send-composed-mail', chat_exposed: true, version: 2, ttl: 0,
  metadata: {
    name: 'Send a composed email',
    description: "Use “Send a composed email” in Recued. Sends one email, written in full, from one of the owner's enrolled mailboxes. Sending is irreversible, so it stops at the approval gate first, and the approval names the recipients, the subject, and every attached file. Attachments travel as references to files the owner already holds, never as bytes.",
    author: 'recued-core', supported_platforms: [], budget_ms: 30000, tags: ['mail', 'compose', 'send', 'outbound'],
  },
  requires: ['mail_send'],
  variables: {
    sender_mail_instance: { label: 'Send from', type: 'string', default: '', help: 'The mailbox to send from, by its name on this server.' },
    to: { label: 'To', type: 'array', default: [], help: 'Email addresses to send to.' },
    cc: { label: 'Cc', type: 'array', default: [] },
    bcc: { label: 'Bcc', type: 'array', default: [] },
    subject: { label: 'Subject', type: 'string', default: '' },
    body: { label: 'Message', type: 'text', default: '' },
    body_format: { label: 'Body format', type: 'string', default: 'text' },
    attachments: { label: 'Attachments', type: 'file_ref[]', default: [], help: 'Files to attach, by their file ids. The approval names each one.' },
    in_reply_to: { label: 'In reply to', type: 'string', default: '' },
    reply_to: { label: 'Reply to', type: 'string', default: '' },
    reconciliation_id: { label: 'Delivery reference', type: 'string', default: null,
      help: 'Optional. Lets a retry of a send to one recipient be checked instead of repeated; leave it empty for a send to several.' },
    references: { label: 'Thread references', type: 'array', default: [] },
  },
  prefetch_steps: [],
  steps: [{ id: 'send', op: 'core.mail.send', args: {
    sender_mail_instance: '{{config.sender_mail_instance}}', to: '{{config.to}}', cc: '{{config.cc}}', bcc: '{{config.bcc}}',
    subject: '{{config.subject}}', body: '{{config.body}}', body_format: '{{config.body_format}}',
    in_reply_to: '{{config.in_reply_to}}', reply_to: '{{config.reply_to}}', reconciliation_id: '{{config.reconciliation_id}}',
    references: '{{config.references}}', attachments: '{{config.attachments}}',
  } }],
  output: { render: [{ type: 'summary', source: 'step.send' }] },
};
const pack = {
  manifest_version: 2, slug: 'postbox', publisher: 'postbox-inc', name: 'Postbox',
  description: 'Send and look up mail through Postbox.', version: 1, recipes: [], requires: ['install_bulk_pack'],
  tags: ['mail'], pack_kind: 'app_pack', contents: [{ type: 'composition', composition: {
    schema_version: 1, slug: 'postbox', catalog_kind: 'official',
    ingredients: [{ slug: 'postbox', kind: 'http', http: { base: 'https://api.postbox.example', connection: 'postbox' } }],
    operations: [
      { op: 'message.send', ingredient: 'postbox', risk: 'write', approval: 'always',
        bind: { kind: 'rest', method: 'POST', path_template: '/v1/messages' } },
      { op: 'message.read', ingredient: 'postbox', risk: 'read', approval: 'never',
        bind: { kind: 'rest', method: 'GET', path_template: '/v1/messages/{message_id}' } },
    ],
  } }],
};

/** D-402 slice C5 — `?kitchen_import=trial`: a draft Recued compiled from a browser job, with a setting
 *  the request gave (`query`) and the browser the job ran in (`browser`, a bare setting). "Try it" is held
 *  at its first change. The spec answers for the owner elsewhere (`TRIAL_ANSWER_KEY` in this tab's
 *  sessionStorage: `approved` or `denied`), then broadcasts the run's event, as the server does. The
 *  server's side is `backend/server/src/__tests__/d-402-trial-run.test.ts`. */
export const TRIAL_ANSWER_KEY = 'recued-test-kitchen-trial-answer';
export const TRIAL_RUN_ID = 'run-trial-1';
export const TRIAL_TRIES_KEY = 'recued-test-kitchen-trial-tries';
const TRIAL_ACTION_REF = 'act-trial-1';
const trialRecipe = {
  recipe_id: 'shop-search-draft', version: 1, ttl: 0,
  metadata: { name: 'Shop search', description: 'Looks a book up on the shop.', author: 'you', supported_platforms: [] },
  variables: { query: { label: 'Search for', type: 'text', default: 'Grace Hopper' }, browser: 'b-home' },
  prefetch_steps: [],
  steps: [{ id: 'search', op: 'core.dom.act', args: { target: 'https://shop.example.com/*', bridge_id: '{{config.browser}}',
    steps: [{ do: 'open', address: 'https://shop.example.com/search' }, { do: 'type', selector: '#q', value: '{{config.query}}' },
      { do: 'click', selector: 'button[type=submit]' }] } }],
  output: { render: [] },
};
const trialAnswered = (): string => sessionStorage.getItem(TRIAL_ANSWER_KEY) ?? 'waiting';
const trialCapture = () => {
  const answered = trialAnswered();
  return { capture_id: 'capture-trial-1', recipe_id: trialRecipe.recipe_id, created_at: 1_700_000_000_000,
    expires_at: Date.now() + 600_000, trial: true, run_id: TRIAL_RUN_ID,
    ...(answered === 'approved' ? { state: 'ready', run_outcome: 'passed' }
      : answered === 'denied' ? { state: 'unavailable', run_outcome: 'failed',
        reason: 'The trial did not finish, so it is no saved test. Try the recipe again once it works.' }
      : { state: 'running', run_outcome: 'held' }) };
};
const trialResult = (fields: Record<string, unknown>) => ({ recipe_id: trialRecipe.recipe_id, recipe_hash: 'fixture',
  output: { render: [], sidebar: [] }, steps: [], errors: [], duration_ms: 40, run_id: TRIAL_RUN_ID, ...fields });
/** What the server answers about the trial: the try itself, held; then the hold's receipt, the run's
 *  kept result once approved, and the capture. Each try is recorded for the spec (`TRIAL_TRIES_KEY`). */
const trialAnswer = (method: string, args: unknown): FixtureAnswer => {
  if (method === 'pair.browsers') {
    return { result: { browsers: [{ browser_id: 'b-home', name: 'Home', online: true }, { browser_id: 'b-work', name: 'Work', online: true }] } };
  }
  if (method === 'recipe.try') {
    sessionStorage.setItem(TRIAL_TRIES_KEY, JSON.stringify([...JSON.parse(sessionStorage.getItem(TRIAL_TRIES_KEY) ?? '[]') as unknown[], args]));
    return { result: trialResult({ success: false, awaiting_approval: true, action_ref: TRIAL_ACTION_REF, capture: trialCapture() }) };
  }
  if (method === 'execution.action.get') {
    const answered = trialAnswered();
    return { result: { receipt: { action_ref: TRIAL_ACTION_REF, run_id: TRIAL_RUN_ID,
      status: answered === 'approved' ? 'completed' : answered === 'denied' ? 'denied' : 'awaiting_approval' }, group: {} } };
  }
  if (method === 'execution.get') {
    return { result: { run: {}, ...(trialAnswered() === 'approved'
      ? { result: trialResult({ success: true, steps: [{ id: 'search', type: 'op', skipped: false, duration_ms: 30, error: null }] }) }
      : {}) } };
  }
  if (method === 'recipe.capture.list') return { result: { captures: [trialCapture()] } };
  return undefined;
};

/** What the fake transport answers: a result, an error, or nothing (another fixture's turn). */
type FixtureAnswer = { result?: unknown; error?: { code: string; message: string } } | undefined;

const createKitchenHomeFixture = () => {
  const now = Date.now();
  const first: KitchenWorkItem = {
    draft_id: 'briefing', kind: 'recipe', title: 'Morning briefing', revision: 3, from: 'Kitchen',
    created_at: now - 600_000, updated_at: now - 120_000, ready: true, problems: 0,
  };
  const items: KitchenWorkItem[] = [first, {
    ...first,
    draft_id: 'renewals',
    title: 'Quarter-end customer follow-up and renewal briefing for North America enterprise account owners after the September pricing and retention review',
    updated_at: now - 240_000, from: 'VS Code', ready: false, problems: 3,
    base: { recipe_id: 'quarterly-renewals', version: 2 },
  }];
  const drafts: IngredientDraftSummary[] = [{
    draft_id: 'bookings', title: 'Bookings', slug: 'bookings', surface: null, operation_count: 2,
    created_at: now - 600_000, updated_at: now - 360_000,
  }];
  return (method: string, args: unknown): FixtureAnswer => {
    if (method === 'kitchen.draft.list') return { result: { items } };
    if (method === 'ingredient.draft.list') return { result: { ok: true, drafts } };
    if (method === 'kitchen.draft.discard') {
      const input = args as { draft_id: string; expected_revision: number };
      const index = items.findIndex(item => item.draft_id === input.draft_id && item.revision === input.expected_revision);
      if (index < 0) return { error: { code: 'conflict', message: 'The draft has changed.' } };
      items.splice(index, 1);
      return { result: { draft_id: input.draft_id, discarded: true } };
    }
    if (method === 'ingredient.draft.delete') {
      const index = drafts.findIndex(draft => draft.draft_id === (args as { draft_id: string }).draft_id);
      if (index >= 0) drafts.splice(index, 1);
      return { result: { ok: true, deleted: index >= 0 } };
    }
    return undefined;
  };
};

/** D-333 — Kitchen's work in progress for `?kitchen_import=<mode>`.
 *  `home` serves a mix of recipe and pack drafts. Editor modes can start with an imported
 *  draft or create one on the first change. Saving a recipe and discarding drafts update
 *  the work shown in Kitchen. */
export const createKitchenImportFixture = (mode: string | null) => {
  if (mode === 'home') return createKitchenHomeFixture();
  let source = JSON.stringify(mode === 'pack' ? pack : mode === 'trial' ? trialRecipe : recipe, null, 2);
  if (mode === 'crlf') source = source.replace(/\n/g, '\r\n');
  if (mode === 'invalid') source = '{"recipe_id":';
  let draftId = 'import-fixture';
  let kind: KitchenImportDraft['kind'] = mode === 'pack' ? 'pack' : 'recipe';
  let from = 'VS Code';
  let revision = 1;
  let present = mode !== 'new' && mode !== 'saved-recipe' && mode !== 'missing';
  let base: KitchenWorkBase | undefined;
  const validation = (): KitchenImportDraft['validation'] => {
    try {
      const body = JSON.parse(source);
      const checked = kind === 'pack' ? validatePack(body, { recipeValidator: validateRecipe }) : validateRecipe(body);
      return { ...checked, total_issues: checked.issues.length };
    } catch {
      return { valid: false, total_issues: 1, issues: [{ severity: 'error' as const, code: 'invalid_json', path: '', message: 'Source must be valid JSON.' }] };
    }
  };
  // Like the server: the title follows the source's own name.
  const title = (): string => {
    try {
      const body = JSON.parse(source) as { name?: unknown; metadata?: { name?: unknown } };
      const name = kind === 'pack' ? body.name : body.metadata?.name;
      if (typeof name === 'string' && name.trim()) return name.trim();
    } catch { /* not JSON yet */ }
    return kind === 'pack' ? 'New pack' : 'New recipe';
  };
  const result = (): KitchenImportDraft => ({ draft_id: draftId, kind, title: title(), source, source_hash: 'fixture', revision,
    created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000, validation: validation(), ...(base ? { base } : {}) });
  const summary = (): KitchenWorkItem => {
    const checked = validation();
    return { draft_id: draftId, kind, title: title(), revision, created_at: 1_700_000_000_000, updated_at: Date.now() - 120_000,
      from, ready: checked.valid, problems: checked.issues.filter(issue => issue.severity === 'error').length,
      ...(base ? { base } : {}) };
  };
  return async (method: string, args: unknown): Promise<FixtureAnswer> => {
    if (!mode) return undefined;
    if (mode === 'kitchen-pack') return kitchenPack(method, args);
    if (mode === 'trial') { const answer = trialAnswer(method, args); if (answer !== undefined) return answer; }
    if (method === 'recipe.save') {
      const saved = (args as { recipe: RecipeDefinition }).recipe;
      return { result: { saved: true, recipe_id: saved.recipe_id, version: 1, name: saved.metadata.name } };
    }
    if (!method.startsWith('kitchen.draft.')) return undefined;
    const input = args as { draft_id?: string; expected_revision?: number; source?: string; kind?: KitchenImportDraft['kind'];
      base?: KitchenWorkBase };
    if (method === 'kitchen.draft.list') return { result: { items: present ? [summary()] : [] } };
    if (method === 'kitchen.draft.create') {
      if (present && input.base !== undefined && base?.recipe_id === input.base.recipe_id) {
        return { error: { code: 'conflict', message: 'Changes to this recipe are already in progress. Reopen it to continue them.' } };
      }
      draftId = 'work-new'; kind = input.kind!; source = input.source!; revision = 1; from = 'Kitchen'; present = true;
      base = input.base;
      return { result: result() };
    }
    if (!present || input.draft_id !== draftId) {
      return { error: { code: 'not_found', message: 'This is no longer in progress in Kitchen.' } };
    }
    if (method === 'kitchen.draft.get') return { result: result() };
    if (method === 'kitchen.draft.update') {
      if (mode === 'slow-save') await new Promise(resolve => setTimeout(resolve, 300));
      if (mode === 'conflict' || input.expected_revision !== revision) {
        return { error: { code: 'conflict', message: 'This changed since you opened it. Reopen it before saving.' } };
      }
      source = input.source!; revision++;
      return { result: result() };
    }
    if (method === 'kitchen.draft.discard') {
      if (input.expected_revision !== revision) {
        return { error: { code: 'conflict', message: 'This changed since you opened it. Reopen it before discarding.' } };
      }
      present = false;
      return { result: { draft_id: draftId, discarded: true } };
    }
    return undefined;
  };
};

/** D-333 — `?kitchen_import=kitchen-pack`: a pack made and installed in Kitchen, as Packs and
 *  the pack builder see it. Its page offers Edit in Kitchen, which opens the draft of changes
 *  to it, carrying the pack's identity. */
const kitchenPackComposition = {
  schema_version: 1, slug: 'acme', catalog_kind: 'private_byo',
  ingredients: [{ slug: 'acme', kind: 'http', http: { base: 'https://api.acme.example', connection: 'acme' } }],
  operations: [{ op: 'deal.read', ingredient: 'acme', risk: 'read', approval: 'never',
    bind: { kind: 'rest', method: 'GET', path_template: '/v3/deals/{deal_id}' } }],
};
const kitchenPackManifest = {
  manifest_version: 2, slug: 'acme-crm', publisher: 'dana', name: 'Acme CRM',
  description: 'Acme deals, made in Kitchen.', version: 1, recipes: [], requires: ['install_bulk_pack'],
  tags: ['crm'], pack_kind: 'app_pack', contents: [{ type: 'composition', composition: kitchenPackComposition }],
};
const kitchenPackDraft = { draft_id: 'pack-changes', title: 'Acme CRM', slug: 'acme', surface: 'api' as const,
  operation_count: 1, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000, base_pack_slug: 'acme-crm' };
/** Another author's pack, as the marketplace serves it: a composition and a recipe. */
const marketPackManifest = {
  manifest_version: 2, slug: 'acme-market', publisher: 'acme-inc', name: 'Acme Market',
  description: 'Acme deals, from the marketplace.', version: 4, recipes: [], requires: ['install_bulk_pack'],
  tags: ['crm'], pack_kind: 'app_pack', contents: [
    { type: 'recipe', slug: 'acme-daily-deals', version: 1 },
    { type: 'composition', composition: { ...kitchenPackComposition, slug: 'acme-market-catalog', catalog_kind: 'official',
      ingredients: [{ ...kitchenPackComposition.ingredients[0], slug: 'acme-market-catalog' }],
      operations: kitchenPackComposition.operations.map(operation => ({ ...operation, ingredient: 'acme-market-catalog' })) } },
  ],
};
/** A recipe from the marketplace pack, which the owner switches to the copy. */
const marketRecipe = {
  recipe_id: 'acme-daily-deals', version: 1, ttl: 300,
  metadata: { name: 'Daily deals', description: '', author: 'acme-inc', supported_platforms: [] },
  variables: {}, prefetch_steps: [], depends_on: ['acme-inc.acme-market'],
  steps: [{ id: 'deals', op: 'acme-inc.acme-market.deal.read' }], output: { render: [] },
};
let kitchenPackEdited = false;
let kitchenPackCopy: { title?: string; body: unknown; pack?: Record<string, unknown> } | undefined;
const kitchenPack = async (method: string, args: unknown): Promise<FixtureAnswer> => {
  if (method === 'packs.list') return { result: { packs: [], installed_versions: [{ slug: 'acme-crm', version: 1, publisher: 'dana' }] } };
  // The installed copy of the marketplace pack, and a recipe of that pack opened in Kitchen.
  if (method === 'ingredient.copies.list') {
    return { result: { copies: [{ pack_ref: 'local-authoring.acme-market-copy', copy_of: 'acme-inc.acme-market' }] } };
  }
  if (method === 'recipe.get' && (args as { recipe_id?: string }).recipe_id === 'acme-daily-deals') {
    return { result: { recipe: { recipe_id: 'acme-daily-deals', publisher_id: 'acme-inc', version: 1,
      recipe_hash: 'fixture', recipe: marketRecipe, source: 'bundled', installed_at: 1_700_000_000_000 } } };
  }
  if (method === 'webhook.ingress.list') return { result: { ingresses: [] } };
  if (method === 'recipe.webhook.status') {
    return { result: { webhook: { declared: false, configured: false, armed: false, bindings: [] } } };
  }
  if (method === 'recipe.release.get') return { error: { code: 'not_found', message: 'No releases.' } };
  // The Packs page settles its roster only once these answer too, as in the harness's packs
  // demo (with `settle_reads=1` for the rest): the seller read fails there on purpose.
  if (method === 'packs.unrunnable') return { result: { findings: [], exact_pack_identities: true } };
  if (method === 'collection.contract.listContracts') return { result: { contracts: [] } };
  if (method === 'server.seller.getOverview') return { error: { code: 'UNAVAILABLE', message: 'No seller backend in the fake transport.' } };
  if (method === 'recipe.list') return { result: { recipes: [] } };
  if (method === 'packs.resolveBySlug' && (args as { slug?: string }).slug === 'acme-crm') {
    return { result: { manifest: kitchenPackManifest, kitchen_editable: true } };
  }
  if (method === 'packs.resolveBySlug' && (args as { slug?: string }).slug === 'acme-market') {
    return { result: { manifest: marketPackManifest } };
  }
  if (method === 'ingredient.draft.save') {
    kitchenPackCopy = args as { title?: string; body: unknown; pack?: Record<string, unknown> };
    return { result: { ok: true, draft: { draft_id: 'copy-1', title: kitchenPackCopy.title, body: kitchenPackCopy.body,
      created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
      ...(kitchenPackCopy.pack ? { pack: kitchenPackCopy.pack } : {}) } } };
  }
  if (method === 'ingredient.draft.get' && (args as { draft_id?: string }).draft_id === 'copy-1' && kitchenPackCopy) {
    return { result: { ok: true, draft: { draft_id: 'copy-1', title: kitchenPackCopy.title, body: kitchenPackCopy.body,
      created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
      ...(kitchenPackCopy.pack ? { pack: kitchenPackCopy.pack } : {}) } } };
  }
  if (method === 'ingredient.draft.edit') {
    kitchenPackEdited = true;
    return { result: { ok: true, draft: kitchenPackDraft } };
  }
  if (method === 'ingredient.draft.list') return { result: { ok: true, drafts: kitchenPackEdited ? [kitchenPackDraft] : [] } };
  if (method === 'ingredient.draft.get') {
    const { contents: _contents, recipes: _recipes, ...identity } = kitchenPackManifest;
    return { result: { ok: true, draft: { draft_id: 'pack-changes', title: 'Acme CRM', body: kitchenPackComposition,
      created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000, base_pack: { pack_slug: 'acme-crm', identity } } } };
  }
  return undefined;
};


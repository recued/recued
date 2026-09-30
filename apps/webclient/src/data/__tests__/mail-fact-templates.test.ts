/** D-315 §6.1, §6.2, §7.1 — Data → Received → Mail facts → Templates: the list
 *  and its health, the standards switches, and the editor from an email or a
 *  pasted sample, through preview and save. */

import { describe, expect, it, vi } from 'vitest';

import type {
  MailFactEmailContent,
  MailFactStandardsSetting,
  MailTemplate,
  MailTemplateDefinition,
  MailFactTypeSpec,
  MailTemplatePreviewRequest,
  MailTemplatePreviewResult,
} from '@recued/contracts';

import {
  createMailFactTemplates,
  MAIL_FACTS_FIELD_ATTR,
  templateBroken,
  type MailFactTemplateCallers,
} from '../mail-fact-templates.js';

const ACTION = 'data-recued-data-action';

const template = (over: Partial<MailTemplate> = {}): MailTemplate => ({
  template_id: 'mtpl_1',
  name: 'UPS notices',
  type: 'shipment',
  entrance: { conditions: [{ field: 'from', op: 'is', value: 'pkginfo@ups.com' }], variables: ['tracking_number'] },
  rules: [{ target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } }],
  html: false,
  ai: { enabled: false },
  origin: { kind: 'owner' },
  active: true,
  revision: 1,
  health: { matched: 3, entered: 3, not_entered: 0, last_entered_at: 2_000 },
  created_at: 1,
  updated_at: 1,
  ...over,
});

const content: MailFactEmailContent = {
  email: { slug: 'work', record_id: 'mail:1', from: 'pkginfo@ups.com', subject: 'UPS Update: Delivered', at: 1_000 },
  from_name: 'UPS',
  body_text: 'Hello,\nTracking Number: 1Z999AA10123456784\nThanks',
  labels: ['INBOX'],
  attachments: [],
  read: 'provider',
};

const el = (attrs: Record<string, string>, value = '', checked = false) =>
  ({ getAttribute: (name: string) => attrs[name] ?? null, value, checked }) as unknown as HTMLElement;

const harness = (callers: MailFactTemplateCallers) => {
  const render = vi.fn();
  const focus = vi.fn();
  const onAddressChange = vi.fn();
  const view = createMailFactTemplates({ callers, actionAttr: ACTION, render, onAddressChange, focus });
  const act = (action: string, attrs: Record<string, string> = {}) => view.handleAction(action, el(attrs));
  const html = () => view.render();
  /** The index of the clickable value showing `text` in the last repaint. */
  const pickIndex = (text: string): string => {
    const match = new RegExp(`data-pick="(\\d+)"[^>]*>${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`).exec(html());
    if (match === null) throw new Error(`no value ${text}`);
    return match[1]!;
  };
  return { view, render, focus, onAddressChange, act, html, pickIndex };
};

describe('the list (§6.2, §7.1)', () => {
  it('shows each template with its health, and marks one that stopped reading', async () => {
    const broken = template({
      template_id: 'mtpl_2',
      name: 'Shop notices',
      health: { matched: 9, entered: 7, not_entered: 2, last_entered_at: 1_000, last_not_entered_at: 3_000 },
    });
    const h = harness({ listTemplates: async () => ({ templates: [template(), broken] }), getStandards: async () => ({ standards: [] }) });
    await h.view.refresh();
    const html = h.html();
    expect(html).toContain('Met its conditions 3 times · read 3 · missed 0');
    expect(html).toMatch(/data-recued-mail-fact-template="mtpl_2" data-broken="true"/);
    expect(html).toContain('It stopped reading');
    expect(templateBroken(template())).toBe(false);
    expect(templateBroken(broken)).toBe(true);
  });

  it('switches a template on and off, and shows a refusal on its row', async () => {
    const updateTemplate = vi.fn(async () => {
      throw Object.assign(new Error('UPS already reads shipment facts from mail with these conditions'), { code: 'conflict' });
    });
    const h = harness({ listTemplates: async () => ({ templates: [template({ active: false })] }), updateTemplate });
    await h.view.refresh();
    h.act('mail-facts-tpl-toggle', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(h.html()).toContain('role="alert"'));
    expect(updateTemplate).toHaveBeenCalledWith({ template_id: 'mtpl_1', active: true });
  });

  it('asks before deleting, and says the facts stay and a trigger narrowed to it is switched off', async () => {
    const deleteTemplate = vi.fn(async () => ({ deleted: true }));
    const h = harness({ listTemplates: async () => ({ templates: [template()] }), deleteTemplate });
    await h.view.refresh();
    h.act('mail-facts-tpl-delete', { 'data-template-id': 'mtpl_1' });
    expect(h.html()).toContain('Delete “UPS notices”? The facts it already read stay; a trigger narrowed to it is switched off.');
    expect(deleteTemplate).not.toHaveBeenCalled();
    h.act('mail-facts-tpl-delete-confirm', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith({ template_id: 'mtpl_1' }));
  });

  it('switches the standards pass per type', async () => {
    const setStandards = vi.fn(async (args: MailFactStandardsSetting) => args);
    const h = harness({
      listTemplates: async () => ({ templates: [] }),
      getStandards: async () => ({ standards: [{ type: 'shipment', on: true }, { type: 'bill', on: false }] }),
      setStandards,
    });
    await h.view.refresh();
    expect(h.html()).toMatch(/data-type="shipment"[^>]*checked/);
    expect(h.html()).not.toMatch(/data-type="bill"[^>]*checked/);
    h.act('mail-facts-std-toggle', { 'data-type': 'shipment' });
    await vi.waitFor(() => expect(setStandards).toHaveBeenCalledWith({ type: 'shipment', on: false }));
  });
});

describe('the editor, from an email (§6.1)', () => {
  it('suggests the sender, turns clicks into rules, and saves the template', async () => {
    const createTemplate = vi.fn(async (args: { definition: MailTemplateDefinition }) => ({ template: template({ ...args.definition }) }));
    const h = harness({
      readEmail: async () => content,
      createTemplate,
      listTemplates: async () => ({ templates: [] }),
    });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    expect(h.onAddressChange).toHaveBeenCalled();
    expect(h.view.addressSegments()).toEqual(['new']);
    // The sender, suggested as the entrance.
    expect(h.html()).toMatch(/data-recued-mail-facts-field="ed:cond-value:0"[^>]*value="pkginfo@ups.com"/);

    // Click the tracking number and say what it is.
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('1Z999AA10123456784') });
    expect(h.html()).toContain('“1Z999AA10123456784” is');
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-variable' }, 'tracking_number'));
    h.act('mail-facts-ed-pick-add');
    expect(h.html()).toContain('the text after “Tracking Number:” in the text');

    // The sender's name is the carrier.
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('UPS') });
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-variable' }, 'carrier'));
    h.act('mail-facts-ed-pick-add');

    h.act('mail-facts-ed-save');
    await vi.waitFor(() => expect(createTemplate).toHaveBeenCalled());
    expect(createTemplate.mock.calls[0]![0].definition).toEqual({
      name: 'Shipment from pkginfo@ups.com',
      type: 'shipment',
      entrance: {
        conditions: [{ field: 'from', op: 'is', value: 'pkginfo@ups.com' }],
        variables: ['carrier', 'tracking_number'],
      },
      rules: [
        { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } },
        { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'whole' } },
      ],
      html: false,
      ai: { enabled: false },
    });
    // Saved: back to the list.
    await vi.waitFor(() => expect(h.view.addressSegments()).toEqual([]));
  });

  it('asks what words mean for a state, and shows the server’s problems on save', async () => {
    const createTemplate = vi.fn(async () => {
      throw Object.assign(new Error('The template cannot be saved'), {
        code: 'bad_request',
        details: { problems: ['the entrance needs at least one condition'] },
      });
    });
    const h = harness({ readEmail: async () => content, createTemplate });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('UPS Update: Delivered') });
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-variable' }, 'state'));
    h.act('mail-facts-ed-pick-add');
    expect(h.html()).toContain('Say which state “UPS Update: Delivered” means.');
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-means' }, 'delivered'));
    h.act('mail-facts-ed-pick-add');
    expect(h.html()).toContain('“UPS Update: Delivered” means Delivered');

    h.act('mail-facts-ed-save');
    await vi.waitFor(() => expect(h.html()).toContain('the entrance needs at least one condition'));
    expect(h.view.addressSegments()).toEqual(['new']);
  });
});

describe('the editor keeps a template it can save', () => {
  it('takes a variable out of the entrance with its last rule', async () => {
    const createTemplate = vi.fn(async (args: { definition: MailTemplateDefinition }) => ({ template: template({ ...args.definition }) }));
    const h = harness({ readEmail: async () => content, createTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('1Z999AA10123456784') });
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-variable' }, 'tracking_number'));
    h.act('mail-facts-ed-pick-add');
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('UPS') });
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-variable' }, 'carrier'));
    h.act('mail-facts-ed-pick-add');
    // The owner sets the entrance by hand, then removes the carrier's rule.
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:entrance:carrier' }, '', true));
    h.act('mail-facts-ed-rule-remove', { 'data-index': '1' });
    h.act('mail-facts-ed-save');
    await vi.waitFor(() => expect(createTemplate).toHaveBeenCalled());
    expect(createTemplate.mock.calls[0]![0].definition.entrance.variables).toEqual(['tracking_number']);
  });

  it('adds a fixed value on the first click after it is typed: leaving the field repaints nothing', async () => {
    const h = harness({ readEmail: async () => content, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    h.view.handleChange({ ...el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:constant-variable' }, 'carrier'), tagName: 'SELECT' } as unknown as HTMLElement);
    h.render.mockClear();
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:constant-value' }, 'UPS'));
    // The `change` of a text field fires on the press of Add.
    expect(h.view.handleChange({ ...el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:constant-value' }, 'UPS'), tagName: 'INPUT' } as unknown as HTMLElement)).toBe(true);
    expect(h.render).not.toHaveBeenCalled();
    h.act('mail-facts-ed-constant-add');
    expect(h.html()).toContain('always “UPS”');
  });
});

describe('the editor, from a pasted email', () => {
  it('reads what is typed without a repaint, and previews the sample', async () => {
    const previewTemplate = vi.fn(async (_request: MailTemplatePreviewRequest) => ({
      source: { read: 'sample' as const, outcome: 'entered' as const, facts: [] },
      recent: [],
      scanned: 120,
    }));
    const h = harness({ previewTemplate, createTemplate: async () => ({ template: template() }) });
    h.act('mail-facts-tpl-new');
    const renders = h.render.mock.calls.length;
    for (const [part, value] of [
      ['from', 'UPS <pkginfo@ups.com>'],
      ['subject', 'UPS Update'],
      ['body', 'Tracking Number: 1Z999AA10123456784'],
    ] as const) {
      expect(h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: `ed:sample-${part}` }, value))).toBe(true);
    }
    expect(h.render.mock.calls.length).toBe(renders);
    h.act('mail-facts-ed-sample-use');
    expect(h.html()).toMatch(/data-recued-mail-facts-field="ed:cond-value:0"[^>]*value="pkginfo@ups.com"/);

    // A fixed value, then preview.
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:constant-variable' }, 'carrier'));
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:constant-value' }, 'UPS'));
    h.act('mail-facts-ed-constant-add');
    expect(h.html()).toContain('always “UPS”');
    h.act('mail-facts-ed-preview');
    await vi.waitFor(() => expect(previewTemplate).toHaveBeenCalled());
    expect(previewTemplate.mock.calls[0]![0]).toMatchObject({
      source: { sample: { from: 'UPS <pkginfo@ups.com>', subject: 'UPS Update', body: 'Tracking Number: 1Z999AA10123456784' } },
      definition: { entrance: { variables: [] }, rules: [{ find: { kind: 'constant', value: 'UPS' } }] },
    });
    await vi.waitFor(() => expect(h.html()).toContain('None among the 120 newest emails.'));
  });
});

describe('its address', () => {
  it('names the template it edits, and loads it on the first refresh — not while the route is built', async () => {
    const getTemplate = vi.fn(async () => ({ template: template() }));
    const h = harness({ getTemplate });
    h.view.openAddress(['mtpl_1']);
    expect(h.view.addressSegments()).toEqual(['mtpl_1']);
    expect(getTemplate).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();
    await h.view.refresh();
    expect(getTemplate).toHaveBeenCalledWith({ template_id: 'mtpl_1' });
    expect(h.onAddressChange).not.toHaveBeenCalled();
    expect(h.html()).toContain('Edit “UPS notices”');
  });
});

describe('reading past mail (§6.3)', () => {
  const job = (over: Record<string, unknown> = {}) => ({
    job_id: 'mbf_1', template_id: 'mtpl_1', days: 90, run_recipes: true, status: 'running' as const,
    total: 40, read: 12, facts: 9, events: 0, stored_copies: 0, kept: 0, started_at: 1, ...over,
  });

  it('offers the periods mail is kept for, and starts with what the owner chose', async () => {
    const startBackfill = vi.fn(async () => job());
    const h = harness({
      listTemplates: async () => ({ templates: [template()] }),
      getBackfill: async () => ({ job: null, max_days: 90 }),
      startBackfill,
    });
    await h.view.refresh();
    h.act('mail-facts-bf-open', { 'data-template-id': 'mtpl_1' });
    const html = h.html();
    expect(html).toContain('<option value="30" selected>30 days</option>');
    expect(html).toContain('<option value="90">90 days</option>');
    expect(html).not.toContain('180 days');
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'bf:days' }, '90'));
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'bf:run' }, '', true));
    h.act('mail-facts-bf-start', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(startBackfill).toHaveBeenCalledWith({ template_id: 'mtpl_1', days: 90, run_recipes: true }));
    await vi.waitFor(() => expect(h.html()).toContain('Reading past mail: 12 of 40 emails · 9 facts'));
  });

  it('stops a running job, and tells what a finished one did', async () => {
    let state = { job: job(), max_days: 365 } as { job: ReturnType<typeof job>; max_days: number };
    const cancelBackfill = vi.fn(async () => {
      state = { ...state, job: job({ status: 'cancelled', read: 12 }) };
      return state.job;
    });
    const h = harness({
      listTemplates: async () => ({ templates: [template()] }),
      getBackfill: async () => state,
      startBackfill: vi.fn(),
      cancelBackfill,
    });
    await h.view.refresh();
    h.act('mail-facts-bf-stop', { 'data-job-id': 'mbf_1' });
    await vi.waitFor(() => expect(cancelBackfill).toHaveBeenCalledWith({ job_id: 'mbf_1' }));
    await vi.waitFor(() => expect(h.html()).toContain('Stopped after reading 12 of 40 emails from the last 90 days: 9 facts.'));

    state = { ...state, job: job({ status: 'done', read: 40, facts: 31, events: 4, kept: 2 }) };
    await h.view.refresh();
    expect(h.html()).toContain('Read 40 of 40 emails from the last 90 days: 31 facts, 4 changes passed to your recipes. 2 could not be read again from your mailbox and kept what Recued had read.');
  });
});

describe('then run a recipe (§5.1)', () => {
  const recipes = [
    { recipe_id: 'parcel-alert', publisher_id: 'local', version: 1, recipe_hash: 'h', recipe: { metadata: { name: 'Tell me when a parcel arrives' } } },
  ] as never;

  it('makes a trigger for what the template reads, narrowed to it', async () => {
    const createTrigger = vi.fn(async () => ({}));
    const h = harness({ listTemplates: async () => ({ templates: [template()] }), listRecipes: async () => ({ recipes }), createTrigger });
    await h.view.refresh();
    h.act('mail-facts-tr-open', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(h.html()).toContain('Tell me when a parcel arrives'));
    h.act('mail-facts-tr-create', { 'data-template-id': 'mtpl_1' });
    expect(h.html()).toContain('Choose a recipe to run.');
    expect(createTrigger).not.toHaveBeenCalled();
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'tr:recipe' }, 'local/parcel-alert'));
    h.act('mail-facts-tr-create', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(createTrigger).toHaveBeenCalledWith({
      recipe_id: 'parcel-alert',
      publisher_id: 'local',
      // On the template's kind (ruling 43), narrowed to the template.
      on: 'mail_fact.shipment',
      where: { template: 'mtpl_1' },
    }));
    await vi.waitFor(() => expect(h.html()).toContain('“Tell me when a parcel arrives” now runs for what “UPS notices” reads.'));
  });

  it('is not offered without the callers it needs', async () => {
    const h = harness({ listTemplates: async () => ({ templates: [template()] }) });
    await h.view.refresh();
    expect(h.html()).not.toContain('Then run…');
  });

  const dish = (over: Record<string, unknown>) => ({
    dish_id: 'dsh_work', recipe_id: 'parcel-alert', publisher_id: 'local', name: '',
    is_default: true, config_overlay: {}, enabled: true, created_at: 1, ...over,
  });

  it('D-319 §5.5 — with more than one dish it asks which one; the main one until another is chosen', async () => {
    const createTrigger = vi.fn(async () => ({}));
    const h = harness({
      listTemplates: async () => ({ templates: [template()] }),
      listRecipes: async () => ({ recipes }),
      listDishes: async () => ({
        dishes: [
          dish({ dish_id: 'dsh_home', name: 'Home mailbox', is_default: false, enabled: false, created_at: 2 }),
          dish({ name: 'Work mailbox' }),
          // Another recipe's dish is not a choice.
          dish({ dish_id: 'dsh_other', recipe_id: 'other' }),
        ],
      }) as never,
      createTrigger,
    });
    await h.view.refresh();
    h.act('mail-facts-tr-open', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(h.html()).toContain('Tell me when a parcel arrives'));
    // No recipe chosen: nothing to ask yet.
    expect(h.html()).not.toContain('tr:dish');

    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'tr:recipe' }, 'local/parcel-alert'));
    const html = h.html();
    expect(html).toContain('Run as');
    expect(html).toMatch(/<option value="dsh_work" selected>Work mailbox \(main\)<\/option>/);
    expect(html).toContain('<option value="dsh_home">Home mailbox — off</option>');
    expect(html).not.toContain('dsh_other');

    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'tr:dish' }, 'dsh_home'));
    h.act('mail-facts-tr-create', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(createTrigger).toHaveBeenCalledWith({
      recipe_id: 'parcel-alert',
      publisher_id: 'local',
      on: 'mail_fact.shipment',
      where: { template: 'mtpl_1' },
      dish_id: 'dsh_home',
    }));
    await vi.waitFor(() => expect(h.html()).toContain('“Tell me when a parcel arrives” now runs as “Home mailbox” for what “UPS notices” reads.'));
  });

  it('with one dish there is nothing to ask: it runs as that dish', async () => {
    const createTrigger = vi.fn(async () => ({}));
    const h = harness({
      listTemplates: async () => ({ templates: [template()] }),
      listRecipes: async () => ({ recipes }),
      listDishes: async () => ({ dishes: [dish({})] }) as never,
      createTrigger,
    });
    await h.view.refresh();
    h.act('mail-facts-tr-open', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(h.html()).toContain('Tell me when a parcel arrives'));
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'tr:recipe' }, 'local/parcel-alert'));
    expect(h.html()).not.toContain('Run as');
    h.act('mail-facts-tr-create', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(createTrigger).toHaveBeenCalledWith(expect.objectContaining({ dish_id: 'dsh_work' })));
  });

  it('a failed read of the dishes is soft: the trigger goes to the recipe’s main dish', async () => {
    const createTrigger = vi.fn(async () => ({}));
    const h = harness({
      listTemplates: async () => ({ templates: [template()] }),
      listRecipes: async () => ({ recipes }),
      listDishes: async () => { throw new Error('offline'); },
      createTrigger,
    });
    await h.view.refresh();
    h.act('mail-facts-tr-open', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(h.html()).toContain('Tell me when a parcel arrives'));
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'tr:recipe' }, 'local/parcel-alert'));
    h.act('mail-facts-tr-create', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(createTrigger).toHaveBeenCalledWith({
      recipe_id: 'parcel-alert',
      publisher_id: 'local',
      on: 'mail_fact.shipment',
      where: { template: 'mtpl_1' },
    }));
  });
});

describe('AI on a template (§4.3)', () => {
  it('is off until switched on; then the prompt, what it may fill and the pool are saved', async () => {
    const createTemplate = vi.fn(async (args: { definition: MailTemplateDefinition }) => ({ template: template({ ...args.definition }) }));
    const h = harness({ readEmail: async () => content, createTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('1Z999AA10123456784') });
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-variable' }, 'tracking_number'));
    h.act('mail-facts-ed-pick-add');
    expect(h.html()).toContain('Let AI fill in what the rules leave empty');
    expect(h.html()).not.toContain('What it may fill in');

    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:ai-on' }, '', true));
    const html = h.html();
    // The entrance's own variable is the rules' alone.
    expect(html).toMatch(/<input type="checkbox" disabled> Tracking number \(lets an email in/);
    expect(html).toContain('data-recued-mail-facts-field="ed:ai-slot:expected_at"');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:ai-prompt' }, 'UPS notices; the expected day is near the top.'));
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:ai-slot:expected_at' }, '', true));
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:ai-data' }, 'Contents'));
    h.act('mail-facts-ed-ai-data-add');
    expect(h.html()).toContain('Write it in lower case');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:ai-data' }, 'contents'));
    h.act('mail-facts-ed-ai-data-add');
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:ai-pool' }, 'free_then_byok'));

    h.act('mail-facts-ed-save');
    await vi.waitFor(() => expect(createTemplate).toHaveBeenCalled());
    expect(createTemplate.mock.calls[0]![0].definition.ai).toEqual({
      enabled: true,
      prompt: 'UPS notices; the expected day is near the top.',
      slots: ['expected_at', 'data.contents'],
      pool: 'free_then_byok',
    });
  });

  it('warns while its entrance is only a domain, and keeps its settings while switched off', async () => {
    const h = harness({
      getTemplate: async () => ({
        template: template({
          entrance: { conditions: [{ field: 'from', op: 'domain_is', value: 'ups.com' }], variables: [] },
          ai: { enabled: true, prompt: 'UPS mail.', slots: ['carrier'], pool: 'byok_only' },
        }),
      }),
      listTemplates: async () => ({ templates: [] }),
    });
    h.view.openAddress(['mtpl_1']);
    await h.view.refresh();
    expect(h.html()).toContain('Before AI can read these emails, narrow which ones it reads');
    expect(h.html()).toMatch(/<option value="byok_only" selected>Your own keys only<\/option>/);
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:ai-on' }, '', false));
    expect(h.html()).not.toContain('What it may fill in');
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:ai-on' }, '', true));
    expect(h.html()).toContain('UPS mail.');
    expect(h.html()).toMatch(/ed:ai-slot:carrier"[^>]*checked/);
  });
});

describe('Draft with AI (§6.1)', () => {
  const drafted = {
    definition: {
      name: 'UPS notices',
      type: 'shipment' as const,
      entrance: { conditions: [{ field: 'from' as const, op: 'is' as const, value: 'pkginfo@ups.com' }], variables: ['tracking_number'] },
      rules: [{ target: { variable: 'tracking_number' }, source: 'body' as const, find: { kind: 'after_label' as const, label: 'Tracking Number:' } }],
      html: false,
      ai: { enabled: false as const },
    },
    dropped: ['the rule for merchant: it held a privacy alias, not a real value'],
  };

  it('drafts from this email, names what it left out, and previews the draft', async () => {
    const draftTemplate = vi.fn(async () => drafted);
    const previewTemplate = vi.fn(async (_args: MailTemplatePreviewRequest) => ({ recent: [], scanned: 0 }));
    const h = harness({ readEmail: async () => content, draftTemplate, previewTemplate });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    expect(h.html()).toContain('Draft with AI');

    h.act('mail-facts-ed-draft');
    await vi.waitFor(() => expect(previewTemplate).toHaveBeenCalled());
    // The owner has not picked a kind of email: the AI proposes one.
    expect(draftTemplate).toHaveBeenCalledWith({ source: { email: { slug: 'work', record_id: 'mail:1' } } });
    const html = h.html();
    expect(html).toContain('Drafted by AI from this email');
    expect(html).toContain('Left out (1)');
    expect(html).toContain('the rule for merchant: it held a privacy alias, not a real value');
    expect(html).toContain('the text after “Tracking Number:” in the text');
    expect(previewTemplate.mock.calls[0]![0].definition).toMatchObject({ name: 'UPS notices', rules: drafted.definition.rules });
  });

  it('asks before it replaces rules the owner made, and passes the kind of email the owner picked', async () => {
    const draftTemplate = vi.fn(async () => drafted);
    const h = harness({ readEmail: async () => content, draftTemplate });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:type' }, 'shipment'));
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('UPS') });
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-variable' }, 'carrier'));
    h.act('mail-facts-ed-pick-add');

    h.act('mail-facts-ed-draft');
    expect(h.html()).toContain('This replaces what the template reads and which emails it reads.');
    h.act('mail-facts-ed-draft-cancel');
    expect(draftTemplate).not.toHaveBeenCalled();
    // The owner's rule is still there.
    expect(h.html()).toContain('<span class="mail-facts-rule-target">Carrier</span>');

    h.act('mail-facts-ed-draft');
    h.act('mail-facts-ed-draft-confirm');
    await vi.waitFor(() => expect(h.html()).toContain('Drafted by AI from this email'));
    expect(draftTemplate).toHaveBeenCalledWith({ source: { email: { slug: 'work', record_id: 'mail:1' } }, type: 'shipment' });
  });

  it('says why when the server refuses', async () => {
    const draftTemplate = vi.fn(async () => {
      throw Object.assign(new Error('This email looks like a security notice (a sign-in code or a password reset). Recued reads nothing from those.'), { code: 'forbidden' });
    });
    const h = harness({ readEmail: async () => content, draftTemplate });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    h.act('mail-facts-ed-draft');
    await vi.waitFor(() => expect(h.html()).toContain('looks like a security notice'));
    expect(h.html()).toContain('Draft with AI');
  });
});

describe('Preview of an AI-on template', () => {
  it('calls no model, and says what the AI would be asked to fill', async () => {
    const previewTemplate = vi.fn(async (): Promise<MailTemplatePreviewResult> => ({
      source: {
        read: 'provider' as const,
        outcome: 'entered' as const,
        facts: [{
          position: 0,
          variables: { carrier: 'UPS', tracking_number: '1Z999AA10123456784', expected_at: null },
          passes: { carrier: 'rule', tracking_number: 'rule' },
          data: null, missing: [], refused: [], complete: true,
        }],
      },
      recent: [],
      scanned: 0,
    }));
    const h = harness({
      getTemplate: async () => ({ template: template({ ai: { enabled: true, prompt: 'UPS.', slots: ['expected_at', 'carrier'], pool: 'free_only' } }) }),
      previewTemplate,
      listTemplates: async () => ({ templates: [] }),
    });
    h.view.openAddress(['mtpl_1']);
    await h.view.refresh();
    h.act('mail-facts-ed-preview');
    await vi.waitFor(() => expect(h.html()).toContain('Left for the AI, once saved: Expected at'));
    // Carrier was read by a rule, so it is not left for the AI.
    expect(h.html()).not.toMatch(/Left for the AI, once saved: [^<]*Carrier/);
  });
});

describe('a preview of a template changed since', () => {
  const ref = { slug: 'work', record_id: 'mail:1' };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const entered: MailTemplatePreviewResult = {
    source: {
      read: 'provider',
      outcome: 'entered',
      facts: [{
        position: 0,
        variables: { carrier: 'UPS', tracking_number: '1Z999AA10123456784' },
        passes: { carrier: 'rule', tracking_number: 'rule' },
        data: null, missing: [], refused: [], complete: true,
      }],
    },
    recent: [],
    scanned: 0,
  };

  it('drops an answer that lands after the template changed: it read another template', async () => {
    const answers: ((value: MailTemplatePreviewResult) => void)[] = [];
    const previewTemplate = vi.fn((_request: MailTemplatePreviewRequest) => new Promise<MailTemplatePreviewResult>((resolve) => { answers.push(resolve); }));
    const h = harness({ readEmail: async () => content, previewTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail(ref);
    h.act('mail-facts-ed-preview');
    // While it reads, the owner narrows the sender to one this email is not from.
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:cond-value:0' }, 'other@ups.com'));
    answers[0]!(entered);
    await flush();
    expect(h.html()).not.toContain('Read a fact');
    expect(h.html()).toContain('The template changed since this preview.');
  });

  it('lets the owner preview the changed template while the old one still reads', async () => {
    const answers: ((value: MailTemplatePreviewResult) => void)[] = [];
    const previewTemplate = vi.fn((_request: MailTemplatePreviewRequest) => new Promise<MailTemplatePreviewResult>((resolve) => { answers.push(resolve); }));
    const h = harness({ readEmail: async () => content, previewTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail(ref);
    h.act('mail-facts-ed-preview');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:cond-value:0' }, 'other@ups.com'));
    expect(h.html()).not.toMatch(/mail-facts-ed-preview"[^>]*aria-disabled/);
    h.act('mail-facts-ed-preview');
    expect(previewTemplate).toHaveBeenCalledTimes(2);
    expect(previewTemplate.mock.calls[1]![0]).toMatchObject({
      definition: { entrance: { conditions: [{ field: 'from', op: 'is', value: 'other@ups.com' }] } },
    });
    // The old one's answer lands last and changes nothing; the new one's shows.
    answers[1]!({ source: { read: 'provider', outcome: 'no_match', facts: [] }, recent: [], scanned: 0 });
    answers[0]!(entered);
    await flush();
    expect(h.html()).not.toContain('Read a fact');
    expect(h.html()).not.toContain('The template changed since this preview.');
  });

  it('keeps the problems a late failure names off the changed template', async () => {
    let fail: (error: unknown) => void = () => {};
    const previewTemplate = vi.fn(() => new Promise<MailTemplatePreviewResult>((_resolve, reject) => { fail = reject; }));
    const h = harness({ readEmail: async () => content, previewTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail(ref);
    h.act('mail-facts-ed-preview');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:cond-value:0' }, 'other@ups.com'));
    fail(Object.assign(new Error('bad'), { code: 'bad_request', details: { problems: ['the entrance needs at least one condition'] } }));
    await flush();
    expect(h.html()).not.toContain('the entrance needs at least one condition');
  });

  it('stops showing a result once the template changes, and says to preview again', async () => {
    const previewTemplate = vi.fn(async () => entered);
    const h = harness({ readEmail: async () => content, previewTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail(ref);
    h.act('mail-facts-ed-preview');
    await vi.waitFor(() => expect(h.html()).toContain('Read a fact'));
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:cond-value:0' }, 'other@ups.com'));
    expect(h.html()).not.toContain('Read a fact');
    expect(h.html()).toContain('The template changed since this preview.');
    // Changed back: what the preview read is this template again.
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:cond-value:0' }, 'pkginfo@ups.com'));
    expect(h.html()).toContain('Read a fact');
  });
});

describe('kinds of email you made (§4.5)', () => {
  const wine = {
    id: 'custom_wine_club_box' as const,
    name: 'Wine club box',
    description: 'A box from the wine club.',
    variables: [
      { name: 'club', kind: 'text' as const, required: true },
      { name: 'box_id', kind: 'id' as const, required: true },
    ],
    states: ['shipped'],
    notices: [],
    identity: [['club', 'box_id']],
  };

  it('are offered in the picker, and a new one made there becomes the template’s kind', async () => {
    const createType = vi.fn(async ({ spec }: { spec: MailFactTypeSpec }) => ({ type: spec }));
    const h = harness({ readEmail: async () => content, listTypes: async () => ({ types: [wine] }), createType });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    expect(h.html()).toMatch(/<optgroup label="Kinds you made"><option value="custom_wine_club_box">Wine club box<\/option><\/optgroup>/);
    expect(h.html()).toContain('<option value="__new__">A new kind of email…</option>');

    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:type' }, '__new__'));
    expect(h.html()).toContain('A new kind of email');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ty:name' }, 'Club newsletter'));
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ty:var-name:0' }, 'issue'));
    h.act('mail-facts-ty-save');
    await vi.waitFor(() => expect(createType).toHaveBeenCalled());
    // Back in the template, now of the new kind.
    await vi.waitFor(() => expect(h.html()).toMatch(/<option value="custom_club_newsletter" selected>Club newsletter<\/option>/));
    expect(h.html()).toContain('The email');
  });

  it('offer the data they name wherever a data field is chosen (§3.2)', async () => {
    const withData = { ...wine, data_fields: [{ path: 'bottles', kind: 'list' as const, description: 'Each bottle in the box.' }] };
    const h = harness({ readEmail: async () => content, listTypes: async () => ({ types: [withData] }) });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:type' }, 'custom_wine_club_box'));
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:ai-on' }, '', true));
    let html = h.html();
    expect(html).toMatch(/ed:ai-slot:data\.bottles"[^>]*> Data: bottles \(Each bottle in the box\)<\/label>/);
    expect(html).toContain('placeholder="for example items" list="mail-facts-ai-data-fields"');
    expect(html).toContain('<datalist id="mail-facts-ai-data-fields"><option value="bottles">Each bottle in the box.</option></datalist>');
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('1Z999AA10123456784') });
    expect(h.html()).toContain('list="mail-facts-pick-data-fields"');
    // A built-in kind's data is offered the same way.
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:type' }, 'purchase'));
    html = h.html();
    expect(html).toContain('> Data: items (Line items)</label>');
    expect(html).not.toContain('data.bottles');
  });

  it('are listed with their own edit and delete, which is refused while a template reads one', async () => {
    const deleteType = vi.fn(async () => {
      throw Object.assign(new Error('Templates still read this kind of email: “The club”. Delete them first.'), { code: 'conflict' });
    });
    const h = harness({
      listTemplates: async () => ({ templates: [template({ template_id: 'mtpl_w', name: 'The club', type: 'custom_wine_club_box' })] }),
      listTypes: async () => ({ types: [wine] }),
      updateType: vi.fn(),
      deleteType,
    });
    await h.view.refresh();
    const html = h.html();
    expect(html).toContain('Kinds of email you made');
    expect(html).toContain('Club, Box id · read by 1 template');
    // The template's pill names the kind the owner made.
    expect(html).toMatch(/The club<\/span>\s*<span class="data-pill">Wine club box<\/span>/);

    h.act('mail-facts-tpl-type-delete', { 'data-type-id': 'custom_wine_club_box' });
    expect(h.html()).toContain('Delete it, and every fact read as one? A trigger on it is switched off.');
    h.act('mail-facts-tpl-type-delete-confirm', { 'data-type-id': 'custom_wine_club_box' });
    await vi.waitFor(() => expect(h.html()).toContain('Templates still read this kind of email: “The club”.'));
    expect(deleteType).toHaveBeenCalledWith({ type_id: 'custom_wine_club_box' });

    h.act('mail-facts-tpl-type-edit', { 'data-type-id': 'custom_wine_club_box' });
    expect(h.html()).toContain('Edit “Wine club box”');
  });
});

// ── D-315 audit: calls that land late, the owner's changes, and the switches ──

describe('a call that lands after the owner moved on (owner finding 6)', () => {
  const ref = { slug: 'work', record_id: 'mail:1' };
  const draftedUps = {
    definition: {
      name: 'UPS notices',
      type: 'shipment' as const,
      entrance: { conditions: [{ field: 'from' as const, op: 'is' as const, value: 'pkginfo@ups.com' }], variables: ['tracking_number'] },
      rules: [{ target: { variable: 'tracking_number' }, source: 'body' as const, find: { kind: 'after_label' as const, label: 'Tracking Number:' } }],
      html: false,
      ai: { enabled: false as const },
    },
    dropped: ['the rule for merchant: it held a privacy alias, not a real value'],
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('a draft for an editor that was left changes nothing in the one open now', async () => {
    let answer: (value: typeof draftedUps) => void = () => {};
    const draftTemplate = vi.fn(() => new Promise<typeof draftedUps>((resolve) => { answer = resolve; }));
    const h = harness({ readEmail: async () => content, draftTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail(ref);
    h.act('mail-facts-ed-draft');
    expect(draftTemplate).toHaveBeenCalledTimes(1);
    // Nothing changed yet: back goes at once, and the owner starts another.
    h.act('mail-facts-ed-back');
    h.act('mail-facts-tpl-new');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:name' }, 'Shop orders'));
    answer(draftedUps);
    await flush();
    const html = h.html();
    expect(html).toContain('New template');
    expect(html).toContain('value="Shop orders"');
    expect(html).not.toContain('Drafted by AI from this email');
    expect(html).not.toContain('the text after “Tracking Number:”');
  });

  it('keeps what the owner did while the email loaded, and counts it unsaved', async () => {
    let loaded: (value: typeof content) => void = () => {};
    const readEmail = vi.fn(() => new Promise<typeof content>((resolve) => { loaded = resolve; }));
    const h = harness({ readEmail, listTemplates: async () => ({ templates: [] }) });
    const opening = h.view.openFromEmail(ref);
    // While "Reading the email…": a name, and a condition of the owner's own.
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:name' }, 'My parcels'));
    h.act('mail-facts-ed-cond-add');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:cond-value:0' }, 'auto@ups.com'));
    loaded(content);
    await opening;
    const html = h.html();
    expect(html).toContain('value="My parcels"');
    expect(html).toMatch(/data-recued-mail-facts-field="ed:cond-value:0"[^>]*value="auto@ups.com"/);
    // Nothing of it is saved: leaving asks first.
    expect(h.view.hasUnsavedChanges()).toBe(true);
  });

  it('suggests the sender beside a name typed while the email loaded, when the owner wrote no condition', async () => {
    let loaded: (value: typeof content) => void = () => {};
    const readEmail = vi.fn(() => new Promise<typeof content>((resolve) => { loaded = resolve; }));
    const h = harness({ readEmail, listTemplates: async () => ({ templates: [] }) });
    const opening = h.view.openFromEmail(ref);
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:name' }, 'My parcels'));
    loaded(content);
    await opening;
    const html = h.html();
    expect(html).toContain('value="My parcels"');
    expect(html).toMatch(/data-recued-mail-facts-field="ed:cond-value:0"[^>]*value="pkginfo@ups.com"/);
    expect(h.view.hasUnsavedChanges()).toBe(true);
  });

  it('a draft that lands after the owner changed the template overwrites nothing: the owner chooses', async () => {
    let answer: (value: typeof draftedUps) => void = () => {};
    const draftTemplate = vi.fn(() => new Promise<typeof draftedUps>((resolve) => { answer = resolve; }));
    const h = harness({ readEmail: async () => content, draftTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail(ref);
    h.act('mail-facts-ed-draft');
    // While it drafts, the owner narrows the sender.
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:cond-value:0' }, 'auto@ups.com'));
    answer(draftedUps);
    await flush();
    let html = h.html();
    expect(html).toMatch(/data-recued-mail-facts-field="ed:cond-value:0"[^>]*value="auto@ups.com"/);
    expect(html).not.toContain('Drafted by AI from this email');
    expect(html).toContain('The AI’s draft came after you changed the template.');
    // Keeping them leaves the edit as it is.
    h.act('mail-facts-ed-draft-late-keep');
    html = h.html();
    expect(html).not.toContain('The AI’s draft came after you changed the template.');
    expect(html).toMatch(/data-recued-mail-facts-field="ed:cond-value:0"[^>]*value="auto@ups.com"/);

    // Drafting again, changing again, and this time taking the draft.
    h.act('mail-facts-ed-draft');
    if (h.html().includes('mail-facts-ed-draft-confirm')) h.act('mail-facts-ed-draft-confirm');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:cond-value:0' }, 'other@ups.com'));
    answer(draftedUps);
    await flush();
    h.act('mail-facts-ed-draft-late-use');
    await flush();
    expect(h.html()).toContain('Drafted by AI from this email');
    expect(h.html()).toMatch(/data-recued-mail-facts-field="ed:cond-value:0"[^>]*value="pkginfo@ups.com"/);
  });

  it('keeps its kind while a new template saves, so the template stays savable', async () => {
    let finish: () => void = () => {};
    const createTemplate = vi.fn(({ definition }: { definition: MailTemplateDefinition }) =>
      new Promise<{ template: MailTemplate }>((resolve) => { finish = () => resolve({ template: template({ type: definition.type }) }); }));
    const h = harness({ readEmail: async () => content, createTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail(ref);
    h.act('mail-facts-ed-save');
    // While it saves, the kind cannot change: the picker is off, and a change is not taken.
    expect(h.html()).toMatch(/data-recued-mail-facts-field="ed:type"[^>]*disabled/);
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:type' }, 'purchase'));
    finish();
    await flush();
    expect(createTemplate).toHaveBeenCalledTimes(1);
    expect(createTemplate.mock.calls[0]![0].definition.type).toBe('shipment');
    // Nothing changed while it saved: it closes.
    await vi.waitFor(() => expect(h.view.addressSegments()).toEqual([]));
  });

  it('a save that lands for a kind the editor no longer has keeps its own template: this one is new', async () => {
    const draftedPurchase = {
      definition: {
        name: 'Shop orders', type: 'purchase' as const,
        entrance: { conditions: [{ field: 'from' as const, op: 'is' as const, value: 'pkginfo@ups.com' }], variables: ['order_id'] },
        rules: [{ target: { variable: 'order_id' }, source: 'body' as const, find: { kind: 'after_label' as const, label: 'Order:' } }],
        html: false, ai: { enabled: false as const },
      },
      dropped: [],
    };
    let answer: (value: typeof draftedPurchase) => void = () => {};
    const draftTemplate = vi.fn(() => new Promise<typeof draftedPurchase>((resolve) => { answer = resolve; }));
    let finish: () => void = () => {};
    const createTemplate = vi.fn(({ definition }: { definition: MailTemplateDefinition }) =>
      new Promise<{ template: MailTemplate }>((resolve) => { finish = () => resolve({ template: template({ template_id: 'mtpl_ship', type: definition.type }) }); }));
    const h = harness({ readEmail: async () => content, draftTemplate, createTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail(ref);
    h.act('mail-facts-ed-draft');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:name' }, 'My parcels'));
    h.act('mail-facts-ed-save');
    answer(draftedPurchase);
    await flush();
    // The late draft, a purchase, is taken while the shipment template saves.
    h.act('mail-facts-ed-draft-late-use');
    finish();
    await flush();
    // The saved shipment keeps its own template; this one is a new purchase.
    h.act('mail-facts-ed-save');
    expect(createTemplate).toHaveBeenCalledTimes(2);
    expect(createTemplate.mock.calls[1]![0].definition.type).toBe('purchase');
  });

  it('a save for an editor that was left keeps the one open now open, as it is', async () => {
    let finish: () => void = () => {};
    const createTemplate = vi.fn(() => new Promise<{ template: MailTemplate }>((resolve) => { finish = () => resolve({ template: template() }); }));
    const h = harness({ readEmail: async () => content, createTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail(ref);
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('1Z999AA10123456784') });
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-variable' }, 'tracking_number'));
    h.act('mail-facts-ed-pick-add');
    h.act('mail-facts-ed-save');
    expect(h.view.hasInFlightWork()).toBe(true);
    // While it saves, the owner leaves it and starts another.
    h.act('mail-facts-ed-back');
    h.act('mail-facts-ed-leave-confirm');
    h.act('mail-facts-tpl-new');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:name' }, 'Shop orders'));
    finish();
    await flush();
    expect(createTemplate).toHaveBeenCalledTimes(1);
    expect(h.view.addressSegments()).toEqual(['new']);
    expect(h.html()).toContain('value="Shop orders"');
    expect(h.view.hasInFlightWork()).toBe(false);
  });

  it('a change made while it saves is kept: the editor stays on the saved template, the change not saved yet', async () => {
    let finish: () => void = () => {};
    const createTemplate = vi.fn((args: { definition: MailTemplateDefinition }) =>
      new Promise<{ template: MailTemplate }>((resolve) => {
        finish = () => resolve({ template: template({ ...args.definition, template_id: 'mtpl_9' }) });
      }));
    const updateTemplate = vi.fn(async (args: { template_id: string; definition?: MailTemplateDefinition }) =>
      ({ template: template({ template_id: args.template_id, ...(args.definition ?? {}) }) }));
    const h = harness({ readEmail: async () => content, createTemplate, updateTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail(ref);
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:name' }, 'First name'));
    h.act('mail-facts-ed-save');
    // While it saves, the owner types a newer name.
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:name' }, 'Newer name'));
    finish();
    await flush();
    expect(createTemplate.mock.calls[0]![0].definition.name).toBe('First name');
    // The newer name is still there, on the template the save made.
    expect(h.view.addressSegments()).toEqual(['mtpl_9']);
    expect(h.html()).toContain('value="Newer name"');
    expect(h.html()).toContain('Saved. Your changes since are not saved yet.');
    expect(h.view.hasUnsavedChanges()).toBe(true);
    expect(h.view.hasInFlightWork()).toBe(false);
    // What was saved is the measure now: back to it, nothing is unsaved.
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:name' }, 'First name'));
    expect(h.view.hasUnsavedChanges()).toBe(false);
    expect(h.html()).not.toContain('Saved. Your changes since are not saved yet.');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:name' }, 'Newer name'));
    // Saving again updates that template: no second one.
    h.act('mail-facts-ed-save');
    await vi.waitFor(() => expect(updateTemplate).toHaveBeenCalledTimes(1));
    expect(updateTemplate.mock.calls[0]![0]).toMatchObject({ template_id: 'mtpl_9', definition: { name: 'Newer name' } });
    expect(createTemplate).toHaveBeenCalledTimes(1);
    // Nothing changed during that save: its editor closes.
    await vi.waitFor(() => expect(h.view.addressSegments()).toEqual([]));
  });

  it('the newest preview wins, and Preview waits while one runs', async () => {
    const answers: Array<(result: MailTemplatePreviewResult) => void> = [];
    const previewTemplate = vi.fn(() => new Promise<MailTemplatePreviewResult>((resolve) => { answers.push(resolve); }));
    const h = harness({ readEmail: async () => content, previewTemplate, draftTemplate: async () => draftedUps });
    await h.view.openFromEmail(ref);
    h.act('mail-facts-ed-preview');
    expect(h.html()).toMatch(/mail-facts-ed-preview" data-recued-mail-facts-focus="ed:preview" aria-disabled="true" aria-busy="true"/);
    h.act('mail-facts-ed-preview');
    expect(previewTemplate).toHaveBeenCalledTimes(1);
    // A draft previews what it drafted: that preview is the newest.
    h.act('mail-facts-ed-draft');
    await vi.waitFor(() => expect(previewTemplate).toHaveBeenCalledTimes(2));
    answers[1]!({ recent: [], scanned: 7 });
    await vi.waitFor(() => expect(h.html()).toContain('None among the 7 newest emails.'));
    // The first lands late: it is not shown over the newer one.
    answers[0]!({ recent: [], scanned: 120 });
    await flush();
    expect(h.html()).toContain('None among the 7 newest emails.');
    expect(h.html()).not.toContain('None among the 120 newest emails.');
  });

  it('reading past mail started for one template keeps another’s form, opened meanwhile, open', async () => {
    let started: (job: never) => void = () => {};
    const startBackfill = vi.fn(() => new Promise<never>((resolve) => { started = resolve; }));
    const h = harness({
      listTemplates: async () => ({ templates: [template(), template({ template_id: 'mtpl_2', name: 'Shop notices' })] }),
      getBackfill: async () => ({ job: null, max_days: 90 }),
      startBackfill,
    });
    await h.view.refresh();
    h.act('mail-facts-bf-open', { 'data-template-id': 'mtpl_1' });
    h.act('mail-facts-bf-start', { 'data-template-id': 'mtpl_1' });
    expect(h.view.hasInFlightWork()).toBe(true);
    h.act('mail-facts-bf-open', { 'data-template-id': 'mtpl_2' });
    started({
      job_id: 'mbf_1', template_id: 'mtpl_1', days: 30, run_recipes: false, status: 'running',
      total: 40, read: 0, facts: 0, events: 0, stored_copies: 0, kept: 0, started_at: 1,
    } as never);
    await flush();
    expect(h.html()).toContain('mail-facts-bf-start" data-template-id="mtpl_2"');
    expect(h.view.hasInFlightWork()).toBe(false);
  });

  it('a trigger made for one template says nothing on another’s “Then run…”, opened meanwhile', async () => {
    const recipes = [
      { recipe_id: 'parcel-alert', publisher_id: 'local', version: 1, recipe_hash: 'h', recipe: { metadata: { name: 'Tell me when a parcel arrives' } } },
    ] as never;
    let made: () => void = () => {};
    const createTrigger = vi.fn(() => new Promise<never>((resolve) => { made = () => resolve({} as never); }));
    const h = harness({
      listTemplates: async () => ({ templates: [template(), template({ template_id: 'mtpl_2', name: 'Shop notices' })] }),
      listRecipes: async () => ({ recipes }),
      createTrigger,
    });
    await h.view.refresh();
    h.act('mail-facts-tr-open', { 'data-template-id': 'mtpl_1' });
    await vi.waitFor(() => expect(h.html()).toContain('Tell me when a parcel arrives'));
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'tr:recipe' }, 'local/parcel-alert'));
    h.act('mail-facts-tr-create', { 'data-template-id': 'mtpl_1' });
    expect(createTrigger).toHaveBeenCalledTimes(1);
    h.act('mail-facts-tr-open', { 'data-template-id': 'mtpl_2' });
    await vi.waitFor(() => expect(h.html()).toContain('mail-facts-tr-create" data-template-id="mtpl_2"'));
    made();
    await flush();
    expect(h.html()).not.toContain('now runs for what');
    expect(h.html()).toContain('mail-facts-tr-create" data-template-id="mtpl_2"');
  });
});

describe('another kind of email for a new template (§6.1)', () => {
  it('keeps the rules that fit it, and asks first, naming how many, before it leaves any out', async () => {
    const createTemplate = vi.fn(async (args: { definition: MailTemplateDefinition }) => ({ template: template({ ...args.definition }) }));
    const h = harness({ readEmail: async () => content, createTemplate, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    const add = (text: string, variable: string, means?: string) => {
      h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex(text) });
      h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-variable' }, variable));
      if (means !== undefined) h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-means' }, means));
      h.act('mail-facts-ed-pick-add');
    };
    add('1Z999AA10123456784', 'tracking_number');
    add('UPS', 'merchant');
    add('UPS Update: Delivered', 'state', 'delivered');
    // A data field fits every kind.
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('1Z999AA10123456784') });
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-data' }, 'reference'));
    h.act('mail-facts-ed-pick-add');

    // A purchase has a merchant, but no tracking number and no “delivered”.
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:type' }, 'purchase'));
    expect(h.html()).toContain('Purchase has no place for 2 of the rules you made: they are left out if you switch.');
    expect(h.focus).toHaveBeenLastCalledWith('ed:type-confirm');
    h.act('mail-facts-ed-type-cancel');
    expect(h.html()).not.toContain('has no place for');
    expect(h.html()).toMatch(/<option value="shipment" selected>Shipment<\/option>/);
    expect(h.html()).toContain('<span class="mail-facts-rule-target">Tracking number</span>');

    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:type' }, 'purchase'));
    h.act('mail-facts-ed-type-confirm');
    expect(h.html()).toMatch(/<option value="purchase" selected>Purchase<\/option>/);
    // What fits a purchase changes kind with no question.
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:type' }, 'return_refund'));
    expect(h.html()).not.toContain('has no place for');
    expect(h.html()).toMatch(/<option value="return_refund" selected>Return or refund<\/option>/);

    h.act('mail-facts-ed-save');
    await vi.waitFor(() => expect(createTemplate).toHaveBeenCalled());
    const { definition } = createTemplate.mock.calls[0]![0];
    expect(definition.type).toBe('return_refund');
    expect(definition.rules).toEqual([
      { target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'whole' } },
      expect.objectContaining({ target: { data: 'reference' } }),
    ]);
  });

  it('asks the same when a kind of email made from the picker has no place for a rule', async () => {
    const createType = vi.fn(async ({ spec }: { spec: MailFactTypeSpec }) => ({ type: spec }));
    const h = harness({ readEmail: async () => content, listTypes: async () => ({ types: [] }), createType });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('1Z999AA10123456784') });
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:pick-variable' }, 'tracking_number'));
    h.act('mail-facts-ed-pick-add');
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:type' }, '__new__'));
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ty:name' }, 'Club newsletter'));
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ty:var-name:0' }, 'issue'));
    h.act('mail-facts-ty-save');
    await vi.waitFor(() => expect(h.html()).toContain('Club newsletter has no place for 1 of the rules you made: it is left out if you switch.'));
    expect(h.html()).toMatch(/<option value="shipment" selected>Shipment<\/option>/);
    h.act('mail-facts-ed-type-confirm');
    expect(h.html()).toMatch(/<option value="custom_club_newsletter" selected>Club newsletter<\/option>/);
    expect(h.html()).not.toContain('<span class="mail-facts-rule-target">Tracking number</span>');
  });

  it('a kind made from the picker and changed while it saves stays open, and the template keeps its kind until it closes', async () => {
    let finish: () => void = () => {};
    const createType = vi.fn(({ spec }: { spec: MailFactTypeSpec }) =>
      new Promise<{ type: MailFactTypeSpec }>((resolve) => { finish = () => resolve({ type: spec }); }));
    const updateType = vi.fn(async ({ spec }: { spec: MailFactTypeSpec }) => ({ type: spec }));
    const h = harness({ readEmail: async () => content, listTypes: async () => ({ types: [] }), createType, updateType });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:type' }, '__new__'));
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ty:name' }, 'Club newsletter'));
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ty:var-name:0' }, 'issue'));
    h.act('mail-facts-ty-save');
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ty:description' }, 'The monthly letter.'));
    h.focus.mockClear();
    finish();
    await vi.waitFor(() => expect(h.html()).toContain('Saved. Your changes since are not saved yet.'));
    // The kind's form is still what shows; the template has not moved to it yet.
    expect(h.html()).toContain('Edit “Club newsletter”');
    expect(h.focus).not.toHaveBeenCalledWith('ed:type');
    h.act('mail-facts-ty-save');
    await vi.waitFor(() => expect(updateType).toHaveBeenCalledTimes(1));
    // Saved with nothing changed since: the form closes, and the template takes the kind.
    await vi.waitFor(() => expect(h.html()).toMatch(/<option value="custom_club_newsletter" selected>Club newsletter<\/option>/));
    expect(h.focus).toHaveBeenCalledWith('ed:type');
    expect(createType).toHaveBeenCalledTimes(1);
  });
});

describe('what stays as the owner left it across repaints', () => {
  it('keeps “More” and “Left out” open or shut, and opening one repaints nothing', async () => {
    const drafted = {
      definition: {
        name: 'UPS notices', type: 'shipment' as const,
        entrance: { conditions: [{ field: 'from' as const, op: 'is' as const, value: 'pkginfo@ups.com' }], variables: [] },
        rules: [], html: false, ai: { enabled: false as const },
      },
      dropped: ['the rule for merchant: it held a privacy alias, not a real value'],
    };
    const h = harness({ readEmail: async () => content, draftTemplate: async () => drafted });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    expect(h.html()).toContain('<details class="mail-facts-advanced">');
    h.render.mockClear();
    // The browser opens it; a repaint here would shut it again.
    h.act('mail-facts-ed-advanced');
    expect(h.render).not.toHaveBeenCalled();
    // Something else repaints: it stays open.
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('UPS') });
    expect(h.render).toHaveBeenCalled();
    expect(h.html()).toContain('<details class="mail-facts-advanced" open>');
    h.act('mail-facts-ed-advanced');
    expect(h.html()).toContain('<details class="mail-facts-advanced">');

    h.act('mail-facts-ed-pick-cancel');
    h.act('mail-facts-ed-draft');
    await vi.waitFor(() => expect(h.html()).toContain('Left out (1)'));
    expect(h.html()).toContain('<details class="mail-facts-dropped"><summary');
    h.act('mail-facts-ed-dropped');
    h.act('mail-facts-ed-pick', { 'data-pick': h.pickIndex('UPS') });
    expect(h.html()).toContain('<details class="mail-facts-dropped" open><summary');
  });
});

describe('leaving a template with changes (§6.1)', () => {
  it('asks first — for the list, or for another email to make a template from', async () => {
    const other = { ...content, email: { ...content.email, record_id: 'mail:2', subject: 'Your order has shipped' } };
    const readEmail = vi.fn(async (ref: { record_id: string }) => (ref.record_id === 'mail:2' ? other : content));
    const h = harness({ readEmail, listTemplates: async () => ({ templates: [] }) });
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:1' });
    expect(h.view.hasUnsavedChanges()).toBe(false);
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ed:name' }, 'My parcels'));
    expect(h.view.hasUnsavedChanges()).toBe(true);

    h.act('mail-facts-ed-back');
    expect(h.html()).toContain('Leave this template? Your changes to it are not saved.');
    expect(h.focus).toHaveBeenLastCalledWith('ed:leave-keep');
    expect(h.view.addressSegments()).toEqual(['new']);
    h.act('mail-facts-ed-leave-cancel');
    expect(h.html()).not.toContain('Leave this template?');
    expect(h.html()).toContain('value="My parcels"');

    // “Make a template from this email” on another email: asked first, read
    // only once the owner says so.
    await h.view.openFromEmail({ slug: 'work', record_id: 'mail:2' });
    expect(readEmail).toHaveBeenCalledTimes(1);
    expect(h.html()).toContain('Open the other email instead? Your changes to this template are not saved.');
    expect(h.html()).toContain('value="My parcels"');
    h.act('mail-facts-ed-leave-confirm');
    await vi.waitFor(() => expect(h.html()).toContain('Your order has shipped'));
    expect(readEmail).toHaveBeenLastCalledWith({ slug: 'work', record_id: 'mail:2' });
    expect(h.view.hasUnsavedChanges()).toBe(false);

    // Nothing changed: back goes at once.
    h.act('mail-facts-ed-back');
    expect(h.view.addressSegments()).toEqual([]);
  });

  it('counts a kind of email with changes, and one being saved', async () => {
    let finish: () => void = () => {};
    const createType = vi.fn(({ spec }: { spec: MailFactTypeSpec }) => new Promise<{ type: MailFactTypeSpec }>((resolve) => { finish = () => resolve({ type: spec }); }));
    const h = harness({ listTemplates: async () => ({ templates: [] }), listTypes: async () => ({ types: [] }), createType });
    await h.view.refresh();
    h.act('mail-facts-tpl-type-new');
    expect(h.view.hasUnsavedChanges()).toBe(false);
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ty:name' }, 'Club newsletter'));
    h.view.handleInput(el({ [MAIL_FACTS_FIELD_ATTR]: 'ty:var-name:0' }, 'issue'));
    expect(h.view.hasUnsavedChanges()).toBe(true);
    h.act('mail-facts-ty-save');
    expect(h.view.hasInFlightWork()).toBe(true);
    finish();
    await vi.waitFor(() => expect(h.view.hasInFlightWork()).toBe(false));
    expect(h.view.hasUnsavedChanges()).toBe(false);
  });
});

describe('the switches (§6.2)', () => {
  it('while one saves, every switch says so, and one clicked goes back as it was', async () => {
    let done: () => void = () => {};
    const updateTemplate = vi.fn(() => new Promise<{ template: MailTemplate }>((resolve) => { done = () => resolve({ template: template() }); }));
    const setStandards = vi.fn();
    const h = harness({
      listTemplates: async () => ({ templates: [template(), template({ template_id: 'mtpl_2', name: 'Shop notices', active: false })] }),
      getStandards: async () => ({ standards: [{ type: 'shipment', on: true }] }),
      updateTemplate,
      setStandards,
    });
    await h.view.refresh();
    // Its name is the template's: a list of switches all called “On” says nothing.
    expect(h.html()).toMatch(/data-template-id="mtpl_2"\s+aria-label="Read new mail with “Shop notices”"/);
    expect(h.html()).toContain('<span aria-hidden="true">Off</span>');
    h.act('mail-facts-tpl-toggle', { 'data-template-id': 'mtpl_1' });
    expect(h.html()).toMatch(/data-template-id="mtpl_2"\s+aria-label="[^"]*"[^>]*aria-disabled="true"/);
    expect(h.html()).toMatch(/data-type="shipment"[^>]*aria-disabled="true"/);
    h.render.mockClear();
    // The browser flips a box as it is clicked: nothing is sent, and it is
    // drawn again as it is.
    h.act('mail-facts-tpl-toggle', { 'data-template-id': 'mtpl_2' });
    h.act('mail-facts-std-toggle', { 'data-type': 'shipment' });
    expect(updateTemplate).toHaveBeenCalledTimes(1);
    expect(setStandards).not.toHaveBeenCalled();
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(h.focus).toHaveBeenLastCalledWith('std:shipment');
    done();
    await vi.waitFor(() => expect(h.html()).not.toContain('aria-disabled="true"'));
  });
});

describe('a template that no longer exists (§6.2)', () => {
  it('shows only that, and the way back', async () => {
    const h = harness({ getTemplate: async () => ({ template: null }), listTemplates: async () => ({ templates: [] }) });
    h.view.openAddress(['mtpl_gone']);
    await h.view.refresh();
    const html = h.html();
    expect(html).toContain('Template not found');
    expect(html).toContain('This template no longer exists: it may have been deleted.');
    expect(html).toContain('mail-facts-ed-back');
    expect(html).not.toContain('Save template');
    expect(html).not.toContain('Kind of email');
    expect(html).not.toContain('Preview');
    expect(h.view.hasUnsavedChanges()).toBe(false);
    h.act('mail-facts-ed-back');
    expect(h.view.addressSegments()).toEqual([]);
  });
});

describe('a template a recipe brought (§5.2)', () => {
  const brought = (over: Partial<MailTemplate> = {}): MailTemplate => template({
    template_id: 'mtpl_r',
    name: 'Shop parcels',
    origin: { kind: 'recipe', publisher: 'recued-core', recipe: 'shop-parcels', variable: 'template', version: 1 },
    ai: { enabled: false, prompt: 'Read the depot.', slots: ['data.depot'], pool: 'free_only' },
    ...over,
  });
  const recipes = async () => ({
    recipes: [{ recipe_id: 'shop-parcels', recipe: { metadata: { name: 'Shop parcels desk' } } }] as never,
  });

  it('names its recipe, offers "Duplicate to edit" for Edit, and no Delete: it goes with its recipe', async () => {
    const h = harness({ listTemplates: async () => ({ templates: [brought(), template()] }), listRecipes: recipes, duplicateTemplate: vi.fn() });
    await h.view.refresh();
    const row = h.html().split('data-recued-mail-fact-template="mtpl_1"')[0]!;
    expect(row).toContain('From the recipe Shop parcels desk');
    expect(row).toContain('Duplicate to edit');
    expect(row).not.toContain('mail-facts-tpl-edit');
    expect(row).not.toContain('mail-facts-tpl-delete');
    expect(row).toContain('Updates with its recipe, and goes with it');
    // The owner's own keeps its Edit and Delete.
    const mine = h.html().split('data-recued-mail-fact-template="mtpl_1"')[1]!;
    expect(mine).toContain('mail-facts-tpl-edit');
    expect(mine).toContain('mail-facts-tpl-delete');
  });

  it('duplicates to edit, then opens the copy', async () => {
    const copy = template({ template_id: 'mtpl_copy', name: 'Shop parcels (copy)' });
    const duplicateTemplate = vi.fn(async () => ({ template: copy }));
    const getTemplate = vi.fn(async ({ template_id }: { template_id: string }) => ({ template: template_id === 'mtpl_copy' ? copy : null }));
    const h = harness({ listTemplates: async () => ({ templates: [brought()] }), listRecipes: recipes, duplicateTemplate, getTemplate });
    await h.view.refresh();
    h.act('mail-facts-tpl-duplicate', { 'data-template-id': 'mtpl_r' });
    await vi.waitFor(() => expect(h.html()).toContain('Edit “Shop parcels (copy)”'));
    expect(duplicateTemplate).toHaveBeenCalledWith({ template_id: 'mtpl_r' });
  });

  it('switches its AI on and off, and picks its pool, sending the recipe’s definition back as it is', async () => {
    let current = brought();
    const updateTemplate = vi.fn(async ({ definition }: { template_id: string; definition?: MailTemplateDefinition }) => {
      current = { ...current, ...definition! };
      return { template: current };
    });
    const h = harness({ listTemplates: async () => ({ templates: [current] }), listRecipes: recipes, updateTemplate });
    await h.view.refresh();
    expect(h.html()).toContain('Turn AI on');
    h.act('mail-facts-tpl-ai', { 'data-template-id': 'mtpl_r' });
    await vi.waitFor(() => expect(h.html()).toContain('Turn AI off'));
    const { ai, ...rest } = updateTemplate.mock.calls[0]![0].definition!;
    expect(ai).toEqual({ enabled: true, prompt: 'Read the depot.', slots: ['data.depot'], pool: 'free_only' });
    expect(rest.rules).toEqual(brought().rules);
    h.view.handleChange(el({ [MAIL_FACTS_FIELD_ATTR]: 'tpl:pool:mtpl_r' }, 'byok_only'));
    await vi.waitFor(() => expect(updateTemplate).toHaveBeenCalledTimes(2));
    expect(updateTemplate.mock.calls[1]![0].definition!.ai).toEqual({
      enabled: true, prompt: 'Read the depot.', slots: ['data.depot'], pool: 'byok_only',
    });
  });

  it('offers no AI switch when the recipe gave its template no prompt', async () => {
    const h = harness({ listTemplates: async () => ({ templates: [brought({ ai: { enabled: false } })] }), updateTemplate: vi.fn() });
    await h.view.refresh();
    expect(h.html()).not.toContain('Turn AI on');
  });

  it('opens read-only: it says whose rules they are, and offers the copy instead of Save', async () => {
    const h = harness({
      listTemplates: async () => ({ templates: [brought()] }),
      listRecipes: recipes,
      getTemplate: async () => ({ template: brought() }),
      duplicateTemplate: vi.fn(),
    });
    await h.view.refresh();
    h.view.openAddress(['mtpl_r']);
    await h.view.refresh();
    await vi.waitFor(() => expect(h.html()).toContain('This template comes with the recipe Shop parcels desk'));
    expect(h.html()).not.toContain('mail-facts-ed-save');
    expect(h.html()).toContain('Duplicate to edit');
    // Its fields are shown, not edited: nothing would save them.
    expect(h.html()).toContain('<fieldset class="mail-facts-readonly" disabled>');
    expect(h.html()).not.toContain('Edit “Shop parcels”');
  });
});

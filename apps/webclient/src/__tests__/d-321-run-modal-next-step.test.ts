/** D-321 P2 — a run refused for a connection not set up says where to set one
 *  up, and every run dialog the webclient opens offers a refused run's next step.
 *
 *  The extraction decides between an offer and the plain message, so each way it
 *  can wrongly say yes puts a link in front of the owner that cannot help, and
 *  each way it wrongly says no hides the only one that would. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';

import { connectionsEnrollAddress, connectionsLaneAddress, connectionsReviewAccessAddress } from '../connections/connections-navigation.js';
import {
  CONNECTION_SETUP_OFFER_ATTR,
  CONNECTION_SETUP_OFFER_SLOT_ATTR,
  connectionSetupFromError,
  connectionSetupLink,
  renderConnectionSetupOffer,
} from '../shell/connection-setup-offer.js';
import { programsBeforeRun, runModalNextStep } from '../shell/run-modal.js';
import {
  RUN_NEEDS_OFFER_ATTR,
  RUN_NEEDS_OFFER_KIND_ATTR,
  renderRunNeedsOffer,
  runNeedStep,
  runNeedsNextStep,
  runNeedsStep,
} from '../shell/run-needs-offer.js';
import type { RunNeed, ServerExecuteResponse, ServerRecipeListEntry } from '@recued/contracts';

const refusal = (details: unknown): RpcError =>
  new RpcError('connection_not_set_up', "Recipe 'x' needs a connection for 'exa'", 400, undefined,
    details as Record<string, unknown>);

describe('connectionSetupFromError', () => {
  it('reads what the owner\'s refusal says, and only that', () => {
    expect(connectionSetupFromError(refusal({ slot: 'exa', pack_slug: 'exa', vendor: 'exa', label: 'Exa', extra: 1 })))
      .toEqual({ slot: 'exa', pack_slug: 'exa', vendor: 'exa', label: 'Exa' });
    // An error that lost its prototype on the way still offers.
    expect(connectionSetupFromError({ code: 'connection_not_set_up', details: { slot: 'exa' } }))
      .toEqual({ slot: 'exa' });
  });

  it('is not an offer without a slot, or for any other error', () => {
    expect(connectionSetupFromError(refusal({}))).toBeNull();
    expect(connectionSetupFromError(refusal({ slot: '  ' }))).toBeNull();
    expect(connectionSetupFromError(new RpcError('connection_not_set_up', 'no details', 400))).toBeNull();
    expect(connectionSetupFromError(new RpcError('connection_choice_invalid', 'x', 400, undefined, { slot: 'exa' })))
      .toBeNull();
    // ⛔ Never from the message: the details are the contract.
    expect(connectionSetupFromError(new Error("needs a connection for 'exa'"))).toBeNull();
  });
});

describe('connectionSetupLink', () => {
  it("opens the vendor's form for the pack's sign-in, as the pack page's Set up does", () => {
    // The slot and the vendor differ for 59 packs (`adobe-sign` signs in as
    // `adobe_sign`): the form matches the pack's requirement by vendor.
    expect(connectionSetupLink({ slot: 'adobe-sign', pack_slug: 'adobe-sign', vendor: 'adobe_sign', label: 'Adobe Sign' }))
      .toEqual({
        href: connectionsEnrollAddress('adobe_sign', { slug: 'adobe-sign', slot: 'adobe-sign' }).hash,
        text: 'Set up Adobe Sign',
      });
  });

  it("falls back to the pack's page, then to Connections", () => {
    expect(connectionSetupLink({ slot: 'acme', pack_slug: 'acme', label: 'acme' }))
      .toEqual({ href: '#packs/acme', text: 'Open its pack' });
    // A server from before D-321 sends the slot alone.
    expect(connectionSetupLink({ slot: 'acme' }))
      .toEqual({ href: connectionsLaneAddress('others').hash, text: 'Open Connections' });
  });
});

describe('renderConnectionSetupOffer', () => {
  it('names the service and links to its form, escaped', () => {
    const html = renderConnectionSetupOffer({ slot: 'exa', pack_slug: 'exa', vendor: 'exa', label: 'E<x>a' });
    expect(html).toContain(CONNECTION_SETUP_OFFER_ATTR);
    expect(html).toContain(`${CONNECTION_SETUP_OFFER_SLOT_ATTR}="exa"`);
    expect(html).toContain('This needs a connection to E&lt;x&gt;a, and none is set up for it yet.');
    expect(html).toContain(`href="${connectionsEnrollAddress('exa', { slug: 'exa', slot: 'exa' }).hash}"`);
    expect(html).not.toContain('<x>');
  });
});

describe('runModalNextStep', () => {
  it('offers the missing packs and the connection to set up, as the pages do', () => {
    expect(runModalNextStep(new RpcError('pack_not_installed', 'x', 400, undefined,
      { missing_packs: ['recued-core.docling', 'recued-core.whisper'] }))).toEqual({
      lead: 'This recipe needs packs you don’t have installed yet. Install them, then run again.',
      links: [
        { text: 'Get docling', href: '#packs/docling' },
        { text: 'Get whisper', href: '#packs/whisper' },
      ],
    });
    expect(runModalNextStep(refusal({ slot: 'exa', pack_slug: 'exa', vendor: 'exa', label: 'Exa' }))).toEqual({
      lead: 'This needs a connection to Exa, and none is set up for it yet. Set one up, then run again.',
      links: [{ text: 'Set up Exa', href: connectionsEnrollAddress('exa', { slug: 'exa', slot: 'exa' }).hash }],
    });
    expect(runModalNextStep(new RpcError('bad_request', 'nope', 400))).toBeNull();
  });
});

// D-346 follow-up (2026-11-08) — the owner's ruling: a "Turn it on" button for a program
// switched off for them, in the run dialog; the result panel still links to the pack.
describe('a program switched off for the owner — "Turn it on"', () => {
  const off: RunNeed = {
    kind: 'switch', step_id: 'find', ingredient_id: 'rg-catalog', operation_id: 'search', pack_slug: 'ripgrep', label: 'Ripgrep',
  };

  it('says what happened and links to the pack', () => {
    expect(runNeedStep(off)).toEqual({
      lead: 'Ripgrep runs a program on your server that is switched off for you, so the run stopped there.',
      link: { text: 'Open Ripgrep', href: '#packs/ripgrep' },
    });
  });

  it('turns it on from the dialog when the dialog can, every one the run named at once', async () => {
    const turned: Array<{ ingredient_id: string; operation_id: string }> = [];
    const turnOn = async (need: { ingredient_id: string; operation_id: string }) => { turned.push(need); };
    const one = runNeedsStep([off], turnOn)!;
    expect(one.action).toMatchObject({ text: 'Turn it on', done: "Ripgrep's program is on now. Run it again." });
    await one.action!.run();
    expect(turned).toEqual([{ ingredient_id: 'rg-catalog', operation_id: 'search' }]);
    const two = runNeedsStep([off, { ...off, step_id: 'list', operation_id: 'list' }], turnOn)!;
    expect(two.action).toMatchObject({ text: 'Turn them on', done: 'Their programs are on now. Run it again.' });
  });

  it('links only, when the dialog cannot turn it on, or nothing is switched off', () => {
    expect(runNeedsStep([off])!.action).toBeUndefined();
    expect(runNeedsStep([{ kind: 'program', step_id: 'find', problem: 'not_found', tool: 'rg' }], async () => {})!.action)
      .toBeUndefined();
  });
});

describe('runNeedStep — what a failed step needed', () => {
  const reconnect: RunNeed = {
    kind: 'connection', step_id: 'search', problem: 'reconnect', slot: 'exa',
    connection_name: 'exa-key', pack_slug: 'exa', vendor: 'exa', label: 'Exa',
  };

  it("a turned-down sign-in opens that connection's editor, where a key is replaced or an OAuth sign-in starts again", () => {
    expect(runNeedStep(reconnect)).toEqual({
      lead: 'Exa did not accept this run’s sign-in. Reconnect it, then run again.',
      link: { text: 'Reconnect Exa', href: connectionsReviewAccessAddress('exa-key').hash },
    });
    // Several connections there: the run cannot say which one, so the pack's page.
    expect(runNeedStep({ ...reconnect, connection_name: undefined }).link)
      .toEqual({ text: 'Open its pack', href: '#packs/exa' });
    expect(runNeedStep({ kind: 'connection', step_id: 's', problem: 'reconnect', slot: 'acme' }).link)
      .toEqual({ text: 'Open Connections', href: connectionsLaneAddress('others').hash });
  });

  it('a connection the step named that is not set up says what a refusal before the run says', () => {
    expect(runNeedStep({ ...reconnect, problem: 'set_up' })).toEqual({
      lead: 'This needs a connection to Exa, and none is set up for it yet. Set one up, then run again.',
      link: { text: 'Set up Exa', href: connectionsEnrollAddress('exa', { slug: 'exa', slot: 'exa' }).hash },
    });
  });

  it("a program links to its pack's page, in the program's own case", () => {
    const missing: RunNeed = { kind: 'program', step_id: 'find', problem: 'not_found', tool: 'rg', pack_slug: 'ripgrep', label: 'Ripgrep' };
    expect(runNeedStep(missing)).toEqual({
      lead: 'rg is not installed on your server, or your server cannot find it. Its pack’s page shows what to do.',
      link: { text: 'Open Ripgrep', href: '#packs/ripgrep' },
    });
    expect(runNeedStep({ ...missing, problem: 'untested_version' }).lead)
      .toBe('The version of rg on your server was not tested with this pack. Its pack’s page shows what to do.');
    // No pack named: the sentence alone, never a link to nowhere.
    expect(runNeedStep({ kind: 'program', step_id: 'find', problem: 'broken' })).toEqual({
      lead: 'A program this run uses is installed on your server, but it did not start. Its pack’s page shows what to do.',
      link: null,
    });
  });
});

describe('runNeedsNextStep and renderRunNeedsOffer', () => {
  const result = (run_needs?: RunNeed[]): ServerExecuteResponse => ({
    recipe_id: 'r', recipe_hash: 'h', success: false, output: { render: [], sidebar: [] }, steps: [], errors: [],
    duration_ms: 1, ...(run_needs !== undefined ? { run_needs } : {}),
  });
  const needs: RunNeed[] = [
    { kind: 'connection', step_id: 'search', problem: 'reconnect', slot: 'exa', connection_name: 'exa-key', label: 'E<x>a' },
    { kind: 'program', step_id: 'find', problem: 'not_found', tool: 'rg' },
  ];

  it('the dialog gets every sentence and each link there is; a run that needed nothing gets none', () => {
    expect(runNeedsNextStep(result(needs))).toEqual({
      lead: 'E<x>a did not accept this run’s sign-in. Reconnect it, then run again. '
        + 'rg is not installed on your server, or your server cannot find it. Its pack’s page shows what to do.',
      links: [{ text: 'Reconnect E<x>a', href: connectionsReviewAccessAddress('exa-key').hash }],
    });
    expect(runNeedsNextStep(result())).toBeNull();
    expect(runNeedsNextStep(result([]))).toBeNull();
  });

  it('the result panel draws a row per need, escaped', () => {
    const html = renderRunNeedsOffer(result(needs));
    expect(html).toContain(RUN_NEEDS_OFFER_ATTR);
    expect(html).toContain('E&lt;x&gt;a did not accept');
    expect(html).toContain(`${RUN_NEEDS_OFFER_KIND_ATTR}="connection">Reconnect E&lt;x&gt;a</a>`);
    expect(html).not.toContain('<x>');
    expect(renderRunNeedsOffer(result())).toBe('');
    expect(renderRunNeedsOffer(null)).toBe('');
  });
});

describe('programsBeforeRun — a program that would stop the run, said before it (D-321 C2)', () => {
  const recipe = { recipe: { depends_on: ['recued-core.ripgrep'] } } as unknown as Pick<ServerRecipeListEntry, 'recipe'>;
  const status = (tools: Array<Record<string, unknown>>) => async () => ({
    system: 'darwin' as const,
    packs: [{ slug: 'ripgrep', tools: tools.map((tool) => ({ catalog: 'rg-catalog', binary: 'rg', install: [], docs: [], ...tool })) }],
  }) as never;

  it('names a missing program and links its pack', async () => {
    expect(await programsBeforeRun(recipe, status([{ state: 'missing' }]))).toEqual({
      lead: 'rg is not installed on your server, or your server cannot find it. Its pack’s page shows what to do.',
      links: [{ text: 'Open its pack', href: '#packs/ripgrep' }],
    });
  });

  it('a program that runs says nothing: ready, or an untested version under Warn', async () => {
    expect(await programsBeforeRun(recipe, status([{ state: 'ready' }]))).toBeNull();
    expect(await programsBeforeRun(recipe, status([{ state: 'untested', outside: 'warn' }]))).toBeNull();
    expect((await programsBeforeRun(recipe, status([{ state: 'untested', outside: 'refuse' }])))?.lead)
      .toContain('The version of rg on your server was not tested with this pack.');
  });

  it('a recipe naming no pack, or a read that fails, says nothing', async () => {
    expect(await programsBeforeRun({ recipe: {} } as never, status([{ state: 'missing' }]))).toBeNull();
    expect(await programsBeforeRun(recipe, async () => { throw new Error('offline'); })).toBeNull();
  });
});

// D-346 follow-up (2026-11-08) — the owner's ruling: before a run, say a program the recipe
// runs is switched off for the owner, and turn it on from there ("Turn it on").
describe('programsBeforeRun — a program switched off for the owner, said before the run', () => {
  const recipe = { recipe: {
    depends_on: ['recued-core.ripgrep'],
    steps: [{ id: 'search', op: 'recued-core.ripgrep.file.search_content' }, { id: 'shape', transform: 'pick' }],
  } } as unknown as Pick<ServerRecipeListEntry, 'recipe'>;
  const ready = async () => ({
    system: 'darwin' as const,
    packs: [{ slug: 'ripgrep', tools: [{ catalog: 'rg-catalog', binary: 'rg', install: [], docs: [], state: 'ready' }] }],
  }) as never;
  const reads = (rows: Array<{ principal: string; ingredient_id: string; operation_id: string; allowed: boolean }>) => ({
    universe: async () => ({ tools: [{ operations: [
      { catalog_slug: 'rg-catalog', operation_id: 'file.search_content' },
      { catalog_slug: 'rg-catalog', operation_id: 'file.list' },
    ] }] }),
    list: async () => ({ rows }),
  });

  it('names the program and turns on exactly the action the recipe runs', async () => {
    const turned: Array<{ ingredient_id: string; operation_id: string }> = [];
    const step = await programsBeforeRun(recipe, ready, {
      reads: reads([]), set: async (need) => { turned.push(need); },
    });
    expect(step?.lead).toBe('rg is switched off for you, so a run would stop there.');
    expect(step?.action).toMatchObject({ text: 'Turn it on', done: 'rg is on now.' });
    await step!.action!.run();
    expect(turned).toEqual([{ ingredient_id: 'rg-catalog', operation_id: 'file.search_content' }]);
  });

  it('says nothing when the owner has it on; an app\'s switch does not count for the owner', async () => {
    expect(await programsBeforeRun(recipe, ready, {
      reads: reads([{ principal: 'user_self', ingredient_id: 'rg-catalog', operation_id: 'file.search_content', allowed: true }]),
    })).toBeNull();
    const onlyAnApp = await programsBeforeRun(recipe, ready, {
      reads: reads([{ principal: 'ct_app_1', ingredient_id: 'rg-catalog', operation_id: 'file.search_content', allowed: true }]),
    });
    expect(onlyAnApp?.lead).toBe('rg is switched off for you, so a run would stop there.');
  });

  it('a read that fails says only what it knew, as before', async () => {
    expect(await programsBeforeRun(recipe, ready, {
      reads: { universe: async () => { throw new Error('offline'); }, list: async () => ({ rows: [] }) },
    })).toBeNull();
  });

  // Live, 2026-11-08: the dialog is opened from a `recipe.list` row, which carries no steps, so
  // it named no action and said nothing before the run. The fixture above had steps the row never
  // does. The row's recipe is read whole (`recipe.get`) to name them.
  it('reads a list row\'s recipe whole to name its actions (a row carries no steps)', async () => {
    const row = { recipe: { recipe_id: 'search-local-files-ripgrep', depends_on: ['recued-core.ripgrep'] } } as unknown as
      Pick<ServerRecipeListEntry, 'recipe'>;
    const whole = { recipe_id: 'search-local-files-ripgrep', steps: [
      { id: 'search', ingredient: 'rg-catalog', input: { operation: 'file.search_content', args: {} } },
    ] };
    const asked: string[] = [];
    const step = await programsBeforeRun(row, ready, {
      reads: { ...reads([]), recipeBody: async (recipe_id) => { asked.push(recipe_id); return whole; } },
    });
    expect(asked).toEqual(['search-local-files-ripgrep']);
    expect(step?.lead).toBe('rg is switched off for you, so a run would stop there.');
    // Without the read, a row still says nothing (an older server, a read that fails).
    expect(await programsBeforeRun(row, ready, { reads: reads([]) })).toBeNull();
    expect(await programsBeforeRun(row, ready, {
      reads: { ...reads([]), recipeBody: async () => { throw new Error('offline'); } },
    })).toBeNull();
  });
});

describe('every run dialog the webclient opens offers a next step', () => {
  it('⛔ none calls the shared dialog past `shell/run-modal.ts`', () => {
    // Seven places open it. The pack offer reached two pages and none of them.
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(path);
        } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
          files.push(path);
        }
      }
    };
    walk(src);
    // A floor, so a walk that found nothing cannot pass.
    expect(files.length).toBeGreaterThan(200);
    const direct = files
      .filter((path) => relative(src, path) !== join('shell', 'run-modal.ts'))
      .filter((path) => /RunModal\s*\.\s*wireRunModal\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(src, path));
    expect(direct).toEqual([]);
    // …and the wrapper is what they open instead.
    const users = files.filter((path) => /import \{[^}]*\bwireRunModal\b[^}]*\} from '[./]+shell\/run-modal\.js'/
      .test(readFileSync(path, 'utf8')));
    expect(users.length).toBeGreaterThanOrEqual(7);
  });
});

// D-402 slice H3c (ruling 14) — a run its browser stopped before step 1: "Use “Home” instead".
describe('a browser the run could not use — "Use this browser instead"', () => {
  const gone: RunNeed = { kind: 'browser', step_id: 'type_home', problem: 'not_paired', setting: 'browser_2', browser_id: 'inst-old',
    name: 'Old laptop', dish_id: 'dsh_main', instead: { browser_id: 'inst-home', name: 'Home (paired Nov 18)' } };
  it('says what else to do and opens the dish\'s settings; its own reason, above, already names the browser', () => {
    expect(runNeedStep(gone)).toEqual({ lead: 'Use another browser instead.',
      link: { text: 'Choose a browser', href: '#automation/dishes/dsh_main' } });
    expect(runNeedStep({ ...gone, problem: 'offline' }).lead).toBe('Or use another browser instead.');
  });
  it('moves the dish to the one browser offered, in one click, and says where it acts now', async () => {
    const moved: unknown[] = [];
    const step = runNeedsStep([gone], undefined, async (args) => { moved.push(args); })!;
    expect(step.action).toMatchObject({ text: 'Use “Home (paired Nov 18)” instead', done: 'It acts in “Home (paired Nov 18)” now. Run it again.' });
    await step.action!.run();
    expect(moved).toEqual([{ dish_id: 'dsh_main', from: 'inst-old', to: 'inst-home' }]);
    // Two settings holding the one browser: said once, linked once, moved together by the server.
    const twice = runNeedsStep([gone, { ...gone, setting: 'browser_3' }], undefined, async () => undefined)!;
    expect(twice.lead).toBe('Use another browser instead.');
    expect(twice.links).toHaveLength(1);
    expect(twice.action?.text).toBe('Use “Home (paired Nov 18)” instead');
  });
  it('⛔ no click for two browsers gone at once, none to offer, no dish, or a switch to turn on first', () => {
    const move = async () => undefined;
    expect(runNeedsStep([gone, { ...gone, setting: 'browser_1', browser_id: 'inst-older' }], undefined, move)!.action).toBeUndefined();
    const { instead: _instead, ...nothing } = gone as Extract<RunNeed, { kind: 'browser' }>;
    expect(runNeedsStep([nothing], undefined, move)!.action).toBeUndefined();
    const { dish_id: _dish, ...dishless } = gone as Extract<RunNeed, { kind: 'browser' }>;
    expect(runNeedsStep([dishless], undefined, move)!).toEqual({ lead: 'Use another browser instead.', links: [] });
    const off: RunNeed = { kind: 'switch', step_id: 'find', ingredient_id: 'rg-catalog', operation_id: 'search', pack_slug: 'ripgrep', label: 'Ripgrep' };
    expect(runNeedsStep([off, gone], async () => undefined, move)!.action?.text).toBe('Turn it on');
    expect(runNeedsStep([gone])!.action).toBeUndefined();
  });
});

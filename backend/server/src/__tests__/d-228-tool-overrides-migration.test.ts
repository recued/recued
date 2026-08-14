/** D-228 slice 3 — THE `tool_overrides` MIGRATION: one tool, one surface, one gate.
 *
 *  An enrolled MCP tool was reachable from chat two ways at once — as a Tier-3
 *  `<connection>.<tool>` entry gated by the presentation store, and as a
 *  `recued_op_*` pack op gated by the contract. Two gates, one action. This suite
 *  covers the three claims that make retiring the first one safe:
 *
 *  1. a tool a pack op covers is withdrawn from BOTH the catalog and the
 *     dispatch — the second is what stops a remembered name reaching the weaker
 *     gate anyway;
 *  2. a tool the pack does NOT cover keeps its Tier-3 entry, because otherwise a
 *     server that added a tool would have one reachable by nothing;
 *  3. the owner's recorded `read` classification survives the move, so the swap
 *     does not silently add an approval prompt to every previously-frictionless
 *     tool.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OWNER_OPERATION_SCOPE,
  operationSpecHash,
  type ConnectionMcpAnnotationState,
  type IngredientManifest,
} from '@recued/contracts';
import { mcpToolNamesFromCatalog } from '@recued/ingredient-authoring';
import { createChatConnectionPackTiers } from '../chat-connection-pack-coverage.js';

import { createChatConnectionPackCoverage } from '../chat-connection-pack-coverage.js';
import { carryMcpToolClassifications } from '../mcp-classification-carryover.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { LEGACY_OVERRIDES } from '../storage/chat-connection-mcp-store.js';

const PACK = 'mcp-0123456789abcdef0123456789abcdef';
const CONN = 'peer';

/** A catalog shaped like a decomposed generated pack: one operation per tool,
 *  each bound to the upstream tool NAME.
 *
 *  ⛔⛔ THE OPERATIONS CARRY A QUALIFIED `operation_id`, AND THE FIXTURE IS WRONG
 *  WITHOUT IT. `stampPackOwnedManifest` stamps
 *  `<publisher>.<pack_slug>.<key>` onto every operation, while the map is keyed
 *  by the SHORT name — and every reader of an owner ruling keys on the QUALIFIED
 *  id. The first version of this fixture omitted the field, which made the two
 *  keys identical, which made a carry-over writing the WRONG one pass every test
 *  here while being inert in production. The live drive is what found it.
 *  ⇒ Fixture the literal the real producer writes. */
const qualified = (key: string): string => `recued-local.${PACK}.${key}`;

const catalogWith = (tools: readonly string[]): IngredientManifest => ({
  slug: PACK,
  operations: Object.fromEntries(
    tools.map((t, i) => [
      `${t}_op${String(i)}`,
      {
        risk_tier: 'write',
        description: t,
        operation_id: qualified(`${t}_op${String(i)}`),
      },
    ]),
  ),
  surfaces: {
    api: {
      executes: Object.fromEntries(
        tools.map((t, i) => [`${t}_op${String(i)}`, { kind: 'mcp', tool: t }]),
      ),
    },
  },
} as unknown as IngredientManifest);

/** ⛔ D-228 slice 4 — the overrides now hide under `LEGACY_OVERRIDES`, because
 *  the field left `ConnectionMcpAnnotationState` and only the MIGRATION may
 *  still see it. Building the fixture the old way would type-error, which is the
 *  compiler enforcing that no new reader appears. */
const annotationWith = (
  tools: readonly string[],
  overrides: Record<string, { enabled: boolean; classification: 'read' | 'write' | 'unknown' }> = {},
): ConnectionMcpAnnotationState => ({
  connection_name: CONN,
  topic_tags: [],
  [LEGACY_OVERRIDES]: overrides,
  tools_list_cache: { tools: tools.map((name) => ({ name })) },
} as unknown as ConnectionMcpAnnotationState);

describe('mcpToolNamesFromCatalog', () => {
  it('reads the upstream tool NAMES a catalog dispatches', () => {
    expect([...mcpToolNamesFromCatalog(catalogWith(['alpha', 'beta']))].sort())
      .toEqual(['alpha', 'beta']);
  });

  it('⛔ ignores non-mcp bindings — an http wrapper covers no MCP tool', () => {
    const mixed = {
      operations: {
        a: { risk_tier: 'read', operation_id: qualified('a') },
        b: { risk_tier: 'read', operation_id: qualified('b') },
      },
      surfaces: { api: { executes: {
        a: { kind: 'mcp', tool: 'alpha' },
        b: { kind: 'http', tool: 'beta' },
      } } },
    } as unknown as IngredientManifest;
    expect([...mcpToolNamesFromCatalog(mixed)]).toEqual(['alpha']);
  });

  it('a catalog with no api surface covers nothing, and that is not an error', () => {
    expect(mcpToolNamesFromCatalog({} as IngredientManifest).size).toBe(0);
  });
});

describe('createChatConnectionPackCoverage', () => {
  it('joins connection → catalog through the store the DISPATCHER uses', () => {
    const coverage = createChatConnectionPackCoverage({
      bindingStore: { resolveCatalogSlug: (n) => (n === CONN ? PACK : undefined) },
      getManifest: (slug) => (slug === PACK ? catalogWith(['alpha']) : null),
    });
    expect([...coverage(CONN)!]).toEqual(['alpha']);
    expect(coverage('unbound')).toBeUndefined();
  });

  it('⛔ a bound catalog that is NOT installed covers nothing', () => {
    // A binding row pointing at a manifest the registry cannot resolve means the
    // route does not exist. Claiming coverage would withdraw the working surface
    // in favour of a broken one.
    const coverage = createChatConnectionPackCoverage({
      bindingStore: { resolveCatalogSlug: () => PACK },
      getManifest: () => null,
    });
    expect(coverage(CONN)).toBeUndefined();
  });

  it('degrades to NO suppression when the stores are unwired', () => {
    expect(createChatConnectionPackCoverage({})(CONN)).toBeUndefined();
  });
});

describe('carryMcpToolClassifications', () => {
  let db: Database.Database;
  let contractStore: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    contractStore = createContractStore(db);
  });
  afterEach(() => db.close());

  const run = (
    overrides: Record<string, { enabled: boolean; classification: 'read' | 'write' | 'unknown' }>,
    catalog: IngredientManifest = catalogWith(['alpha', 'beta']),
  ) =>
    carryMcpToolClassifications(
      {
        contractStore,
        getAnnotation: () => annotationWith(['alpha', 'beta'], overrides),
        getManifest: (slug) => (slug === PACK ? catalog : null),
      },
      { connection_name: CONN, pack_slug: PACK },
    );

  /** ⚠ Reads by the QUALIFIED id — the key both real readers use. */
  const ruling = (operation: string) =>
    contractStore.get(OWNER_OPERATION_SCOPE, [PACK, qualified(operation)])?.value as
      | { risk?: string; approval?: string; op_hash?: string }
      | undefined;

  it('carries a `read` classification as a ruling at the risk floor', () => {
    const result = run({ alpha: { enabled: true, classification: 'read' } });

    expect(result.carried).toEqual([qualified('alpha_op0')]);
    expect(ruling('alpha_op0')).toMatchObject({ risk: 'read', approval: 'never' });
    // Stamped like every other owner ruling, so a re-mint that changes the
    // operation body leaves the decision behind rather than reapplying it.
    expect(ruling('alpha_op0')?.op_hash).toBe(
      operationSpecHash(catalogWith(['alpha', 'beta']).operations!.alpha_op0!),
    );
  });

  it('⛔⛔ writes NOTHING for a tool the owner never classified', () => {
    // The D-225 slice 2f hazard, stated exactly: a third party adds a tool, and
    // nobody has looked at it. It must keep write + ask.
    expect(run({}).carried).toEqual([]);
    expect(ruling('alpha_op0')).toBeUndefined();
    expect(ruling('beta_op1')).toBeUndefined();
  });

  it('⛔ writes NOTHING for a `write` classification — the pack already says that', () => {
    expect(run({ alpha: { enabled: true, classification: 'write' } }).carried).toEqual([]);
    expect(ruling('alpha_op0')).toBeUndefined();
  });

  it('⛔ writes NOTHING for a DISABLED override — that is a withdrawal, not a classification', () => {
    expect(run({ alpha: { enabled: false, classification: 'read' } }).carried).toEqual([]);
    expect(ruling('alpha_op0')).toBeUndefined();
  });

  it('⛔ NEVER clobbers a ruling the owner made in the editor', () => {
    // A decision made in the gated editor is newer and better-informed than a
    // presentation-store value being migrated.
    // ⚠ `op_hash` is REQUIRED by the owner_operation value shape — omitting it
    // throws `missing_required_field`, which is how this fixture first failed.
    // Worth keeping visible: the carry-over stamps one for the same reason.
    contractStore.put(OWNER_OPERATION_SCOPE, [PACK, qualified('alpha_op0')], {
      risk: 'destructive',
      approval: 'always',
      op_hash: operationSpecHash(catalogWith(['alpha', 'beta']).operations!.alpha_op0!),
    });

    const result = run({ alpha: { enabled: true, classification: 'read' } });

    expect(result.carried).toEqual([]);
    expect(result.skipped_existing).toEqual([qualified('alpha_op0')]);
    expect(ruling('alpha_op0')).toMatchObject({ risk: 'destructive', approval: 'always' });
  });

  it('⛔⛔ keys the row on the QUALIFIED operation_id, not the map key', () => {
    // THE BUG THE LIVE DRIVE FOUND. Both readers of an owner ruling — the D-166
    // 4d.4 gateway scan and the owner-operation rpc — key on the fully-qualified
    // `operation_id`. A row under the short map key is written, stored, and read
    // by NOTHING: the gateway resolved `risk=write` with the ruling sitting
    // right there in the store.
    run({ alpha: { enabled: true, classification: 'read' } });

    expect(contractStore.get(OWNER_OPERATION_SCOPE, [PACK, qualified('alpha_op0')]))
      .not.toBeNull();
    // ⚠ AND THE SHORT KEY MUST BE EMPTY. Without this half, writing BOTH would
    // pass — and a stray short-key row is exactly the inert artifact this is
    // about.
    expect(contractStore.get(OWNER_OPERATION_SCOPE, [PACK, 'alpha_op0'])).toBeNull();
  });

  it('is idempotent — a second run finds its own row and skips', () => {
    expect(run({ alpha: { enabled: true, classification: 'read' } }).carried).toEqual([qualified('alpha_op0')]);
    const again = run({ alpha: { enabled: true, classification: 'read' } });
    expect(again.carried).toEqual([]);
    expect(again.skipped_existing).toEqual([qualified('alpha_op0')]);
  });

  it('an uninstalled pack carries nothing rather than throwing', () => {
    const result = carryMcpToolClassifications(
      {
        contractStore,
        getAnnotation: () => annotationWith(['alpha'], {
          alpha: { enabled: true, classification: 'read' },
        }),
        getManifest: () => null,
      },
      { connection_name: CONN, pack_slug: PACK },
    );
    expect(result.carried).toEqual([]);
  });
});


describe('createChatConnectionPackTiers — the tier that replaced the classification', () => {
  let db: Database.Database;
  let contractStore: ContractStore;

  beforeEach(() => {
    db = new Database(':memory:');
    contractStore = createContractStore(db);
  });
  afterEach(() => db.close());

  const tiersFor = (catalog = catalogWith(['alpha'])) =>
    createChatConnectionPackTiers({
      bindingStore: { resolveCatalogSlug: (n) => (n === CONN ? PACK : undefined) },
      getManifest: (slug) => (slug === PACK ? catalog : null),
      contractScan: (scope, segments) =>
        contractStore.scan(scope, segments) as never,
    })(CONN);

  it('takes the AUTHORED risk tier when the owner has ruled nothing', () => {
    expect(tiersFor()?.get('alpha')).toBe('write');
  });

  it('⛔⛔ takes the OWNER RULING when there is one — read on the QUALIFIED id', () => {
    // The ruling is keyed on the fully-qualified `operation_id`, exactly as the
    // gateway scans it. Reading it any other way returns undefined for every row
    // that exists — the defect this arc shipped once and had to correct.
    contractStore.put(OWNER_OPERATION_SCOPE, [PACK, qualified('alpha_op0')], {
      risk: 'read',
      approval: 'never',
      op_hash: operationSpecHash(catalogWith(['alpha']).operations!.alpha_op0!),
    });

    expect(tiersFor()?.get('alpha')).toBe('read');
  });

  it('⚠ takes only the RISK from a ruling, never the approval', () => {
    // The gate asks "what tier is this tool". Approval is the separate axis the
    // preflight owns; folding it in would let a ruling answer a question nobody
    // asked it.
    contractStore.put(OWNER_OPERATION_SCOPE, [PACK, qualified('alpha_op0')], {
      approval: 'never',
      op_hash: operationSpecHash(catalogWith(['alpha']).operations!.alpha_op0!),
    });

    expect(tiersFor()?.get('alpha')).toBe('write');
  });

  it('an unbound connection resolves NO tiers, so the gate refuses', () => {
    const tiers = createChatConnectionPackTiers({
      bindingStore: { resolveCatalogSlug: () => undefined },
      getManifest: () => null,
    });
    expect(tiers(CONN)).toBeUndefined();
  });
});

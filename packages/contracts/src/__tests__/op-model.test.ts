/** D-182 — contracts slice (op-model.ts).
 *
 *  Pins the two-tier op addressing, the `depends_on` cover invariant, the one
 *  op-step guard, arg normalization, the preflight stage→reason mapping, and the
 *  OpKind / handler-registry contract. These are the foundation the kernel op
 *  registry (slice 2) + per-kind handlers (slice 5) build on, so the parsing +
 *  fail-closed edges are locked here. */

import { describe, expect, it } from 'vitest';
import {
  KERNEL_OP_PREFIX,
  parseOpId,
  isKernelOp,
  isPackOp,
  parseDependsOn,
  uncoveredOpDependencies,
  isOpStep,
  operationArgKey,
  normalizeOperationArg,
  OP_KINDS,
  OP_KINDS_SET,
  isOpKind,
  PREFLIGHT_STAGES,
  PREFLIGHT_STAGE_DENY_REASON,
  preflightAdmit,
  preflightDeny,
  resolveKindHandler,
  type ParsedKernelOp,
  type ParsedPackOp,
  type OpStep,
  type OperationArgEntry,
  type KindHandler,
  type KindHandlerRegistry,
  type OpKind,
} from '../op-model.js';
import { INGREDIENT_KINDS } from '../ingredient.js';

describe('parseOpId — two-tier addressing (§3)', () => {
  it('parses a Tier-K kernel op (closed kind, single-segment op)', () => {
    const p = parseOpId('core.ai.summarize');
    expect(p?.tier).toBe('kernel');
    const k = p as ParsedKernelOp;
    expect(k.domain).toBe('ai');
    expect(k.op).toBe('summarize');
    expect(k.raw).toBe('core.ai.summarize');
  });

  it('parses a Tier-K kernel op with a dotted op remainder + hyphenated domain', () => {
    const k = parseOpId('core.work-entity.commitment.create') as ParsedKernelOp;
    expect(k.tier).toBe('kernel');
    expect(k.domain).toBe('work-entity');
    expect(k.op).toBe('commitment.create');
  });

  it('parses a Tier-K canonical convention op (crm)', () => {
    const k = parseOpId('core.crm.deal.search') as ParsedKernelOp;
    expect(k.tier).toBe('kernel');
    expect(k.domain).toBe('crm');
    expect(k.op).toBe('deal.search');
  });

  it('parses a Tier-P pack op with a dotted operation', () => {
    const p = parseOpId('recued-core.whisper.audio.transcribe') as ParsedPackOp;
    expect(p.tier).toBe('pack');
    expect(p.publisher).toBe('recued-core');
    expect(p.pack).toBe('whisper');
    expect(p.operation).toBe('audio.transcribe');
    expect(p.pack_ref).toBe('recued-core.whisper');
  });

  it('treats `recued-core` as a publisher (Tier-P), distinct from the kernel `core`', () => {
    expect(isPackOp('recued-core.gdrive.file.download')).toBe(true);
    expect(isKernelOp('recued-core.gdrive.file.download')).toBe(false);
    // The kernel head is the literal `core`, not a publisher.
    expect(KERNEL_OP_PREFIX).toBe('core');
    expect(isKernelOp('core.data.read')).toBe(true);
  });

  it('distinguishes the two third-party publishers that share a pack slug', () => {
    expect((parseOpId('alice.whisper.audio.transcribe') as ParsedPackOp).publisher).toBe('alice');
    expect((parseOpId('bob.whisper.audio.transcribe') as ParsedPackOp).publisher).toBe('bob');
  });

  it('fails closed on malformed ids', () => {
    expect(parseOpId('')).toBeNull();
    expect(parseOpId('core')).toBeNull(); // no domain/op
    expect(parseOpId('core.ai')).toBeNull(); // kernel needs core.<domain>.<op>
    expect(parseOpId('publisher.pack')).toBeNull(); // pack needs a third segment
    expect(parseOpId('a..b')).toBeNull(); // empty segment
    expect(parseOpId('.core.ai.x')).toBeNull(); // leading dot → empty head
    expect(parseOpId('core.ai.x.')).toBeNull(); // trailing dot → empty tail segment
    expect(parseOpId('Core.Ai.Summarize')).toBeNull(); // uppercase not slug-legal
    expect(parseOpId('core.crm_alias.deal.search')).toBeNull(); // underscore not slug-legal
    // @ts-expect-error — runtime guard against non-string input
    expect(parseOpId(42)).toBeNull();
  });

  it('admits `_` in an operation-remainder segment but keeps the address head strict', () => {
    // operation remainder may carry `_` — the acct alias `ledger_account` keeps its
    // underscore (warehouse entity-id identity), so it must be addressable.
    const k = parseOpId('core.acct.ledger_account.search') as ParsedKernelOp;
    expect(k.tier).toBe('kernel');
    expect(k.domain).toBe('acct');
    expect(k.op).toBe('ledger_account.search');
    const p = parseOpId('recued-core.accounting-quickbooks.ledger_account.search') as ParsedPackOp;
    expect(p.tier).toBe('pack');
    expect(p.operation).toBe('ledger_account.search');
    // ...but the HEAD (publisher / pack / domain) stays strict SLUG_RE — NO underscore.
    expect(parseOpId('core.crm_alias.deal.search')).toBeNull(); // domain underscore
    expect(parseOpId('pub_lisher.pack.op')).toBeNull(); // publisher underscore
    expect(parseOpId('pub.pa_ck.op')).toBeNull(); // pack underscore
  });
});

describe('depends_on (§3)', () => {
  it('parses a bare pack ref', () => {
    expect(parseDependsOn('recued-core.whisper')).toEqual({
      pack_ref: 'recued-core.whisper',
      publisher: 'recued-core',
      pack: 'whisper',
    });
  });

  it('parses a version-pinned entry', () => {
    expect(parseDependsOn('recued-core.gdrive@3')).toEqual({
      pack_ref: 'recued-core.gdrive',
      publisher: 'recued-core',
      pack: 'gdrive',
      min_version: 3,
    });
  });

  it('fails closed on a non-`publisher.pack` ref or a bad pin', () => {
    expect(parseDependsOn('whisper')).toBeNull(); // missing publisher
    expect(parseDependsOn('a.b.c')).toBeNull(); // three segments — that's an op id, not a pack ref
    expect(parseDependsOn('recued-core.gdrive@0')).toBeNull(); // pin < 1
    expect(parseDependsOn('recued-core.gdrive@x')).toBeNull(); // non-integer pin
    expect(parseDependsOn('')).toBeNull();
  });

  it('covers every Tier-P op and exempts Tier-K kernel ops (§9 cover invariant)', () => {
    const ops = [
      'core.ai.summarize', // Tier-K — exempt
      'core.crm.deal.search', // Tier-K — exempt
      'recued-core.whisper.audio.transcribe', // Tier-P — needs dep
      'recued-core.gdrive.file.download', // Tier-P — needs dep
    ];
    expect(uncoveredOpDependencies(ops, ['recued-core.whisper', 'recued-core.gdrive'])).toEqual([]);
  });

  it('reports the de-duplicated uncovered pack refs', () => {
    const ops = [
      'recued-core.whisper.audio.transcribe',
      'recued-core.whisper.audio.detect', // same pack — reported once
      'bob.acme.foo.bar',
    ];
    expect(uncoveredOpDependencies(ops, ['recued-core.whisper@2']).sort()).toEqual(['bob.acme']);
  });

  it('a version-pinned dep still covers the unpinned op reference', () => {
    expect(
      uncoveredOpDependencies(['recued-core.whisper.audio.transcribe'], ['recued-core.whisper@5']),
    ).toEqual([]);
  });

  it('ignores malformed op ids (not a Tier-P dep)', () => {
    expect(uncoveredOpDependencies(['core.ai', 'garbage'], [])).toEqual([]);
  });
});

describe('isOpStep guard (§3)', () => {
  it('accepts a string-`op` step', () => {
    const step: OpStep = { id: 's', op: 'core.ai.summarize', args: { data: 'x' } };
    expect(isOpStep(step)).toBe(true);
  });

  it('rejects the concrete legacy step discriminants', () => {
    expect(isOpStep({ id: 's', transform: 'filter', op: 'x' })).toBe(false);
    expect(isOpStep({ id: 's', ingredient: 'foo', op: 'x' })).toBe(false);
    expect(isOpStep({ id: 's', guard: 'g', op: 'x' })).toBe(false);
  });

  it('rejects non-objects + a missing/non-string op', () => {
    expect(isOpStep(null)).toBe(false);
    expect(isOpStep('core.ai.summarize')).toBe(false);
    expect(isOpStep({ id: 's' })).toBe(false);
    expect(isOpStep({ id: 's', op: 42 })).toBe(false);
  });
});

describe('operation args (§4)', () => {
  it('treats a bare string as a required string key', () => {
    expect(operationArgKey('source')).toBe('source');
    expect(normalizeOperationArg('source')).toEqual({ key: 'source', type: 'string' });
  });

  it('reads the key + defaults the type on an object form', () => {
    const spec: OperationArgEntry = { key: 'to', affects_target: true };
    expect(operationArgKey(spec)).toBe('to');
    expect(normalizeOperationArg(spec)).toEqual({ key: 'to', type: 'string', affects_target: true });
  });

  it('preserves an explicit non-string type', () => {
    expect(normalizeOperationArg({ key: 'limit', type: 'number' })).toEqual({
      key: 'limit',
      type: 'number',
    });
  });
});

describe('OpKind set (§6/§7)', () => {
  it('equals the IngredientKind set (cli graduated in — D-182 F2)', () => {
    // `cli` was an OpKind-only superset member while the §7 capability handler
    // was being built; with it landed, cli graduated into IngredientKind, so
    // OpKind is now an alias of IngredientKind — the two sets are equal.
    expect(OP_KINDS).toContain('cli');
    for (const k of INGREDIENT_KINDS) expect(OP_KINDS_SET.has(k)).toBe(true);
    expect(OP_KINDS.length).toBe(INGREDIENT_KINDS.size);
  });

  it('membership predicate', () => {
    expect(isOpKind('cli')).toBe(true);
    expect(isOpKind('http')).toBe(true);
    expect(isOpKind('nope')).toBe(false);
    expect(isOpKind(7)).toBe(false);
  });
});

describe('preflight helpers (§6)', () => {
  it('runs three ordered stages with a canonical reason each', () => {
    expect(PREFLIGHT_STAGES).toEqual(['installed', 'reachable', 'authorized']);
    expect(PREFLIGHT_STAGE_DENY_REASON).toEqual({
      installed: 'not_installed',
      reachable: 'unreachable',
      authorized: 'not_authorized',
    });
  });

  it('admit + deny builders', () => {
    expect(preflightAdmit()).toEqual({ admit: true });
    expect(preflightDeny('reachable', 'whisper not on PATH')).toEqual({
      admit: false,
      stage: 'reachable',
      reason: 'unreachable',
      detail: 'whisper not on PATH',
    });
    expect(preflightDeny('authorized')).toEqual({
      admit: false,
      stage: 'authorized',
      reason: 'not_authorized',
    });
  });
});

describe('kind handler registry (§6 Fork F2)', () => {
  it('resolves a registered handler by kind + returns undefined for an empty slot', () => {
    const cliHandler: KindHandler = {
      kind: 'cli' as OpKind,
      preflight: () => preflightAdmit(),
      execute: async () => ({ file_ref: 'r1' }),
    };
    const registry: KindHandlerRegistry = { cli: cliHandler };
    expect(resolveKindHandler(registry, 'cli')).toBe(cliHandler);
    expect(resolveKindHandler(registry, 'http')).toBeUndefined();
  });
});

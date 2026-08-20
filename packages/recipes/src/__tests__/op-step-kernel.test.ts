import { describe, expect, it } from 'vitest';
import { OP_STEP_PASSTHROUGH_KNOBS, type OpStep } from '@recued/contracts';
import { resolveKernelClosedKindOpStep } from '../op-step-kernel.js';

describe('resolveKernelClosedKindOpStep (D-182 Slice 5 Increment 1)', () => {
  it('rewrites core.ai.prompt to the core-ai-prompt ingredient, args→input identity, no connection', () => {
    const step: OpStep = {
      id: 'analysis',
      op: 'core.ai.prompt',
      args: { 'llm.system_prompt': 'be terse', 'llm.prompt': '{{step.x}}', 'llm.model_hint': 'quality' },
    };
    const out = resolveKernelClosedKindOpStep(step);
    expect(out).toEqual({
      id: 'analysis',
      ingredient: 'core-ai-prompt',
      input: { 'llm.system_prompt': 'be terse', 'llm.prompt': '{{step.x}}', 'llm.model_hint': 'quality' },
    });
    // connection-less by construction.
    expect(out && 'connection' in out).toBe(false);
  });

  it('rewrites core.dom.read to the dom-read backing ingredient (args→input, no connection)', () => {
    const out = resolveKernelClosedKindOpStep({
      id: 'gemini_response',
      op: 'core.dom.read',
      args: { target: 'gemini.google.com/*', selector: '.markdown' },
    });
    expect(out).toEqual({
      id: 'gemini_response',
      ingredient: 'dom-read',
      input: { target: 'gemini.google.com/*', selector: '.markdown' },
    });
    expect(out && 'connection' in out).toBe(false);
  });

  it('rewrites core.dom.write to the dom-write backing ingredient', () => {
    const out = resolveKernelClosedKindOpStep({
      id: 'send_prompt',
      op: 'core.dom.write',
      args: { target: 'gemini.google.com/*', selector: 'div.ql-editor', value: '{{config.prompt}}', submit_selector: 'div.ql-editor' },
    });
    expect(out?.ingredient).toBe('dom-write');
    expect(out?.input).toEqual({ target: 'gemini.google.com/*', selector: 'div.ql-editor', value: '{{config.prompt}}', submit_selector: 'div.ql-editor' });
  });

  it('rewrites core.data.enrichment.upsert to enrichment-upsert', () => {
    const step: OpStep = {
      id: 'upsert',
      op: 'core.data.enrichment.upsert',
      args: { topic: 't', scope: 's', id: 'i', value: { a: 1 }, authored_by_recipe_id: 'r' },
    };
    expect(resolveKernelClosedKindOpStep(step)).toEqual({
      id: 'upsert',
      ingredient: 'enrichment-upsert',
      input: { topic: 't', scope: 's', id: 'i', value: { a: 1 }, authored_by_recipe_id: 'r' },
    });
  });

  it('rewrites core.work-entity.task.create to task-create', () => {
    const out = resolveKernelClosedKindOpStep({
      id: 'create',
      op: 'core.work-entity.task.create',
      args: { title: 't' },
    });
    expect(out?.ingredient).toBe('task-create');
  });

  it('carries foreach onto the concrete step (core.storage.shared.write)', () => {
    const step: OpStep = {
      id: 'mark',
      op: 'core.storage.shared.write',
      foreach: '{{step.rows}}',
      args: { key: '{{item.key}}', value: { state: 'done' } },
    };
    const out = resolveKernelClosedKindOpStep(step);
    expect(out?.ingredient).toBe('shared-write');
    expect(out?.foreach).toBe('{{step.rows}}');
  });

  it('carries skip_when / fail_on / cache passthrough knobs', () => {
    const out = resolveKernelClosedKindOpStep({
      id: 'notify',
      op: 'core.notification.send',
      args: { channels: '{{config.channels}}', title: 'hi' },
      skip_when: '{{step.x}} is_null',
      fail_on: '{{step.y}} equal true',
      cache: 'fresh',
    });
    expect(out).toMatchObject({
      ingredient: 'core-notification-send',
      skip_when: '{{step.x}} is_null',
      fail_on: '{{step.y}} equal true',
      cache: 'fresh',
    });
  });

  it('carries the step-level pii_fields shorthand onto the lowered ai step', () => {
    // The uncontracted `core.ai.prompt` / multi-data `core.ai.compare` ops support
    // ONLY the bare-name pii_fields form — it must survive lowering or the step
    // loses its PII protection silently.
    const out = resolveKernelClosedKindOpStep({
      id: 'narrative',
      op: 'core.ai.prompt',
      args: { 'llm.prompt': '{{step.x}}' },
      pii_fields: ['deal_name'],
    });
    expect(out).toMatchObject({ ingredient: 'core-ai-prompt', pii_fields: ['deal_name'] });
  });

  it('carries the D-113 approval knobs (timeout_ms / on_timeout / prompt) onto a write op-step', () => {
    // The engine reads these off the CONCRETE step — a write/destructive op-step
    // that authors a custom approval prompt / timeout must keep it through lowering.
    const out = resolveKernelClosedKindOpStep({
      id: 'send',
      op: 'core.mail.send',
      args: { to: '{{config.to}}' },
      timeout_ms: 600000,
      on_timeout: 'reject',
      prompt: 'Approve sending this outreach mail?',
    });
    expect(out).toMatchObject({
      ingredient: 'mail-send',
      timeout_ms: 600000,
      on_timeout: 'reject',
      prompt: 'Approve sending this outreach mail?',
    });
  });

  it('emits input:{} when the op carries no args', () => {
    const out = resolveKernelClosedKindOpStep({ id: 's', op: 'core.data.enrichment.list' });
    expect(out).toEqual({ id: 's', ingredient: 'enrichment-list', input: {} });
  });

  it('returns null for a Tier-K canonical convention op (core.crm.*) — Increment 2 territory', () => {
    expect(resolveKernelClosedKindOpStep({ id: 'd', op: 'core.crm.deal.read', connection: '{{config.crm}}' })).toBeNull();
  });

  it('returns null for a Tier-K canonical convention op (core.acct.*) — Increment 2 territory', () => {
    expect(
      resolveKernelClosedKindOpStep({ id: 'i', op: 'core.acct.invoice.search', connection: '{{config.acct}}' }),
    ).toBeNull();
  });

  it('drops a connection erroneously carried on a closed-kind kernel op-step (kernel ops are connection-less)', () => {
    const out = resolveKernelClosedKindOpStep({
      id: 'c',
      op: 'core.ai.classify',
      connection: '{{config.crm}}',
      args: { 'llm.data': '{{step.rows}}', 'llm.categories': ['a', 'b'] },
    });
    expect(out).toEqual({
      id: 'c',
      ingredient: 'core-ai-classify',
      input: { 'llm.data': '{{step.rows}}', 'llm.categories': ['a', 'b'] },
    });
    expect(out && 'connection' in out).toBe(false);
  });

  it('returns null for a Tier-P pack op', () => {
    expect(
      resolveKernelClosedKindOpStep({ id: 't', op: 'recued-core.whisper.audio.transcribe', args: { source: 'x' } }),
    ).toBeNull();
  });

  it('returns null for a malformed / unknown op id', () => {
    expect(resolveKernelClosedKindOpStep({ id: 'a', op: 'core.ai.nonexistent' })).toBeNull();
    expect(resolveKernelClosedKindOpStep({ id: 'b', op: 'not-an-op' })).toBeNull();
    // `core.ai.embed` used to be the excluded-op example; the ai→core migration
    // made it a real kernel op (`core-ai-embed`), so `core.ai.nonexistent` above
    // is now the valid-kind / unknown-op case.
  });
});

// Round-12 audit fix (T2 Q1) — the lowering allowlist is now the ONE shared
// list, and this ratchet pins BOTH halves: the list's contents, and that a
// lowering carries every member. A knob added to `OpStep` without a carry
// decision is already a compile error (the exhaustiveness proof beside the
// constant); this test is the runtime half — a lowering that stops consuming
// the list reddens here instead of silently no-opping on 99.7 % of op-steps.
describe('OP_STEP_PASSTHROUGH_KNOBS — total knob carry (round-12 T2 Q1)', () => {
  it('pins the shared knob list', () => {
    expect([...OP_STEP_PASSTHROUGH_KNOBS]).toEqual([
      'skip_when',
      'fail_on',
      'fail_kind',
      'cache',
      'foreach',
      'pii_fields',
      'timeout_ms',
      'on_timeout',
      'prompt',
    ]);
  });

  it('kernel lowering carries EVERY knob — including fail_kind, which the old hand-kept spread dropped', () => {
    const step: OpStep = {
      id: 'notify',
      op: 'core.notification.send',
      args: { channels: '{{config.channels}}', title: 'hi' },
      skip_when: '{{step.x}} is_null',
      fail_on: '{{step.y}} equal true',
      fail_kind: 'policy',
      cache: 'fresh',
      foreach: '{{step.rows}}',
      pii_fields: ['title'],
      timeout_ms: 60_000,
      on_timeout: 'reject',
      prompt: 'Send this notification?',
    };
    const out = resolveKernelClosedKindOpStep(step);
    expect(out).toMatchObject({
      ingredient: 'core-notification-send',
      skip_when: '{{step.x}} is_null',
      fail_on: '{{step.y}} equal true',
      fail_kind: 'policy',
      cache: 'fresh',
      foreach: '{{step.rows}}',
      pii_fields: ['title'],
      timeout_ms: 60_000,
      on_timeout: 'reject',
      prompt: 'Send this notification?',
    });
    for (const knob of OP_STEP_PASSTHROUGH_KNOBS) {
      expect(out, `knob '${knob}' must survive the kernel lowering`).toHaveProperty(knob);
    }
  });

  it('absent knobs stay absent — no undefined-valued keys appear', () => {
    const out = resolveKernelClosedKindOpStep({
      id: 'bare',
      op: 'core.notification.send',
      args: { title: 'hi' },
    });
    for (const knob of OP_STEP_PASSTHROUGH_KNOBS) {
      expect(out !== null && knob in out, `knob '${knob}' must not materialise`).toBe(false);
    }
  });
});

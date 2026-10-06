import { describe, expect, it, vi } from 'vitest';
import { type StepMeta } from '@recued/contracts';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError } from '../types.js';

const mkCall = (
  slug: string,
  input: Record<string, unknown>,
  stepMeta?: StepMeta,
) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
  ...(stepMeta !== undefined ? { stepMeta } : {}),
});


describe('createKernelAdapter', () => {
  it('routes shared-write to the write dispatcher', async () => {
    const adapter = createKernelAdapter({
      write: async (input) => ({ ok: true, key: input.key, bytes_written: 42 }),
    });
    const res = await adapter(mkCall('shared-write', { key: 'data.shared.a', value: 1 }));
    expect(res).toEqual({ ok: true, key: 'data.shared.a', bytes_written: 42 });
  });

  it('throws SERVER_NOT_REACHABLE when a dispatcher is absent', async () => {
    const adapter = createKernelAdapter({});
    await expect(adapter(mkCall('shared-write', { key: 'x', value: 1 }))).rejects.toBeInstanceOf(IngredientError);
    try {
      await adapter(mkCall('shared-write', { key: 'x', value: 1 }));
    } catch (e) {
      expect((e as IngredientError).code).toBe('SERVER_NOT_REACHABLE');
    }
  });

  it('routes each supported slug to its dispatcher', async () => {
    const calls: string[] = [];
    const adapter = createKernelAdapter({
      write: async () => { calls.push('write'); return { ok: true, key: 'k', bytes_written: 0 }; },
      compareAndSet: async () => {
        calls.push('compareAndSet');
        return { ok: true, key: 'k', revision: 0, created: true, bytes_written: 0 };
      },
      read: async () => { calls.push('read'); return { found: true, key: 'k', value: 1 }; },
      list: async () => { calls.push('list'); return { entries: [] }; },
      search: async () => { calls.push('search'); return { matches: [] }; },
      delete: async () => { calls.push('delete'); return { ok: true, key: 'k' }; },
      deletePrefix: async () => { calls.push('deletePrefix'); return { ok: true, prefix: 'p', deleted: 0 }; },
    });
    await adapter(mkCall('shared-write', { key: 'k', value: 1 }));
    await adapter(mkCall('shared-compare-and-set', {
      key: 'k',
      expected_revision: null,
      value: { revision: 0 },
    }));
    await adapter(mkCall('shared-read', { key: 'k' }));
    await adapter(mkCall('shared-list', { prefix: 'p' }));
    await adapter(mkCall('shared-search', { scope: 's', query: 'q' }));
    await adapter(mkCall('shared-delete', { key: 'k' }));
    await adapter(mkCall('shared-delete-prefix', { prefix: 'p' }));
    expect(calls).toEqual([
      'write',
      'compareAndSet',
      'read',
      'list',
      'search',
      'delete',
      'deletePrefix',
    ]);
  });

  it('fails closed when shared-compare-and-set has no dispatcher', async () => {
    const adapter = createKernelAdapter({});
    await expect(adapter(mkCall('shared-compare-and-set', {
      key: 'data.shared.state.1',
      expected_revision: null,
      value: { revision: 0 },
    }))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it('routes shared-patch with a null part as an absent one, and fails closed without a key or a dispatcher', async () => {
    const seen: unknown[] = [];
    const adapter = createKernelAdapter({
      patch: async (input) => {
        seen.push(input);
        return { ok: true, key: input.key, found: true, applied: true, bytes_written: 1 };
      },
    });
    await adapter(mkCall('shared-patch', { key: 'data.shared.row', set: { a: 1 }, unset: null, match: null }));
    await adapter(mkCall('shared-patch', { key: 'data.shared.row', unset: ['a'], match: { b: 2 } }));
    expect(seen).toEqual([
      { key: 'data.shared.row', set: { a: 1 } },
      { key: 'data.shared.row', unset: ['a'], match: { b: 2 } },
    ]);
    await expect(adapter(mkCall('shared-patch', { set: { a: 1 } })))
      .rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(createKernelAdapter({})(mkCall('shared-patch', { key: 'data.shared.row', set: { a: 1 } })))
      .rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it('routes shared-read without canonical stamping', async () => {
    const adapter = createKernelAdapter({
      read: async () => ({ found: true, key: 'data.shared.a', value: 1 }),
    });
    const res = await adapter(mkCall('shared-read', { key: 'data.shared.a' }));
    expect(res).toEqual({ found: true, key: 'data.shared.a', value: 1 });
  });

  it('rejects unknown kernel slugs', async () => {
    const adapter = createKernelAdapter({ write: async () => ({ ok: true, key: '', bytes_written: 0 }) });
    await expect(adapter(mkCall('unknown-kernel', {}))).rejects.toBeInstanceOf(IngredientError);
  });

  it('§5 — routes the core-notification-send alias to the same notification dispatcher', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      notificationSend: async (input) => { captured = input; return { delivered_to: ['in_app'], failed: [] }; },
    });
    const input = { channels: ['in_app'], text: 'hi', title: 'T' };
    const viaBare = await adapter(mkCall('notification-send', input));
    const viaCore = await adapter(mkCall('core-notification-send', input));
    // The core- alias reaches the same `notification-send` case + dispatcher.
    expect(viaCore).toEqual(viaBare);
    expect(captured).toEqual({ channels: ['in_app'], text: 'hi', title: 'T' });
  });

  it('§5 — core-notification-send without a dispatcher fails closed like the bare slug', async () => {
    const adapter = createKernelAdapter({});
    await expect(adapter(mkCall('core-notification-send', { channels: ['in_app'], text: 'hi' })))
      .rejects.toBeInstanceOf(IngredientError);
  });

  it('routes a recipe callback with engine-stamped recipe provenance', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      notificationRecipeCallback: async (input) => {
        captured = input;
        return {
          queued_to: 1,
          failed_to: 0,
          coalesced: true,
          skipped_reason: null,
        };
      },
    });
    const result = await adapter(mkCall(
      'core-notification-recipe-callback',
      {
        destination_contract_id: 'ct_office',
        topic: 'mail.action-required',
        query_tool: 'recued-core/mail-action-required-query',
        arguments: { mail_slug: 'work', record_id: 'mail:1' },
        ttl_seconds: 3600,
      },
      { step_id: 'notify', recipe_id: 'mail-action-required-watch' },
    ));
    expect(result).toMatchObject({ queued_to: 1, coalesced: true });
    expect(captured).toEqual({
      destination_contract_id: 'ct_office',
      topic: 'mail.action-required',
      query_tool: 'recued-core/mail-action-required-query',
      arguments: { mail_slug: 'work', record_id: 'mail:1' },
      ttl_seconds: 3600,
      source_recipe_id: 'mail-action-required-watch',
    });
  });

  it('rejects a recipe callback outside a recipe execution context', async () => {
    const adapter = createKernelAdapter({
      notificationRecipeCallback: async () => ({
        queued_to: 0,
        failed_to: 0,
        coalesced: true,
        skipped_reason: null,
      }),
    });
    await expect(adapter(mkCall('core-notification-recipe-callback', {
      destination_contract_id: 'ct_office',
      topic: 'mail.action-required',
      query_tool: 'recued-core/mail-action-required-query',
      arguments: {},
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  // D-193 amendment (2026-10-05) — no recipe step may schedule another recipe:
  // the `schedule-recipe` ingredient is gone (chat schedules through its own
  // `recipe.schedule` tool), so a step naming it is an unknown kernel ingredient.
  it('has no schedule-recipe ingredient: a step naming it is refused', async () => {
    const adapter = createKernelAdapter({});
    await expect(adapter(mkCall('schedule-recipe', {
      recipe_id: 'today', mode: 'recurring', cron_expression: '0 9 * * *',
    }))).rejects.toThrow(/unknown kernel ingredient 'schedule-recipe'/);
  });

  it('routes core Seller offer ensure with recipe-stamped provenance', async () => {
    let captured: unknown;
    const offer = {
      offer_id: 'paid-document.outcome',
      kind: 'document' as const,
      display_name: 'Paid document',
      description: '',
      pricing_kind: 'fixed' as const,
      amount_minor: 12_500,
      currency: 'USD',
      fulfillment_recipe_id: null,
      checkout_url: null,
      fulfillment_config: null,
      state: 'draft' as const,
      created_by_recipe_id: 'paid-document-setup',
      created_at: 1,
      updated_at: 1,
    };
    const adapter = createKernelAdapter({
      sellerOfferEnsure: async (input) => {
        captured = input;
        return { result: 'created', offer };
      },
    });

    await expect(adapter(mkCall('seller-offer-ensure', {
      offer_id: ' paid-document.outcome ',
      kind: 'document',
      display_name: ' Paid document ',
      description: '',
      pricing_kind: 'fixed',
      amount_minor: 12_500,
      currency: 'usd',
      fulfillment_recipe_id: '',
    }, {
      step_id: 'register-offer',
      recipe_id: 'paid-document-setup',
    }))).resolves.toEqual({ result: 'created', offer });
    expect(captured).toEqual({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      pricing_kind: 'fixed',
      amount_minor: 12_500,
      currency: 'usd',
      created_by_recipe_id: 'paid-document-setup',
    });
  });

  it('attaches Seller fulfillment only to the engine-stamped creator recipe', async () => {
    const sellerOfferFulfillmentAttach = vi.fn(async () => ({
      result: 'updated' as const,
      offer: { fulfillment_recipe_id: 'local-paid-document-origin' } as never,
    }));
    const adapter = createKernelAdapter({ sellerOfferFulfillmentAttach });

    await expect(adapter(mkCall('seller-offer-attach-fulfillment', {
      offer_id: ' paid-document.outcome ',
    }, {
      step_id: 'attach-fulfillment',
      recipe_id: 'local-paid-document-origin',
    }))).resolves.toMatchObject({ result: 'updated' });
    expect(sellerOfferFulfillmentAttach).toHaveBeenCalledWith({
      offer_id: 'paid-document.outcome',
      recipe_id: 'local-paid-document-origin',
    });

    await expect(adapter(mkCall('seller-offer-attach-fulfillment', {
      offer_id: 'paid-document.outcome',
      fulfillment_recipe_id: 'attacker-target',
    }, {
      step_id: 'attach-fulfillment',
      recipe_id: 'local-paid-document-origin',
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(adapter(mkCall('seller-offer-attach-fulfillment', {
      offer_id: 'paid-document.outcome',
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerOfferFulfillmentAttach).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['pack_slug', 'paid-document-pack'],
    ['publisher', 'recued-core'],
    ['version', 22],
    ['state', 'active'],
    ['created_by_recipe_id', 'attacker-recipe'],
  ] as const)('rejects caller-controlled Seller authority field %s', async (field, value) => {
    const sellerOfferEnsure = vi.fn(async () => ({
      result: 'created' as const,
      offer: {} as never,
    }));
    const adapter = createKernelAdapter({ sellerOfferEnsure });

    await expect(adapter(mkCall('seller-offer-ensure', {
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      pricing_kind: 'unspecified',
      [field]: value,
    }, {
      step_id: 'register-offer',
      recipe_id: 'paid-document-setup',
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerOfferEnsure).not.toHaveBeenCalled();
  });

  it('requires recipe context to establish an offer and validates pricing before dispatch', async () => {
    const sellerOfferEnsure = vi.fn(async () => ({
      result: 'created' as const,
      offer: {} as never,
    }));
    const adapter = createKernelAdapter({ sellerOfferEnsure });
    const base = {
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      pricing_kind: 'fixed',
      currency: 'USD',
    };

    await expect(adapter(mkCall('seller-offer-ensure', {
      ...base,
      amount_minor: 100,
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(adapter(mkCall('seller-offer-ensure', base, {
      step_id: 'register-offer',
      recipe_id: 'paid-document-setup',
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerOfferEnsure).not.toHaveBeenCalled();
  });

  it('routes Seller offer reads through the fixed core registry', async () => {
    const sellerOfferGet = vi.fn(async () => ({ offer: null }));
    const sellerOfferList = vi.fn(async () => ({ offers: [] }));
    const adapter = createKernelAdapter({ sellerOfferGet, sellerOfferList });

    await expect(adapter(mkCall('seller-offer-get', {
      offer_id: ' paid-document.outcome ',
    }))).resolves.toEqual({ offer: null });
    await expect(adapter(mkCall('seller-offer-list', {
      kind: 'document',
      state: 'draft',
    }))).resolves.toEqual({ offers: [] });
    expect(sellerOfferGet).toHaveBeenCalledWith({
      offer_id: 'paid-document.outcome',
    });
    expect(sellerOfferList).toHaveBeenCalledWith({
      kind: 'document',
      state: 'draft',
    });
  });

  it('routes customer-access-issue with normalized customer metadata only', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      customerAccessIssue: async (input: Record<string, unknown>) => {
        captured = input;
        return {
          result: 'created',
          customer: { customer_id: 'seller_customer_1' } as never,
          claim: {
            claim_url: 'https://seller.example/claim?t=claim',
            expires_at: 123,
          },
          claim_email_delivery: null,
        };
      },
    } as never);
    const res = await adapter(mkCall('customer-access-issue', {
      lifecycle_source: 'manual',
      door_id: ' door_mcp ',
      source_customer_id: ' source_1 ',
      entitlement_key: ' basic ',
      email: ' Buyer@Example.com ',
      period_end: 123,
      source_status: 'active',
    }));
    expect(res).toEqual({
      result: 'created',
      customer: { customer_id: 'seller_customer_1' },
      claim: {
        claim_url: 'https://seller.example/claim?t=claim',
        expires_at: 123,
      },
      claim_email_delivery: null,
    });
    expect(captured).toEqual({
      lifecycle_source: 'manual',
      door_id: 'door_mcp',
      source_customer_id: 'source_1',
      entitlement_key: 'basic',
      email: 'Buyer@Example.com',
      current_period_end: 123,
      source_status: 'active',
    });
  });

  it.each([
    ['token_grants', { attacker: true }],
    ['token_label', 'attacker'],
    ['token_expires_at', 123],
    ['token_concurrency_tier', 10],
    ['token_chat_mode', null],
  ] as const)('rejects caller-controlled %s on customer-access-issue', async (field, value) => {
    let dispatched = false;
    const adapter = createKernelAdapter({
      customerAccessIssue: async () => {
        dispatched = true;
        return {
          result: 'created',
          customer: {} as never,
          claim: null,
          claim_email_delivery: null,
        };
      },
    } as never);
    await expect(adapter(mkCall('customer-access-issue', {
      lifecycle_source: 'manual',
      door_id: 'door_mcp',
      source_customer_id: 'source_1',
      entitlement_key: 'basic',
      [field]: value,
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(dispatched).toBe(false);
  });

  it('rejects caller-controlled local customer ids on customer-access-issue', async () => {
    let dispatched = false;
    const adapter = createKernelAdapter({
      customerAccessIssue: async () => {
        dispatched = true;
        return {
          result: 'created',
          customer: {} as never,
          claim: null,
          claim_email_delivery: null,
        };
      },
    } as never);

    await expect(adapter(mkCall('customer-access-issue', {
      lifecycle_source: 'manual',
      door_id: 'door_mcp',
      source_customer_id: 'source_1',
      entitlement_key: 'basic',
      customer_id: 'attacker_customer',
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(dispatched).toBe(false);
  });

  it('routes customer-access-extend by source-qualified target', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      customerAccessExtend: async (input: Record<string, unknown>) => {
        captured = input;
        return { customer: { customer_id: 'seller_customer_1' } as never };
      },
    } as never);
    await adapter(mkCall('customer-access-extend', {
      customer_id: '',
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_123',
      period_end: null,
      source_status: '',
      email: null,
    }));
    expect(captured).toEqual({
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_123',
      current_period_end: null,
      email: null,
    });
  });

  it('rejects customer-access target and close-reason shape errors', async () => {
    const adapter = createKernelAdapter({
      customerAccessExtend: async () => ({ customer: {} as never }),
      customerAccessClose: async () => ({ customer: {} as never }),
    } as never);
    await expect(adapter(mkCall('customer-access-extend', {
      lifecycle_source: 'manual',
      door_id: 'door_mcp',
    }))).rejects.toBeInstanceOf(IngredientError);
    try {
      await adapter(mkCall('customer-access-close', {
        customer_id: 'seller_customer_1',
        reason: 'paused',
      }));
    } catch (e) {
      expect((e as IngredientError).code).toBe('BAD_INPUT');
    }
  });

  it('rejects conflicting customer-access period aliases', async () => {
    const adapter = createKernelAdapter({
      customerAccessExtend: async () => ({ customer: {} as never }),
    } as never);
    await expect(adapter(mkCall('customer-access-extend', {
      customer_id: 'seller_customer_1',
      period_end: 123,
      current_period_end: 456,
    }))).rejects.toBeInstanceOf(IngredientError);
  });

  describe('Phase D — warehouse readers', () => {
    it('routes file-list with platform=file', async () => {
      let captured: unknown;
      const adapter = createKernelAdapter({
        collectionList: async (input) => { captured = input; return { records: [] }; },
      });
      await adapter(mkCall('file-list', {
        slug: 'work', filters: { mime_type: 'text/plain' }, since: 10, limit: 5,
      }));
      expect(captured).toEqual({
        platform: 'file', slug: 'work',
        filters: { mime_type: 'text/plain' }, since: 10, limit: 5,
      });
    });

    it('routes webhook-list with platform=webhook', async () => {
      let captured: unknown;
      const adapter = createKernelAdapter({
        collectionList: async (input) => { captured = input; return { records: [] }; },
      });
      await adapter(mkCall('webhook-list', { slug: 'github' }));
      expect((captured as { platform: string }).platform).toBe('webhook');
    });

    it('routes email-list with platform=mail (slug prefix is "email" but contract is "mail")', async () => {
      let captured: unknown;
      const adapter = createKernelAdapter({
        collectionList: async (input) => { captured = input; return { records: [] }; },
      });
      await adapter(mkCall('email-list', { slug: 'work' }));
      expect((captured as { platform: string }).platform).toBe('mail');
    });

    it('routes file-get + email-get + webhook-get through collectionGet', async () => {
      const seen: Array<{ platform: string; slug: string; record_id: string }> = [];
      const adapter = createKernelAdapter({
        collectionGet: async (input) => { seen.push(input); return { record: null }; },
      });
      await adapter(mkCall('file-get', { slug: 'work', record_id: 'r1' }));
      await adapter(mkCall('email-get', { slug: 'work', record_id: 'r2' }));
      await adapter(mkCall('webhook-get', { slug: 'github', record_id: 'r3' }));
      expect(seen.map((x) => x.platform)).toEqual(['file', 'mail', 'webhook']);
      expect(seen.map((x) => x.record_id)).toEqual(['r1', 'r2', 'r3']);
    });

    it('routes email-search through collectionSearch with platform=mail', async () => {
      let captured: unknown;
      const adapter = createKernelAdapter({
        collectionSearch: async (input) => { captured = input; return { matches: [] }; },
      });
      await adapter(mkCall('email-search', { slug: 'work', query: 'Q3 review', limit: 20 }));
      expect(captured).toEqual({ platform: 'mail', slug: 'work', query: 'Q3 review', limit: 20 });
    });

    it('SERVER_NOT_REACHABLE when collectionList is absent', async () => {
      const adapter = createKernelAdapter({});
      await expect(adapter(mkCall('file-list', { slug: 'work' })))
        .rejects.toBeInstanceOf(IngredientError);
      try {
        await adapter(mkCall('file-list', { slug: 'work' }));
      } catch (e) {
        expect((e as IngredientError).code).toBe('SERVER_NOT_REACHABLE');
      }
    });

    it('SERVER_NOT_REACHABLE when collectionGet is absent', async () => {
      const adapter = createKernelAdapter({});
      try {
        await adapter(mkCall('file-get', { slug: 'work', record_id: 'r1' }));
      } catch (e) {
        expect((e as IngredientError).code).toBe('SERVER_NOT_REACHABLE');
      }
    });
  });
});

describe('createKernelAdapter — work-entity create admission forwarding (D-192 6c.2c)', () => {
  const mkCreateCall = (
    input: Record<string, unknown>,
    stepMeta?: Record<string, unknown>,
  ) => ({
    slug: 'task-create',
    risk_tier: 'write' as const,
    input,
    output: {},
    manifest_version: 1,
    ...(stepMeta !== undefined ? { stepMeta } : {}),
  });

  const captureTaskCreate = (): {
    dispatchers: { taskCreate: unknown };
    seen: () => Record<string, unknown> | undefined;
  } => {
    let captured: Record<string, unknown> | undefined;
    return {
      dispatchers: {
        taskCreate: (async (input: Record<string, unknown>) => {
          captured = input;
          return { task: {} };
        }) as never,
      },
      seen: () => captured,
    };
  };

  it('forwards an ENGINE-SET stepMeta.work_entity_write_preadmitted onto the dispatch input', async () => {
    const cap = captureTaskCreate();
    const adapter = createKernelAdapter(cap.dispatchers as never);
    await adapter(mkCreateCall({ title: 'x' }, { step_id: 'rerun', work_entity_write_preadmitted: true }) as never);
    expect(cap.seen()?.work_entity_write_preadmitted).toBe(true);
  });

  it('STRIPS a recipe-supplied work_entity_write_preadmitted when stepMeta lacks it (no self-admit)', async () => {
    const cap = captureTaskCreate();
    const adapter = createKernelAdapter(cap.dispatchers as never);
    // A recipe cannot forge the admission: the input value is dropped and no
    // stepMeta re-sets it.
    await adapter(mkCreateCall({ title: 'x', work_entity_write_preadmitted: true }) as never);
    expect(cap.seen()?.work_entity_write_preadmitted).toBeUndefined();
  });

  it('the engine-set stepMeta WINS over a recipe-supplied value (strip-then-set)', async () => {
    const cap = captureTaskCreate();
    const adapter = createKernelAdapter(cap.dispatchers as never);
    // Input forges `false`; the engine-set stepMeta says `true` → the adapter
    // strips the input value then sets from stepMeta only → `true`.
    await adapter(
      mkCreateCall({ title: 'x', work_entity_write_preadmitted: false }, { step_id: 'rerun', work_entity_write_preadmitted: true }) as never,
    );
    expect(cap.seen()?.work_entity_write_preadmitted).toBe(true);
  });

  // D-192 baseline-admission (S2) — the run's execution source rides the SAME
  // adapter-owned, unforgeable channel: the server dispatcher's actor-aware
  // contract-grant admission must evaluate the REAL dispatch identity, never a
  // recipe-forged one.
  const DOOR = {
    channel: 'mcp', actor: 'contracted_user',
    agent_id: 'a', tool_call_id: 't', mcp_token_id: 'k', contract_id: 'door-1',
  };
  const FORGED_OWNER = {
    channel: 'user', actor: 'user_self', user_id: 'attacker', client_token_id: 'ct',
  };

  it('forwards the ENGINE-SET stepMeta.execution_source onto the dispatch input as origin_execution_source', async () => {
    const cap = captureTaskCreate();
    const adapter = createKernelAdapter(cap.dispatchers as never);
    await adapter(mkCreateCall({ title: 'x' }, { step_id: 's', execution_source: DOOR }) as never);
    expect(cap.seen()?.origin_execution_source).toEqual(DOOR);
  });

  it('STRIPS a recipe-supplied origin_execution_source when stepMeta lacks it (no actor spoofing)', async () => {
    const cap = captureTaskCreate();
    const adapter = createKernelAdapter(cap.dispatchers as never);
    // A recipe cannot spoof the dispatch identity: the input value is dropped and no
    // stepMeta re-sets it → the executor sees no source → the create degrades on `ask`.
    await adapter(mkCreateCall({ title: 'x', origin_execution_source: FORGED_OWNER }) as never);
    expect(cap.seen()?.origin_execution_source).toBeUndefined();
  });

  it('the engine-set stepMeta.execution_source WINS over a recipe-forged one (strip-then-set)', async () => {
    const cap = captureTaskCreate();
    const adapter = createKernelAdapter(cap.dispatchers as never);
    // Input forges a privileged OWNER source; the engine-set stepMeta is the real DOOR
    // identity → the adapter strips the input then sets from stepMeta only → the door.
    await adapter(
      mkCreateCall({ title: 'x', origin_execution_source: FORGED_OWNER }, { step_id: 's', execution_source: DOOR }) as never,
    );
    expect(cap.seen()?.origin_execution_source).toEqual(DOOR);
  });
});

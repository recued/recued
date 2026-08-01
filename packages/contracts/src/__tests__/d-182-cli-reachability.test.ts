/** D-182 §7.2 — the shared cli-reachability vocabulary: the execution-source →
 *  principal mapping (the §7.2 grid row key).
 *
 *  The mapping ORDER is load-bearing (Codex F-V2): a contract in force wins FIRST,
 *  so a self-restricted owner (`actor: user_self` running under a contract they
 *  minted to limit themselves) resolves to that contract's row — NOT the
 *  unrestricted owner row — and the self-restriction is honoured, not bypassed.
 *  An unrestricted owner (no contract) is the owner principal. A server-derived
 *  scheduled fire is the owner's unattended execution and resolves to that SAME
 *  principal; every other contract-free non-owner source remains `null` ⇒ the
 *  resolver denies (fail-closed). */

import { describe, expect, it } from 'vitest';

import {
  CLI_REACHABILITY_OWNER_PRINCIPAL,
  cliPrincipalFromExecutionSource,
} from '../cli-reachability.js';

describe('D-182 §7.2 cliPrincipalFromExecutionSource — contract-first principal mapping', () => {
  it('the UNRESTRICTED owner (user_self, no contract) → the owner principal', () => {
    expect(cliPrincipalFromExecutionSource({ actor: 'user_self' })).toBe(
      CLI_REACHABILITY_OWNER_PRINCIPAL,
    );
    expect(CLI_REACHABILITY_OWNER_PRINCIPAL).toBe('user_self');
  });

  it('a contract in force WINS FIRST — even for the owner (self-restriction is honoured, not bypassed)', () => {
    // The V2 bug: owner-first would have returned `user_self` and bypassed the
    // self-imposed contract. Contract-first resolves against the contract row.
    expect(
      cliPrincipalFromExecutionSource({ actor: 'user_self', contract_id: 'contract_self' }),
    ).toBe('contract_self');
  });

  it('a contracted agent (contracted_user under a contract) → that contract', () => {
    expect(
      cliPrincipalFromExecutionSource({ actor: 'contracted_user', contract_id: 'contract_x' }),
    ).toBe('contract_x');
  });

  it('a contract-free scheduled fire → the owner principal (owner automation)', () => {
    expect(
      cliPrincipalFromExecutionSource({
        channel: 'schedule',
        actor: 'system',
        cron: '0 9 * * *',
        source_recipe: 'daily-briefing',
      }),
    ).toBe(CLI_REACHABILITY_OWNER_PRINCIPAL);
  });

  it('a non-owner actor with NO contract → null (fail-closed; an agent can never reach the owner row)', () => {
    expect(cliPrincipalFromExecutionSource({ actor: 'contracted_user' })).toBeNull();
    expect(cliPrincipalFromExecutionSource({ actor: 'anonymous' })).toBeNull();
    expect(cliPrincipalFromExecutionSource({ actor: 'system' })).toBeNull();
    expect(cliPrincipalFromExecutionSource({
      channel: 'schedule',
      actor: 'system',
      source_recipe: 'daily-briefing',
    })).toBeNull();
    expect(cliPrincipalFromExecutionSource({
      channel: 'reactive',
      actor: 'system',
      source_recipe: 'daily-briefing',
    })).toBeNull();
    expect(cliPrincipalFromExecutionSource({
      channel: 'housekeeping',
      actor: 'system',
    })).toBeNull();
    // an empty actor (a dispatch with no execution_source) is also denied.
    expect(cliPrincipalFromExecutionSource({ actor: '' })).toBeNull();
  });

  it('a contract in force still wins over the schedule owner-automation fallback', () => {
    expect(
      cliPrincipalFromExecutionSource({
        channel: 'schedule',
        actor: 'system',
        cron: '0 9 * * *',
        source_recipe: 'daily-briefing',
        contract_id: 'contract_future_schedule',
      }),
    ).toBe('contract_future_schedule');
  });

  it('an empty contract_id string is not a contract — it falls through to the actor branch', () => {
    expect(cliPrincipalFromExecutionSource({ actor: 'user_self', contract_id: '' })).toBe(
      CLI_REACHABILITY_OWNER_PRINCIPAL,
    );
    expect(cliPrincipalFromExecutionSource({ actor: 'contracted_user', contract_id: '' })).toBeNull();
  });
});

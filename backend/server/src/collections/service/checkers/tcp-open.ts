/** D-118 Phase 4 — `tcp_open` checker.
 *
 *  Semantics (spec line 485): TCP connect succeeds within 2 s.
 *  The spec's 2 s is a hard ceiling — templates can't override —
 *  so that a wedged network stack can't stall startup reconcile
 *  beyond that window per instance.
 */
import type { ServiceCheckResult } from '@recued/contracts';

import {
  CheckerParamError,
  type CheckerContext,
  type CheckerKindModule,
} from './types.js';
import { withDefaults } from './process.js';

export interface TcpOpenParams {
  host: string;
  port: number;
}

/** Spec-defined per-check timeout — not template-configurable. */
export const TCP_CONNECT_TIMEOUT_MS = 2_000;

const validate = (raw: unknown): TcpOpenParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new CheckerParamError('tcp_open', 'params must be an object');
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.host !== 'string' || p.host === '') {
    throw new CheckerParamError('tcp_open', 'host required (string)');
  }
  if (
    typeof p.port !== 'number' ||
    !Number.isInteger(p.port) ||
    p.port < 1 ||
    p.port > 65_535
  ) {
    throw new CheckerParamError('tcp_open', 'port required (1..65535)');
  }
  return { host: p.host, port: p.port };
};

const check = async (
  params: TcpOpenParams,
  ctx: CheckerContext,
): Promise<ServiceCheckResult> => {
  const io = withDefaults(ctx);
  const ok = await io.tcpConnect(params.host, params.port, TCP_CONNECT_TIMEOUT_MS);
  return ok
    ? { passed: true, detail: `${params.host}:${params.port} reachable` }
    : { passed: false, detail: `${params.host}:${params.port} unreachable` };
};

export const tcpOpenChecker: CheckerKindModule<TcpOpenParams> = {
  validate,
  check,
};

/** D-118 Phase 4 — `http_ok` checker.
 *
 *  Semantics (spec line 484): HTTP GET returns status ∈
 *  `status_ok` (default `[200]`). `timeout_ms` defaults to 5 s —
 *  health checks run on an interval and shouldn't stall the loop
 *  when a service is wedged.
 *
 *  Uses `globalThis.fetch` by default (Node 18+) with an
 *  AbortController tied to the timeout. Any non-2xx status inside
 *  the allowlist still counts as `passed: true` — this is a
 *  reachability + shape probe, not a response validator.
 */
import type { ServiceCheckResult } from '@recued/contracts';
import { discardResponseBody } from '@recued/ingredients';

import {
  CheckerParamError,
  type CheckerContext,
  type CheckerKindModule,
} from './types.js';
import { withDefaults } from './process.js';

export interface HttpOkParams {
  url: string;
  status_ok: number[];
  timeout_ms: number;
}

const DEFAULT_STATUS_OK = [200];
const DEFAULT_TIMEOUT_MS = 5_000;

const validate = (raw: unknown): HttpOkParams => {
  if (raw === null || typeof raw !== 'object') {
    throw new CheckerParamError('http_ok', 'params must be an object');
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.url !== 'string' || p.url === '') {
    throw new CheckerParamError('http_ok', 'url required (string)');
  }
  if (!/^https?:\/\//i.test(p.url)) {
    throw new CheckerParamError('http_ok', 'url must be http:// or https://');
  }

  let status_ok = DEFAULT_STATUS_OK;
  if (p.status_ok !== undefined) {
    if (
      !Array.isArray(p.status_ok) ||
      p.status_ok.length === 0 ||
      !p.status_ok.every((s) => typeof s === 'number' && Number.isInteger(s))
    ) {
      throw new CheckerParamError(
        'http_ok',
        'status_ok must be a non-empty array of integers',
      );
    }
    status_ok = p.status_ok as number[];
  }

  let timeout_ms = DEFAULT_TIMEOUT_MS;
  if (p.timeout_ms !== undefined) {
    if (
      typeof p.timeout_ms !== 'number' ||
      !Number.isFinite(p.timeout_ms) ||
      p.timeout_ms <= 0
    ) {
      throw new CheckerParamError(
        'http_ok',
        'timeout_ms must be a positive number',
      );
    }
    timeout_ms = p.timeout_ms;
  }

  return { url: p.url, status_ok, timeout_ms };
};

const check = async (
  params: HttpOkParams,
  ctx: CheckerContext,
): Promise<ServiceCheckResult> => {
  const io = withDefaults(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, params.timeout_ms);
  let res: Response | undefined;
  try {
    res = await io.fetch(params.url, {
      method: 'GET',
      signal: controller.signal,
    });
    if (params.status_ok.includes(res.status)) {
      return { passed: true, detail: `${params.url} → ${res.status}` };
    }
    return {
      passed: false,
      detail: `${params.url} → ${res.status} (not in [${params.status_ok.join(', ')}])`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      passed: false,
      detail: isAbort
        ? `${params.url} timed out after ${params.timeout_ms}ms`
        : `${params.url} failed: ${msg}`,
    };
  } finally {
    if (res !== undefined) discardResponseBody(res);
    clearTimeout(timer);
  }
};

export const httpOkChecker: CheckerKindModule<HttpOkParams> = {
  validate,
  check,
};

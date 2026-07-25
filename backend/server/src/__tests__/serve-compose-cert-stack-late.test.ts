import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  composeCertStackLate,
  type ComposeCertStackLateOptions,
} from '../serve/compose-cert-stack-late.js';
import type {
  CertStack,
  CertStackLateDeps,
} from '../composition/bin/wire-cert-stack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const composeCertStackLatePath = join(
  repoRoot,
  'backend/server/src/serve/compose-cert-stack-late.ts',
);
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);

const makeCertStack = (overrides: Partial<CertStack> = {}): CertStack =>
  ({
    rotationEngine: undefined,
    proAuthStateMachineRef: undefined,
    setProAuthResolver: vi.fn(),
    setPublisherIdResolver: vi.fn(),
    composeLate: vi.fn(async () => undefined),
    getTlsCertSourceRef: vi.fn(() => undefined),
    getTlsRenewalHookRef: vi.fn(() => undefined),
    getInitialAcmeDomainIssuerRef: vi.fn(() => undefined),
    getHandleStateMachineRef: vi.fn(() => undefined),
    getPassportCertSourceRef: vi.fn(() => undefined),
    getTlsRenewerConfigured: vi.fn(() => false),
    ...overrides,
  }) as CertStack;

const makeOptions = (
  overrides: Partial<ComposeCertStackLateOptions> = {},
): ComposeCertStackLateOptions => ({
  certStack: makeCertStack(),
  tlsDomainStore: { tag: 'tls-domain-store' } as unknown as CertStackLateDeps['tlsDomainStore'],
  lanBindAddress: '127.0.0.1',
  actualPort: 3939,
  ...overrides,
});

describe('composeCertStackLate', () => {
  it('delegates late composition and returns the TLS refs after composeLate resolves', async () => {
    const order: string[] = [];
    const tlsDomainStore = {
      tag: 'tls-domain-store',
    } as unknown as CertStackLateDeps['tlsDomainStore'];
    const tlsCertSource = {
      tag: 'tls-cert-source',
    } as unknown as ReturnType<CertStack['getTlsCertSourceRef']>;
    const composeLate = vi.fn(async () => {
      order.push('composeLate');
    });
    const getTlsCertSourceRef = vi.fn(() => {
      order.push('getTlsCertSourceRef');
      return tlsCertSource;
    });
    const getTlsRenewerConfigured = vi.fn(() => {
      order.push('getTlsRenewerConfigured');
      return true;
    });
    const certStack = makeCertStack({
      composeLate,
      getTlsCertSourceRef,
      getTlsRenewerConfigured,
    });

    const result = await composeCertStackLate(
      makeOptions({
        certStack,
        tlsDomainStore,
        lanBindAddress: '0.0.0.0',
        actualPort: 4444,
      }),
    );

    expect(composeLate).toHaveBeenCalledTimes(1);
    expect(composeLate).toHaveBeenCalledWith({
      tlsDomainStore,
      lanBindAddress: '0.0.0.0',
      actualPort: 4444,
    });
    expect(result).toEqual({
      tlsCertSource,
      tlsRenewerConfigured: true,
    });
    expect(order).toEqual([
      'composeLate',
      'getTlsCertSourceRef',
      'getTlsRenewerConfigured',
    ]);
  });

  it('passes undefined TLS domain store through to the cert stack', async () => {
    const composeLate = vi.fn(async () => undefined);
    const certStack = makeCertStack({ composeLate });

    const result = await composeCertStackLate(
      makeOptions({
        certStack,
        tlsDomainStore: undefined,
      }),
    );

    expect(composeLate).toHaveBeenCalledWith({
      tlsDomainStore: undefined,
      lanBindAddress: '127.0.0.1',
      actualPort: 3939,
    });
    expect(result).toEqual({
      tlsCertSource: undefined,
      tlsRenewerConfigured: false,
    });
  });
});

describe('compose-cert-stack-late source boundary', () => {
  it('keeps cert-stack late composition behind post-listener runtime', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(runtimeSource).toMatch(/compose-cert-stack-late\.js/);
    expect(runtimeSource).toMatch(/composeCertStackLate\(\{/);
  });

  it('preserves listener exposure finalization, cert late-compose, scheduler, and tail order', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');
    const exposureIndex = bridgeSource.indexOf('await composeServeExposure({');
    const runtimeStartIndex = bridgeSource.indexOf('await startPostListenerRuntime({');
    const certLateIndex = runtimeSource.indexOf('await composeCertStackLate({');
    const housekeepingIndex = runtimeSource.indexOf('await startHousekeepingStartup({');
    const tailIndex = runtimeSource.indexOf('startPostHousekeepingTail({');

    expect(exposureIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeStartIndex).toBeGreaterThan(exposureIndex);
    expect(certLateIndex).toBeGreaterThanOrEqual(0);
    expect(housekeepingIndex).toBeGreaterThan(certLateIndex);
    expect(tailIndex).toBeGreaterThan(housekeepingIndex);
  });

  it('keeps the helper focused on the late cert-stack phase only', () => {
    const source = readFileSync(composeCertStackLatePath, 'utf8');

    expect(source).toMatch(/composeLate/);
    expect(source).toMatch(/getTlsCertSourceRef/);
    expect(source).toMatch(/getTlsRenewerConfigured/);
    expect(source).not.toMatch(/composeSchedulers|composeHousekeepingScheduler/);
    expect(source).not.toMatch(/composeVendorSubstrate|composeHousekeepingLlmCallables/);
    expect(source).not.toMatch(/startRetentionPruners|startDdnsUpdatePoller/);
    expect(source).not.toMatch(/logBootBanner|installShutdown/);
    expect(source).not.toMatch(/createServerHandlerSet|createProductionPathListenerCoordinator/);
  });
});

import type { AskLandingAbuseDeps } from '../ask-landing-port.js';

/** Baseline live-route abuse bundle for tests that are about rendering or
 * answer semantics rather than the abuse controls themselves. */
export const allowingAskLandingAbuseDeps = (): AskLandingAbuseDeps => ({
  getRateLimiter: () => ({
    consumePreVerify: () => ({ ok: true as const }),
  } as never),
  getPepper: () => Buffer.alloc(32, 7),
  getStore: () => ({ appendAccessLog: () => {} }),
  getIpBlockStore: () => ({ isBlocked: () => false } as never),
});

export const attachAskTestSocket = <T extends object>(request: T): T => {
  Object.defineProperty(request, 'socket', {
    configurable: true,
    value: { remoteAddress: '127.0.0.1' },
  });
  return request;
};

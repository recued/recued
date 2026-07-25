import type { TransformContext } from '../types.js';

export const ctx = (overrides?: Partial<TransformContext>): TransformContext => ({
  resolve: () => null,
  evaluate: () => false,
  now: () => new Date('2026-04-08T12:00:00Z'),
  ...overrides,
});

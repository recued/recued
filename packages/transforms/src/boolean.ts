import type { TransformFn } from './types.js';

export const starts_with: TransformFn = (p) =>
  typeof p.input === 'string' && typeof p.prefix === 'string' && p.input.startsWith(p.prefix);

export const ends_with: TransformFn = (p) =>
  typeof p.input === 'string' && typeof p.suffix === 'string' && p.input.endsWith(p.suffix);

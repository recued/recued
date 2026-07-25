import { describe, it, expect } from 'vitest';
import {
  toRecoveryWords,
  fromRecoveryWords,
  distributeTokens,
} from '../recovery-words.js';

describe('toRecoveryWords', () => {
  it('splits a 24-word phrase into 24 slots', () => {
    const phrase = Array.from({ length: 24 }, (_, i) => `w${i + 1}`).join(' ');
    const slots = toRecoveryWords(phrase);
    expect(slots).toHaveLength(24);
    expect(slots[0]).toBe('w1');
    expect(slots[23]).toBe('w24');
  });

  it('pads a shorter phrase with empty slots', () => {
    const slots = toRecoveryWords('abandon ability able');
    expect(slots).toHaveLength(24);
    expect(slots.slice(0, 3)).toEqual(['abandon', 'ability', 'able']);
    expect(slots.slice(3).every((w) => w === '')).toBe(true);
  });

  it('handles empty input as 24 empties', () => {
    expect(toRecoveryWords('')).toEqual(Array(24).fill(''));
  });

  it('collapses multiple spaces and tabs between tokens', () => {
    const slots = toRecoveryWords('abandon    ability\tthe');
    expect(slots.slice(0, 3)).toEqual(['abandon', 'ability', 'the']);
  });
});

describe('fromRecoveryWords', () => {
  it('joins non-empty words with single spaces', () => {
    const words = ['a', 'b', 'c', ...Array(21).fill('')];
    expect(fromRecoveryWords(words)).toBe('a b c');
  });

  it('round-trips a joined phrase back through itself', () => {
    const phrase = 'abandon ability able about above absent';
    expect(fromRecoveryWords(toRecoveryWords(phrase))).toBe(phrase);
  });

  it('drops stray internal doubles so half-filled forms stay clean', () => {
    const words = ['a', '', 'c', ...Array(21).fill('')];
    expect(fromRecoveryWords(words)).toBe('a c');
  });
});

describe('distributeTokens', () => {
  it('writes tokens starting at fromIndex without touching earlier slots', () => {
    const before = ['keep', ...Array(23).fill('')];
    const next = distributeTokens(before, ['one', 'two', 'three'], 1);
    expect(next[0]).toBe('keep');
    expect(next.slice(1, 4)).toEqual(['one', 'two', 'three']);
  });

  it('clamps at slot 24 — extra tokens after are dropped', () => {
    const before = Array(24).fill('');
    const tokens = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const next = distributeTokens(before, tokens, 0);
    expect(next).toHaveLength(24);
    expect(next[0]).toBe('t0');
    expect(next[23]).toBe('t23');
  });

  it('pasting a full 24-word phrase into slot 0 fills every slot', () => {
    const before = Array(24).fill('');
    const phrase = Array.from({ length: 24 }, (_, i) => `w${i + 1}`);
    const next = distributeTokens(before, phrase, 0);
    expect(next[0]).toBe('w1');
    expect(next[23]).toBe('w24');
    expect(next.every((w) => w.length > 0)).toBe(true);
  });

  it('skips empty tokens in the paste (collapsed whitespace)', () => {
    const before = Array(24).fill('');
    const next = distributeTokens(before, ['a', '', '  ', 'b'], 0);
    expect(next.slice(0, 2)).toEqual(['a', 'b']);
  });

  it('negative fromIndex is clamped to 0', () => {
    const before = Array(24).fill('');
    const next = distributeTokens(before, ['a'], -5);
    expect(next[0]).toBe('a');
  });
});

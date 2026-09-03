/** D-164 prompt-cache restructure — the load-bearing invariants:
 *
 *  1. `composeChatMainTurnPromptParts(packet).body` is BYTE-IDENTICAL to the
 *     legacy single `JSON.stringify` of the merged packet (so the model reads
 *     the exact same bytes → ZERO routing-quality risk), AND `cacheable_prefix`
 *     is always a literal prefix of `body` (so the LLM layer can split it into a
 *     cached block + a per-turn block with a byte-identical concatenation).
 *  2. `dropStaleCachePrefix` removes a now-stale `llm.cache_prefix` when the
 *     (PII-aliased) body no longer starts with it, without mutating the input.
 */
import { describe, it, expect } from 'vitest';
import {
  partitionPriorToolCalls,
  type ChatPriorToolCall,
  type ChatTailMessage,
} from '@recued/contracts';
import {
  composeChatMainTurnPromptParts,
  formatChatCurrentDate,
} from '../chat-turn-executor.js';
import type { ChatMainTurnTool } from '../chat-orchestrator.js';
import { dropStaleCachePrefix } from '../chat-pii-egress.js';

const tool = (slug: string): ChatMainTurnTool => ({
  recipe_slug: slug,
  args_schema: { type: 'object', properties: { text: { type: 'string' } } },
  description: `desc for ${slug}`,
});

const priorCall = (tool_name: string): ChatPriorToolCall => ({
  tool_name,
  tier: 1,
  args: { query: tool_name },
  status: 'ok',
  result: { detail: tool_name },
  detail: tool_name,
  started_at: 0,
  completed_at: 1,
});

const TAIL: ChatTailMessage[] = [{ role: 'user', content: 'earlier' }];

interface Packet {
  readonly available_tools: ReadonlyArray<ChatMainTurnTool>;
  readonly content: { chat_tail: ReadonlyArray<ChatTailMessage>; user_message: string };
  readonly correction_context?: readonly string[];
  readonly prefetch_context?: readonly string[];
  readonly current_date?: string;
  readonly in_flight_context?: string;
  readonly prior_tool_calls?: ReadonlyArray<ChatPriorToolCall>;
}

/** Reconstruct the LEGACY single `JSON.stringify` exactly as the pre-split
 *  composer did — the byte-identity target. Uses the SAME partition primitive,
 *  so a mismatch can only come from the split surgery, not the partition. */
const legacyBody = (p: Packet): string => {
  const { prior, recall } = partitionPriorToolCalls(p.prior_tool_calls ?? []);
  return JSON.stringify({
    available_tools: p.available_tools,
    commitment_context: [] as const,
    ...(p.correction_context && p.correction_context.length > 0
      ? { correction_context: p.correction_context }
      : {}),
    ...(p.prefetch_context && p.prefetch_context.length > 0
      ? { prefetch_context: p.prefetch_context }
      : {}),
    chat_tail: p.content.chat_tail,
    ...(p.current_date ? { current_date: p.current_date } : {}),
    ...(p.in_flight_context ? { in_flight_context: p.in_flight_context } : {}),
    user_message: p.content.user_message,
    ...(recall.length > 0 ? { recall_context: recall } : {}),
    ...(prior.length > 0 ? { prior_tool_calls: prior } : {}),
  });
};

const C = { chat_tail: TAIL, user_message: 'what is X?' };
const CASES: ReadonlyArray<{ name: string; p: Packet }> = [
  { name: 'minimal (empty chat_tail, no optionals)', p: { available_tools: [tool('contact.search')], content: { chat_tail: [], user_message: 'q' } } },
  { name: 'empty available_tools', p: { available_tools: [], content: C } },
  { name: 'correction only', p: { available_tools: [tool('a')], content: C, correction_context: ['be brief'] } },
  { name: 'prefetch only', p: { available_tools: [tool('a')], content: C, prefetch_context: ['verify: Alice'] } },
  { name: 'correction + prefetch', p: { available_tools: [tool('a')], content: C, correction_context: ['x'], prefetch_context: ['y'] } },
  { name: 'prior only (no recall)', p: { available_tools: [tool('a')], content: C, prior_tool_calls: [priorCall('contact.search')] } },
  { name: 'recall only (memory.search partitions to recall)', p: { available_tools: [tool('a')], content: C, prior_tool_calls: [priorCall('memory.search')] } },
  { name: 'mixed prior + recall', p: { available_tools: [tool('a')], content: C, prior_tool_calls: [priorCall('contact.search'), priorCall('memory.search')] } },
  { name: 'current_date present', p: { available_tools: [tool('a')], content: C, current_date: 'Tuesday 2026-06-09 12:00 (UTC+00:00)' } },
  { name: 'in-flight context present', p: { available_tools: [tool('a')], content: C, in_flight_context: 'run=run_1; recipe=review' } },
  { name: 'everything present', p: { available_tools: [tool('a'), tool('b')], content: C, correction_context: ['c'], prefetch_context: ['p'], current_date: 'Tuesday 2026-06-09 12:00 (UTC+00:00)', prior_tool_calls: [priorCall('contact.search'), priorCall('memory.search')] } },
];

describe('composeChatMainTurnPromptParts — byte-identity + prefix invariants', () => {
  it.each(CASES)('$name: body === legacy single JSON.stringify', ({ p }) => {
    expect(composeChatMainTurnPromptParts(p).body).toBe(legacyBody(p));
  });

  it.each(CASES)('$name: cacheable_prefix is a literal prefix of body', ({ p }) => {
    const { cacheable_prefix, body } = composeChatMainTurnPromptParts(p);
    expect(cacheable_prefix.length).toBeGreaterThan(0);
    expect(body.startsWith(cacheable_prefix)).toBe(true);
    expect(body.length).toBeGreaterThan(cacheable_prefix.length); // a per-turn suffix always follows
  });

  it.each(CASES)('$name: cacheable_prefix === stringify({available_tools, commitment_context:[]}) sans closing brace', ({ p }) => {
    const { cacheable_prefix } = composeChatMainTurnPromptParts(p);
    expect(cacheable_prefix).toBe(
      JSON.stringify({ available_tools: p.available_tools, commitment_context: [] }).slice(0, -1),
    );
  });

  it.each(CASES)('$name: body is valid JSON with the catalog + commitment_context first', ({ p }) => {
    const obj = JSON.parse(composeChatMainTurnPromptParts(p).body) as Record<string, unknown>;
    expect(obj.available_tools).toEqual(p.available_tools);
    expect(obj.commitment_context).toEqual([]);
    expect(Object.keys(obj).slice(0, 2)).toEqual(['available_tools', 'commitment_context']);
  });
});

describe('current_date in the per-turn tail', () => {
  const BASE: Packet = { available_tools: [tool('a')], content: C };
  const DATED: Packet = { ...BASE, current_date: 'Tuesday 2026-06-09 12:00 (UTC+00:00)' };

  it('serializes between chat_tail and user_message — never in the cacheable prefix', () => {
    const dated = composeChatMainTurnPromptParts(DATED);
    expect(dated.cacheable_prefix).not.toContain('current_date');
    const keys = Object.keys(JSON.parse(dated.body) as Record<string, unknown>);
    expect(keys).toEqual([
      'available_tools',
      'commitment_context',
      'chat_tail',
      'current_date',
      'user_message',
    ]);
  });

  it('a date change (day rollover) never moves the cacheable prefix', () => {
    const a = composeChatMainTurnPromptParts(DATED);
    const b = composeChatMainTurnPromptParts({
      ...BASE,
      current_date: 'Wednesday 2026-06-10 12:00 (UTC+00:00)',
    });
    expect(a.cacheable_prefix).toBe(b.cacheable_prefix);
    expect(a.body).not.toBe(b.body);
  });
});

describe('D-259 in-flight state in the per-turn tail', () => {
  it('sits beside the current prompt and never invalidates the catalog prefix', () => {
    const parts = composeChatMainTurnPromptParts({
      available_tools: [tool('a')],
      content: C,
      in_flight_context: 'run=run_1; recipe=review; risk=write',
    });
    const parsed = JSON.parse(parts.body) as Record<string, unknown>;
    expect(parts.cacheable_prefix).not.toContain('in_flight_context');
    expect(parsed.in_flight_context).toBe('run=run_1; recipe=review; risk=write');
    expect(Object.keys(parsed)).toEqual([
      'available_tools',
      'commitment_context',
      'chat_tail',
      'in_flight_context',
      'user_message',
    ]);
  });
});

describe('formatChatCurrentDate', () => {
  // 2026-06-09T12:00:00Z — a Tuesday.
  const EPOCH = Date.UTC(2026, 5, 9, 12, 0, 0);

  it('renders weekday + YYYY-MM-DD + 24h time-of-day + current UTC offset', () => {
    expect(formatChatCurrentDate(EPOCH, 'UTC')).toBe(
      'Tuesday 2026-06-09 12:00 (UTC+00:00)',
    );
  });

  it('resolves the calendar day AND wall-clock time in the given timezone, not UTC', () => {
    // 23:30Z on the 9th is already 11:30 Wednesday the 10th in Auckland
    // (NZ winter — UTC+12, their DST runs Sep-Apr).
    const lateEvening = Date.UTC(2026, 5, 9, 23, 30, 0);
    expect(formatChatCurrentDate(lateEvening, 'Pacific/Auckland')).toBe(
      'Wednesday 2026-06-10 11:30 (UTC+12:00)',
    );
  });

  it('resolves the DST-correct current offset + local time, not the standard offset', () => {
    // June in Los Angeles is PDT (UTC-7); January is PST (UTC-8). A
    // hardcoded standard offset would be an hour wrong half the year.
    expect(formatChatCurrentDate(EPOCH, 'America/Los_Angeles')).toBe(
      'Tuesday 2026-06-09 05:00 (UTC-07:00)',
    );
    const winter = Date.UTC(2026, 0, 15, 12, 0, 0); // a Thursday
    expect(formatChatCurrentDate(winter, 'America/Los_Angeles')).toBe(
      'Thursday 2026-01-15 04:00 (UTC-08:00)',
    );
  });

  it('renders half-hour offsets explicitly', () => {
    expect(formatChatCurrentDate(EPOCH, 'Asia/Kolkata')).toBe(
      'Tuesday 2026-06-09 17:30 (UTC+05:30)',
    );
  });

  it('two instants on the same local day now render DISTINCT wall-clock times (time-granular)', () => {
    const morning = Date.UTC(2026, 5, 9, 6, 0, 0);
    const evening = Date.UTC(2026, 5, 9, 18, 0, 0);
    expect(formatChatCurrentDate(morning, 'UTC')).toBe('Tuesday 2026-06-09 06:00 (UTC+00:00)');
    expect(formatChatCurrentDate(evening, 'UTC')).toBe('Tuesday 2026-06-09 18:00 (UTC+00:00)');
    expect(formatChatCurrentDate(morning, 'UTC')).not.toBe(
      formatChatCurrentDate(evening, 'UTC'),
    );
  });

  const SHAPE = /^\w+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/;

  it('falls back to server-local on an invalid user-supplied timezone (never throws)', () => {
    // The tz is user-supplied (webclient / bot) → untrusted. A garbage zone
    // must degrade to server-local, NOT crash the turn — Intl.DateTimeFormat
    // throws RangeError on an unknown zone.
    let out = '';
    expect(() => {
      out = formatChatCurrentDate(EPOCH, 'Not/ARealZone');
    }).not.toThrow();
    expect(out).toMatch(SHAPE);
  });

  it('renders in the server-local zone when no timezone is supplied', () => {
    let out = '';
    expect(() => {
      out = formatChatCurrentDate(EPOCH);
    }).not.toThrow();
    expect(out).toMatch(SHAPE);
  });
});

describe('dropStaleCachePrefix', () => {
  const PREFIX = '{"available_tools":[],"commitment_context":[]';
  const BODY = `${PREFIX},"chat_tail":[],"user_message":"q"}`;

  it('keeps cache_prefix (same ref, unchanged) when the body still starts with it', () => {
    const input = { 'llm.prompt': BODY, 'llm.cache_prefix': PREFIX, 'llm.model_hint': 'fast' };
    const out = dropStaleCachePrefix(input);
    expect(out).toBe(input);
    expect(out['llm.cache_prefix']).toBe(PREFIX);
  });

  it('drops a stale cache_prefix when the head drifted, without mutating the input', () => {
    const stale = '{"DRIFTED":1}';
    const input = { 'llm.prompt': BODY, 'llm.cache_prefix': stale, 'llm.model_hint': 'fast' };
    const out = dropStaleCachePrefix(input);
    expect(out['llm.cache_prefix']).toBeUndefined();
    expect(out['llm.prompt']).toBe(BODY);
    expect(out['llm.model_hint']).toBe('fast'); // siblings preserved
    expect(input['llm.cache_prefix']).toBe(stale); // original NOT mutated
  });

  it('is a no-op (same ref) when there is no cache_prefix', () => {
    const input = { 'llm.prompt': BODY };
    expect(dropStaleCachePrefix(input)).toBe(input);
  });

  it('is a no-op when cache_prefix is not a string', () => {
    const input = { 'llm.prompt': BODY, 'llm.cache_prefix': 123 as unknown as string };
    expect(dropStaleCachePrefix(input)).toBe(input);
  });
});

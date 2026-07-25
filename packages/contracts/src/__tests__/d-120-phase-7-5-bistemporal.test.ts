/** D-120 Phase 7.5 — bistemporal stamping + run_mode contracts tests.
 *
 *  Pure-contract coverage:
 *    - RunMode + TimelineAxis enum membership + predicates
 *    - default constants (live, manual)
 *    - TimelineRequest accepts axis / falls back to event-default
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_MODE,
  MANUAL_TRIGGER_RUN_MODE,
  RUN_MODES,
  TIMELINE_AXES,
  TIMELINE_AXIS_DEFAULT,
  isRunMode,
  isTimelineAxis,
  type RunMode,
  type TimelineAxis,
  type TimelineRequest,
} from '../index.js';

describe('RUN_MODES', () => {
  it('contains exactly live + backfill + manual', () => {
    expect(RUN_MODES).toEqual(['live', 'backfill', 'manual']);
  });

  it('default is live', () => {
    expect(DEFAULT_RUN_MODE).toBe('live');
  });

  it('manual-trigger default is manual', () => {
    expect(MANUAL_TRIGGER_RUN_MODE).toBe('manual');
  });
});

describe('isRunMode', () => {
  it('accepts every documented mode', () => {
    expect(isRunMode('live')).toBe(true);
    expect(isRunMode('backfill')).toBe(true);
    expect(isRunMode('manual')).toBe(true);
  });

  it('rejects unknown values + non-strings', () => {
    expect(isRunMode('historical')).toBe(false);
    expect(isRunMode('')).toBe(false);
    expect(isRunMode(undefined)).toBe(false);
    expect(isRunMode(null)).toBe(false);
    expect(isRunMode(0)).toBe(false);
    expect(isRunMode({})).toBe(false);
  });

  it('narrows the type when true', () => {
    const v: unknown = 'backfill';
    if (isRunMode(v)) {
      const r: RunMode = v;
      expect(r).toBe('backfill');
    }
  });
});

describe('TIMELINE_AXES', () => {
  it('contains exactly event + ingestion', () => {
    expect(TIMELINE_AXES).toEqual(['event', 'ingestion']);
  });

  it('default axis is event', () => {
    expect(TIMELINE_AXIS_DEFAULT).toBe('event');
  });
});

describe('isTimelineAxis', () => {
  it('accepts the two documented axes', () => {
    expect(isTimelineAxis('event')).toBe(true);
    expect(isTimelineAxis('ingestion')).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isTimelineAxis('chronological')).toBe(false);
    expect(isTimelineAxis(undefined)).toBe(false);
    expect(isTimelineAxis(null)).toBe(false);
  });

  it('narrows the type when true', () => {
    const v: unknown = 'event';
    if (isTimelineAxis(v)) {
      const a: TimelineAxis = v;
      expect(a).toBe('event');
    }
  });
});

describe('TimelineRequest accepts the new axis field', () => {
  it('compiles + round-trips an event-axis request', () => {
    const req: TimelineRequest = {
      entity_id: 'mail:msg-1',
      axis: 'event',
    };
    expect(req.axis).toBe('event');
  });

  it('compiles + round-trips an ingestion-axis request', () => {
    const req: TimelineRequest = {
      entity_id: 'mail:msg-1',
      axis: 'ingestion',
    };
    expect(req.axis).toBe('ingestion');
  });

  it('axis is optional — request validates without it', () => {
    const req: TimelineRequest = { entity_id: 'mail:msg-1' };
    expect(req.axis).toBeUndefined();
  });
});

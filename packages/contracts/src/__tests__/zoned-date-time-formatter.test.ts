import { afterEach, describe, expect, it, vi } from 'vitest';
import { assetDateAt } from '../asset-rule-clock.js';
import { AssetValidationError } from '../assets.js';
import { zoneOffsetMsAt, zonedWallClockToEpochMs } from '../zoned-wall-clock.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const trackConstruction = () => {
  const Native = Intl.DateTimeFormat;
  return vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) { return new Native(locales, options); });
};

describe('reusing zoned date formatters', () => {
  it('constructs one formatter per zone and calculation while formatting each new instant', () => {
    const construct = trackConstruction();
    for (let day = 1; day <= 20; day++) {
      const instant = Date.UTC(2026, 0, day, 12);
      expect(assetDateAt(instant, 'UTC')).toBe(`2026-01-${String(day).padStart(2, '0')}`);
      expect(zoneOffsetMsAt(instant, 'UTC')).toBe(0);
    }
    expect(construct).toHaveBeenCalledTimes(2);
    expect(assetDateAt(Date.UTC(2026, 0, 1, 0, 30), 'America/Los_Angeles')).toBe('2025-12-31');
    expect(zoneOffsetMsAt(Date.UTC(2026, 0, 1, 0, 30), 'America/Los_Angeles')).toBe(-8 * 3600000);
    expect(construct).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['2026-03-08T09:30:00Z', 'America/Los_Angeles', '2026-03-08', -8 * 60],
    ['2026-03-08T10:30:00Z', 'America/Los_Angeles', '2026-03-08', -7 * 60],
    ['2026-11-01T08:30:00Z', 'America/Los_Angeles', '2026-11-01', -7 * 60],
    ['2026-11-01T09:30:00Z', 'America/Los_Angeles', '2026-11-01', -8 * 60],
    ['2026-01-01T00:30:00Z', 'America/Los_Angeles', '2025-12-31', -8 * 60],
    ['2025-12-31T12:30:00Z', 'Pacific/Kiritimati', '2026-01-01', 14 * 60],
    ['2026-01-01T20:00:00Z', 'Asia/Kathmandu', '2026-01-02', 5 * 60 + 45],
    ['2026-01-01T20:00:00Z', 'Pacific/Chatham', '2026-01-02', 13 * 60 + 45],
    ['2024-02-29T23:30:00Z', 'UTC', '2024-02-29', 0],
  ])('keeps the date and offset at %s in %s', (instant, zone, date, minutes) => {
    expect(assetDateAt(Date.parse(instant), zone)).toBe(date);
    expect(zoneOffsetMsAt(Date.parse(instant), zone)).toBe(minutes * 60000);
  });

  it('retains wall-clock conversion across repeated DST gap and overlap reads', () => {
    for (let n = 0; n < 3; n++) {
      expect(zonedWallClockToEpochMs('2026-03-08T03:30:00', 'America/Los_Angeles')).toBe(Date.parse('2026-03-08T10:30:00Z'));
      expect(zonedWallClockToEpochMs('2026-11-01T01:30:00', 'America/Los_Angeles')).toBe(Date.parse('2026-11-01T08:30:00Z'));
      expect(zonedWallClockToEpochMs('2026-01-01T12:00:00', 'Asia/Kathmandu')).toBe(Date.parse('2026-01-01T06:15:00Z'));
    }
  });

  it('preserves asset date validation before consulting the formatter', () => {
    const construct = trackConstruction();
    for (const instant of [NaN, Infinity, -Infinity, 1.5, 8.64e15 + 1]) {
      expect(() => assetDateAt(instant, 'Unknown/Zone')).toThrow(AssetValidationError);
    }
    expect(construct).not.toHaveBeenCalled();
    for (const date of ['0001-01-01', '9999-12-31']) {
      expect(assetDateAt(Date.parse(`${date}T12:00:00Z`), 'UTC')).toBe(date);
    }
    expect(() => assetDateAt(Date.parse('0000-01-01T12:00:00Z'), 'UTC')).toThrow(AssetValidationError);
    expect(() => assetDateAt(8.64e15, 'UTC')).toThrow(AssetValidationError);
  });

  it('keeps throwing invalid-zone errors after warm reads without caching failures', () => {
    const construct = trackConstruction();
    const instant = Date.UTC(2026, 0, 1, 12);
    assetDateAt(instant, 'UTC');
    for (let n = 0; n < 2; n++) expect(() => assetDateAt(instant, 'Unknown/Zone')).toThrow(RangeError);
    expect(construct).toHaveBeenCalledTimes(3);
    expect(zonedWallClockToEpochMs('2026-01-01', 'Unknown/Zone')).toBeNull();
  });

  it('bounds the retained timezone set and reconstructs evicted entries', () => {
    const construct = trackConstruction();
    const zones = Intl.supportedValuesOf('timeZone').slice(0, 33);
    expect(zones).toHaveLength(33);
    const instant = Date.UTC(2026, 0, 1, 12);
    for (const zone of zones) assetDateAt(instant, zone);
    expect(construct).toHaveBeenCalledTimes(33);
    assetDateAt(instant, zones.at(-1)!);
    expect(construct).toHaveBeenCalledTimes(33);
    assetDateAt(instant, zones[0]!);
    expect(construct).toHaveBeenCalledTimes(34);
  });

  it('uses the current host timezone for callers that omit the zone at runtime', () => {
    const instant = Date.parse('2026-01-01T00:30:00Z');
    vi.stubEnv('TZ', 'UTC');
    expect(Reflect.apply(assetDateAt, undefined, [instant, undefined])).toBe('2026-01-01');
    expect(Reflect.apply(zoneOffsetMsAt, undefined, [instant, undefined])).toBe(0);
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(Reflect.apply(assetDateAt, undefined, [instant, undefined])).toBe('2025-12-31');
    expect(Reflect.apply(zoneOffsetMsAt, undefined, [instant, undefined])).toBe(-8 * 3600000);
  });

  it('honors replacement Intl implementations after a formatter has been cached', () => {
    const instant = Date.UTC(2026, 0, 1, 12);
    assetDateAt(instant, 'UTC'); zoneOffsetMsAt(instant, 'UTC');
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { throw new RangeError('Intl unavailable'); });
    expect(() => assetDateAt(instant, 'UTC')).toThrow('Intl unavailable');
    expect(() => zoneOffsetMsAt(instant, 'UTC')).toThrow('Intl unavailable');
  });
});

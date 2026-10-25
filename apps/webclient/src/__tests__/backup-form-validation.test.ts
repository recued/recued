import { describe, expect, it, vi } from 'vitest';
import { createBackupFormValidation, isBackupUtcTime, isBackupWatchdogUrl, isBackupWholeNumber } from '../settings/backup-form-validation.js';
import { pickerTestDom } from './helpers/file-download-picker-dom.js';
import { createWebhookBoundedHttpsUrlParser } from '../../../../backend/server/src/webhook-bounded-https-url-parser.js';

const monitorPrefix = 'https://monitor.example/';
const maxAsciiUrl = monitorPrefix + 'x'.repeat(2048 - monitorPrefix.length);
const maxUtf8Url = monitorPrefix + 'é'.repeat(Math.floor((2048 - monitorPrefix.length) / 2)) + 'x'.repeat((2048 - monitorPrefix.length) % 2);
const serverMonitorUrl = createWebhookBoundedHttpsUrlParser({ kind: 'bounded_https_url.v1', max_bytes: 2048, allowed_ports: [443] });

describe('backup form validation', () => {
  it.each([
    ['ordinary URL', monitorPrefix + 'ping', true],
    ['explicit port 443', 'https://monitor.example:443/ping', true],
    ['Unicode path', monitorPrefix + 'é', true],
    ['ASCII byte limit', maxAsciiUrl, true],
    ['UTF-8 byte limit', maxUtf8Url, true],
    ['surrounding whitespace', ' https://monitor.example/ping ', true],
    ['legacy empty query delimiter', monitorPrefix + 'ping?', true],
    ['legacy empty fragment delimiter', monitorPrefix + 'ping#', true],
    ['empty URL', '', false],
    ['HTTP', 'http://monitor.example/ping', false],
    ['relative URL', '/ping', false],
    ['malformed URL', 'https://', false],
    ['username', 'https://private@monitor.example/ping', false],
    ['password', 'https://user:private@monitor.example/ping', false],
    ['unsupported port', 'https://monitor.example:8443/ping', false],
    ['query', monitorPrefix + 'ping?private=value', false],
    ['fragment', monitorPrefix + 'ping#private', false],
    ['ASCII over byte limit', maxAsciiUrl + 'x', false],
    ['UTF-8 over byte limit', maxUtf8Url + 'é', false],
  ] as const)('matches the server monitor URL rules for %s', (_name, value, allowed) => {
    expect(isBackupWatchdogUrl(value)).toBe(allowed);
    expect(serverMonitorUrl.parse(value) !== null).toBe(allowed);
  });

  it('waits for Save, preserves supporting descriptions, and updates errors without taking focus', () => {
    const { root, document } = pickerTestDom();
    const control = document.createElement('input'); control.value = '';
    control.setAttribute('aria-describedby', 'existing-help');
    const focus = vi.spyOn(control, 'focus');
    const validation = createBackupFormValidation(document, 'fixture');
    validation.field(control, root as unknown as HTMLElement, 'count', () => isBackupWholeNumber(control.value, 1, 30) ? undefined : 'Choose a count.');
    const error = root.querySelector('[data-fixture-count-error]')!;
    validation.refresh(); expect(control.getAttribute('aria-invalid')).toBeNull(); expect(error.textContent).toBe('');
    expect(validation.validate()).toBe(false); expect(focus).toHaveBeenCalledTimes(1);
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.getAttribute('aria-describedby')).toBe(`existing-help ${error.id}`);
    validation.refresh(); expect(control.getAttribute('aria-describedby')).toBe(`existing-help ${error.id}`);
    control.value = '5'; validation.refresh();
    expect(control.getAttribute('aria-invalid')).toBeNull(); expect(control.getAttribute('aria-describedby')).toBe('existing-help');
    expect(error.textContent).toBe(''); expect(focus).toHaveBeenCalledTimes(1);
    control.value = '0'; validation.refresh(); expect(error.textContent).toBe('Choose a count.');
    validation.reset(); validation.refresh(); expect(error.textContent).toBe('');
    expect(control.getAttribute('aria-describedby')).toBe('existing-help');
    validation.dispose(); expect(validation.validate()).toBe(false); validation.refresh();
    expect(error.textContent).toBe(''); expect(focus).toHaveBeenCalledTimes(1);
  });

  it('gives simultaneous mounts independent error IDs', () => {
    const { root, document } = pickerTestDom();
    for (let index = 0; index < 2; index++) {
      createBackupFormValidation(document, 'same-panel').field(document.createElement('input'), root as unknown as HTMLElement, 'time', () => 'Choose a time.');
    }
    const errors = root.querySelectorAll('[data-same-panel-time-error]');
    expect(errors[0]!.id).not.toBe(errors[1]!.id);
  });

  it.each(['', ' ', '-1', '31', '1.5', 'NaN', 'Infinity'])('rejects an invalid retention count %j', value => {
    expect(isBackupWholeNumber(value, 1, 30)).toBe(false);
  });
  it('allows both retention boundaries and Sunday, and rejects an empty weekday', () => {
    expect(isBackupWholeNumber('1', 1, 30)).toBe(true); expect(isBackupWholeNumber('30', 1, 30)).toBe(true);
    expect(isBackupWholeNumber('0', 0, 6)).toBe(true); expect(isBackupWholeNumber('', 0, 6)).toBe(false);
  });
  it.each(['', '2:00', '24:00', '12:60', '12:30:00', '-1:00'])('rejects an invalid UTC time %j', value => {
    expect(isBackupUtcTime(value)).toBe(false);
  });
  it.each(['00:00', '02:00', '23:59'])('allows UTC time %s', value => { expect(isBackupUtcTime(value)).toBe(true); });
});

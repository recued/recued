import { describe, expect, it, vi } from 'vitest';

import {
  PICKER_SCRIPT_FILE,
  createPickerInjector,
  isInjectableUrl,
  type PickerInjectorActiveTab,
  type PickerInjectorChromeApi,
} from '../picker-injector.js';

const document = { tab_id: 7, document_id: 'doc-7', page_url: 'https://app.example.com/x/1' };
const launch = () => ({ launch_id: 'launch', expires_at: Date.now() + 300_000, bind: vi.fn(() => true) });

const buildApi = (
  overrides: Partial<PickerInjectorChromeApi> = {},
): { api: PickerInjectorChromeApi; injectFile: ReturnType<typeof vi.fn> } => {
  const injectFile = vi.fn(async () => undefined);
  const api: PickerInjectorChromeApi = {
    async queryActiveTab(): Promise<PickerInjectorActiveTab | null> {
      return { id: 7, url: 'https://app.example.com/x/1' };
    },
    prepare: async () => document,
    injectFile,
    ...overrides,
  };
  return { api, injectFile };
};

describe('D-169 brick 3 — isInjectableUrl', () => {
  it('accepts only http/https pages', () => {
    expect(isInjectableUrl('https://x.com')).toBe(true);
    expect(isInjectableUrl('http://x.com')).toBe(true);
    expect(isInjectableUrl('chrome://extensions')).toBe(false);
    expect(isInjectableUrl('file:///x')).toBe(false);
    expect(isInjectableUrl('chrome-extension://abc/p.html')).toBe(false);
    expect(isInjectableUrl(undefined)).toBe(false);
    expect(isInjectableUrl(null)).toBe(false);
    expect(isInjectableUrl('')).toBe(false);
  });
});

describe('D-169 brick 3 — createPickerInjector', () => {
  it('does not inject after the document changed or the launch was retired during preparation', async () => {
    const changed = buildApi({ prepare: async () => ({ ...document, page_url: 'https://other.example/' }) });
    expect(await createPickerInjector(changed.api).injectIntoActiveTab(launch())).toEqual({ ok: false, reason: 'picker_session_invalid' });
    expect(changed.injectFile).not.toHaveBeenCalled();
    const retired = buildApi();
    const credential = launch();
    credential.bind.mockReturnValue(false);
    expect(await createPickerInjector(retired.api).injectIntoActiveTab(credential)).toEqual({ ok: false, reason: 'picker_session_invalid' });
    expect(retired.injectFile).not.toHaveBeenCalled();
  });
  it('injects the picker bundle into a usable active tab', async () => {
    const { api, injectFile } = buildApi();
    const outcome = await createPickerInjector(api).injectIntoActiveTab(launch());
    expect(outcome).toEqual({ ok: true });
    expect(injectFile).toHaveBeenCalledWith(7, PICKER_SCRIPT_FILE, 'doc-7');
  });

  it('reports no_active_tab when the query returns null or an id-less tab', async () => {
    const noTab = buildApi({ queryActiveTab: async () => null });
    expect(await createPickerInjector(noTab.api).injectIntoActiveTab(launch())).toEqual({
      ok: false,
      reason: 'no_active_tab',
    });
    expect(noTab.injectFile).not.toHaveBeenCalled();

    const idless = buildApi({ queryActiveTab: async () => ({ url: 'https://x.com' }) });
    expect(await createPickerInjector(idless.api).injectIntoActiveTab(launch())).toEqual({
      ok: false,
      reason: 'no_active_tab',
    });
  });

  it('reports unsupported_page for a non-web tab without attempting injection', async () => {
    const { api, injectFile } = buildApi({
      queryActiveTab: async () => ({ id: 9, url: 'chrome://newtab/' }),
    });
    expect(await createPickerInjector(api).injectIntoActiveTab(launch())).toEqual({
      ok: false,
      reason: 'unsupported_page',
    });
    expect(injectFile).not.toHaveBeenCalled();
  });

  it('reports inject_failed (with detail) when executeScript rejects', async () => {
    const { api } = buildApi({
      injectFile: async () => {
        throw new Error('Cannot access contents of the page');
      },
    });
    const outcome = await createPickerInjector(api).injectIntoActiveTab(launch());
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.reason).toBe('inject_failed');
      expect(outcome.detail).toContain('Cannot access');
    }
  });

  it('reports no_active_tab (with detail) when the query throws', async () => {
    const { api } = buildApi({
      queryActiveTab: async () => {
        throw new Error('tabs unavailable');
      },
    });
    const outcome = await createPickerInjector(api).injectIntoActiveTab(launch());
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.reason).toBe('no_active_tab');
      expect(outcome.detail).toContain('tabs unavailable');
    }
  });
});

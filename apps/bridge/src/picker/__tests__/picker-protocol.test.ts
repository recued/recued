/** Brick 2 — picker result message guard (consumed by brick 3's SW). */

import { describe, it, expect } from 'vitest';
import {
  isPickerResultMessage,
  isUsablePickedSelector,
  PICKER_RESULT_MESSAGE_TYPE,
} from '../picker-protocol.js';

describe('isUsablePickedSelector', () => {
  it('accepts a non-empty selector without a template ref', () => {
    expect(isUsablePickedSelector('#deal')).toBe(true);
    expect(isUsablePickedSelector('div[data-test-id="x"] > span:nth-of-type(2)')).toBe(true);
  });
  it('rejects empty / whitespace-only', () => {
    expect(isUsablePickedSelector('')).toBe(false);
    expect(isUsablePickedSelector('   ')).toBe(false);
  });
  it('rejects a selector carrying a `{{` template ref', () => {
    expect(isUsablePickedSelector('div[data-x="{{foo}}"]')).toBe(false);
  });
});

describe('isPickerResultMessage', () => {
  it('accepts a well-formed picked message', () => {
    expect(
      isPickerResultMessage({
        type: PICKER_RESULT_MESSAGE_TYPE,
        result: {
          status: 'picked',
          selector: '#deal',
          page_url: 'https://app.hubspot.com/contacts/1',
          sample_text: 'Acme',
        },
      }),
    ).toBe(true);
  });

  it('accepts a picked message with null sample_text', () => {
    expect(
      isPickerResultMessage({
        type: PICKER_RESULT_MESSAGE_TYPE,
        result: { status: 'picked', selector: '.x', page_url: 'https://x.test/', sample_text: null },
      }),
    ).toBe(true);
  });

  it('accepts a cancelled message', () => {
    expect(
      isPickerResultMessage({ type: PICKER_RESULT_MESSAGE_TYPE, result: { status: 'cancelled' } }),
    ).toBe(true);
  });

  it('rejects a foreign message type', () => {
    expect(
      isPickerResultMessage({ type: 'recued.bridge.inspect', result: { status: 'cancelled' } }),
    ).toBe(false);
  });

  it('rejects a picked message missing fields', () => {
    expect(
      isPickerResultMessage({
        type: PICKER_RESULT_MESSAGE_TYPE,
        result: { status: 'picked', selector: '#x' },
      }),
    ).toBe(false);
  });

  it('rejects a picked message with non-string selector', () => {
    expect(
      isPickerResultMessage({
        type: PICKER_RESULT_MESSAGE_TYPE,
        result: { status: 'picked', selector: 5, page_url: 'https://x.test/', sample_text: null },
      }),
    ).toBe(false);
  });

  it('rejects a picked message whose selector is empty or carries `{{`', () => {
    for (const selector of ['', '   ', 'div[data-x="{{y}}"]']) {
      expect(
        isPickerResultMessage({
          type: PICKER_RESULT_MESSAGE_TYPE,
          result: { status: 'picked', selector, page_url: 'https://x.test/', sample_text: null },
        }),
      ).toBe(false);
    }
  });

  it('rejects non-objects and null', () => {
    expect(isPickerResultMessage(null)).toBe(false);
    expect(isPickerResultMessage('nope')).toBe(false);
    expect(isPickerResultMessage(undefined)).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(
      isPickerResultMessage({ type: PICKER_RESULT_MESSAGE_TYPE, result: { status: 'weird' } }),
    ).toBe(false);
  });
});

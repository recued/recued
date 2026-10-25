import { yoursFieldError } from './yours-field-errors.js';
import { yoursInput, yoursNode } from './yours-view.js';

const regions = new Intl.DisplayNames(['en'], { type: 'region' });
const validCode = (code: string) => /^[A-Z]{2}$/u.test(code) && code !== 'ZZ' && regions.of(code) !== code;
const names = new Map<string, string>();
for (let first = 65; first <= 90; first++) for (let second = 65; second <= 90; second++) {
  const code = String.fromCharCode(first, second);
  if (validCode(code) && !['EU', 'UN', 'QO', 'XA', 'XB'].includes(code) && !names.has(regions.of(code)!)) names.set(regions.of(code)!, code);
}

/** Suggest names while retaining the existing country-code storage contract. */
export const mountCountryChoice = (host: HTMLElement, title: string, name: string, initial: string, changed: () => void) => {
  const input = yoursInput(host, title, name, initial && validCode(initial) ? regions.of(initial)! : initial, changed);
  const suggestions = yoursNode(host, 'datalist', ''); suggestions.id = `yours-countries-${globalThis.crypto.randomUUID()}`;
  input.setAttribute('list', suggestions.id); input.autocomplete = 'off'; input.placeholder = 'Choose a country';
  for (const [label, code] of [...names].sort(([a], [b]) => a.localeCompare(b))) {
    const option = yoursNode(suggestions, 'option', '', code); option.value = label;
  }
  return { input, read() {
    const value = input.value.trim(); if (!value) return '';
    const country = [...names].find(([name]) => name.toLocaleLowerCase('en') === value.toLocaleLowerCase('en'))?.[1] ?? value.toUpperCase();
    if (!validCode(country)) yoursFieldError(input, 'Choose a country from the suggestions, or enter a valid two-letter country code.');
    return country;
  } };
};

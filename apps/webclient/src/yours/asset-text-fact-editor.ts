import { ASSET_DOCUMENT_DETAILS_ATTRIBUTE, ASSET_EXPECTED_PATTERNS, type Asset, type AssetPatch } from '@recued/contracts';
import { yoursChoice, yoursDisclosure, yoursInput, yoursNode } from './yours-view.js';
import { factKey, factName } from './fact-words.js';
import { yoursFieldError } from './yours-field-errors.js';

export const mountAssetTextFactEditor = (host: HTMLFormElement, asset: Asset, group: 'attributes' | 'settings', originalName: string | undefined, changed: () => void) => {
  const original = originalName === undefined ? undefined : asset[group][originalName];
  yoursNode(host, 'p', 'yours-muted', 'Save a descriptive fact. Text stays exactly as you enter it; it does not create a rule or automatic update.');
  const name = yoursInput(host, 'Fact name', 'fact-name', originalName ? factName(originalName) : '', changed); name.required = true; name.readOnly = !!originalName;
  const label = yoursNode(host, 'label', '', 'Value'); const entry = yoursNode(label, 'textarea', ''); entry.name = 'fact-value'; entry.dataset.yoursFocus = 'fact-value';
  entry.value = original === undefined || original === null ? '' : String(original); entry.addEventListener('input', changed);
  const options = yoursDisclosure(host, 'Value options');
  const keyInput = yoursInput(options, 'Field key', 'fact-key', originalName ?? '', changed); keyInput.readOnly = !!originalName;
  const keyNote = yoursNode(options, 'small', '', 'A stable key for rules and connected apps. Generated from the fact name.');
  let customKey = false;
  keyInput.addEventListener('input', () => { customKey = true; });
  name.addEventListener('input', () => { if (!customKey) keyInput.value = factKey(name.value); keyNote.textContent = keyInput.value ? `Saved as ${factName(keyInput.value)}.` : 'Choose a field key for this name.'; });
  const kind = yoursChoice(options, 'Value type', 'fact-type', [['Text', 'Text'], ['Number', 'Number'], ['Boolean', 'Boolean']], typeof original === 'number' ? 'Number' : typeof original === 'boolean' ? 'Boolean' : 'Text', changed);
  const displayedText = entry.value; const displayedType = kind.value;
  if (kind.value !== 'Text') options.open = true;
  yoursNode(host, 'small', '', 'AI apps you connect can read this value exactly as entered.');
  return { read(): AssetPatch | null {
    const key = originalName ?? (customKey ? keyInput.value.trim() : factKey(name.value));
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key) || ['constructor', 'prototype'].includes(key)) yoursFieldError(customKey ? keyInput : name, 'Choose a name that makes a short field key, or enter a key such as hose_length in Value options.');
    if (group === 'attributes' && key === ASSET_DOCUMENT_DETAILS_ATTRIBUTE) yoursFieldError(name, 'Use Document details on the attached file.');
    if (group === 'settings' && ['nationality', 'valid_for', ASSET_EXPECTED_PATTERNS].includes(key)) yoursFieldError(name, 'Use Edit asset or the condition controls for this setting.');
    if (!originalName && Object.hasOwn(asset[group], key)) yoursFieldError(name, `A fact named ${factName(key)} already exists. Edit its saved row or choose another name.`);
    if (kind.value === 'Number' && (!entry.value.trim() || !Number.isFinite(Number(entry.value)))) yoursFieldError(entry, 'Enter a real number.');
    if (kind.value === 'Boolean' && !['true', 'false'].includes(entry.value.toLowerCase())) yoursFieldError(entry, 'Use true or false.');
    const next = kind.value === 'Number' ? Number(entry.value) : kind.value === 'Boolean' ? entry.value.toLowerCase() === 'true' : entry.value;
    // Viewing and saving an unchanged guess does not turn it into an owner
    // assertion. Compare the initial display too: textareas normalize CRLF,
    // while an unchanged saved value must retain its original line endings.
    if (originalName && (kind.value === displayedType && entry.value === displayedText || next === original || original === null && next === '')) return null;
    return { [group]: { [key]: next } };
  } };
};

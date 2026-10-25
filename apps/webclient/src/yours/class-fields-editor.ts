import type { AssetClassPreset } from '@recued/contracts';
import { factKey, factName } from './fact-words.js';
import { yoursFieldError } from './yours-field-errors.js';
import { yoursDisclosure, yoursInput, yoursNode } from './yours-view.js';

export const mountClassFieldsEditor = (host: HTMLFormElement, preset: AssetClassPreset, changed: () => void) => {
  const readers: Array<() => void> = [];
  const result = structuredClone(preset.fields);
  for (const [group, title] of [['dates', 'Date'], ['readings', 'Reading'], ['observations', 'Condition']] as const) {
    const section = yoursNode(host, 'fieldset', 'yours-class-fields'); yoursNode(section, 'legend', '', `${title} fields`);
    const rows = yoursNode(section, 'div', 'yours-class-field-list');
    const getters: Array<{ name: HTMLInputElement; read(): [string, unknown] | null }> = [];
    const add = (original?: string) => {
      let removed = false; let customKey = false;
      const row = yoursNode(rows, 'article', 'yours-class-field'); row.dataset.yoursClassField = group;
      const initialName = original ? factName(original) : '';
      const name = yoursInput(row, `${title} field name`, `${group}-field-${getters.length}`, initialName, changed);
      name.placeholder = title === 'Date' ? 'Warranty expiry' : title === 'Reading' ? 'Battery level' : 'Water leak';
      const identity = yoursDisclosure(row, 'Field identity');
      identity.dataset.yoursDisclosure = JSON.stringify(['class-field', preset.id, group, original ?? getters.length]);
      const key = yoursInput(identity, 'Field key', `${group}-key-${getters.length}`, original ?? '', changed);
      key.readOnly = !!original;
      key.addEventListener('input', () => { customKey = true; });
      name.addEventListener('input', () => { if (!customKey) key.value = original && name.value === initialName ? original : factKey(name.value); });
      const used = preset.rules.some(rule => (rule.when.kind === 'condition' ? 'observations' : rule.when.kind === 'objective' ? 'readings' : 'dates') === group && rule.when.field === original);
      if (used) { name.readOnly = true; yoursNode(row, 'small', '', 'Used by a preset rule. Edit or remove that rule before removing this field.'); }
      const remove = yoursNode(row, 'button', 'yours-quiet', `Remove ${title.toLowerCase()} field`); remove.type = 'button'; remove.disabled = used;
      remove.addEventListener('click', () => { removed = true; row.remove(); changed(); addButton.focus(); });
      getters.push({ name, read: () => {
        if (removed) return null;
        if (!name.value.trim() && !key.value.trim()) return null;
        if (!name.value.trim()) yoursFieldError(name, 'Name this field.');
        const value = original && name.value === initialName ? original : customKey ? key.value.trim() : factKey(name.value);
        if (!/^[a-z][a-z0-9_]{0,63}$/u.test(value) || ['constructor', 'prototype'].includes(value)) yoursFieldError(customKey ? key : name, 'Choose a short field name, or enter its key in Field identity.');
        return [value, original ? preset.fields[group][original] ?? null : null];
      } });
      return name;
    };
    const addButton = yoursNode(section, 'button', '', `Add ${title.toLowerCase()} field`); addButton.type = 'button';
    addButton.addEventListener('click', () => { const name = add(); changed(); name.focus(); });
    Object.keys(preset.fields[group]).forEach(key => add(key));
    readers.push(() => {
      const entries: Array<[string, unknown]> = [];
      const seen = new Set<string>();
      for (const row of getters) {
        const entry = row.read(); if (!entry) continue;
        if (seen.has(entry[0])) yoursFieldError(row.name, 'Choose a different name. Each field in this group needs its own key.');
        seen.add(entry[0]); entries.push(entry);
      }
      Object.assign(result, { [group]: Object.fromEntries(entries) });
    });
  }
  return { read() { readers.forEach(read => read()); return structuredClone(result); } };
};

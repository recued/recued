import { yoursFieldError } from './yours-field-errors.js';
import { ASSET_DOCUMENT_DETAILS_ATTRIBUTE, calendarDayMs, type Asset, type AssetAnchor, type AssetPatch, type AssetValue } from '@recued/contracts';

/** Typed forms preserve source receipts on untouched historical values. Free
 * attributes remain descriptive and never become a rule expression. */
export const mountAssetFactsEditor = (host: HTMLElement, own: Partial<Asset>, changed: () => void) => {
  const doc = host.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text?: string) => { const value = doc.createElement(tag); if (text !== undefined) value.textContent = text; parent.append(value); return value; };
  const section = (name: string) => { const value = node('fieldset', host); node('legend', value, name); return value; };
  let nextId = 0;
  const field = (parent: HTMLElement, title: string, value = '', type = 'text') => { const label = node('label', parent, title); const input = node('input', label); input.type = type; input.value = value;
    input.setAttribute('aria-label', title); input.dataset.yoursFocus = `asset-fact-${nextId++}`; input.addEventListener('input', changed); return input; };
  const choice = (parent: HTMLElement, title: string, values: string[], value: string) => { const label = node('label', parent, title); const input = node('select', label); input.setAttribute('aria-label', title);
    values.forEach(value => { const option = node('option', input, value); option.value = value; }); input.value = value; input.addEventListener('change', changed); return input; };
  const rowFocus = new WeakMap<Element, HTMLElement>();
  const removeRow = (row: HTMLElement, fallback: HTMLElement): HTMLElement => {
    const rows = Array.from(row.parentElement?.children ?? []).filter(child => rowFocus.has(child));
    const at = rows.indexOf(row); const neighbor = rows[at + 1] ?? rows[at - 1];
    row.remove(); return (neighbor && rowFocus.get(neighbor)) || fallback;
  };
  const button = (parent: HTMLElement, title: string, action: () => HTMLElement) => {
    const input = node('button', parent, title); input.type = 'button';
    input.addEventListener('click', event => {
      const active = doc.activeElement;
      // Safari pointer clicks need not focus buttons. A real activation still
      // owns its new row; a scripted click must respect focus held elsewhere.
      const owned = active === input || event.isTrusted;
      const target = action(); changed();
      if (owned && target.isConnected && host.contains(target) && (doc.activeElement === active || doc.activeElement === doc.body)) target.focus();
    });
    return input;
  };
  const maps: Array<() => AssetPatch> = [];
  for (const [key, title] of [['settings', 'Settings'], ['attributes', 'Attributes']] as const) {
    const root = section(title); const values = { ...own[key] }; const getters: Array<() => [string, unknown] | null> = [];
    // Document cards own this field. An ordinary asset draft must not write its
    // hidden snapshot back over a document edited by another owner meanwhile.
    if (key === 'attributes') delete values[ASSET_DOCUMENT_DETAILS_ATTRIBUTE];
    node('p', root, (key === 'attributes' ? 'Descriptive notes. Reminder rules use Dates, Readings and Conditions.' : 'Named preferences for this asset and its installed recipes.')
      + ' AI apps you connect can read them exactly as typed.');
    const add = (name = '', value: unknown = '') => {
      const row = node('article', root); let removed = false;
      const nameField = field(row, `${title} field name`, name);
      if (value !== null && typeof value === 'object') {
        nameField.disabled = true;
        node('p', row, `${name}: ${JSON.stringify(value)}`);
        getters.push(() => removed ? [name, null] : [name, value]);
      } else {
        const kind = choice(row, `${title} value type`, ['Text', 'Number', 'Boolean'], typeof value === 'number' ? 'Number' : typeof value === 'boolean' ? 'Boolean' : 'Text');
        const input = field(row, `${title} value`, value == null ? '' : String(value));
        getters.push(() => {
          if (removed) return name ? [name, null] : null;
          const next = nameField.value.trim(); if (!next && !input.value.trim()) return null;
          if (!/^[a-z][a-z0-9_]{0,63}$/u.test(next)) yoursFieldError(nameField, `Use a field name such as colour for ${title.toLowerCase()}`);
          if (key === 'settings' && next === 'nationality') yoursFieldError(nameField, 'Use the passport nationality field above');
          if (key === 'settings' && next === 'valid_for') yoursFieldError(nameField, 'Use the visa country field above');
          if (key === 'attributes' && next === ASSET_DOCUMENT_DETAILS_ATTRIBUTE) yoursFieldError(nameField, 'Use Document details on the attached file');
          if (name && next !== name) values[name] = null;
          if (kind.value === 'Number' && (!input.value.trim() || !Number.isFinite(Number(input.value)))) yoursFieldError(input, `Enter a real number for ${next}`);
          if (kind.value === 'Boolean' && !['true', 'false'].includes(input.value.toLowerCase())) yoursFieldError(input, `Use true or false for ${next}`);
          return [next, kind.value === 'Number' ? Number(input.value) : kind.value === 'Boolean' ? input.value.toLowerCase() === 'true' : input.value];
        });
      }
      const remove = button(row, `Remove ${key === 'settings' ? 'setting' : 'attribute'}`, () => { removed = true; return removeRow(row, addButton); });
      rowFocus.set(row, nameField.disabled ? remove : nameField);
      return nameField;
    };
    // Their own fields above the form edit these two settings.
    Object.entries(values).filter(([name]) => key !== 'settings' || !['nationality', 'valid_for'].includes(name)).forEach(([key, value]) => add(key, value));
    const addButton = button(root, key === 'settings' ? 'Add setting' : 'Add attribute', () => add());
    maps.push(() => { const entries = getters.map(get => get()).filter((row): row is [string, unknown] => row !== null);
      if (new Set(entries.filter(([, value]) => value !== null).map(([key]) => key)).size !== entries.filter(([, value]) => value !== null).length) throw new Error(`Choose distinct ${title.toLowerCase()} field names`);
      return { [key]: { ...values, ...Object.fromEntries(entries) } }; });
  }
  const anchors = section('Anchors'); const anchorGetters: Array<() => AssetAnchor | null> = [];
  const anchorAdds = new Map<AssetAnchor['kind'], HTMLButtonElement>();
  const addAnchor = (own?: AssetAnchor, kind: AssetAnchor['kind'] = own?.kind ?? 'place') => {
    const row = node('article', anchors); let removed = false; node('h3', row, kind === 'place' ? 'Place' : kind === 'identifier' ? 'Identifier' : 'Financial instrument');
    let first: HTMLInputElement;
    if (kind === 'place') {
      const value = own?.kind === 'place' ? own : undefined;
      const name = field(row, 'Place name', value?.name); const address = field(row, 'Place address', value?.address);
      first = name;
      const latitude = field(row, 'Latitude', value?.latitude === undefined ? '' : String(value.latitude), 'number'); latitude.step = 'any'; latitude.min = '-90'; latitude.max = '90';
      const longitude = field(row, 'Longitude', value?.longitude === undefined ? '' : String(value.longitude), 'number'); longitude.step = 'any'; longitude.min = '-180'; longitude.max = '180';
      node('small', row, 'No reminder needs an address or coordinates. AI apps you connect can read them exactly as entered.');
      anchorGetters.push(() => { if (removed) return null;
        if (Boolean(latitude.value.trim()) !== Boolean(longitude.value.trim())) yoursFieldError(latitude.value.trim() ? longitude : latitude, 'A place needs both latitude and longitude');
        if (!name.value.trim() && !address.value.trim() && !latitude.value.trim()) yoursFieldError(name, 'Name the place, give an address or enter coordinates');
        return { kind: 'place', ...(name.value.trim() ? { name: name.value.trim() } : {}), ...(address.value.trim() ? { address: address.value.trim() } : {}),
          ...(latitude.value.trim() ? { latitude: Number(latitude.value), longitude: Number(longitude.value) } : {}) };
      });
    } else if (kind === 'identifier') {
      const value = own?.kind === kind ? own : undefined; const scheme = field(row, 'Identifier scheme', value?.scheme); const input = field(row, 'Identifier value', value?.value);
      first = scheme;
      node('small', row, 'AI apps you connect can read this value exactly as entered.');
      anchorGetters.push(() => removed ? null : { kind, scheme: scheme.value.trim(), value: input.value.trim() });
    } else {
      const value = own?.kind === kind ? own : undefined; const identifier = field(row, 'Instrument identifier', value?.identifier); const quantity = field(row, 'Quantity (optional)', value?.quantity === undefined ? '' : String(value.quantity), 'number'); quantity.step = 'any';
      first = identifier;
      anchorGetters.push(() => removed ? null : { kind, identifier: identifier.value.trim(), ...(quantity.value.trim() ? { quantity: Number(quantity.value) } : {}) });
    }
    button(row, 'Remove anchor', () => { removed = true; return removeRow(row, anchorAdds.get(kind)!); });
    rowFocus.set(row, first); return first;
  };
  own.anchors?.forEach(anchor => addAnchor(anchor));
  for (const [kind, title] of [['place', 'Add place'], ['identifier', 'Add identifier'], ['instrument', 'Add instrument']] as const) anchorAdds.set(kind, button(anchors, title, () => addAnchor(undefined, kind)));
  const values = section('Value history'); const valueGetters: Array<() => AssetValue | null> = [];
  node('p', values, 'Add an entry for a new valuation. Edit an old entry to correct it; the correction is recorded as yours.');
  const addValue = (own?: AssetValue) => {
    const row = node('article', values); let removed = false;
    const amount = field(row, 'Amount', own?.amount, 'text'); amount.inputMode = 'decimal'; const currency = field(row, 'Currency', own?.currency ?? ''); currency.maxLength = 3;
    const originalDate = own ? new Date(own.as_of).toISOString().slice(0, 10) : '';
    const asOf = field(row, 'Valued on', originalDate, 'date'); const basis = choice(row, 'Value basis', ['purchase', 'appraisal', 'insured', 'estimate', 'market'], own?.basis ?? 'estimate');
    valueGetters.push(() => { if (removed) return null;
      const at = calendarDayMs(asOf.value); if (at === null) yoursFieldError(asOf, 'Enter the actual valuation date');
      const value = { amount: amount.value.trim(), currency: currency.value.trim().toUpperCase(), as_of: own && asOf.value === originalDate ? own.as_of : at,
        basis: basis.value as AssetValue['basis'] };
      const unchanged = own && value.amount === own.amount && value.currency === own.currency && value.as_of === own.as_of && value.basis === own.basis;
      return { ...value, evidence: unchanged ? own.evidence : [] };
    });
    button(row, 'Remove value', () => { removed = true; return removeRow(row, addValueButton); });
    rowFocus.set(row, amount); return amount;
  };
  own.values?.forEach(value => addValue(value)); const addValueButton = button(values, 'Add value', () => addValue());
  return { read(): AssetPatch { return { ...Object.assign({}, ...maps.map(get => get())), anchors: anchorGetters.map(get => get()).filter((row): row is AssetAnchor => row !== null),
    values: valueGetters.map(get => get()).filter((row): row is AssetValue => row !== null) }; } };
};

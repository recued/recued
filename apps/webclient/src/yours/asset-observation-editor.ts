import { validateAsset, type Asset, type AssetPatch } from '@recued/contracts';

export const assetObservationFieldName = (name: string) => name[0]!.toUpperCase() + name.slice(1).replaceAll('_', ' ');
const localTime = (at: number) => {
  const date = new Date(at); const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** A manual observation writes one typed fact through the existing owner path.
 * Values are never prefilled from an old sample or another field's draft. */
export const mountAssetObservationEditor = (host: HTMLFormElement, asset: Asset, kind: 'reading' | 'condition', changed: () => void, initialField?: string) => {
  const doc = host.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text?: string) => {
    const value = doc.createElement(tag); if (text !== undefined) value.textContent = text; parent.append(value); return value;
  };
  const input = (parent: HTMLElement, title: string, name: string, type = 'text') => {
    const label = node('label', parent, title); const field = node('input', label); field.type = type; field.name = name;
    field.setAttribute('aria-label', title); field.dataset.yoursFocus = name; field.addEventListener('input', changed); return field;
  };
  const select = (parent: HTMLElement, title: string, name: string, choices: Array<[string, string]>) => {
    const label = node('label', parent, title); const field = node('select', label); field.name = name;
    field.setAttribute('aria-label', title); field.dataset.yoursFocus = name;
    for (const [key, title] of choices) { const option = node('option', field, title); option.value = key; }
    field.addEventListener('change', changed); return field;
  };
  const map = kind === 'reading' ? asset.readings : asset.observations;
  const NEW_FIELD = '__new__';
  const picker = select(host, kind === 'reading' ? 'Reading' : 'Condition', 'observation-field', [
    ...Object.keys(map).map(key => [key, assetObservationFieldName(key)] as [string, string]),
    [NEW_FIELD, kind === 'reading' ? 'New reading…' : 'New condition…'],
  ]);
  if (initialField && Object.hasOwn(map, initialField)) picker.value = initialField;
  const custom = node('div', host);
  const name = input(custom, 'Field name', 'observation-name'); name.maxLength = 64; name.pattern = '[a-z][a-z0-9_]{0,63}';
  node('p', custom, 'Use a name such as gas_pressure or leak_detected. Letters, numbers and underscores.').className = 'yours-muted';
  const previous = node('p', host); previous.dataset.yoursObservationPrevious = ''; previous.className = 'yours-muted';
  const value = kind === 'reading' ? input(host, 'Value', 'observation-value', 'number') : null;
  if (value) { value.step = 'any'; value.required = true; }
  const unit = kind === 'reading' ? input(host, 'Unit', 'observation-unit') : null;
  if (unit) { unit.required = true; unit.maxLength = 80; }
  const unitHint = kind === 'reading' ? node('p', host) : null;
  if (unitHint) { unitHint.className = 'yours-muted'; unitHint.dataset.yoursObservationUnit = ''; }
  const state = kind === 'condition' ? select(host, 'What you observed', 'observation-state', [
    ['', 'Choose what you observed'], ['present', 'Present'], ['possible', 'Possibly present'], ['clear', 'Clear'],
  ]) : null;
  if (state) state.required = true;
  const at = input(host, 'Observed at', 'observation-at', 'datetime-local'); at.required = true; at.step = '1';
  const capturedAt = Math.floor(Date.now() / 1000) * 1000;
  at.value = localTime(capturedAt); const capturedText = at.value;
  node('p', host, 'Times use this device’s time zone.').className = 'yours-muted';
  node('p', host, 'Your entry takes priority over automatic updates to this field.');
  type Draft = { value: string; unit: string; state: string; at: string };
  const drafts = new Map<string, Draft>(); let selected = picker.value;
  const ruleUnits = (key: string) => [...new Set(asset.rules.flatMap(rule => rule.when.kind === 'objective' && rule.when.field === key ? [rule.when.unit] : []))];
  const update = () => {
    const fresh = selected === NEW_FIELD; const draft = drafts.get(selected);
    custom.hidden = !fresh; name.disabled = !fresh; name.required = fresh;
    if (value && unit && unitHint) {
      const reading = fresh ? null : asset.readings[selected]; const units = fresh ? [] : ruleUnits(selected);
      value.value = draft?.value ?? '';
      unit.value = reading?.unit ?? (units.length === 1 ? units[0]! : draft?.unit ?? '');
      unit.readOnly = !!reading || units.length === 1;
      unitHint.textContent = units.length > 1 ? 'Rules for this reading use different units. Edit those rules before recording a value.'
        : reading ? 'Unit from the last recorded reading.' : units.length === 1 ? 'Unit from this asset’s rule.' : 'Enter the unit you observed.';
      previous.textContent = reading ? `Last recorded: ${reading.value} ${reading.unit} · ${new Date(reading.as_of).toLocaleString()}` : fresh ? 'Add the value you observed.' : 'No reading recorded yet. Enter the actual value.';
    } else if (state) {
      const condition = fresh ? null : asset.observations[selected]; state.value = draft?.state ?? '';
      previous.textContent = condition ? `Last recorded: ${condition.active ? 'Present' : 'Clear'} · ${condition.certainty === 'conditional' ? 'possible' : 'confirmed'} · ${new Date(condition.as_of).toLocaleString()}`
        : fresh ? 'Choose the condition you observed.' : 'No condition recorded yet. Unknown is not clear.';
    }
    at.value = draft?.at ?? capturedText;
  };
  picker.addEventListener('change', () => {
    drafts.set(selected, { value: value?.value ?? '', unit: unit?.value ?? '', state: state?.value ?? '', at: at.value });
    selected = picker.value; update();
  });
  update();
  return { read(): AssetPatch {
    const fresh = picker.value === NEW_FIELD; const key = fresh ? name.value.trim() : picker.value;
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) throw new Error('Use a field name such as gas_pressure or leak_detected.');
    if (fresh && Object.hasOwn(map, key)) throw new Error('That field already exists. Choose it from the list.');
    if (!fresh && !Object.hasOwn(map, key)) throw new Error('Choose an existing field or add a new one.');
    // Keep the captured instant when an unchanged local wall time is ambiguous
    // during a DST rollback. Reject nonexistent edited wall times, including gaps.
    const asOf = at.value === capturedText ? capturedAt : new Date(at.value).getTime();
    const normalized = at.value.length === 16 ? `${at.value}:00` : at.value;
    if (!at.value || !Number.isFinite(asOf) || asOf < 0 || localTime(asOf) !== normalized) throw new Error('Enter a valid observation time in this device’s time zone.');
    if (asOf > Date.now()) throw new Error('Choose an observation time that has already happened.');
    let patch: AssetPatch;
    if (value && unit) {
      if (!value.value.trim() || !Number.isFinite(Number(value.value))) throw new Error('Enter the actual reading; unknown is not zero.');
      if (!unit.value.trim()) throw new Error('Enter the reading’s unit.');
      if (!fresh && ruleUnits(key).length > 1) throw new Error('Rules for this reading use different units. Edit those rules first.');
      patch = { readings: { [key]: { value: Number(value.value), unit: unit.readOnly ? unit.value : unit.value.trim(), as_of: asOf, evidence: [] } } };
    } else {
      if (!state || !['present', 'possible', 'clear'].includes(state.value)) throw new Error('Choose what you observed. Unknown is not clear.');
      patch = { observations: { [key]: { active: state.value !== 'clear', certainty: state.value === 'possible' ? 'conditional' : 'confirmed',
        as_of: asOf, evidence: [], source: 'owner' } } };
    }
    validateAsset({ ...asset, readings: { ...asset.readings, ...patch.readings }, observations: { ...asset.observations, ...patch.observations } });
    return patch;
  } };
};

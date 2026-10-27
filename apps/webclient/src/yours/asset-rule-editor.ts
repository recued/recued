import { validateAssetRule, type Asset, type AssetRule } from '@recued/contracts';

export const parseReminderOffsets = (value: string): AssetRule['schedule']['before'] => value.trim() ? value.split(',').map(part => {
  const match = /^\s*(\d+)\s+(days?|weeks?|months?)\s*$/u.exec(part);
  if (!match || Number(match[1]) > 36500) throw new Error('Use offsets such as 6 months, 3 months, 1 week.');
  return { amount: Number(match[1]), unit: `${match[2]!.replace(/s$/u, '')}s` as 'days' | 'weeks' | 'months' };
}) : [];

export const ruleOffsetWords = (point: AssetRule['schedule']['before'][number]): string =>
  `${point.amount} ${point.amount === 1 ? point.unit.replace(/s$/u, '') : point.unit}`;

export const assetRuleWhenWords = (when: AssetRule['when']): string => {
  const field = when.field.replaceAll('_', ' ');
  switch (when.kind) {
    case 'expiry': return when.offset ? `${ruleOffsetWords(when.offset)} before “${field}”` : `On the date in “${field}”`;
    case 'interval': return `Every ${ruleOffsetWords(when.every)} after ${field}`;
    case 'objective': return `As ${field} ${when.direction === 'rising' ? 'rises' : 'falls'} toward ${when.target} ${when.unit}`;
    case 'condition': return `When ${field} is ${when.certainty === 'confirmed' ? 'confirmed' : 'possibly'} present`;
  }
};

/** Pick from the asset's existing facts. Inactive kinds keep their draft values,
 * but cannot participate in validation or the saved rule. */
export const mountAssetRuleEditor = (host: HTMLFormElement, asset: Asset, own: AssetRule | undefined, changed: () => void,
  options: { classPreset?: boolean; proposal?: boolean; scheduleOnly?: boolean; initialField?: { group: 'dates' | 'readings' | 'observations'; field: string } } = {}) => {
  const scheduleRule = options.scheduleOnly ? own : undefined;
  if (options.scheduleOnly && !scheduleRule) throw new Error('A schedule needs an existing rule.');
  const doc = host.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text?: string) => {
    const value = doc.createElement(tag); if (text !== undefined) value.textContent = text; parent.append(value); return value;
  };
  const input = (parent: HTMLElement, title: string, name: string, value = '', type = 'text') => {
    const label = node('label', parent, title); const field = node('input', label); field.type = type; field.name = name; field.value = value;
    field.setAttribute('aria-label', title); field.dataset.yoursFocus = name; field.addEventListener('input', changed); return field;
  };
  const select = (parent: HTMLElement, title: string, name: string, choices: ReadonlyArray<readonly [string, string]>, value: string) => {
    const label = node('label', parent, title); const field = node('select', label); field.name = name; field.dataset.yoursFocus = name;
    field.setAttribute('aria-label', title);
    for (const [key, title] of choices) { const option = node('option', field, title); option.value = key; }
    field.value = value; field.addEventListener('change', changed); return field;
  };
  const check = (parent: HTMLElement, title: string, name: string, value: boolean) => {
    const field = input(parent, title, name, '', 'checkbox'); field.checked = value; return field;
  };
  const amount = (parent: HTMLElement, title: string, name: string, value: string, min: number, optional = false, decimal = false) => {
    const field = input(parent, title, name, value, 'number'); field.min = String(min); field.step = decimal ? 'any' : '1'; field.required = !optional;
    return field;
  };
  const units = [['days', 'days'], ['weeks', 'weeks'], ['months', 'months']] as const;
  if (scheduleRule) node('p', host, 'This proposal changes reminder times only. Edit the rule on the asset to change its deadline or behavior.');
  const title = input(host, 'Title', 'title', own?.title ?? (options.initialField ? `Check ${options.initialField.field.replaceAll('_', ' ')}` : 'Renew or service')); title.required = true; title.maxLength = 500;
  const when = own?.when;
  const kind = select(host, 'When', 'kind', [['expiry', 'On an asset date'], ['interval', 'An interval after last done'],
    ['objective', 'A reading approaches a target'], ['condition', 'A condition is active']], when?.kind
      ?? (options.initialField ? options.initialField.group === 'readings' ? 'objective' : options.initialField.group === 'observations' ? 'condition' : 'expiry'
        : Object.keys(asset.dates).length ? 'expiry' : Object.keys(asset.readings).length ? 'objective' : Object.keys(asset.observations).length ? 'condition' : 'expiry'));
  const fact = select(host, 'Asset date', 'field', [], ''); fact.required = true;
  const hint = node('p', host); hint.className = 'yours-muted'; hint.dataset.yoursRuleFactHint = '';
  const preview = node('p', host); preview.className = 'yours-rule-preview'; preview.dataset.yoursRulePreview = ''; preview.setAttribute('role', 'status');
  const factLabel = fact.parentElement!;
  const savedFields = new Map<string, string>();
  const category = (kind: string) => kind === 'objective' ? 'readings' : kind === 'condition' ? 'observations' : 'dates';
  if (when) savedFields.set(category(when.kind), when.field);
  else if (options.initialField) savedFields.set(options.initialField.group, options.initialField.field);
  const readable = (field: string) => field[0]!.toUpperCase() + field.slice(1).replaceAll('_', ' ');
  const groups: Array<{ node: HTMLFieldSetElement; kinds: readonly string[] }> = [];
  const group = (parent: HTMLElement, title: string, ...kinds: string[]) => {
    const root = node('fieldset', parent); node('legend', root, title); groups.push({ node: root, kinds }); return root;
  };
  const interval = group(host, 'Service interval', 'interval');
  const every = amount(interval, 'Interval amount', 'every', when?.kind === 'interval' ? String(when.every.amount) : '12', 1);
  const everyUnit = select(interval, 'Interval unit', 'unit', units, when?.kind === 'interval' ? when.every.unit : 'months');
  const objective = group(host, 'Reading target', 'objective');
  const target = input(objective, 'Target', 'target', when?.kind === 'objective' ? String(when.target) : '', 'number'); target.step = 'any'; target.required = true;
  const readingUnit = input(objective, 'Reading unit', 'reading-unit', when?.kind === 'objective' ? when.unit : ''); readingUnit.required = true; readingUnit.maxLength = 80;
  const unitDrafts = new Map<string, string>(); let readingKey: string | undefined;
  if (when?.kind === 'objective') unitDrafts.set(when.field, when.unit);
  const direction = select(objective, 'Direction', 'direction', [['rising', 'Rising toward the target'], ['falling', 'Falling toward the target']], when?.kind === 'objective' ? when.direction : 'rising');
  const mode = select(objective, 'After completion', 'mode', [['usage', 'Wait for the next service'], ['condition', 'Wait for the reading to recover']], when?.kind === 'objective' ? when.mode : 'usage');
  const condition = group(host, 'Condition evidence', 'condition');
  const certainty = select(condition, 'Observation certainty', 'certainty', [['confirmed', 'Confirmed'], ['conditional', 'Confirmed or conditional']], when?.kind === 'condition' ? when.certainty : 'confirmed');
  const before = input(host, 'Remind before (for example 6 months, 1 week)', 'before', own ? own.schedule.before.map(ruleOffsetWords).join(', ') : '1 month');
  const onDay = check(host, 'On the day', 'on-day', own?.schedule.on_day ?? true);
  const consequence = select(host, 'Consequence', 'consequence', [['routine', 'Routine'], ['floor', 'Safety, legal or travel']], own?.consequence ?? 'routine');
  const expiry = select(host, 'Expiry', 'expiry', [['strict_expire', 'Lapse on the due day'], ['escalate_overdue', 'Keep overdue'], ['indefinite', 'No expiry']], own?.expiry_policy ?? 'strict_expire');
  const reaction = select(host, 'Creates', 'reaction', [['action', 'An action to complete'], ['notice', 'A notice with nothing to complete'], ['', 'Nothing under Due']], own?.reaction.occurrence ?? (own ? '' : 'action'));
  const notify = check(host, 'Notify', 'notify', own?.reaction.notify ?? true);
  const more = node('details', host); more.dataset.yoursRuleMore = ''; node('summary', more, 'More rule options');
  const date = group(more, 'Earlier deadline', 'expiry');
  const offset = amount(date, 'Date offset before its field (blank for the field date)', 'date-offset', when?.kind === 'expiry' && when.offset ? String(when.offset.amount) : '', 0, true);
  const offsetUnit = select(date, 'Date offset unit', 'date-offset-unit', units, when?.kind === 'expiry' ? when.offset?.unit ?? 'days' : 'days');
  const trend = group(more, 'Reading estimates and recurrence', 'objective');
  const leadDays = amount(trend, 'Trend lead in days', 'lead-days', when?.kind === 'objective' ? String(when.lead_days) : '14', 0, false, true);
  const leadValue = amount(trend, 'Reading lead (optional, in the reading unit)', 'lead-value', when?.kind === 'objective' && when.lead_value !== undefined ? String(when.lead_value) : '', 0, true, true);
  const usageHost = node('div', trend);
  const usageEvery = amount(usageHost, 'Usage interval (optional)', 'usage-every', when?.kind === 'objective' && when.every !== undefined ? String(when.every) : '', 0, true, true);
  const updateUsage = () => {
    usageHost.hidden = mode.value !== 'usage'; usageEvery.disabled = kind.value !== 'objective' || mode.value !== 'usage';
  };
  mode.addEventListener('change', updateUsage);
  const after = amount(more, 'Repeat after (blank for none)', 'after', own?.schedule.after ? String(own.schedule.after.amount) : '', 1, true);
  const afterUnit = select(more, 'Repeat unit', 'after-unit', units, own?.schedule.after?.unit ?? 'weeks');
  const repeatHint = node('p', more); repeatHint.className = 'yours-muted';
  const enabled = check(more, 'Enabled', 'enabled', own?.enabled ?? true);
  enabled.disabled = !!options.proposal;
  const emit = check(more, 'Emit an event', 'emit', own?.reaction.emit ?? false);
  // Collapsed optional controls must become reachable before native validation
  // tries to focus them (including WebKit's deferred layout).
  let revealingInvalid = false;
  more.addEventListener('invalid', event => {
    more.open = true;
    if (revealingInvalid) return;
    event.preventDefault(); revealingInvalid = true;
    doc.defaultView?.requestAnimationFrame(() => { if (host.isConnected) host.reportValidity(); revealingInvalid = false; });
  }, true);
  const updateRepeatHint = () => {
    repeatHint.textContent = reaction.value !== 'action' ? 'Only an action can repeat after its date. Leave Repeat after blank for a notice or for nothing under Due.'
      : expiry.value === 'strict_expire' ? 'This rule lapses on the due day, so it will not repeat afterward.' : 'Repeats continue while the action is open.';
  };
  expiry.addEventListener('change', updateRepeatHint); reaction.addEventListener('change', updateRepeatHint); updateRepeatHint();
  const updateFactHint = () => {
    const key = fact.value;
    if (!key) {
      if (Object.keys(asset[category(kind.value)]).length) { hint.textContent = 'This rule’s fact is no longer available. Choose an existing fact.'; return; }
      const facts = category(kind.value) === 'dates' ? 'dates' : category(kind.value) === 'readings' ? 'readings' : 'conditions';
      const next = facts === 'dates' ? 'Add one in Edit asset' : facts === 'readings' ? 'Use Record reading on the asset' : 'Use Record condition on the asset';
      hint.textContent = options.classPreset ? `No ${facts} in this class yet. Add one to the class fields before saving this kind of rule.`
        : `No ${facts} on this asset yet. ${next} before saving this kind of rule.`;
      return;
    }
    if (kind.value === 'objective') {
      const reading = asset.readings[key];
      if (readingKey !== key) {
        if (readingKey && !asset.readings[readingKey]) unitDrafts.set(readingKey, readingUnit.value);
        readingUnit.value = reading?.unit ?? unitDrafts.get(key) ?? ''; readingKey = key;
      }
      readingUnit.readOnly = !!reading;
      hint.textContent = reading ? 'The target uses the selected reading’s unit.' : 'The reading is unknown. No current value or trend has been assumed.';
    } else if (kind.value === 'condition') hint.textContent = asset.observations[key] ? 'This rule uses the selected condition’s recorded evidence.' : 'The condition is unknown. No active condition has been assumed.';
    else hint.textContent = asset.dates[key] ? 'This rule uses the selected asset date.' : 'The date is unknown. No deadline has been assumed.';
  };
  const updateKind = () => {
    for (const group of groups) { const active = group.kinds.includes(kind.value); group.node.hidden = !active; group.node.disabled = !active; }
    updateUsage();
    const key = category(kind.value);
    const name = key === 'dates' ? 'Asset date' : key === 'readings' ? 'Asset reading' : 'Asset condition';
    factLabel.firstChild!.textContent = name; fact.setAttribute('aria-label', name); fact.replaceChildren();
    const entries = Object.keys(asset[key]);
    if (!entries.length) { const empty = node('option', fact, `No ${key === 'observations' ? 'conditions' : key} available`); empty.value = ''; }
    for (const field of entries) {
      const value = key === 'dates' ? asset.dates[field] : key === 'readings' ? asset.readings[field] : asset.observations[field];
      const detail = value == null ? 'Unknown' : typeof value === 'string' ? value : 'value' in value ? `${value.value} ${value.unit}` : value.active ? 'Active' : 'Clear';
      const option = node('option', fact, `${readable(field)} · ${detail}`); option.value = field;
    }
    const selected = savedFields.get(key);
    if (selected && entries.includes(selected)) fact.value = selected;
    else if (selected) {
      const unavailable = node('option', fact, `${readable(selected)} · No longer on this asset`); unavailable.value = ''; unavailable.disabled = true; fact.value = '';
    }
    updateFactHint();
  };
  fact.addEventListener('change', () => { savedFields.set(category(kind.value), fact.value); updateFactHint(); });
  kind.addEventListener('change', updateKind); updateKind();
  if (scheduleRule) {
    const editable = new Set(['before', 'on-day', 'after', 'after-unit']);
    for (const control of host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) if (!editable.has(control.name)) control.disabled = true;
  }
  const id = own?.id ?? `rule_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  const updatePreview = () => {
    let trigger = 'Choose a fact and complete the rule details';
    if (fact.value) {
      if (kind.value === 'objective' && target.value && readingUnit.value) trigger = assetRuleWhenWords({ kind: 'objective', field: fact.value, target: Number(target.value), unit: readingUnit.value,
        direction: direction.value as 'rising' | 'falling', mode: mode.value as 'usage' | 'condition', lead_days: Number(leadDays.value) });
      else if (kind.value === 'interval' && every.value) trigger = assetRuleWhenWords({ kind: 'interval', field: fact.value, every: { amount: Number(every.value), unit: everyUnit.value as 'days' | 'weeks' | 'months' } });
      else if (kind.value === 'condition') trigger = assetRuleWhenWords({ kind: 'condition', field: fact.value, certainty: certainty.value as 'confirmed' | 'conditional' });
      else if (kind.value === 'expiry') trigger = assetRuleWhenWords({ kind: 'expiry', field: fact.value, ...(offset.value ? { offset: { amount: Number(offset.value), unit: offsetUnit.value as 'days' | 'weeks' | 'months' } } : {}) });
    }
    const reminders = [before.value.trim() ? `${before.value.trim()} before` : '', onDay.checked ? 'on the day' : ''].filter(Boolean).join(', ');
    const repeats = reaction.value === 'action' && expiry.value !== 'strict_expire' && after.value ? ` Then every ${ruleOffsetWords({ amount: Number(after.value), unit: afterUnit.value as 'days' | 'weeks' | 'months' })} while open.` : '';
    preview.textContent = `${!enabled.checked ? 'Rule disabled. ' : own?.muted ? 'Reminders are muted. ' : ''}${trigger}. ${reaction.value === 'action' ? 'Create a task' : reaction.value === 'notice' ? 'Create a notice' : 'Nothing under Due'}${notify.checked ? ' and notify you' : ''}.${reminders ? ` Remind ${reminders}.` : ' No scheduled reminder.'}${repeats}`;
  };
  host.addEventListener('input', updatePreview); host.addEventListener('change', updatePreview); updatePreview();
  return { read(): AssetRule {
    if (!scheduleRule && (!fact.value || !Object.hasOwn(asset[category(kind.value)], fact.value))) throw new Error('Choose an existing asset fact for this rule.');
    const ruleWhen: AssetRule['when'] = kind.value === 'interval' ? { kind: 'interval', field: fact.value, every: { amount: Number(every.value), unit: everyUnit.value as 'days' | 'weeks' | 'months' } }
      : kind.value === 'objective' ? { kind: 'objective', field: fact.value, target: Number(target.value), unit: readingUnit.value, direction: direction.value as 'rising' | 'falling',
        mode: mode.value as 'usage' | 'condition', lead_days: Number(leadDays.value), ...(leadValue.value.trim() ? { lead_value: Number(leadValue.value) } : {}),
        ...(mode.value === 'usage' && usageEvery.value.trim() ? { every: Number(usageEvery.value) } : {}) }
      : kind.value === 'condition' ? { kind: 'condition', field: fact.value, certainty: certainty.value as 'confirmed' | 'conditional' }
      : { kind: 'expiry', field: fact.value, ...(offset.value.trim() ? { offset: { amount: Number(offset.value), unit: offsetUnit.value as 'days' | 'weeks' | 'months' } } : {}) };
    try {
      if (!scheduleRule && kind.value === 'objective' && !target.value.trim()) throw new Error('Enter the actual target; unknown is not zero.');
      if (after.value.trim() && (scheduleRule ? scheduleRule.reaction.occurrence : reaction.value) !== 'action') throw new Error('Only an action can repeat after its date. Clear Repeat after or choose an action.');
      const schedule: AssetRule['schedule'] = { before: parseReminderOffsets(before.value), on_day: onDay.checked,
        ...(after.value.trim() ? { after: { amount: Number(after.value), unit: afterUnit.value as 'days' | 'weeks' | 'months' } } : {}) };
      const rule: AssetRule = scheduleRule ? { ...scheduleRule, schedule } : { ...own, id, title: title.value, when: ruleWhen, enabled: enabled.checked, muted: own?.muted ?? false, pinned: true,
        consequence: consequence.value as AssetRule['consequence'], expiry_policy: expiry.value as AssetRule['expiry_policy'],
        reaction: { notify: notify.checked, emit: emit.checked, occurrence: reaction.value as 'action' | 'notice' || null },
        schedule };
      validateAssetRule(rule, asset); return rule;
    } catch (error) { more.open = true; throw error; }
  } };
};

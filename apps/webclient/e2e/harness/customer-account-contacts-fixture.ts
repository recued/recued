import { parseCustomerAccountContactDefaults,type CustomerAccountContactDefaults,type CustomerAccountContactDefaultsRecord,
  type CustomerAccountContactDefaultsSetInput } from '@recued/contracts';

export interface AccountContactFixtureControls {
  contactDefaults(contact: CustomerAccountContactDefaults,account_id?: string): void;
  contactFailure(kind: 'read' | 'save' | 'none'): void;contactWrongAccount(): void;
}
/** Preferences have their own revision and never bump the fixture's billing revision. */
export const createAccountContactFixture = (now: number,defaultAccount: string,exists: (id: string) => boolean) => {
  const saved = new Map<string,CustomerAccountContactDefaultsRecord>();let failure = '';let wrong = false;
  const value = (account_id: string): CustomerAccountContactDefaultsRecord => {
    if (!exists(account_id)) throw new Error('Choose a saved customer account.');
    return saved.get(account_id) ?? { format: 'recued.customer-account-contact-defaults',version: 1,account_id,revision: 0,updated_at: null,contact: {} };
  };
  const set = (input: CustomerAccountContactDefaultsSetInput) => {
    if (failure === 'save') throw new Error('Contact defaults could not be saved. Your edits remain in this form.');
    const previous = value(input.account_id);if (previous.revision !== input.expected_revision) throw new Error('The contact defaults changed. Refresh them before saving again.');
    const record: CustomerAccountContactDefaultsRecord = { ...previous,revision: previous.revision+1,updated_at: now,contact: parseCustomerAccountContactDefaults(input.contact) };
    saved.set(input.account_id,record);return structuredClone(record);
  };
  const controls: AccountContactFixtureControls = {
    contactDefaults: (contact,account_id = defaultAccount) => { set({ account_id,expected_revision: value(account_id).revision,contact }); },
    contactFailure: kind => { failure = kind === 'none' ? '' : kind; },contactWrongAccount: () => { wrong = true; },
  };
  return { controls,set,get: (account_id: string) => {
    if (failure === 'read') throw new Error('Contact defaults unavailable. Refresh and try again.');
    const record = structuredClone(value(account_id));if (wrong) { wrong = false;record.account_id='aaaaaaaa-aaaa-aaaa-aaaa-999999999999'; }return record;
  } };
};

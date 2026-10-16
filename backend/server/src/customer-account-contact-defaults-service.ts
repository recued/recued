import type Database from 'better-sqlite3';
import { parseCustomerAccountContactDefaults,type CustomerAccountContactDefaults,type CustomerAccountContactDefaultsRecord,
  type CustomerAccountInput,type CustomerAccountContactDefaultsSetInput } from '@recued/contracts';
import type { CustomerAccountStatementService } from './customer-account-statement-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { QuoteSignoffError } from './quote-signoff-service.js';

interface Row { account_id: string;revision: number;settings_ciphertext: string;updated_at: number }
const unavailable = (): never => { throw new QuoteSignoffError('customer_account_contact_unavailable','Saved account contact defaults could not be read. Refresh and try again.'); };
const stale = (): never => { throw new QuoteSignoffError('customer_account_contact_stale','The contact defaults changed. Refresh them before saving again.'); };
const invalid = (message: string): never => { throw new QuoteSignoffError('customer_account_contact_invalid',message,400); };
const id = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  ? value : invalid('Choose a saved customer account.');
const contact = (value: unknown): CustomerAccountContactDefaults => {
  try { return parseCustomerAccountContactDefaults(value); }
  catch (error) { return invalid(error instanceof Error ? error.message : 'Choose valid account contact defaults.'); }
};

/** Contact changes neither rewrite account membership nor invalidate billing evidence. */
export const createCustomerAccountContactDefaultsService = (deps: {
  db: Database.Database;accounts: Pick<CustomerAccountStatementService,'get'>;codec: PreapprovalCodec;now: () => number;
}) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS customer_account_contact_defaults (
    account_id TEXT PRIMARY KEY REFERENCES customer_accounts(account_id),revision INTEGER NOT NULL,
    settings_ciphertext TEXT NOT NULL,updated_at INTEGER NOT NULL
  )`);
  const row = (account_id: string) => deps.db.prepare('SELECT * FROM customer_account_contact_defaults WHERE account_id=?').get(account_id) as Row | undefined;
  const assertCurrent = (account_id: string,expected: Row | undefined) => {
    deps.codec.assertUnlocked();
    if (JSON.stringify(row(account_id)) !== JSON.stringify(expected)) return stale();
    if (!deps.db.prepare('SELECT 1 FROM customer_accounts WHERE account_id=?').get(account_id)) return unavailable();
  };
  const open = async (saved: Row): Promise<CustomerAccountContactDefaultsRecord> => {
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 1 || !Number.isSafeInteger(saved.updated_at) || saved.updated_at < 0) return unavailable();
    let value: unknown;
    try { value = await deps.codec.open(saved.settings_ciphertext); }
    catch { return unavailable(); }
    assertCurrent(saved.account_id,saved);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'account_id,contact,format,revision,updated_at,version'
      || !('format' in value) || value.format !== 'recued.customer-account-contact-defaults'
      || !('version' in value) || value.version !== 1 || !('account_id' in value) || value.account_id !== saved.account_id
      || !('revision' in value) || value.revision !== saved.revision || !('updated_at' in value) || value.updated_at !== saved.updated_at
      || !('contact' in value)) return unavailable();
    let fields: CustomerAccountContactDefaults;
    try { fields = parseCustomerAccountContactDefaults(value.contact); }
    catch { return unavailable(); }
    return { format: 'recued.customer-account-contact-defaults',version: 1,account_id: saved.account_id,
      revision: saved.revision,updated_at: saved.updated_at,contact: fields };
  };
  const account = async (value: unknown) => {
    deps.codec.assertUnlocked();const account_id = id(value);
    await deps.accounts.get({ account_id });deps.codec.assertUnlocked();return account_id;
  };
  return {
    async get(input: CustomerAccountInput): Promise<CustomerAccountContactDefaultsRecord> {
      const account_id = await account(input.account_id);const saved = row(account_id);
      if (saved) return open(saved);
      assertCurrent(account_id,undefined);
      return { format: 'recued.customer-account-contact-defaults',version: 1,account_id,revision: 0,updated_at: null,contact: {} };
    },
    async set(input: CustomerAccountContactDefaultsSetInput): Promise<CustomerAccountContactDefaultsRecord> {
      deps.codec.assertUnlocked();
      if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 || input.expected_revision >= Number.MAX_SAFE_INTEGER) {
        invalid('Refresh the account contact defaults before saving.');
      }
      const fields = contact(input.contact);const account_id = await account(input.account_id);const previous = row(account_id);
      if ((previous?.revision ?? 0) !== input.expected_revision) return stale();
      if (previous) await open(previous);
      const updated_at = deps.now();if (!Number.isSafeInteger(updated_at) || updated_at < 0) return unavailable();
      const saved: CustomerAccountContactDefaultsRecord = { format: 'recued.customer-account-contact-defaults',version: 1,
        account_id,revision: input.expected_revision+1,updated_at,contact: fields };
      const ciphertext = deps.codec.sealSync(saved);
      return deps.db.transaction(() => {
        assertCurrent(account_id,previous);
        deps.db.prepare(`INSERT INTO customer_account_contact_defaults (account_id,revision,settings_ciphertext,updated_at) VALUES (?,?,?,?)
          ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,settings_ciphertext=excluded.settings_ciphertext,updated_at=excluded.updated_at`)
          .run(account_id,saved.revision,ciphertext,updated_at);
        return saved;
      })();
    },
  };
};
export type CustomerAccountContactDefaultsService = ReturnType<typeof createCustomerAccountContactDefaultsService>;

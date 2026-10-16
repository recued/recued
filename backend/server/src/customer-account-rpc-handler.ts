import { RpcError,type CustomerAccountInput,type CustomerAccountSaveInput,type CustomerAccountsListInput,type CustomerAccountStatementDraftInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { CustomerAccountStatementService } from './customer-account-statement-service.js';

type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps,input: unknown,caller: Caller,keys: string[],
  body: (service: CustomerAccountStatementService) => T | Promise<T>): Promise<T> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Customer accounts require a paired owner client.',401);
  if (!deps.getCustomerAccountStatementService) throw new RpcError('not_configured','Customer accounts are unavailable on this server.',503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new RpcError('customer_account_invalid','Invalid customer account input.',400);
  }
  try { return await body(deps.getCustomerAccountStatementService()); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};
export const handleCustomerAccountsList = (deps: ReceptionRpcDeps,input: CustomerAccountsListInput | void,caller: Caller) =>
  run(deps,input === undefined ? {} : input,caller,['limit','cursor'],service => service.list(input || {}));
export const handleCustomerAccountGet = (deps: ReceptionRpcDeps,input: CustomerAccountInput,caller: Caller) =>
  run(deps,input,caller,['account_id'],service => service.get(input));
export const handleCustomerAccountSave = (deps: ReceptionRpcDeps,input: CustomerAccountSaveInput,caller: Caller) =>
  run(deps,input,caller,['account_id','expected_revision','customer','job_ids'],service => service.save(input));
export const handleCustomerAccountStatement = (deps: ReceptionRpcDeps,input: CustomerAccountInput,caller: Caller) =>
  run(deps,input,caller,['account_id'],service => service.statement(input));
export const handleCustomerAccountStatementDraft = (deps: ReceptionRpcDeps,input: CustomerAccountStatementDraftInput,caller: Caller) =>
  run(deps,input,caller,['account_id','expected_statement_hash','sender_mail_instance','recipient_email'],service => service.draft(input));

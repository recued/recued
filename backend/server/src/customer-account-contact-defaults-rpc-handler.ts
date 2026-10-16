import { RpcError,type CustomerAccountInput,type CustomerAccountContactDefaultsSetInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import type { CustomerAccountContactDefaultsService } from './customer-account-contact-defaults-service.js';
import { QuoteSignoffError } from './quote-signoff-service.js';

type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps,input: unknown,caller: Caller,keys: string[],body: (service: CustomerAccountContactDefaultsService) => Promise<T>) => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Account contact defaults require a paired owner client.',401);
  if (!deps.getCustomerAccountContactDefaultsService) throw new RpcError('not_configured','Account contact defaults are unavailable on this server.',503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new RpcError('customer_account_contact_invalid','Invalid account contact defaults input.',400);
  }
  try { return await body(deps.getCustomerAccountContactDefaultsService()); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};
export const handleCustomerAccountContactDefaultsGet = (deps: ReceptionRpcDeps,input: CustomerAccountInput,caller: Caller) =>
  run(deps,input,caller,['account_id'],service => service.get(input));
export const handleCustomerAccountContactDefaultsSet = (deps: ReceptionRpcDeps,input: CustomerAccountContactDefaultsSetInput,caller: Caller) =>
  run(deps,input,caller,['account_id','expected_revision','contact'],service => service.set(input));

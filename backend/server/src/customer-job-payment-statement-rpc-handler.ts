import { RpcError,type CustomerJobPaymentStatementInput,type CustomerJobPaymentStatementDraftInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';
import type { CustomerJobPaymentStatementService } from './customer-job-payment-statement-service.js';

type Caller = { instance_id?: string | null } | undefined;
const run = async <T>(deps: ReceptionRpcDeps,input: unknown,caller: Caller,keys: string[],
  body: (service: CustomerJobPaymentStatementService) => T | Promise<T>): Promise<T> => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Job payment statements require a paired owner client.',401);
  if (!deps.getCustomerJobPaymentStatementService) throw new RpcError('not_configured','Customer job payment statements are unavailable on this server.',503);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new RpcError('customer_statement_invalid','Invalid job payment statement input.',400);
  }
  try { return await body(deps.getCustomerJobPaymentStatementService()); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};
export const handleCustomerJobPaymentStatement = (deps: ReceptionRpcDeps,input: CustomerJobPaymentStatementInput,caller: Caller) =>
  run(deps,input,caller,['job_id'],service => service.statement(input));
export const handleCustomerJobPaymentStatementDraft = (deps: ReceptionRpcDeps,input: CustomerJobPaymentStatementDraftInput,caller: Caller) =>
  run(deps,input,caller,['job_id','expected_statement_hash','sender_mail_instance','recipient_email'],service => service.draft(input));

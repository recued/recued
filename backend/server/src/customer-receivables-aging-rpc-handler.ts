import { RpcError,type CustomerReceivablesAgingInput } from '@recued/contracts';
import type { ReceptionRpcDeps } from './reception-rpc-handler.js';
import { QuoteSignoffError } from './quote-signoff-service.js';

export const handleCustomerReceivablesAging = (deps: ReceptionRpcDeps,input: CustomerReceivablesAgingInput | void,
  caller: { instance_id?: string | null } | undefined) => {
  if (!caller?.instance_id) throw new RpcError('unauthorized','Receivables aging requires a paired owner client.',401);
  if (!deps.getCustomerReceivablesAgingService) throw new RpcError('not_configured','Receivables aging is unavailable on this server.',503);
  try { return deps.getCustomerReceivablesAgingService().get(input === undefined ? {} : input); }
  catch (error) { if (error instanceof QuoteSignoffError) throw new RpcError(error.code,error.message,error.status);throw error; }
};

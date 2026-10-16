import type Database from 'better-sqlite3';
import type { QuoteSignoffReminder,QuoteSignoffReminderSetInput } from '@recued/contracts';
import type { QuoteSignoffService } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import type { PublicEndpointRegistryStore } from './storage/public-endpoint-registry-store.js';
import { createCustomerReminderService,type CustomerReminderState } from './customer-reminder-service.js';

export const createQuoteSignoffReminderService = (deps: {
  db: Database.Database;signoffs: QuoteSignoffService;codec: PreapprovalCodec;endpoints: PublicEndpointRegistryStore;
  pepper: () => Buffer;shareBaseUrl: () => string;now: () => number;
}) => {
  const service = createCustomerReminderService({ ...deps,kind: 'offer',requests: deps.signoffs,identify: request => request.signoff_id,
    message: (request,link) => { const name = request.quote_reference ?? request.quote_label;return {
      subject: `Reminder: please review ${name}`,
      body: `Hello ${request.customer},\n\nPlease review our offer for ${name} (${request.amount} ${request.currency}) and let us know your decision.\n\n${link}\n\nThis offer expires on ${new Date(request.expires_at).toISOString()}.\n\nThank you.`,
    }; } });
  const reminder = ({ request_id,...state }: CustomerReminderState): QuoteSignoffReminder => ({ signoff_id: request_id,...state });
  const facade = { rememberLink: service.rememberLink,guardSend: service.guardSend,draft: service.draft,
    get: async (id: string) => reminder(await service.get(id)),
    set: async ({ signoff_id,...settings }: QuoteSignoffReminderSetInput) => reminder(await service.set({ ...settings,request_id: signoff_id })),
    list: async (input: Parameters<typeof service.list>[0] = {}) => { const { reminders,...page } = await service.list(input);
      return { ...page,reminders: reminders.map(item => ({ signoff: item.request,reminder: reminder(item.reminder) })) }; },
  };
  return Object.assign(facade,{ sweep: (notify: Parameters<typeof service.sweep>[0],isQuiet?: Parameters<typeof service.sweep>[1]) =>
    service.sweep(notify,isQuiet,async id => { const state = await facade.get(id);return { ...state,request_id: state.signoff_id }; }) });
};
export type QuoteSignoffReminderService = ReturnType<typeof createQuoteSignoffReminderService>;

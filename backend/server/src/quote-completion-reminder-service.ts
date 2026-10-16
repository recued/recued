import type Database from 'better-sqlite3';
import type { QuoteCompletionReminder,QuoteCompletionReminderSetInput } from '@recued/contracts';
import type { QuoteCompletionService } from './quote-completion-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import type { PublicEndpointRegistryStore } from './storage/public-endpoint-registry-store.js';
import { createCustomerReminderService,type CustomerReminderState } from './customer-reminder-service.js';

export const createQuoteCompletionReminderService = (deps: {
  db: Database.Database;completions: QuoteCompletionService;codec: PreapprovalCodec;endpoints: PublicEndpointRegistryStore;
  pepper: () => Buffer;shareBaseUrl: () => string;now: () => number;
}) => {
  const service = createCustomerReminderService({ ...deps,kind: 'completion',requests: deps.completions,identify: request => request.completion_id,
    message: (request,link) => { const name = request.quote_label;return {
      subject: `Reminder: please confirm delivery for ${name}`,
      body: `Hello ${request.customer},\n\nPlease review the delivered work for ${name} and confirm completion or request corrections.\n\n${link}\n\nThis completion request expires on ${new Date(request.expires_at).toISOString()}.\n\nThank you.`,
    }; } });
  const reminder = ({ request_id,...state }: CustomerReminderState): QuoteCompletionReminder => ({ completion_id: request_id,...state });
  const facade = { rememberLink: service.rememberLink,guardSend: service.guardSend,draft: service.draft,
    get: async (id: string) => reminder(await service.get(id)),
    set: async ({ completion_id,...settings }: QuoteCompletionReminderSetInput) => reminder(await service.set({ ...settings,request_id: completion_id })),
    list: async (input: Parameters<typeof service.list>[0] = {}) => { const { reminders,...page } = await service.list(input);
      return { ...page,reminders: reminders.map(item => ({ completion: item.request,reminder: reminder(item.reminder) })) }; },
  };
  return Object.assign(facade,{ sweep: (notify: Parameters<typeof service.sweep>[0],isQuiet?: Parameters<typeof service.sweep>[1]) =>
    service.sweep(notify,isQuiet,async id => { const state = await facade.get(id);return { ...state,request_id: state.completion_id }; }) });
};
export type QuoteCompletionReminderService = ReturnType<typeof createQuoteCompletionReminderService>;

import type { HandlerSlice, ServerRpcRegistry } from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { MailFollowUpService } from './mail-follow-up-service.js';

export interface MailFollowUpRpcDeps {
  service: MailFollowUpService;
  send?: import('./mail-follow-up-send-service.js').MailFollowUpSendService;
  authorize(client: WsClient): string;
}
type Methods = 'mail.follow_up.get' | 'mail.follow_up.start' | 'mail.follow_up.check' | 'mail.follow_up.cancel' | 'mail.follow_up.reschedule' | 'mail.follow_up.list'
  | 'mail.follow_up.replacement.create' | 'mail.follow_up.delivery_report.get' | 'mail.follow_up.reply.get' | 'mail.follow_up.reply_notification.set'
  | 'mail.follow_up.send.capabilities' | 'mail.follow_up.send.get' | 'mail.follow_up.send.cancel'
  | 'mail.follow_up.task.get' | 'mail.follow_up.task.set' | 'mail.follow_up.task.list' | 'mail.follow_up.task.create' | 'mail.follow_up.task.context';

export const makeMailFollowUpHandlers = (
  deps: MailFollowUpRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, Methods, WsClient> | undefined => {
  if (!deps) return undefined;
  // Decryption yields. A token revoked while the request is in progress must
  // not receive the decrypted watch or draft identity when it resumes.
  const owner = async <T>(client: WsClient, work: (token: string) => Promise<T>): Promise<T> => {
    const token = deps.authorize(client);
    const result = await work(token);
    deps.authorize(client);
    return result;
  };
  return {
    methods: ['mail.follow_up.get', 'mail.follow_up.start', 'mail.follow_up.check', 'mail.follow_up.cancel', 'mail.follow_up.reschedule', 'mail.follow_up.list', 'mail.follow_up.reply.get', 'mail.follow_up.delivery_report.get', 'mail.follow_up.replacement.create', 'mail.follow_up.reply_notification.set',
      'mail.follow_up.send.capabilities', 'mail.follow_up.send.get', 'mail.follow_up.send.cancel',
      'mail.follow_up.task.get', 'mail.follow_up.task.set', 'mail.follow_up.task.list', 'mail.follow_up.task.create', 'mail.follow_up.task.context'],
    handlers: {
      'mail.follow_up.get': (args, client) => owner(client, () => deps.service.get(args)),
      'mail.follow_up.task.get': (args, client) => owner(client, () => deps.service.getTask(args)),
      'mail.follow_up.task.context': (args, client) => owner(client, () => deps.service.taskContext(args)),
      'mail.follow_up.task.set': (args, client) => owner(client, () => deps.service.setTask(args, () => { deps.authorize(client); })),
      'mail.follow_up.task.create': (args, client) => owner(client, () => deps.service.createTask(args, () => { deps.authorize(client); })),
      'mail.follow_up.task.list': (args, client) => owner(client, () => deps.service.taskLinks(args)),
      'mail.follow_up.start': (args, client) => owner(client, token => deps.service.start(args, token, () => { deps.authorize(client); })),
      'mail.follow_up.check': (args, client) => owner(client, () => deps.service.check(args?.id)),
      'mail.follow_up.cancel': (args, client) => owner(client, () => deps.service.cancel(args)),
      'mail.follow_up.reschedule': (args, client) => owner(client, () => deps.service.reschedule(args, () => { deps.authorize(client); })),
      'mail.follow_up.list': (args, client) => owner(client, async () => {
        const pending = deps.send && (args === undefined || Object.keys(args).length === 0) ? await deps.send.pending() : undefined;
        return { ...await deps.service.list(args), ...(pending ? { pending_sends: pending } : {}) };
      }),
      'mail.follow_up.send.capabilities': (_args, client) => owner(client, async () => {
        const available = deps.send !== undefined;
        const scheduledTask = typeof deps.send?.validateScheduledTask === 'function';
        return {
          available, scheduled: available, waiting_for: available,
          scheduled_replacement_task: scheduledTask, scheduled_follow_up_task: scheduledTask,
          scheduled_no_reply: typeof deps.send?.prepareScheduledCondition === 'function',
        };
      }),
      'mail.follow_up.send.get': (args, client) => owner(client, async () => deps.send ? deps.send.get(args?.id) : null),
      'mail.follow_up.send.cancel': (args, client) => owner(client, async () => {
        if (!deps.send) throw new Error('Pending reply watches are unavailable.');
        return deps.send.cancel(args, () => { deps.authorize(client); });
      }),
      'mail.follow_up.replacement.create': (args, client) => owner(client, token => deps.service.createReplacement(args, token, () => { deps.authorize(client); })),
      'mail.follow_up.delivery_report.get': (args, client) => owner(client, () => deps.service.getDeliveryReport(args)),
      'mail.follow_up.reply.get': (args, client) => owner(client, () => deps.service.getReply(args)),
      'mail.follow_up.reply_notification.set': (args, client) => owner(client, token => deps.service.setReplyNotification(args, () => { deps.authorize(client); }, token)),
    },
  };
};

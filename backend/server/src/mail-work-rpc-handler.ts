import { RpcError, type HandlerSlice, type ServerRpcRegistry } from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { MailWorkService } from './mail-work-service.js';

type Methods = 'mail.work.list' | 'mail.work.get' | 'mail.work.create' | 'mail.work.update' | 'mail.work.review' | 'mail.work.search' | 'mail.work.delete';
export const makeMailWorkRpcHandlers = (service: MailWorkService | undefined): HandlerSlice<ServerRpcRegistry, Methods, WsClient> | undefined => {
  if (!service) return undefined;
  const owner = (client: WsClient, args: unknown): void => {
    if (!client.instance_id || client.client_kind !== 'webclient') {
      throw new RpcError('unauthorized', 'Following work requires a paired webclient.', 401);
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new RpcError('bad_request', 'Arguments are required.', 400);
  };
  return {
    methods: ['mail.work.list', 'mail.work.get', 'mail.work.create', 'mail.work.update', 'mail.work.review', 'mail.work.search', 'mail.work.delete'],
    handlers: {
      'mail.work.list': async (args, client) => { owner(client, args === undefined ? {} : args); return service.list(args); },
      'mail.work.get': async (args, client) => { owner(client, args); return service.get(args.id); },
      'mail.work.create': async (args, client) => { owner(client, args); return service.create(args); },
      'mail.work.update': async (args, client) => { owner(client, args); return service.update(args); },
      'mail.work.review': async (args, client) => { owner(client, args); return service.review(args.id, args.expected_revision); },
      'mail.work.search': async (args, client) => { owner(client, args); return service.search(args.query); },
      'mail.work.delete': async (args, client) => { owner(client, args); return service.delete(args); },
    },
  };
};

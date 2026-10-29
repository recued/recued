import { formatToolProgress } from '@recued/contracts';
import { withToolProgress } from './execution/tool-progress.js';

export interface McpProgressNotification {
  jsonrpc: '2.0';
  method: 'notifications/progress';
  params: { progressToken: string | number; progress: number; message: string };
}
export type McpProgressSink = (notification: McpProgressNotification) => void;

/** Standard request-scoped notifications, never recipe callbacks or model
 * messages. A recipe can mix steps and provider units, so the wire counter
 * counts observed updates and has no invented overall total/percentage. The
 * caption carries the actual current operation's measurement. */
export const withMcpToolProgress = async <T>(
  params: unknown,
  send: McpProgressSink | undefined,
  run: () => Promise<T>,
): Promise<T> => {
  const meta = params !== null && typeof params === 'object'
    ? (params as { _meta?: unknown })._meta : undefined;
  const token = meta !== null && typeof meta === 'object'
    ? (meta as { progressToken?: unknown }).progressToken : undefined;
  const valid = typeof token === 'string' || typeof token === 'number' && Number.isSafeInteger(token);
  let observations = 0;
  return withToolProgress(send && valid ? (progress) => {
    send({ jsonrpc: '2.0', method: 'notifications/progress',
      params: { progressToken: token, progress: ++observations, message: formatToolProgress(progress) } });
  } : undefined, run);
};

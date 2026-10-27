import { RpcError } from '@recued/contracts';
import type { MailEnrollDeps } from './mail/enroll.js';
import type { CalendarEnrollDeps } from './calendar/enroll.js';
import type { CollectionInstanceRecord } from './instance-store.js';
import { probeCalendarAdapter } from './calendar/adapter-registry.js';
import { defaultImapClientFactory } from './mail/imap-provider.js';
import { verifySmtpCredentials } from './mail/smtp.js';
import { withCollectionAuthenticationLock } from '../collection-authentication-locks.js';

export interface PasswordRepairResult { ok: true; restart_needed: boolean }
type Passwords = { password?: string; smtp_password?: string };

/** Verify read/login access without saving secrets or sending a message. */
export const verifyImapPasswords = async (config: Record<string, unknown>, passwords: Passwords): Promise<void> => {
  const client = defaultImapClientFactory({
    // Match the live provider's defaults for legacy saved accounts.
    host: String(config.host ?? ''), port: typeof config.port === 'number' ? config.port : 993,
    secure: typeof config.secure === 'boolean' ? config.secure : true,
    auth: { user: String(config.username), pass: passwords.password ?? '' },
    logger: false, disableAutoIdle: true, connectionTimeout: 15_000,
    greetingTimeout: 15_000, socketTimeout: 15_000,
  });
  // ⛔ Once connected, a reset socket or the 15 s socket timeout reaches the
  // client as an `'error'` event, and one nobody listens for is thrown out of a
  // socket callback: the server's crash handler exits. This check fails anyway,
  // through the command the closed socket rejects.
  client.on('error', () => { /* reported by the rejected command */ });
  try {
    await client.connect();
    const folders = Array.isArray(config.folders) && config.folders.length ? config.folders : ['INBOX'];
    for (const folder of folders) await client.mailboxOpen(String(folder), { readOnly: true });
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
  const smtp = config.smtp as Record<string, unknown> | undefined;
  if (!smtp) return;
  // SMTP VERIFY authenticates without creating or sending an email.
  const { createTransport } = require('nodemailer') as {
    createTransport(config: unknown): { verify(): Promise<boolean>; close(): void };
  };
  const transport = createTransport({ host: smtp.host, port: smtp.port ?? 587, secure: smtp.secure ?? false,
    auth: { user: smtp.username ?? config.username, pass: passwords.smtp_password ?? passwords.password },
    logger: false, debug: false, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000 });
  try { await transport.verify(); } finally { transport.close(); }
};

const material = (row: CollectionInstanceRecord) => JSON.stringify([row.created_at, row.adapter_type, row.config, row.caps]);

/** Password-only repair keeps the server, username, selections and cursors fixed. */
export const repairCollectionPasswords = async (
  platform: 'mail' | 'calendar', deps: MailEnrollDeps | CalendarEnrollDeps,
  args: { slug: string; password?: string; smtp_password?: string },
): Promise<PasswordRepairResult> => {
  if (!args || typeof args.slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(args.slug)) throw new RpcError('bad_request', 'Choose an existing account.');
  const changedKeys = (['password', 'smtp_password'] as const).filter(key => args[key] !== undefined);
  if (!changedKeys.length || changedKeys.some(key => typeof args[key] !== 'string' || !args[key]!.length || args[key]!.length > 16_384)
    || platform === 'calendar' && (args.password === undefined || args.smtp_password !== undefined)) throw new RpcError('bad_request', 'Enter a replacement password.');
  return withCollectionAuthenticationLock(deps.instances.authenticationLocks, platform + ':' + args.slug, async () => {
    const row = deps.instances.get(platform, args.slug);
    const adapter = platform === 'mail' ? row?.adapter_type : 'caldav';
    if (!row || (platform === 'mail' ? adapter !== 'imap' && adapter !== 'smtp' : row.adapter_type !== adapter)) throw new RpcError('bad_request', 'This account does not use password authentication.');
    if (args.smtp_password !== undefined && !row.config.smtp) throw new RpcError('bad_request', 'This mailbox has no SMTP configuration.');
    const before = material(row); const prefix = adapter + '.' + args.slug + '.';
    const saved: Passwords = { password: await deps.accountStore.get(prefix + 'password') ?? undefined,
      ...(platform === 'mail' ? { smtp_password: await deps.accountStore.get(prefix + 'smtp_password') ?? undefined } : {}) };
    const replacement = { ...saved, ...Object.fromEntries(changedKeys.map(key => [key, args[key]])) };
    try {
      if (adapter === 'smtp') {
        await ((deps as MailEnrollDeps).verifySmtp ?? verifySmtpCredentials)({
          host: String(row.config.host), port: Number(row.config.port), secure: row.config.secure === true,
          requireTLS: row.config.secure !== true, username: String(row.config.username),
          from: String(row.config.from), password: replacement.password ?? '',
        });
      } else if (platform === 'mail') await ((deps as MailEnrollDeps).verifyPasswords ?? verifyImapPasswords)(row.config, replacement);
      else {
        const factory = (deps as CalendarEnrollDeps).adapters.get('caldav');
        if (!factory) throw new Error('CalDAV is unavailable.');
        await probeCalendarAdapter(factory, { slug: args.slug, config: { ...row.config, probe_rsvp: false },
          getAccountValue: async key => key === 'password' ? replacement.password ?? null : deps.accountStore.get(prefix + key) });
      }
    } catch {
      // Provider errors can contain passwords/headers. Only this value-free message crosses RPC.
      throw new RpcError('access_failed', 'The replacement credentials could not verify account access. Saved credentials were kept. Check the password and server availability.', 403);
    }
    const current = () => {
      const latest = deps.instances.get(platform, args.slug);
      if (!latest || material(latest) !== before) throw new RpcError('conflict', 'The account changed. Open it again before updating credentials.');
    };
    current();
    const lifecycle = deps.authenticationChange;
    let committed = false;
    try {
      await lifecycle?.stop(args.slug);
      current();
      for (const key of changedKeys) await deps.accountStore.set(prefix + key, args[key]!);
      current();
      deps.instances.updateAuthState(platform, args.slug, { auth_state: 'healthy' });
      committed = true;
    } catch (error) {
      const restored = await Promise.allSettled(changedKeys.map(key => saved[key] === undefined
        ? deps.accountStore.delete(prefix + key) : deps.accountStore.set(prefix + key, saved[key]!)));
      if (restored.some(result => result.status === 'rejected')) {
        deps.instances.updateAuthState(platform, args.slug, { auth_state: 'degraded' });
        throw new RpcError('repair_incomplete', 'Credential storage could not be reconciled. No successful update is confirmed. Reopen this account and verify access before retrying.', 500);
      }
      if (error instanceof RpcError) throw error;
      throw new RpcError('update_failed', 'The replacement could not be saved. Previous credentials were restored. Reopen the account and try again.', 500);
    } finally {
      if (!committed) await lifecycle?.restart(args.slug).catch(() => {});
    }
    let restartNeeded = lifecycle === undefined;
    try { await lifecycle?.restart(args.slug); } catch { restartNeeded = true; }
    return { ok: true, restart_needed: restartNeeded };
  });
};

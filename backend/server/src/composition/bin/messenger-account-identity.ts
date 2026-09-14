/** Bot identities are verified with the vendor, never inferred from a token's
 * spelling. The cache is keyed by a credential digest and bounded; rotation
 * verifies the replacement before it can reuse a conversation binding.
 * https://docs.slack.dev/reference/methods/auth.test/
 * https://core.telegram.org/bots/api#getme
 * https://docs.discord.com/developers/resources/user#get-current-user */
import { createHash } from 'node:crypto';
import { getJson, postJson } from '@recued/transport';
export const createMessengerAccountResolver = (fetchImpl: typeof fetch = fetch, timeoutMs = 10000) => {
  const cache = new Map<string, Promise<{ account: string; sender_id?: string }>>();
  const identityKey = (vendor: string, token: string): string => `${vendor}:${createHash('sha256').update(token).digest('hex')}`;
  const identity = (vendor: string, token: string): Promise<{ account: string; sender_id?: string }> => {
    const key = identityKey(vendor, token);
    const known = cache.get(key); if (known) return known;
    const pending = (async () => {
      let url: string; let headers: Record<string, string>;
      if (vendor === 'telegram') { url = `https://api.telegram.org/bot${token}/getMe`; headers = {}; }
      else if (vendor === 'slack') { url = 'https://slack.com/api/auth.test'; headers = { Authorization: `Bearer ${token}` }; }
      else if (vendor === 'discord') { url = 'https://discord.com/api/v10/users/@me'; headers = { Authorization: `Bot ${token}` }; }
      else throw new Error('Messenger mirroring is not supported for this vendor.');
      try {
        const options = { headers, timeoutMs, fetchImpl, maxResponseBytes: 64 * 1024 };
        const response = await (vendor === 'discord' ? getJson(url, options) : postJson(url, { ...options, body: '' }));
        if (!response.ok) throw new Error('identity unavailable');
        const body: unknown = response.json;
        if (!body || typeof body !== 'object') throw new Error('invalid identity');
        const record = body as Record<string, unknown>;
        if (vendor === 'slack' && record.ok === true && typeof record.team_id === 'string'
          && typeof record.bot_id === 'string' && record.team_id && record.bot_id) return {
            account: `slack:${record.team_id}:${record.bot_id}`,
            ...(typeof record.user_id === 'string' && record.user_id ? { sender_id: record.user_id } : {}),
          };
        if (vendor === 'discord' && record.bot === true && typeof record.id === 'string' && record.id) return { account: `discord:${record.id}`, sender_id: record.id };
        const bot = record.result as { id?: unknown; is_bot?: unknown } | undefined;
        if (vendor === 'telegram' && record.ok === true && bot?.is_bot === true
          && ((typeof bot.id === 'number' && Number.isSafeInteger(bot.id) && bot.id > 0)
            || (typeof bot.id === 'string' && /^[1-9]\d*$/.test(bot.id)))) return { account: `telegram:${bot.id}`, sender_id: String(bot.id) };
        throw new Error('invalid identity');
      } catch { throw new Error('Could not verify the connected Messenger bot account.'); }
    })();
    cache.set(key, pending);
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    void pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    return pending;
  };
  return Object.assign(async (vendor: string, token: string): Promise<string> => (await identity(vendor, token)).account, {
    // Slack file-share messages need not carry bot_id. auth.test's user_id
    // identifies the bot author without mistaking an owner's forwarded file
    // for an echo, even before the outbound HTTP receipt reaches the worker.
    senderId: async (vendor: string, token: string): Promise<string | undefined> => {
      const result = await identity(vendor, token);
      // An incomplete auth envelope must not poison subsequent intake retries.
      if (!result.sender_id) cache.delete(identityKey(vendor, token));
      return result.sender_id;
    },
  });
};

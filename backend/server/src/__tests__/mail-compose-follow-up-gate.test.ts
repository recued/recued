import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createMailComposeFollowUpFixture } from './fixtures/mail-compose-follow-up-fixture.js';

const fixtures: ReturnType<typeof createMailComposeFollowUpFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const fixture = () => { const f = createMailComposeFollowUpFixture(); fixtures.push(f); return f; };
const request = () => ({ recipe_id: 'send-composed-mail', trigger_source: 'manual',
  config: { sender_mail_instance: 'work', to: ['alex@example.test'], cc: ['copy@example.test'], subject: 'Native watched send', body: 'Please reply.', body_format: 'text' },
  mail_follow_up: { request_id: randomUUID(), after_ms: 3600000 } });

describe('composer reply watch across the actual send approval gate', () => {
  it('keeps a saved watch preference out of the send recipe argument boundary', async () => {
    const f = fixture(), args = request();
    const response = await f.execute({ ...args, config: { ...args.config, follow_up: { after_ms: 3600000 } } });
    expect(response.awaiting_approval).toBe(true); await f.answer('approve'); expect(f.delivered).toHaveLength(1);
    f.syncSent(); expect((await f.send().get(response.mail_follow_up!.id))!.state).toBe('armed');
  });
  it('captures an already authorized one-off send without inventing an approval or starting before Sent sync', async () => {
    const f = createMailComposeFollowUpFixture(undefined, false); fixtures.push(f);
    const response = await f.execute(request()); expect(response.success).toBe(true); expect(f.delivered).toHaveLength(1);
    expect(response.mail_follow_up!.state).toBe('awaiting_sync'); expect((await f.service.list()).watches).toEqual([]);
    f.syncSent(); expect((await f.send().get(response.mail_follow_up!.id))!.state).toBe('armed');
  });
  it('does not dispatch or arm before approval, joins the resumed native send, and arms only after Sent sync', async () => {
    const f = fixture(), args = request(), response = await f.execute(args);
    expect(response.awaiting_approval, JSON.stringify(response)).toBe(true); expect(response.mail_follow_up?.state).toBe('awaiting_approval');
    expect(f.delivered).toEqual([]); expect((await f.service.list()).watches).toEqual([]);
    await f.answer('approve'); expect(f.delivered).toHaveLength(1);
    const id = response.mail_follow_up!.id; expect((await f.send().get(id))!.state).toBe('awaiting_sync');
    expect(f.delivered[0]!.input.run_id).toBe(response.run_id);
    f.syncSent(); f.restartSend(); expect((await f.send().get(id))!.state).toBe('armed');
    expect((await f.service.list()).watches).toMatchObject([{ id, subject: args.config.subject }]);
    await f.execute(args); expect(f.delivered).toHaveLength(1);
  });
  it('leaves no active watch or delivery after the owner denies the actual send approval', async () => {
    const f = fixture(), response = await f.execute(request()); expect(response.awaiting_approval, JSON.stringify(response)).toBe(true);
    await f.answer('deny'); expect(f.delivered).toEqual([]); expect((await f.service.list()).watches).toEqual([]);
    expect((await f.send().get(response.mail_follow_up!.id))!.state).toBe('not_sent');
  });
});

import type { ChatTurnQueueSnapshot } from '@recued/contracts';

/** D-265's queue read, answered for the fake-transport full-app harness.
 *
 *  ⛔⛔ WITHOUT THIS, SENDING IS INERT AND THE BUTTON LOOKS READY. `sendMessage`
 *  awaits `queueView.generation(session)`, which on a cold snapshot awaits
 *  `chat.turns.list`. An unanswered method in this harness never settles, so
 *  the await never returns: the Send button renders enabled, reads "Send",
 *  and a click produces ZERO `chat.send` calls. Six full-app tests went red
 *  the day the queue landed and stayed red — the vitest suite is green at
 *  80k+ tests and cannot see this, because it never drives the composition.
 *
 *  ⚠ THE SNAPSHOT IS DELIBERATELY EMPTY-BUT-PRESENT. `turns: []` with a real
 *  `generation` is the ordinary state of a conversation with nothing in
 *  flight, and it is what exercises the interesting path: the send then
 *  carries `queue_generation`, which the server compares against its own and
 *  rejects on mismatch. Returning nothing at all would skip that field and
 *  quietly test the pre-D-265 shape instead.
 *
 *  🔑 The GENERATION IS STABLE for the life of the page. It changes only when
 *  a conversation is reset server-side; a fixture that minted a fresh one per
 *  call would make every second send fail the staleness check for reasons no
 *  test intends. */
export const CHAT_QUEUE_FIXTURE_GENERATION = 'gen_fixture_1';

export const chatTurnQueueDemoReply = (
  method: string,
  raw: unknown,
): { result?: unknown } | null => {
  if (method !== 'chat.turns.list') return null;
  const args = raw as { session_id?: string };
  const snapshot: ChatTurnQueueSnapshot = {
    generation: CHAT_QUEUE_FIXTURE_GENERATION,
    revision: 0,
    turns: [],
  };
  // The session id is echoed through the caller's own map key, so an unknown
  // session still gets a well-formed empty queue rather than a hang.
  void args.session_id;
  return { result: snapshot };
};

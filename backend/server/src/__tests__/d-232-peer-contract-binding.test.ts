/** D-232 § 26 — the contract → MCP binding, refused where a human can fix it.
 *
 *  ⛔⛔ WHY THIS IS AN ENROLL-TIME GUARD AND NOT A DISPATCH-TIME ONE.
 *  `peerConnectionForContract` fails closed by returning UNDEFINED, and an
 *  exchange with no connection routes LOCAL — so a bad binding does not raise,
 *  it makes the server answer ITSELF, file the run under the peer's ref, and
 *  report `succeeded`. Both failures below were seen for real while building
 *  D-232, and neither was visible at answer time.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createConnectionStore } from '../storage/connection-store.js';
import { handleConnectionEnroll } from '../connection-handler.js';

const enroll = async (store: ReturnType<typeof createConnectionStore>, name: string, peer: unknown) =>
  handleConnectionEnroll({ store } as never, {
    kind: 'mcp',
    subtype: 'sse',
    name,
    display_name: name,
    config: { endpoint: 'http://127.0.0.1:9/mcp', transport: 'sse', peer_contract_id: peer },
    auth: { type: 'bearer', token: 't' },
  } as never);

describe('D-232 § 26 — peer_contract_id binding', () => {
  const store = () => createConnectionStore(new Database(':memory:'));

  it('⛔ refuses an EMPTY binding — it routes the peer\'s answers back here', async () => {
    await expect(enroll(store(), 'peer-a', '   ')).rejects.toThrow(/non-empty string/);
  });

  it('⛔⛔ refuses a DUPLICATE binding, naming the connection it clashes with', async () => {
    /** The resolver refuses on ambiguity rather than guessing which of two
     *  connections to answer down — correct, and silent. Two connections
     *  claiming one contract therefore disables that peer's callback path
     *  entirely, with the symptom appearing only as a self-answered exchange. */
    const s = store();
    await enroll(s, 'peer-a', 'tok_alice');
    await expect(enroll(s, 'peer-b', 'tok_alice')).rejects.toThrow(/already bound to connection 'peer-a'/);
  });

  it('admits a distinct binding, and re-enrolling the SAME connection is not a clash', async () => {
    // ⚠ The self-exclusion matters: an owner re-enrolling to rotate a bearer
    // must not be told their own connection is squatting on their contract.
    const s = store();
    await enroll(s, 'peer-a', 'tok_alice');
    await expect(enroll(s, 'peer-b', 'tok_bob')).resolves.toBeDefined();
    await expect(enroll(s, 'peer-a', 'tok_alice')).resolves.toBeDefined();
  });

  it('is silent when no binding is declared — an ordinary mcp connection is unaffected', async () => {
    await expect(enroll(store(), 'plain', undefined)).resolves.toBeDefined();
  });
});

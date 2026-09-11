import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { PREAPPROVAL_LIMITS, RpcError, type PreapprovalResult, type PreapprovalReview } from '@recued/contracts';
import { startServer } from '../server.js';
import { createClientTokenStore, type ClientKind } from '../pairing/client-tokens.js';
import { preparedPlan, repositoryFixture } from './d-261-fixtures.js';

interface Reply { request_id: string; result?: unknown; error?: { code: string; message: string } }
const rpc = (ws: WebSocket, method: string, args: unknown = {}): Promise<Reply> => new Promise((resolve, reject) => {
  const request_id = crypto.randomUUID();
  const timeout = setTimeout(() => { ws.off('message', receive); reject(new Error(`RPC timeout: ${method}`)); }, 5000);
  const receive = (data: WebSocket.RawData): void => {
    const reply: Reply = JSON.parse(data.toString());
    if (reply.request_id !== request_id) return;
    clearTimeout(timeout); ws.off('message', receive); resolve(reply);
  };
  ws.on('message', receive); ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
});

it('binds real WebSocket decisions to the live paired webclient and current review', async () => {
  const db = new Database(':memory:');
  const tokens = createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 } });
  const fixture = repositoryFixture(db, { now: 1000, locked: false }, {
    validateResponder(responder) {
      const token = tokens.get(responder.key);
      if (responder.channel !== 'webclient' || token?.client_kind !== 'webclient'
        || token.revoked_at !== null || typeof token.metadata?.instance_id !== 'string') {
        throw new RpcError('preapproval_invalid_proof', 'Owner response required.', 403);
      }
    },
  });
  const server = await startServer(0, { clientTokens: tokens, preapprovalDeps: {
    ownerId: 'owner-test-realm',
    repository: fixture.repository, clientTokens: tokens,
    prepare: (request, origin) => fixture.repository.prepare({ ...preparedPlan(), request, origin }, false),
    capabilities: () => ({ protocol_version: 1, activation_kinds: ['one_shot'], bindings: [],
      child_calls: [], decision_channels: ['webclient'], limits: PREAPPROVAL_LIMITS }),
  } });
  const sockets: WebSocket[] = [];
  const connect = async (kind: ClientKind, instance?: string) => {
    const token = await tokens.issue({ client_kind: kind,
      ...(instance === undefined ? {} : { metadata: { instance_id: instance } }) });
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(`${token.token_id}.${token.bearer}`)}`);
      sockets.push(socket); socket.once('open', () => resolve(socket)); socket.once('error', reject);
    });
    return { ws, token_id: token.token_id, bearer: token.bearer };
  };
  try {
    const owner = await connect('webclient', 'browser-one');
    const otherBrowser = await connect('webclient', 'browser-two');
    const cli = await connect('cli', 'model-cli');
    const unpaired = await connect('webclient');
    for (const caller of [cli, unpaired]) {
      expect(await rpc(caller.ws, 'preapproval.capabilities')).toMatchObject({ error: { code: 'preapproval_invalid_proof' } });
    }
    const request = preparedPlan().request;
    expect(await rpc(owner.ws, 'preapproval.prepare', { ...request, approved: true })).toMatchObject({ error: { code: 'bad_request' } });
    const response = await rpc(owner.ws, 'preapproval.prepare', request);
    expect(response.error).toBeUndefined();
    const proposal = response.result as PreapprovalResult;
    const stored = await fixture.repository.loadExecution(proposal.future_execution_ref);
    expect(stored.origin).toMatchObject({ owner_id: 'owner-test-realm',
      source: { user_id: 'owner-test-realm', client_token_id: owner.token_id } });
    expect(JSON.stringify(stored)).not.toContain(owner.bearer);
    const reviewResponse = await rpc(owner.ws, 'preapproval.review', { proposal_id: proposal.proposal_id });
    expect(reviewResponse.error).toBeUndefined();
    const review = reviewResponse.result as PreapprovalReview;
    const decision = { proposal_id: proposal.proposal_id, expected_revision: review.revision,
      review_digest: review.review_digest, challenge: review.challenge, decision: 'approve', request_id: 'owner-click-1' };
    expect(await rpc(cli.ws, 'preapproval.decide', decision)).toMatchObject({ error: { code: 'preapproval_invalid_proof' } });
    expect(await rpc(otherBrowser.ws, 'preapproval.decide', decision)).toMatchObject({ error: { code: 'preapproval_invalid_proof' } });
    const accepted = await rpc(owner.ws, 'preapproval.decide', decision);
    expect(accepted).toMatchObject({ result: { decision: 'approve', execution_status: 'active' } });
    expect(await rpc(owner.ws, 'preapproval.decide', decision)).toMatchObject({ result: accepted.result });
    expect(db.prepare('SELECT COUNT(*) AS count FROM preapproval_grants').get()).toEqual({ count: 1 });
    tokens.revoke(owner.token_id, 'owner revoked device');
    const rejected = await rpc(owner.ws, 'preapproval.decide', decision);
    expect(rejected.error).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS count FROM preapproval_grants').get()).toEqual({ count: 1 });
  } finally {
    for (const socket of sockets) socket.terminate();
    await server.close(); db.close();
  }
}, 15000);

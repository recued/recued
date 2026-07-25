/** D-160 P3 acceptance -- messenger -> trigger -> messenger depth bound. */

import { describe, expect, it } from 'vitest';
import {
  MAX_DISPATCH_DEPTH,
  nextDispatchDepth,
  type Commit,
  type ExecutionSource,
} from '@recued/contracts';
import {
  DispatchDepthExceededError,
  wrapWithCommitGateway,
  type GatewayInner,
} from '@recued/gateway';
import {
  createCommitStore,
  createInMemoryCollection,
  type Collection,
  type CommitStore,
} from '@recued/storage';

import { buildCommitRunIdentity } from '../commit-gateway-wiring.js';

type SurfaceTag = 'chat' | 'messenger-slack' | 'messenger-telegram';

interface ChannelInbound {
  session_id: string;
  surface: SurfaceTag;
  text: string;
  from: string;
  source: ExecutionSource;
  dispatch_depth: number;
  ts: number;
}

interface SessionEntry {
  session_id: string;
  surface: SurfaceTag;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

interface SessionStateStore {
  append(entry: SessionEntry): void;
  history(session_id: string): readonly SessionEntry[];
}

interface Transport {
  readonly vendor: 'slack' | 'telegram';
  send(message: {
    recipient: string;
    text: string;
    token: string;
  }): Promise<{ ok: true; vendor_message_id?: string } | {
    ok: false;
    error: { kind: string; detail: string };
  }>;
  parseInbound(payload: unknown): {
    from: string;
    text: string;
    vendor_message_id?: string;
  } | null;
}

interface MessengerChannel {
  readonly surface: SurfaceTag;
  deliver(event: unknown): Promise<void>;
  onInbound(handler: (message: ChannelInbound) => void | Promise<void>): void;
  ingest(payload: unknown, dispatch_depth?: number): Promise<void>;
}

type CreateMessengerChannel = (options: {
  transport: Transport;
  sessionStore: SessionStateStore;
  token: string;
  recipient: string;
  sessionId: string;
  now?: () => number;
}) => MessengerChannel;

const loadCreateMessengerChannel = async (): Promise<CreateMessengerChannel> => {
  const packageName = '@recued/messenger';
  const messenger = await import(packageName) as {
    createMessengerChannel: CreateMessengerChannel;
  };
  return messenger.createMessengerChannel;
};

const createSessionStore = (): SessionStateStore => {
  const bySession = new Map<string, SessionEntry[]>();
  return {
    append(entry) {
      const history = bySession.get(entry.session_id);
      if (history) history.push(entry);
      else bySession.set(entry.session_id, [entry]);
    },
    history(session_id) {
      return bySession.get(session_id) ?? [];
    },
  };
};

const payloadForDepth = (depth: number): { kind: 'trigger-hop'; depth: number } => ({
  kind: 'trigger-hop',
  depth,
});

const payloadDepth = (payload: unknown): number => {
  if (
    payload !== null
    && typeof payload === 'object'
    && 'depth' in payload
    && typeof (payload as { depth?: unknown }).depth === 'number'
  ) {
    return (payload as { depth: number }).depth;
  }
  throw new Error('test payload missing numeric depth');
};

describe('D-160 P3 dispatch_depth acceptance', () => {
  it('bounds a synthetic messenger -> trigger -> messenger cycle at depth 33', async () => {
    const createMessengerChannel = await loadCreateMessengerChannel();
    const backing: Collection<Commit> = createInMemoryCollection<Commit>();
    const store: CommitStore = createCommitStore(backing);
    const inbound: ChannelInbound[] = [];
    const executorCalls: number[] = [];
    let clock = 1_700_000_000_000;

    const channel = createMessengerChannel({
      transport: {
        vendor: 'slack',
        async send() {
          return { ok: true, vendor_message_id: 'vendor-1' };
        },
        parseInbound(payload) {
          const depth = payloadDepth(payload);
          return {
            from: `sender-${depth}`,
            text: `hop ${depth}`,
            vendor_message_id: `msg-${depth}`,
          };
        },
      },
      sessionStore: createSessionStore(),
      token: 'byo-token',
      recipient: 'recipient-1',
      sessionId: 'session-1',
      now: () => 1_716_141_000_000,
    });
    channel.onInbound((message) => {
      inbound.push(message);
    });

    const ingestHop = async (depth: number): Promise<ChannelInbound> => {
      const index = inbound.length;
      await channel.ingest(payloadForDepth(depth), depth);
      expect(inbound).toHaveLength(index + 1);
      return inbound[index];
    };

    const inner: GatewayInner = async (_slug, input) => {
      const depth = (input as { depth: number }).depth;
      executorCalls.push(depth);
      return { accepted_depth: depth };
    };

    let depth = 0;
    for (let hop = 0; hop <= MAX_DISPATCH_DEPTH; hop += 1) {
      expect(depth).toBe(hop);

      const message = await ingestHop(depth);
      expect(message.dispatch_depth).toBe(depth);

      const identity = buildCommitRunIdentity({
        request_id: `run-${depth}`,
        source: message.source,
        channel_session_id: `messenger:${message.session_id}`,
        correlation_id: `corr-${depth}`,
        dispatch_depth: message.dispatch_depth,
      });
      const executor = wrapWithCommitGateway(inner, {
        commitStore: store,
        identity,
        getIngredientCategory: () => 'action',
        genCommitId: () => `commit-${depth}`,
        genIdempotencyKey: () => `idem-${depth}`,
        now: () => {
          clock += 1;
          return clock;
        },
      });

      await expect(executor('messenger.send', { depth }))
        .resolves.toEqual({ accepted_depth: depth });
      expect(await store.get(`commit-${depth}`)).toMatchObject({
        commit_id: `commit-${depth}`,
        request_id: `run-${depth}`,
        dispatch_depth: depth,
        status: 'succeeded',
      });

      depth = nextDispatchDepth(depth);
    }

    expect(depth).toBe(MAX_DISPATCH_DEPTH + 1);

    const refusedMessage = await ingestHop(depth);
    const refusedIdentity = buildCommitRunIdentity({
      request_id: `run-${depth}`,
      source: refusedMessage.source,
      channel_session_id: `messenger:${refusedMessage.session_id}`,
      correlation_id: `corr-${depth}`,
      dispatch_depth: refusedMessage.dispatch_depth,
    });
    const refused = wrapWithCommitGateway(inner, {
      commitStore: store,
      identity: refusedIdentity,
      getIngredientCategory: () => 'action',
      genCommitId: () => `commit-${depth}`,
      genIdempotencyKey: () => `idem-${depth}`,
      now: () => {
        clock += 1;
        return clock;
      },
    });

    let thrown: unknown;
    try {
      await refused('messenger.send', { depth });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DispatchDepthExceededError);
    expect(thrown).toMatchObject({
      code: 'DISPATCH_DEPTH_EXCEEDED',
      dispatch_depth: MAX_DISPATCH_DEPTH + 1,
      max_dispatch_depth: MAX_DISPATCH_DEPTH,
    });
    expect(executorCalls).toEqual(
      Array.from({ length: MAX_DISPATCH_DEPTH + 1 }, (_v, index) => index),
    );
    expect(await store.get(`commit-${MAX_DISPATCH_DEPTH + 1}`)).toBeNull();
    expect(await store.size()).toBe(MAX_DISPATCH_DEPTH + 1);
  });
});

/** Live realm composition. Public owner requests and kernel requests share
 * one preparation service, repository, notification queue and owned driver. */
import type { NotificationBlock } from '@recued/notification';
import type { ExecuteHandlerDeps } from '../../execute-handler.js';
import type { PreapprovalHandlerDeps } from '../../preapproval-handler.js';
import { createPreapprovalActivations, type PreapprovalAutomationDeps } from '../../storage/preapproval-activations.js';
import { createPreapprovalService, type PreapprovalServiceDeps } from '../../preapproval-service.js';
import { createPreapprovalOriginAuthority } from '../../preapproval-origin-authority.js';
import { createPreapprovalRequestOrigin } from '../../preapproval-request-origin.js';
import { createPreapprovalExecutionRuntime } from '../../preapproval-execution.js';
import { createPreapprovalDriver } from '../../preapproval-driver.js';
import { createPreapprovalNotifications } from '../../preapproval-notifications.js';
import { createPreapprovalTelegramDelivery } from '../../preapproval-telegram-delivery.js';
import { createPreapprovalOutbox } from '../../preapproval-outbox.js';
import type { PreapprovalStorage } from '../../storage/preapproval-storage.js';
import type { ClientTokenStore } from '../../pairing/client-tokens.js';
import type { ContractDefinitionStore } from '../../storage/contract-definition-store.js';
import type { ChatInboundTokenStore } from '../../storage/chat-inbound-token-store.js';
import { createPreapprovalMail } from '../../preapproval-mail.js';
import { createMailDraftService } from '../../mail-draft-service.js';

export const composePreapproval = (deps: {
  ownerId: string; storage: PreapprovalStorage; sources: PreapprovalServiceDeps['sources'];
  circuits: PreapprovalAutomationDeps['circuits']; execution: ExecuteHandlerDeps;
  profiles: PreapprovalServiceDeps['profiles']; clientTokens: ClientTokenStore;
  definitions: ContractDefinitionStore; inboundTokens?: ChatInboundTokenStore;
  notifications: NotificationBlock; reviewLink(proposalId: string): string | null;
  keys?: Parameters<typeof createPreapprovalTelegramDelivery>[0]['keys'];
  mail?: Pick<Parameters<typeof createPreapprovalMail>[0], 'registry' | 'instances' | 'blobs'>;
  now?: () => number;
  onActivationChanged?: () => void | Promise<void>;
  /** D-315 §6.4 — the recovery clock's runs go on the trigger dispatcher's books. */
  settleRecoveredTrigger?: Parameters<typeof createPreapprovalDriver>[0]['settleRecovered'];
}) => {
  if (!deps.execution.opAdmissionGate || !deps.execution.approvalResumeAuthority
    || !deps.execution.commitStore || !deps.execution.checkpointStore || !deps.execution.gatedActionStore) {
    throw new Error('The reviewed execution requires live authority, Commit, receipt and checkpoint services.');
  }
  const authority = createPreapprovalOriginAuthority({ realm: deps.ownerId, clientTokens: deps.clientTokens,
    resumeAuthority: deps.execution.approvalResumeAuthority, opAdmissionGate: deps.execution.opAdmissionGate,
    connections: deps.profiles.connectionStore });
  const activations = createPreapprovalActivations({ ...deps.sources, circuits: deps.circuits, now: deps.now });
  const mail = deps.mail ? createPreapprovalMail({ ...deps.mail, db: deps.sources.db,
    manifest: slug => deps.execution.executorConfig.manifests.get(slug) }) : undefined;
  const drafts = createMailDraftService({ store: deps.storage.drafts, authority, gate: deps.execution.opAdmissionGate,
    origin: { ownerId: deps.ownerId, recipes: deps.sources.recipes, definitions: deps.definitions,
      clientTokens: deps.clientTokens, inboundTokens: deps.inboundTokens } });
  let composed = false;
  const service = createPreapprovalService({ storage: deps.storage, sources: deps.sources,
    activations, authority, execution: deps.execution, profiles: deps.profiles, now: deps.now, drafts,
    ...(mail ? { mail } : {}),
    executionCapabilities: () => composed ? {
      activation_kinds: ['one_shot', 'next_schedule', 'next_auto_run', 'next_trigger'],
      bindings: [{ family: 'http', identity_version: 1 }, { family: 'graphql', identity_version: 1 },
        ...(deps.execution.executorConfig.bridgeDispatcherRef?.()?.describeDocument
          ? [{ family: 'dom' as const, identity_version: 1 }] : []),
        ...(deps.execution.executorConfig.resolveLlmConfig || deps.execution.executorConfig.llmConfig
          ? [{ family: 'ai' as const, identity_version: 1 }] : []),
        ...(deps.execution.cliReachabilityResolver ? [{ family: 'cli' as const, identity_version: 1 }] : []),
        ...(deps.execution.executorConfig.connectionMcp ? [{ family: 'mcp' as const, identity_version: 1 }] : []),
        ...(mail ? [{ family: 'kernel' as const, identity_version: 1 }] : [])],
      child_calls: mail ? ['mail_attachments', 'ai_input', 'http_upload'] : [], decision_channels: deps.keys ? ['webclient', 'telegram'] : ['webclient'],
    } : { activation_kinds: [], bindings: [], child_calls: [], decision_channels: [] },
  });
  const runtime = createPreapprovalExecutionRuntime({ storage: deps.storage, service });
  const notifications = createPreapprovalNotifications({ repository: deps.storage.repository,
    block: deps.notifications, gatedActions: deps.execution.gatedActionStore, reviewLink: deps.reviewLink });
  const telegram = deps.keys ? createPreapprovalTelegramDelivery({ repository: deps.storage.repository,
    connectionStore: deps.profiles.connectionStore, block: deps.notifications, keys: deps.keys,
    reviewLink: deps.reviewLink }) : undefined;
  const outbox = createPreapprovalOutbox({ storage: deps.storage, activations, notifications, ...(telegram ? { telegram } : {}),
    ...(deps.onActivationChanged ? { onActivationChanged: deps.onActivationChanged } : {}),
    maintain: async () => { mail?.releaseExpired(deps.now?.() ?? Date.now()); await runtime.maintain(); } });
  const driver = createPreapprovalDriver({ storage: deps.storage, activations, runtime,
    execution: deps.execution, pumpOutbox: () => outbox.drain(),
    ...(deps.settleRecoveredTrigger ? { settleRecovered: deps.settleRecoveredTrigger } : {}) });
  deps.execution.preapprovalRuntime = runtime;
  deps.execution.mailDraft = async (method, raw, meta) => drafts.kernel(method, raw, meta);
  // D-264 — wired only when the mail stack is up, because the export needs a
  // live collection registry to reach the mailbox. Absent ⇒ the kernel case
  // raises SERVER_NOT_REACHABLE like any unwired dispatcher, which is the
  // honest answer for a server with no mail enrolled.
  if (deps.mail) {
    const registry = deps.mail.registry;
    deps.execution.mailDraftSaveToMailbox = async (input, meta) => {
      const { handleMailDraftSaveToMailbox } = await import('../../collections/mail/draft-save-to-mailbox.js');
      const origin = createPreapprovalRequestOrigin({ ownerId: deps.ownerId, recipes: deps.sources.recipes,
        definitions: deps.definitions, clientTokens: deps.clientTokens, inboundTokens: deps.inboundTokens }, meta);
      return handleMailDraftSaveToMailbox({ registry, drafts: deps.storage.drafts },
        input, drafts.saveToMailboxPrincipal(origin));
    };
  }
  deps.execution.preapprovalDriver = driver;
  deps.execution.preapprovalRequest = async (request, meta) => {
    const origin = createPreapprovalRequestOrigin({ ownerId: deps.ownerId, recipes: deps.sources.recipes,
      definitions: deps.definitions, clientTokens: deps.clientTokens, inboundTokens: deps.inboundTokens }, meta);
    const pending = await service.prepare(request, origin);
    await outbox.drain();
    return pending;
  };
  const handlers: PreapprovalHandlerDeps = { ownerId: deps.ownerId, repository: deps.storage.repository,
    clientTokens: deps.clientTokens, prepare: service.prepare, capabilities: service.capabilities, drafts };
  composed = true;
  return { service, runtime, driver, outbox, handlers, autoRunStatus: activations.describeAutoRun,
    triggerStatus: activations.describeTrigger, scheduleStatus: activations.describeSchedule };
};

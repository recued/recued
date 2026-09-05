/** D-196 S3/S4 — one-time customer claim presentation and mail delivery.
 *
 * Claim creation stays inside the customer lifecycle transaction. This module
 * owns only the public, short-lived claim URL and the post-commit delivery
 * outcome so manual RPC and provider/kernel issuance cannot drift apart. */

import {
  contractPermitsDoorType,
  type ContractDefinition,
  type SellerCustomer,
  type SellerCustomerClaim,
  type SellerCustomerClaimEmailDelivery,
} from '@recued/contracts';

import { resolvePublicBaseUrl } from '../ask-landing-answer-link.js';
import type { LLMConfigManager } from '../llm-config.js';
import { RECEPTION_SELLER_CLAIM_PATH } from '../ports/reception/handlers/seller-claim.js';
import type {
  SellerClaimPayload,
  SellerIssuedClaim,
} from '../storage/seller-claim-store.js';
import type { SellerStore } from '../storage/seller-store.js';

export class SellerCustomerClaimConfigurationError extends Error {
  constructor() {
    super(
      'one-time customer claims require the sealed claim store, a public HTTPS Reception URL, and an MCP or LLM gateway customer access type',
    );
    this.name = 'SellerCustomerClaimConfigurationError';
  }
}

export interface SellerCustomerClaimSupportDeps {
  /** Read lazily: lifecycle operations that do not mint a bearer must remain
   * available when a deployment has no public Reception origin. */
  readonly getPublicBaseUrl?: () => string;
  readonly llmManager?: Pick<LLMConfigManager, 'getConfig'>;
}

const requireSellerClaimBaseUrl = (
  deps: SellerCustomerClaimSupportDeps,
): string => {
  if (!deps.getPublicBaseUrl) {
    throw new SellerCustomerClaimConfigurationError();
  }
  let raw: string | null;
  try {
    raw = resolvePublicBaseUrl(deps.getPublicBaseUrl());
  } catch {
    throw new SellerCustomerClaimConfigurationError();
  }
  if (raw === null) {
    throw new SellerCustomerClaimConfigurationError();
  }
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'https:'
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.search.length > 0
      || parsed.hash.length > 0
    ) {
      throw new SellerCustomerClaimConfigurationError();
    }
  } catch (error) {
    if (error instanceof SellerCustomerClaimConfigurationError) throw error;
    throw new SellerCustomerClaimConfigurationError();
  }
  return raw;
};

const readLlmGatewayModelAlias = (
  llmManager: Pick<LLMConfigManager, 'getConfig'> | undefined,
): string | null => {
  if (!llmManager) return null;
  try {
    const config = llmManager.getConfig() as Record<string, unknown>;
    const rawAlias = config.llm_gateway_model_alias;
    return typeof rawAlias === 'string' && rawAlias.trim().length > 0
      ? rawAlias.trim()
      : null;
  } catch {
    return null;
  }
};

export const createSellerCustomerClaimSupport = (
  deps: SellerCustomerClaimSupportDeps,
): {
  readonly buildClaimPayload: (input: {
    readonly bearer_plaintext: string;
    readonly contract: ContractDefinition;
  }) => SellerClaimPayload;
  readonly toPublicClaim: (claim: SellerIssuedClaim) => SellerCustomerClaim;
} => {
  let claimBaseUrl: string | undefined;
  const getClaimBaseUrl = (): string => {
    claimBaseUrl ??= requireSellerClaimBaseUrl(deps);
    return claimBaseUrl;
  };

  return {
    buildClaimPayload: (input) => {
      const baseUrl = getClaimBaseUrl();
      const exposesMcp = contractPermitsDoorType(input.contract, 'mcp');
      const exposesLlmGateway = contractPermitsDoorType(
        input.contract,
        'llm_gateway',
      );
      return {
        bearer_plaintext: input.bearer_plaintext,
        mcp_url: exposesMcp ? `${baseUrl}/mcp` : null,
        llm_gateway_base_url: exposesLlmGateway ? `${baseUrl}/v1` : null,
        llm_gateway_model_alias: exposesLlmGateway
          ? readLlmGatewayModelAlias(deps.llmManager)
          : null,
      };
    },
    toPublicClaim: (claim) => ({
      claim_url: `${getClaimBaseUrl()}${RECEPTION_SELLER_CLAIM_PATH}?t=${encodeURIComponent(claim.claim_secret)}`,
      expires_at: claim.expires_at,
    }),
  };
};

export interface SellerCustomerClaimDeliveryDeps {
  readonly sellerStore: Pick<
    SellerStore,
    | 'getSettings'
    | 'reserveClaimEmailDelivery'
    | 'markClaimEmailDeliverySent'
  >;
  readonly now?: () => number;
  /** Resolve against the live collection registry, not enrollment metadata. */
  readonly isLiveSendCapableMailInstance?: (instanceId: string) => boolean;
  /** Canonical audited mail-send path. Claim delivery never calls a provider
   * directly. */
  readonly sendClaimMail?: (input: {
    readonly instance_id: string;
    readonly to: string;
    readonly subject: string;
    readonly body_text: string;
  }) => Promise<{
    readonly message_id: string;
    readonly sent_at: number;
  }>;
}

/** A delivery marker is written after the lifecycle transaction. Refresh the
 * response when possible, but never let a transient post-commit read make a
 * committed issue (and possibly accepted mail) look rolled back. */
export const readSellerCustomerAfterClaimDelivery = (
  sellerStore: Pick<SellerStore, 'getCustomer'>,
  fallback: SellerCustomer,
): SellerCustomer => {
  try {
    return sellerStore.getCustomer(fallback.customer_id) ?? fallback;
  } catch {
    return fallback;
  }
};

const claimEmailFailure = (
  error_code: string,
): SellerCustomerClaimEmailDelivery => ({
  status: 'failed',
  error_code,
});

const claimEmailErrorCode = (error: unknown): string => {
  try {
    const code = (error as { readonly code?: unknown } | null)?.code;
    return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/u.test(code)
      ? code
      : 'CLAIM_EMAIL_SEND_FAILED';
  } catch {
    return 'CLAIM_EMAIL_SEND_FAILED';
  }
};

/** Claim delivery accepts one bare mailbox only. The generic mail substrate
 * also supports display names and recipient lists, but a source-supplied
 * customer email must never inject another RFC-5322 header or recipient that
 * receives the one-time claim capability. */
const isSafeClaimEmailRecipient = (value: string): boolean =>
  value.length <= 320
  && /^[^\s@<>,;\u0000-\u001f\u007f]+@[^\s@<>,;\u0000-\u001f\u007f]+$/u.test(value);

export const deliverSellerCustomerClaimEmail = async (input: {
  readonly deps: SellerCustomerClaimDeliveryDeps;
  readonly customer_id: string;
  readonly email: string | null;
  readonly issued_claim: SellerIssuedClaim;
  readonly public_claim: SellerCustomerClaim;
}): Promise<SellerCustomerClaimEmailDelivery> => {
  if (input.email === null) {
    return claimEmailFailure('CLAIM_EMAIL_RECIPIENT_MISSING');
  }
  if (!isSafeClaimEmailRecipient(input.email)) {
    return claimEmailFailure('CLAIM_EMAIL_RECIPIENT_INVALID');
  }

  let instanceId: string | null;
  try {
    instanceId = input.deps.sellerStore.getSettings().sender_mail_instance_id;
  } catch {
    return claimEmailFailure('CLAIM_EMAIL_PREPARATION_FAILED');
  }
  let senderReady = false;
  if (instanceId !== null) {
    try {
      senderReady =
        input.deps.isLiveSendCapableMailInstance?.(instanceId) === true;
    } catch {
      senderReady = false;
    }
  }
  if (
    instanceId === null
    || !senderReady
    || !input.deps.sendClaimMail
  ) {
    return claimEmailFailure('CLAIM_EMAIL_SENDER_NOT_CONFIGURED');
  }

  const marker = `claim:${input.issued_claim.claim_id}`;
  let reserved = false;
  try {
    reserved = input.deps.sellerStore.reserveClaimEmailDelivery({
      customer_id: input.customer_id,
      marker,
      now: input.deps.now?.() ?? Date.now(),
    });
  } catch {
    return claimEmailFailure('CLAIM_EMAIL_RESERVATION_FAILED');
  }
  if (!reserved) {
    return claimEmailFailure('CLAIM_EMAIL_ALREADY_RESERVED');
  }

  try {
    const expiresAt = new Date(input.public_claim.expires_at).toISOString();
    const sent = await input.deps.sendClaimMail({
      instance_id: instanceId,
      to: input.email,
      subject: 'Your Recued access is ready',
      body_text: [
        'Your Recued access is ready.',
        '',
        'Open this one-time link to claim your access:',
        input.public_claim.claim_url,
        '',
        `This link expires at ${expiresAt} and can be used once.`,
        'The claim page will show your access token and connection settings once.',
      ].join('\n'),
    });
    if (
      typeof sent.message_id !== 'string'
      || sent.message_id.trim().length === 0
      || !Number.isInteger(sent.sent_at)
      || sent.sent_at < 0
    ) {
      return claimEmailFailure('CLAIM_EMAIL_SEND_INVALID_RESULT');
    }
    const completed = input.deps.sellerStore.markClaimEmailDeliverySent({
      customer_id: input.customer_id,
      marker,
      sent_at: sent.sent_at,
      now: input.deps.now?.() ?? Date.now(),
    });
    if (!completed) {
      return claimEmailFailure('CLAIM_EMAIL_SUPERSEDED');
    }
    return {
      status: 'sent',
      message_id: sent.message_id,
      sent_at: sent.sent_at,
    };
  } catch (error) {
    // The durable reservation intentionally remains after an uncertain
    // transport failure. Reissue creates a fresh claim/marker; replaying issue
    // can therefore never send this claim twice.
    return claimEmailFailure(claimEmailErrorCode(error));
  }
};

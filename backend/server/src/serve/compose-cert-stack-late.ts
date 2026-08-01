import type {
  CertStack,
  CertStackLateDeps,
} from '../composition/bin/wire-cert-stack.js';

export interface ComposeCertStackLateOptions {
  readonly certStack: CertStack;
  readonly tlsDomainStore: CertStackLateDeps['tlsDomainStore'];
  readonly lanAdvertisedAddress: CertStackLateDeps['lanAdvertisedAddress'];
  readonly actualPort: CertStackLateDeps['actualPort'];
}

export interface CertStackLateRefs {
  readonly tlsCertSource: ReturnType<CertStack['getTlsCertSourceRef']>;
  readonly tlsRenewerConfigured: ReturnType<CertStack['getTlsRenewerConfigured']>;
}

export const composeCertStackLate = async (
  options: ComposeCertStackLateOptions,
): Promise<CertStackLateRefs> => {
  const {
    certStack,
    tlsDomainStore,
    lanAdvertisedAddress,
    actualPort,
  } = options;

  await certStack.composeLate({ tlsDomainStore, lanAdvertisedAddress, actualPort });

  return {
    tlsCertSource: certStack.getTlsCertSourceRef(),
    tlsRenewerConfigured: certStack.getTlsRenewerConfigured(),
  };
};

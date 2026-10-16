import { customerWorkReturnHash, serializeLogsRunAddress } from '../shell/route.js';
/** The server's saved anchor is the only identity used for an approval link. */
export const setCustomerReviewLink = (doc: Document, link: HTMLElement, runId: string | undefined, fallback: string): void => {
    link.hidden = !runId;
    if (!runId) {
        link.removeAttribute('href');
        return;
    }
    const returnToReception = customerWorkReturnHash(doc.defaultView?.location?.hash ?? '') ?? customerWorkReturnHash(fallback);
    link.setAttribute('href', serializeLogsRunAddress({ runId, ...(returnToReception ? { returnToReception } : {}) }));
};

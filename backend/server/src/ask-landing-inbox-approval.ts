import type { NotificationBlock } from '@recued/notification';
import { createAskLandingEditApproval } from './ask-landing-edit-approval.js';
import { isAskEditWindowClosed, isAskLinkExpired } from './ask-landing-port.js';
import {
  findReceptionHoldItem,
  handleReceptionInboxApprove,
  type ReceptionInboxDeps,
} from './reception-inbox-handler.js';

/** The production join between the public form and the inbox approval
 *  funnel. The ask capability stays distinct from a paired app caller. */
export const createAskLandingInboxApproval = (deps: {
  inbox: ReceptionInboxDeps;
  submitAnswer: NotificationBlock['submitAnswer'];
  timeZone?: string;
}): ReturnType<typeof createAskLandingEditApproval> => createAskLandingEditApproval({
  findHoldItem: hold_id => findReceptionHoldItem(deps.inbox, hold_id),
  ...(deps.timeZone !== undefined ? { timeZone: deps.timeZone } : {}),
  approve: async ({ hold_id, edits, ask_id, via }) => {
    const out = await handleReceptionInboxApprove(
      {
        ...deps.inbox,
        // Carry this form's validated channel without changing the shared
        // app callback. The inbox still verifies the ask/hold binding before
        // releasing; the URL capability has the same role as on plain POSTs.
        submitPreparedAnswer: (id, option, prepare) =>
          deps.submitAnswer({ ask_id: id, option, via, landing_capability: true }, {
            prepare: async current => {
              const data = await prepare();
              const now = deps.inbox.now();
              if (isAskLinkExpired(current, now) || isAskEditWindowClosed(current, now)) {
                throw new Error('This decision link can no longer be used to edit the request.');
              }
              return data;
            },
          }),
      },
      { hold_id, edits },
      { ask_landing: { ask_id } },
    );
    return { released: out.released, ...(out.reason !== undefined ? { reason: out.reason } : {}) };
  },
});

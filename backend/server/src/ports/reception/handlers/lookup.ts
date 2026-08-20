/** D-240 slice 3 — `GET /reception/lookup/<secret>`, the submitter's viewback.
 *
 *  The read half of the credential slice 2 mints. A submitter who kept their
 *  receipt can come back and see where their request got to — the first surface
 *  in the reception substrate that answers a non-owner's question about a
 *  record they created.
 *
 *  ## What it is NOT
 *
 *  ⛔ NOT `status_link`. That kind projects an OWNER-CHOSEN entity to whoever
 *  holds one shared URL (`reception_status_projection` is `1:1 with status_link
 *  endpoints` + a `source_entity_id` pinned at create). This is per-RECORD and
 *  minted per submission, which is the whole reason it could not be built there.
 *
 *  ⛔ NOT A WRITE SURFACE. GET only, and it resolves through `peek`, which never
 *  flips `consumed_at`. A viewback the visitor can only look at once would be
 *  worse than none — they would burn it on the confirmation click.
 *
 *  ## ⛔⛔ IT DOES NOT RENDER WHAT THEY SUBMITTED
 *
 *  The submission's visitor fields are AEAD-sealed and stay that way. The
 *  receipt already echoed them once, at submit, to the person who had just typed
 *  them. Re-rendering them from a long-lived bearer URL would widen that
 *  exposure from "the browser that submitted" to "anyone the link reaches", for
 *  no gain the submitter asked for — they know what they sent; they came back to
 *  learn what HAPPENED. This handler therefore reads only the record's STATE.
 *
 *  Spec: D-240 § D5 / D13 / D14. */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ReceptionManageCredentialStore } from '../../../storage/reception-manage-credential-store.js';
import type { FormSubmissionSummary } from '../../../storage/reception-form-store.js';
import type { ReceptionLookupRunOutcome } from '../../../reception-lookup-recipe-runner.js';
import { htmlEscape, renderReceptionOutputBlocks } from './reception-page-render.js';
import { RECEPTION_LOOKUP_PATH } from './visitor-lookup-mint.js';

export interface ReceptionLookupHandlerDeps {
  readonly getCredentialStore: () => ReceptionManageCredentialStore;
  readonly findRecord: (record_id: string) => FormSubmissionSummary | null;
  readonly now: () => number;
  /** D-240 slice 3b — run the endpoint's bound viewback recipe, if any. Absent
   *  on a server with no lookup runner wired ⇒ the substrate status, which is
   *  exactly what slice 3 shipped. */
  /** D-240 — the durable target's completion, the ONLY thing that may promote a
   *  viewback to `completed`. Absent ⇒ the page tops out at `in_progress`, which
   *  is the honest answer for a substrate that cannot see the target. Shared with
   *  the expiry sweep: one reader, two consumers, so the page and the expiry can
   *  never disagree about whether a request ended. */
  readonly readCompletion?: (input: {
    readonly endpoint_id: string;
    readonly record_id: string;
  }) => { readonly done: boolean } | null;
  readonly runLookupRecipe?: (input: {
    readonly endpoint_id: string;
    readonly record_id: string;
    readonly record: Readonly<Record<string, unknown>>;
  }) => Promise<ReceptionLookupRunOutcome>;
}

/** What the visitor is told, as a closed list.
 *
 *  🔑 THREE STATES, NOT THE RECORD'S VOCABULARY. `processing_outcome` carries
 *  substrate words (`pending` / `duplicate` / `rejected_domain` / `spam`) that
 *  describe INGESTION and would be both meaningless and, in two cases,
 *  actively misleading to the person who submitted. The visitor's question is
 *  "is anything happening, and is it finished" — so the projection answers
 *  exactly that and nothing else.
 *
 *  ⚠ `spam` and `rejected_domain` deliberately map to `received`. Telling a
 *  visitor their submission was classified as spam hands a bot the honeypot
 *  oracle that D-149's unconditional receipt exists to deny, and D-207 slice 2c
 *  already ruled that silence is the property of SILENT rejection. */
export type VisitorLookupState = 'received' | 'in_progress' | 'completed';

/** ⛔⛔ `processing_outcome` DOES NOT DECIDE `completed`, AND THE FIRST VERSION OF
 *  THIS FUNCTION LET IT. § D7 says in as many words that `processing_outcome`
 *  describes INGESTION, not the request's lifecycle — and the intake processor
 *  proves it: it marks `processed` the moment a submission is handed to the
 *  review workflow, with a comment saying *"`resolved_target_*` stay null:
 *  nothing is materialized until the user approves."*
 *
 *  So a request SITTING IN THE OWNER'S APPROVAL QUEUE told the submitter "Your
 *  request has been completed." The one state a viewback exists to report, and
 *  it was reporting the opposite of the truth.
 *
 *  ⇒ `completed` now requires the durable target to say `done`, which the
 *  substrate cannot know on its own — hence the reader. WITHOUT one the honest
 *  ceiling is `in_progress`: something was materialized, and we cannot see
 *  whether it finished. Claiming `completed` from what this row knows is exactly
 *  the bug. */
export const projectLookupState = (
  record: FormSubmissionSummary,
  completion?: { readonly done: boolean } | null,
): VisitorLookupState => {
  const materialized =
    typeof record.resolved_target_id === 'string' && record.resolved_target_id.length > 0;
  if (!materialized) {
    // Nothing exists yet — whatever ingestion says about itself.
    return 'received';
  }
  return completion?.done === true ? 'completed' : 'in_progress';
};

const STATE_COPY: Readonly<Record<VisitorLookupState, string>> = {
  received: 'We have your request. Nothing has been decided yet.',
  in_progress: 'Your request is being worked on.',
  completed: 'Your request has been completed.',
};

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">`
  + `<meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<meta name="robots" content="noindex,nofollow">`
  + `<title>${htmlEscape(title)}</title></head><body>`
  + `<main class="rcp-page">${body}</main></body></html>`;

/** The visitor-facing AI notice for a viewback page.
 *
 *  ⚠ PAST TENSE, AND THE DIFFERENCE FROM THE INTAKE FORM'S NOTICE IS REAL. On a
 *  form the notice is a warning about what will happen to what you are about to
 *  send; here the run has already finished and the visitor is reading its
 *  output, so the honest claim is about what produced THIS PAGE.
 *
 *  ⛔ The body is a fixed literal taking no input — nothing per-visitor, nothing
 *  from the record, nothing to escape. Same discipline as the trust footer. */
const AI_NOTICE_HTML =
  '<p class="rcp-ai-notice">Parts of this page were produced using AI.</p>';

/** ⚠ ONE BODY FOR EVERY UNRESOLVABLE CREDENTIAL, and the three `peek` statuses
 *  are NOT surfaced separately to the visitor even though § D14 keeps them
 *  distinct internally. A page that said "expired" for one secret and "not
 *  found" for another is an oracle: it confirms which random strings were ever
 *  real. The owner's access log records which it was; the stranger gets one
 *  answer. */
const UNAVAILABLE = page(
  'Link unavailable',
  '<h1>This link is no longer available</h1>'
  + '<p>It may have expired, or the address may be incomplete. '
  + 'If you still need an update, reply to the confirmation you received.</p>',
);

export const createReceptionLookupHandler = (
  deps: ReceptionLookupHandlerDeps,
): ((req: IncomingMessage, res: ServerResponse, secret: string) => Promise<void>) =>
  async (req, res, secret) => {
    const write = (html: string, status: number): void => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        // D-149 § A.18.3 — the secret is in the URL, so it must not travel in a
        // Referer to anything the page links to.
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(html);
    };

    // ⛔ GET ONLY. A POST here has no meaning — there is nothing to submit — and
    // accepting one would be the first step toward a write surface on a
    // credential that was handed to an anonymous stranger.
    if (req.method !== 'GET') {
      write(UNAVAILABLE, 405);
      return;
    }

    // `peek`, never `consume`: this page is meant to be refreshed.
    const resolved = deps.getCredentialStore().peek(secret, deps.now(), 'lookup');
    if (resolved.status !== 'ok') {
      write(UNAVAILABLE, 404);
      return;
    }

    const record = deps.findRecord(resolved.scope.record_id);
    // A live credential whose record is gone — retention collected it, or the
    // owner deleted it. Same body: the visitor cannot act on the difference.
    if (record === null) {
      write(UNAVAILABLE, 404);
      return;
    }
    // ⛔ THE CREDENTIAL'S ENDPOINT, NOT THE RECORD'S CLAIM. Belt-and-braces
    // against a record id that somehow resolves under a different endpoint: the
    // scope is what was signed at mint, so it is the authority.
    if (record.endpoint_id !== resolved.scope.endpoint_id) {
      write(UNAVAILABLE, 404);
      return;
    }

    let completion: { readonly done: boolean } | null = null;
    try {
      completion = deps.readCompletion?.({
        endpoint_id: resolved.scope.endpoint_id,
        record_id: resolved.scope.record_id,
      }) ?? null;
    } catch (error) {
      // A reader failure degrades to `in_progress`, never to a wrong
      // `completed`: the visitor is told less, not something untrue.
      console.warn(
        `[visitor-lookup] completion read failed for record '${resolved.scope.record_id}': `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
    const state = projectLookupState(record, completion);
    const submitted = new Date(record.submitted_at).toISOString();
    const substrateBody =
      `<h1>Your request</h1>`
      + `<p class="rcp-lookup-state">${htmlEscape(STATE_COPY[state])}</p>`
      + `<p class="rcp-lookup-meta">Reference ID: <code>${htmlEscape(record.submission_id)}</code></p>`
      + `<p class="rcp-lookup-meta">Submitted ${htmlEscape(submitted)}</p>`;

    // D-240 slice 3b — a bound viewback recipe REPLACES the substrate status.
    //
    // ⚠ DEGRADES TO THE SUBSTRATE STATUS RATHER THAN ERRORING, and the
    // distinction from the SUBMIT path is deliberate. A submit promises
    // something the visitor is owed, so D-207 slice 1c refuses to show a
    // thank-you page it cannot honour. A viewback promises a status — and the
    // substrate can always produce a true one from the record. Narrower is not
    // a lie; a 404 for a live request would be.
    //
    // ⛔ BUT NOT SILENTLY. A door that stopped working must reach the owner, and
    // "the page still renders" is exactly how it would not. The failure is
    // logged with the endpoint and the reason; the visitor sees the honest
    // narrower answer.
    let blocks: ReadonlyArray<unknown> | null = null;
    // Tracked beside `blocks` on purpose: the notice belongs to the SAME outcome
    // that produced them, so a fallback to the substrate status cannot carry an
    // AI claim over text the substrate wrote.
    let blocksUsedAi = false;
    if (deps.runLookupRecipe !== undefined) {
      try {
        const outcome = await deps.runLookupRecipe({
          endpoint_id: resolved.scope.endpoint_id,
          record_id: resolved.scope.record_id,
          // The PROJECTED state, never the sealed submission — see the runner's
          // input contract.
          record: {
            reference_id: record.submission_id,
            state,
            submitted_at: record.submitted_at,
            ...(record.resolved_target_kind === null
              ? {}
              : { resolved_target_kind: record.resolved_target_kind }),
            ...(record.resolved_target_id === null
              ? {}
              : { resolved_target_id: record.resolved_target_id }),
          },
        });
        if (outcome.kind === 'completed') {
          blocks = outcome.render;
          blocksUsedAi = outcome.uses_ai;
        }
        else if (outcome.kind === 'failed') {
          console.warn(
            `[visitor-lookup] viewback recipe failed for endpoint `
            + `'${resolved.scope.endpoint_id}' — falling back to the substrate status: `
            + JSON.stringify(outcome.errors).slice(0, 400),
          );
        }
      } catch (error) {
        // Concurrency refusals land here too. The visitor gets the status; the
        // owner gets the reason.
        console.warn(
          `[visitor-lookup] viewback recipe threw for endpoint `
          + `'${resolved.scope.endpoint_id}': `
          + (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    // ⛔⛔ RE-CHECKED AFTER THE AWAIT. The credential was peeked before the recipe
    // ran; a run takes real time, and an owner who revokes during it (or an
    // expiry that lands during it) must not be answered with output produced for
    // a credential that is no longer live. Cheap — one hashed lookup — against a
    // window that is exactly as long as the recipe takes.
    //
    // ⚠ It does not stop the run, only the ANSWER. Cancelling mid-flight would
    // need the engine to model it, and the run is read-only by the §3c bind
    // refusal, so what is at stake is disclosure rather than a side effect.
    if (blocks !== null) {
      const stillLive = deps.getCredentialStore().peek(secret, deps.now(), 'lookup');
      if (stillLive.status !== 'ok') {
        write(UNAVAILABLE, 404);
        return;
      }
    }

    write(
      page(
        'Your request',
        blocks !== null && blocks.length > 0
          // ⛔ THE ONE PUBLIC RENDER PATH. `RECEPTION_RENDER_CONTEXT` is applied
          // inside `renderReceptionOutputBlocks`, so a caller physically cannot
          // render a run's blocks for a stranger using the owner's context.
          //
          // The notice leads the blocks rather than trailing them: "at the
          // latest at the time of first exposure" means before the content, not
          // under it.
          ? (blocksUsedAi ? AI_NOTICE_HTML : '')
            + renderReceptionOutputBlocks(blocks as never)
          : substrateBody,
      ),
      200,
    );
  };

/** Extract the secret from a `/reception/lookup/<secret>` path, or `null`.
 *
 *  ⚠ Exact-depth: `/reception/lookup/<secret>/anything` is NOT a lookup URL. A
 *  prefix match would let a crafted path carry the secret into a segment the
 *  router might later route on. */
export const parseLookupSecretFromPath = (pathname: string): string | null => {
  const prefix = `${RECEPTION_LOOKUP_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) return null;
  return rest;
};

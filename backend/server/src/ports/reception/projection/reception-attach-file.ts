/** D-173 P5 — the reception drop file-attach seam.
 *
 *  A drop materializes a TASK with the uploaded file attached (D-172
 *  attachments-v2). This seam is the `attachFile` projection dep — injected
 *  into `runReceptionProjection` as `deps.attachFile` so the projection stays
 *  agnostic of the annotation store + collection registry. It wraps the D-172
 *  `attachFile` helper (`data.link role:'attachment'`), binding the live deps
 *  and adapting the call shape to the projection's narrow seam type.
 *
 *  Idempotent by construction — `attachFile` reuses an existing edge, so a
 *  re-release lands no duplicate link.
 *
 *  Spec: docs/d-172-spec.md § A.3 / N.3 (attachFile) + docs/d-173-spec.md § A.1 / P5. */

import {
  attachFile as attachFileHelper,
  type AttachFileArgs,
  type AttachFileDeps,
  type AttachFileResult,
} from '../../../collections/file/attach-file.js';
import type { ReceptionAttachFileEffect } from './reception-projection.js';

export interface ReceptionAttachFileSeamDeps {
  /** The live `attachFile` deps (annotation store + collection registry). */
  readonly attachDeps: AttachFileDeps;
  /** DI for unit fakes; production passes the real `attachFile`. */
  readonly attach?: (args: AttachFileArgs, deps: AttachFileDeps) => Promise<AttachFileResult>;
}

/** Build the `attachFile` effect bound to the live annotation/registry deps. */
export const createReceptionAttachFileSeam = (
  deps: ReceptionAttachFileSeamDeps,
): ReceptionAttachFileEffect => {
  const attach = deps.attach ?? attachFileHelper;
  return async (input) => {
    await attach(
      {
        file_id: input.file_id,
        to_collection: input.to_collection,
        to_id: input.to_id,
      },
      deps.attachDeps,
    );
  };
};

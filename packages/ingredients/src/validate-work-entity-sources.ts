/** D-192 P1 — fail-closed shape validation for the manifest's
 *  `work_entity_sources` declarations (spec § Validation invariants).
 *
 *  Section validator folded into `validateIngredient` — same `add`
 *  reporter contract as the other section validators. Everything here
 *  is manifest-internal (no document, no IO), so it runs identically at
 *  local install and marketplace publish. The one document-dependent
 *  proof is transport-appropriate + lives in the generic publish loop:
 *  REST `(method, path)` via `crossCheckCatalogOpenApi` /
 *  `crossCheckCatalogGoogleDiscovery`; GraphQL op + selected-field
 *  existence via `crossCheckGraphqlSchema` (D-192 Gate E′). This module
 *  pins everything AROUND it: every named op must exist in
 *  `surfaces.api.executes` with a binding whose kind MATCHES the
 *  transport its `contract_source` proves — REST for openapi /
 *  google_discovery, GraphQL for graphql (`WORK_ENTITY_CONTRACT_SOURCE_
 *  TRANSPORT`) — so no op escapes its prover (a Source pins ONE schema
 *  doc; a graphql op has no `(method, path)` for a REST prover, a REST op
 *  is invisible to `crossCheckGraphqlSchema`). The realtime subscription
 *  kinds and a graphql `subscription` are excluded by construction (they
 *  prove no transport). And the `contract_source` pin must EQUAL the
 *  catalog's schema-source pin for its kind (openapi / google_discovery /
 *  graphql).
 *
 *  Field-path proof (response record paths / id / version / tombstone /
 *  projection source paths) is deliberately NOT here — authoring
 *  discipline + risk-based marketplace review (D-192 owner decision;
 *  the runtime fails closed on bad paths regardless). */

import {
  CATALOG_SCHEMA_SOURCE_SHA256_REGEX,
  PROJECT_STATES,
  TASK_PRIORITIES,
  WORK_ENTITY_CONTRACT_SOURCE_KINDS,
  isRealtimeApiBindingKind,
  WORK_ENTITY_CONTRACT_SOURCE_SURFACES,
  WORK_ENTITY_CONTRACT_SOURCE_TRANSPORT,
  WORK_ENTITY_DATE_CANONICAL_FIELDS,
  WORK_ENTITY_SOURCE_DECLARABLE_KIND_SET,
  WORK_ENTITY_SYNC_MODES,
  WORK_ENTITY_SYNC_DEPTHS,
  WORK_ENTITY_TOMBSTONE_KINDS,
  WORK_ENTITY_LIST_ROW_KINDS,
  WORK_ENTITY_LIST_SCOPES,
  WORK_ENTITY_VERSION_KINDS,
  WORK_ENTITY_CURSOR_KINDS,
  WORK_ENTITY_CONDITIONAL_WRITE_KINDS,
  WORK_ENTITY_CONFLICT_RESOLUTIONS,
  WORK_ENTITY_PAIRING_MODES,
  WORK_ENTITY_LOOKUP_KEYS,
  WORK_ENTITY_RELATIONSHIP_TARGET_SET,
  WORK_ENTITY_REMOTE_WHEN_REASON_SET,
  WORK_ENTITY_OP_SLOTS,
  WORK_ENTITY_TARGETED_OP_SLOTS,
  WORK_ENTITY_WRITE_OP_SLOTS,
  WORK_ENTITY_SOURCE_CANONICAL_FIELDS,
  WORK_ENTITY_SOURCE_REQUIRED_CANONICAL,
  WORK_ENTITY_SOURCE_DERIVABLE_CANONICAL,
  WORK_ENTITY_SOURCE_COALESCABLE_CANONICAL,
  WORK_ENTITY_SOURCE_TRANSFORMABLE_CANONICAL,
  WORK_ENTITY_CANONICAL_DERIVE_KINDS,
  WORK_ENTITY_CANONICAL_TRANSFORM_FNS,
  WORK_ENTITY_SOURCE_RELATIONSHIP_LOCAL_FIELDS,
  WORK_ENTITY_PREVIEW_HARD_MAX_CHARS,
  WORK_ENTITY_EXTENSION_SCALAR_MAX_CHARS,
  WORK_ENTITY_EXTENSION_MAX_ENTRIES,
  WORK_ENTITY_WRITE_DATE_FORMATS,
  WORK_ENTITY_WRITE_TRANSFORM_KINDS,
  WORK_ENTITY_DEPENDENCY_RESOLVE_MODES,
  type WorkEntityContractSourceKind,
  type WorkEntitySourceDeclarableKind,
  type WorkEntityOpSlot,
} from '@recued/contracts';
import type { ValidationSeverity } from './validate.js';

type AddFn = (severity: ValidationSeverity, code: string, path: string, message: string) => void;

const isObjectRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

/** D-192 — validate ONE `WorkEntityConfigArgBinding` (shared by
 *  `create_arg_bindings` and `op_arg_bindings`; single source of truth so the
 *  two paths can never diverge). Two sources:
 *   - `connection_config` — a non-empty, non-prototype `config_key` (a prototype
 *     key would resolve an inherited property, refused at runtime — rejected at
 *     publish so the dead binding never ships);
 *   - `static` — a non-empty string `value` (a CONSTANT baked into the
 *     declaration; Zoho `module='Tasks'`).
 *  Emits errors under the caller's `code` (create vs op-arg). */
const validateConfigArgBinding = (binding: unknown, path: string, code: string, add: AddFn): void => {
  if (!isObjectRecord(binding)) {
    add('error', code, path, "a config arg binding must be an object declaring a source ('connection_config' | 'static')");
    return;
  }
  if (binding.source === 'static') {
    if (!isNonEmptyString(binding.value)) {
      add('error', code, path, "a static arg binding must declare a non-empty string 'value'");
    }
    return;
  }
  if (binding.source !== 'connection_config') {
    add('error', code, path, "a config arg binding must declare source 'connection_config' or 'static'");
    return;
  }
  if (!isNonEmptyString(binding.config_key)) {
    add('error', code, path, 'a connection_config arg binding must declare a non-empty config_key');
  } else if (binding.config_key === '__proto__' || binding.config_key === 'constructor'
      || binding.config_key === 'prototype') {
    add('error', code, `${path}.config_key`,
      `config_key '${binding.config_key}' is a reserved prototype key, not a config value`);
  }
};

/** Validate `m.work_entity_sources` when present. No-op when the field
 *  is absent — the contract is opt-in per catalog. */
export const validateWorkEntitySources = (m: Record<string, unknown>, add: AddFn): void => {
  const raw = m.work_entity_sources;
  if (raw === undefined) return;

  if (!Array.isArray(raw)) {
    add('error', 'WORK_ENTITY_SOURCES_INVALID', 'work_entity_sources',
      'work_entity_sources must be an array of Source declarations');
    return;
  }
  if (raw.length === 0) {
    add('error', 'WORK_ENTITY_SOURCES_INVALID', 'work_entity_sources',
      'work_entity_sources must not be empty — declare a Source or omit the field');
    return;
  }

  // ── Catalog prerequisites: an api surface with executes and at least
  //    one pinned schema source (OpenAPI, Google Discovery, or GraphQL).
  //    No pin → no work-entity Source (fail closed — spec § Vendor
  //    eligibility). Which pin a declaration must reference + equal is
  //    resolved per-declaration by its contract_source.kind. ──
  const surfaces = isObjectRecord(m.surfaces) ? m.surfaces : undefined;
  const api = surfaces && isObjectRecord(surfaces.api) ? surfaces.api : undefined;
  const executes = api && isObjectRecord(api.executes) ? api.executes : undefined;
  // The op registry — used to prove a `source_dependencies[].list_op` is a READ
  // (the create-assist grant extension in `deriveAllowedOperations` auto-admits a
  // dependency's list_op, so a non-read one would over-grant; belt-and-suspenders
  // to that runtime gate).
  const operations = isObjectRecord(m.operations) ? m.operations : undefined;
  const surfacePins: Record<WorkEntityContractSourceKind, Record<string, unknown> | undefined> = {
    openapi: api && isObjectRecord(api.openapi_source) ? api.openapi_source : undefined,
    google_discovery:
      api && isObjectRecord(api.google_discovery_source) ? api.google_discovery_source : undefined,
    graphql:
      api && isObjectRecord(api.graphql_schema_source) ? api.graphql_schema_source : undefined,
  };
  // A Source needs OPS to call — that requirement is real and stays.
  //
  // 🔴 AMENDED 2026-07-14. This guard ALSO demanded a pinned surface
  // (`openapi_source` / `google_discovery_source` / `graphql_schema_source`) on the
  // CATALOG, for any declaration, and `return`ed — short-circuiting the whole
  // validator. That was the REAL official-doc-or-nothing ceiling, and making
  // `contract_source` optional on the DECLARATION did not touch it: a doc-less
  // vendor has no pin to put on the catalog either, so it still failed here.
  //
  // The proof was sitting in the suite the whole time. The three unpinned KERNEL
  // Sources (hubspot note · salesforce task · microsoft task) each carry a make-live
  // test titled *"the no-pin posture is deliberate — THE PUBLISH GATE REFUSES WHAT THE
  // KERNEL CARRIES"*, asserting this exact error. That is the ceiling, written down and
  // green: **a pack could not do what the kernel does.** The authority ladder's thesis
  // was that the amendment "invents nothing — it generalises the kernel's existing,
  // working posture to packs". Until now it generalised the wrong half.
  //
  // ⛔ A missing pin is NOT an error in itself. It is an error only for a declaration
  // that CLAIMS a `contract_source` whose surface the catalog does not pin — and that
  // is already checked per-declaration below (`pin === undefined` ⇒
  // WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID), which is the right place: it fires on
  // the declaration that lied, not on every Source in the catalog.
  if (!api || !executes) {
    add('error', 'WORK_ENTITY_SOURCES_SURFACE_REQUIRED', 'work_entity_sources',
      'work_entity_sources requires a catalog manifest with surfaces.api.executes');
    return;
  }

  const seenSourceIdTemplates = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const p = `work_entity_sources[${i}]`;
    const d = raw[i];
    if (!isObjectRecord(d)) {
      add('error', 'WORK_ENTITY_SOURCES_INVALID', p, 'declaration must be an object');
      continue;
    }

    // ── kind ──
    if (d.kind === 'commitment') {
      add('error', 'WORK_ENTITY_SOURCES_KIND_INVALID', `${p}.kind`,
        'commitment is reserved — commitments require the separate stricter commitment_evidence declaration kind, never work_entity_sources');
      continue;
    }
    if (!isNonEmptyString(d.kind) || !WORK_ENTITY_SOURCE_DECLARABLE_KIND_SET.has(d.kind)) {
      add('error', 'WORK_ENTITY_SOURCES_KIND_INVALID', `${p}.kind`,
        'kind must be one of task|note|project');
      continue;
    }
    const kind = d.kind as WorkEntitySourceDeclarableKind;

    // ── source identity ──
    if (!isNonEmptyString(d.source_id_template)) {
      add('error', 'WORK_ENTITY_SOURCES_SOURCE_ID_TEMPLATE_INVALID', `${p}.source_id_template`,
        'source_id_template is required');
    } else {
      // EXACTLY the CONNECTION_SOURCE_ID format —
      // `<vendor>.${connection_id}.<kind>` with a single dot-free
      // vendor segment. Anything looser breaks the boot reconcile's
      // id→connection-name round-trip (`sourceIdConnectionName` slices
      // between the first and last dot; extra literal segments would
      // mis-attribute the Source to another connection's name — D-192
      // P2 fold).
      const expectedTemplate = new RegExp(`^[a-z0-9][a-z0-9-]*\\.\\$\\{connection_id\\}\\.${kind}$`);
      if (!expectedTemplate.test(d.source_id_template)) {
        add('error', 'WORK_ENTITY_SOURCES_SOURCE_ID_TEMPLATE_INVALID', `${p}.source_id_template`,
          `source_id_template must be exactly '<vendor>.\${connection_id}.${kind}' (the CONNECTION_SOURCE_ID format — one dot-free vendor segment, the connection placeholder, the entity kind)`);
      }
      if (seenSourceIdTemplates.has(d.source_id_template)) {
        add('error', 'WORK_ENTITY_SOURCES_DUPLICATE', `${p}.source_id_template`,
          `duplicate source_id_template '${d.source_id_template}' — each declaration must register a distinct Source id`);
      }
      seenSourceIdTemplates.add(d.source_id_template);
    }
    if (d.source_label_template !== undefined && !isNonEmptyString(d.source_label_template)) {
      add('error', 'WORK_ENTITY_SOURCES_INVALID', `${p}.source_label_template`,
        'source_label_template must be a non-empty string when present');
    }
    if (d.source_kind !== 'connection') {
      add('error', 'WORK_ENTITY_SOURCES_INVALID', `${p}.source_kind`,
        "source_kind must be 'connection' — v1 pack declarations are connection-derived Sources only");
    }

    // ── contract_source: must EQUAL the catalog's pinned schema source
    //    for its kind (openapi ↔ openapi_source, google_discovery ↔
    //    google_discovery_source — WORK_ENTITY_CONTRACT_SOURCE_SURFACES). ──
    const cs = d.contract_source;
    if (cs === undefined) {
      // AMENDED — D-192 authority ladder, ratified 2026-07-14. An ABSENT
      // contract_source is LEGAL, not an error: the Source carries no
      // *documentary* op proof and instead proves its ops EMPIRICALLY (a live
      // smoke against a real connection — ladder §6), which is the stronger
      // proof of the two. There is nothing to pin-equality-check, so every
      // check below is skipped rather than failed.
      //
      // ⛔ Deliberately NOT validated here, and it must stay that way: whether
      // the empirical proof was actually run, and what attests the field paths,
      // live in the AUTHORING DOCUMENT (`docs/sources/<slug>-<kind>.md`) — a
      // human artifact under human review. Encoding that as a validator rule
      // would put publish-only logic into `packages/`, which every self-hosted
      // server ships and none of them can ever run (ladder §0.1), and it would
      // manufacture a false sense of security: this validator cannot check a
      // field path (see the header note), so a green gate here would attest
      // nothing about where the silent harm actually lives. The substrate
      // enforces what the machine can; judgment stays with the human who
      // authors and the owner who grants.
    } else if (!isObjectRecord(cs)) {
      add('error', 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID', `${p}.contract_source`,
        'contract_source, when present, must be an object binding the Source to the pinned schema source (omit it entirely for an empirically-proven Source)');
    } else if (!isNonEmptyString(cs.kind)
        || !(WORK_ENTITY_CONTRACT_SOURCE_KINDS as readonly string[]).includes(cs.kind)) {
      add('error', 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID', `${p}.contract_source.kind`,
        `contract_source.kind must be one of ${WORK_ENTITY_CONTRACT_SOURCE_KINDS.join('|')}`);
    } else {
      const csKind = cs.kind as WorkEntityContractSourceKind;
      const expectedSurface = WORK_ENTITY_CONTRACT_SOURCE_SURFACES[csKind];
      const pin = surfacePins[csKind];
      if (cs.surface !== expectedSurface) {
        add('error', 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID', `${p}.contract_source.surface`,
          `contract_source.surface must be '${expectedSurface}' for kind '${csKind}'`);
      }
      if (pin === undefined) {
        add('error', 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID', `${p}.contract_source`,
          `contract_source.kind '${csKind}' requires the catalog to pin ${expectedSurface}`);
      } else {
        if (!isNonEmptyString(cs.url)) {
          add('error', 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID', `${p}.contract_source.url`,
            'contract_source.url is required');
        } else if (cs.url !== pin.url) {
          add('error', 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID', `${p}.contract_source.url`,
            `contract_source.url must equal ${expectedSurface}.url — one document, one pin`);
        }
        if (typeof cs.sha256 !== 'string' || !CATALOG_SCHEMA_SOURCE_SHA256_REGEX.test(cs.sha256)) {
          add('error', 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID', `${p}.contract_source.sha256`,
            'contract_source.sha256 must be a 64-char lowercase hex digest');
        } else if (cs.sha256 !== pin.sha256) {
          add('error', 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID', `${p}.contract_source.sha256`,
            `contract_source.sha256 must equal ${expectedSurface}.sha256 — one document, one pin`);
        }
      }
    }

    // ── ops: slot → executes key, provable against the pinned doc, read
    //    side mandatory. Each op's binding kind must EQUAL the transport
    //    the declaration's contract_source proves (REST for openapi /
    //    google_discovery, GraphQL for graphql) — the faithful
    //    generalization of the original REST-only gate, so no op escapes
    //    its prover. Malformed/missing contract_source.kind → the
    //    fail-closed 'openapi'/REST default (the kind error is reported
    //    above; a mismatched op still fails here, never slips through). ──
    const csKindResolved: WorkEntityContractSourceKind =
      isObjectRecord(cs) && isNonEmptyString(cs.kind)
        && (WORK_ENTITY_CONTRACT_SOURCE_KINDS as readonly string[]).includes(cs.kind)
        ? (cs.kind as WorkEntityContractSourceKind)
        : 'openapi';
    const expectedBindingKind = WORK_ENTITY_CONTRACT_SOURCE_TRANSPORT[csKindResolved];
    // ⛔ D-225 Slice 3 — an ABSENT contract_source has NO PINNED DOC, so it has
    // no prover, so "must match the prover's transport" has nothing to say.
    //
    // The gate above resolves a missing `contract_source` to the fail-closed
    // `openapi`/REST default, which is right for a MALFORMED one (the kind error
    // is reported separately and a mismatched op must not slip through) and
    // WRONG for a legally-absent one: it silently confines the EMPIRICAL route —
    // the one the ladder rates highest — to REST-bound ops. A doc-less Source
    // over a graphql pack is rejected today for the same reason, so this was
    // never an mcp-specific limit; widening for mcp alone would have left the
    // real rule unstated.
    //
    // With no document, the only constraint the machine can honestly impose is
    // that the op is SYNCHRONOUSLY DISPATCHABLE — a realtime webhook / queue /
    // push binding cannot back a Source op whatever proves it. Everything else
    // is the human's attestation in the authoring document (ladder §6), exactly
    // as the absent-contract_source branch above already says.
    const empiricallyProven = cs === undefined;
    const declaredOps = new Map<WorkEntityOpSlot, string>();
    const ops = d.ops;
    if (!isObjectRecord(ops)) {
      add('error', 'WORK_ENTITY_SOURCES_OP_INVALID', `${p}.ops`, 'ops is required');
    } else {
      for (const [slot, opName] of Object.entries(ops)) {
        const sp = `${p}.ops.${slot}`;
        if (!(WORK_ENTITY_OP_SLOTS as readonly string[]).includes(slot)) {
          add('error', 'WORK_ENTITY_SOURCES_OP_INVALID', sp,
            `unknown op slot '${slot}' — must be one of ${WORK_ENTITY_OP_SLOTS.join('|')}`);
          continue;
        }
        if (opName === null || opName === undefined) continue;
        if (!isNonEmptyString(opName)) {
          add('error', 'WORK_ENTITY_SOURCES_OP_INVALID', sp,
            'op must be null or a non-empty operation key');
          continue;
        }
        const binding = executes[opName];
        if (binding === undefined) {
          add('error', 'WORK_ENTITY_SOURCES_OP_INVALID', sp,
            `operation '${opName}' is not declared in surfaces.api.executes`);
        } else if (!isObjectRecord(binding)
          || (empiricallyProven
            ? isRealtimeApiBindingKind(binding.kind)
            : binding.kind !== expectedBindingKind)) {
          // The op's binding must be the transport this declaration's
          // contract_source proves — '${expectedBindingKind}' here (REST →
          // `(method, path)` against the pinned OpenAPI/Discovery doc; GraphQL → op +
          // selected-field existence against the pinned schema via
          // `crossCheckGraphqlSchema`, D-192 Gate E′). Any OTHER kind — a mismatched
          // transport, or a realtime webhook/queue/push subscription — can't be proven
          // against this declaration's ONE pinned doc → fail closed.
          // WORK_ENTITY_CONTRACT_SOURCE_TRANSPORT keeps the kind→transport mapping
          // declarative (a new provable transport adds one entry, no edit here — §0.5).
          add('error', 'WORK_ENTITY_SOURCES_OP_INVALID', sp,
            empiricallyProven
              ? `operation '${opName}' must have a synchronously-dispatchable execution binding — a realtime webhook/queue/push subscription cannot back a Source op, whatever proves it`
              : `operation '${opName}' must have a ${expectedBindingKind} execution binding to match the '${csKindResolved}' contract_source — every Source op must be provable against the one pinned schema document`);
        }
        declaredOps.set(slot as WorkEntityOpSlot, opName);
      }
      for (const requiredSlot of ['list', 'read'] as const) {
        if (!declaredOps.has(requiredSlot)) {
          add('error', 'WORK_ENTITY_SOURCES_OP_INVALID', `${p}.ops.${requiredSlot}`,
            `ops.${requiredSlot} is required — sync needs a list walk and remote-detail/preflight reads need a read op`);
        }
      }
    }
    const declaredWriteSlots = WORK_ENTITY_WRITE_OP_SLOTS.filter((s) => declaredOps.has(s));

    // ── op_bindings (D-192 P4) ──
    // Optional: a list-only Source needs none, and a declaration
    // without bindings stays syncable (the executor config-fails a
    // targeted invocation whose slot lacks one — graceful, not a
    // publish gate). When PRESENT the shape is strict: targeted slots
    // only, each bound slot's op must actually be declared, and the
    // id_arg must name a real argument.
    const bindings = d.op_bindings;
    if (bindings !== undefined) {
      if (!isObjectRecord(bindings)) {
        add('error', 'WORK_ENTITY_SOURCES_OP_BINDING_INVALID', `${p}.op_bindings`,
          'op_bindings must be an object keyed by targeted op slot');
      } else {
        for (const [slot, binding] of Object.entries(bindings)) {
          const bp = `${p}.op_bindings.${slot}`;
          if (!(WORK_ENTITY_TARGETED_OP_SLOTS as readonly string[]).includes(slot)) {
            add('error', 'WORK_ENTITY_SOURCES_OP_BINDING_INVALID', bp,
              `unknown targeted op slot '${slot}' — must be one of ${WORK_ENTITY_TARGETED_OP_SLOTS.join('|')}`);
            continue;
          }
          if (!declaredOps.has(slot as WorkEntityOpSlot)) {
            add('error', 'WORK_ENTITY_SOURCES_OP_BINDING_INVALID', bp,
              `op_bindings.${slot} binds a slot whose op is not declared in ops`);
            continue;
          }
          if (!isObjectRecord(binding) || !isNonEmptyString(binding.id_arg)) {
            add('error', 'WORK_ENTITY_SOURCES_OP_BINDING_INVALID', bp,
              'a targeted op binding must declare a non-empty id_arg — the op argument carrying the vendor-native record id');
            continue;
          }
          // D-192 P4b — conditional-write precondition arg. Strict when
          // present: non-empty, write slots only (a read carries no
          // precondition token).
          if (binding.precondition_arg !== undefined) {
            if (!isNonEmptyString(binding.precondition_arg)) {
              add('error', 'WORK_ENTITY_SOURCES_OP_BINDING_INVALID', `${bp}.precondition_arg`,
                'precondition_arg must be a non-empty op argument name when present');
            } else if (slot === 'read') {
              add('error', 'WORK_ENTITY_SOURCES_OP_BINDING_INVALID', `${bp}.precondition_arg`,
                'precondition_arg is write-slot-only — a read op carries no conditional-write precondition');
            }
          }
        }
      }
    }

    // contract_source.operations must assert coverage of every named op.
    if (isObjectRecord(cs) && Array.isArray(cs.operations)) {
      const asserted = new Set(cs.operations.filter(isNonEmptyString));
      for (const [slot, opName] of declaredOps) {
        if (!asserted.has(opName)) {
          add('error', 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID', `${p}.contract_source.operations`,
            `ops.${slot} operation '${opName}' is missing from contract_source.operations — the coverage assertion must name every op the Source uses`);
        }
      }
    } else if (isObjectRecord(cs)) {
      add('error', 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID', `${p}.contract_source.operations`,
        'contract_source.operations must be an array naming every op the Source uses');
    }

    // ── remote identity ──
    // Tracked for the write_policy coherence gate below: a version-kind
    // 'none' Source can never produce a precondition token, so a
    // conditional-write strategy would be an unsatisfiable promise.
    let versionKindNone = false;
    const remote = d.remote;
    if (!isObjectRecord(remote)) {
      add('error', 'WORK_ENTITY_SOURCES_REMOTE_INVALID', `${p}.remote`, 'remote is required');
    } else {
      if (!isNonEmptyString(remote.entity)) {
        add('error', 'WORK_ENTITY_SOURCES_REMOTE_INVALID', `${p}.remote.entity`,
          'remote.entity is required — one remote entity collection per declaration');
      }
      if (!isNonEmptyString(remote.id)) {
        add('error', 'WORK_ENTITY_SOURCES_REMOTE_INVALID', `${p}.remote.id`,
          'remote.id is required — the response field carrying the vendor-native record id');
      }
      if (remote.create_response_id_field !== undefined) {
        if (!isNonEmptyString(remote.create_response_id_field)) {
          add('error', 'WORK_ENTITY_SOURCES_REMOTE_INVALID', `${p}.remote.create_response_id_field`,
            'remote.create_response_id_field must be a non-empty field path when present');
        } else if (!declaredOps.has('create')) {
          add('error', 'WORK_ENTITY_SOURCES_REMOTE_INVALID', `${p}.remote.create_response_id_field`,
            'remote.create_response_id_field requires ops.create — it names the id field of a create response this Source never receives');
        }
      }
      const version = remote.version;
      if (!isObjectRecord(version)
          || !isNonEmptyString(version.kind)
          || !(WORK_ENTITY_VERSION_KINDS as readonly string[]).includes(version.kind)) {
        add('error', 'WORK_ENTITY_SOURCES_REMOTE_INVALID', `${p}.remote.version`,
          `remote.version.kind must be one of ${WORK_ENTITY_VERSION_KINDS.join('|')} — a Source must declare a version/hash strategy`);
      } else if (version.kind === 'none') {
        // D-192 CORE #8c — the declared tokenless posture: the pinned
        // schema exposes NO version signal; change detection rides the
        // local source_record_hash compare. The field gate is
        // LOAD-BEARING, not hygiene: the projector mints
        // source_version_token from any declared version.field, so a
        // 'none' declaration carrying one would quietly become a
        // token-bearing Source.
        versionKindNone = true;
        if (version.field !== undefined) {
          add('error', 'WORK_ENTITY_SOURCES_REMOTE_INVALID', `${p}.remote.version.field`,
            "remote.version.field is forbidden for kind 'none' — the kind asserts the pinned schema exposes no version signal; declare the field's real kind instead");
        }
      } else if (version.kind !== 'etag' && !isNonEmptyString(version.field)) {
        add('error', 'WORK_ENTITY_SOURCES_REMOTE_INVALID', `${p}.remote.version.field`,
          `remote.version.field is required for kind '${version.kind}' (only an etag may live outside the response body)`);
      }
      if (!Array.isArray(remote.hash_fields) || remote.hash_fields.length === 0
          || !remote.hash_fields.every(isNonEmptyString)) {
        add('error', 'WORK_ENTITY_SOURCES_REMOTE_INVALID', `${p}.remote.hash_fields`,
          'remote.hash_fields must be a non-empty array of field names — the dedup/conflict hash basis');
      }
    }

    // ── sync ──
    const sync = d.sync;
    let mode: string | undefined;
    if (!isObjectRecord(sync)) {
      add('error', 'WORK_ENTITY_SOURCES_SYNC_INVALID', `${p}.sync`, 'sync is required');
    } else {
      if (!isNonEmptyString(sync.mode) || !(WORK_ENTITY_SYNC_MODES as readonly string[]).includes(sync.mode)) {
        add('error', 'WORK_ENTITY_SOURCES_SYNC_INVALID', `${p}.sync.mode`,
          'sync.mode must be read_only|read_write — write_only is not a valid work-entity Source mode');
      } else {
        mode = sync.mode;
      }
      if (!isNonEmptyString(sync.depth) || !(WORK_ENTITY_SYNC_DEPTHS as readonly string[]).includes(sync.depth)) {
        add('error', 'WORK_ENTITY_SOURCES_SYNC_INVALID', `${p}.sync.depth`,
          "sync.depth must be 'meta' — the full mode was dropped (D-192 fork F3); the declared extended-vendor field is the only wider lane");
      }
      if (!isNonEmptyString(sync.tombstones)
          || !(WORK_ENTITY_TOMBSTONE_KINDS as readonly string[]).includes(sync.tombstones)) {
        add('error', 'WORK_ENTITY_SOURCES_SYNC_INVALID', `${p}.sync.tombstones`,
          `sync.tombstones must be one of ${WORK_ENTITY_TOMBSTONE_KINDS.join('|')} — tombstone semantics are mandatory`);
      } else if (sync.tombstones === 'native' && !isNonEmptyString(sync.tombstone_field)) {
        add('error', 'WORK_ENTITY_SOURCES_SYNC_INVALID', `${p}.sync.tombstone_field`,
          "tombstones 'native' requires sync.tombstone_field — the remote field marking a vendor-side deletion (P3 runner reads it)");
      } else if (sync.tombstones === 'missing_means_deleted' && sync.list_scope !== 'complete_authoritative') {
        add('error', 'WORK_ENTITY_SOURCES_SYNC_INVALID', `${p}.sync.list_scope`,
          "tombstones 'missing_means_deleted' requires sync.list_scope 'complete_authoritative' — a filtered list must never drive absence-based deletes");
      }
      if (sync.list_scope !== undefined
          && (!isNonEmptyString(sync.list_scope) || !(WORK_ENTITY_LIST_SCOPES as readonly string[]).includes(sync.list_scope))) {
        add('error', 'WORK_ENTITY_SOURCES_SYNC_INVALID', `${p}.sync.list_scope`,
          `sync.list_scope must be one of ${WORK_ENTITY_LIST_SCOPES.join('|')} when present`);
      }
      // ── list_rows (D-192 CORE #8b) ──
      // 'reference' = identity-only list rows; every listed row hydrates
      // through the read op before projection. Hydration is a TARGETED
      // read, so the read binding is a publish-time requirement — a
      // reference Source without op_bindings.read.id_arg would config-
      // fail EVERY sync cycle (there is no degraded-but-working mode).
      if (sync.list_rows !== undefined
          && (!isNonEmptyString(sync.list_rows) || !(WORK_ENTITY_LIST_ROW_KINDS as readonly string[]).includes(sync.list_rows))) {
        add('error', 'WORK_ENTITY_SOURCES_SYNC_INVALID', `${p}.sync.list_rows`,
          `sync.list_rows must be one of ${WORK_ENTITY_LIST_ROW_KINDS.join('|')} when present`);
      } else if (sync.list_rows === 'reference') {
        const readBinding = isObjectRecord(d.op_bindings) && isObjectRecord(d.op_bindings.read)
          ? d.op_bindings.read
          : undefined;
        if (readBinding === undefined || !isNonEmptyString(readBinding.id_arg)) {
          add('error', 'WORK_ENTITY_SOURCES_SYNC_INVALID', `${p}.sync.list_rows`,
            "sync.list_rows 'reference' requires op_bindings.read.id_arg — every listed row hydrates through the read op before projection, and the executor cannot name the vendor record without the binding");
        }
      }
      if (!isPositiveInt(sync.stale_after_ms)) {
        add('error', 'WORK_ENTITY_SOURCES_SYNC_INVALID', `${p}.sync.stale_after_ms`,
          'sync.stale_after_ms must be a positive integer — the stale-source threshold is mandatory');
      }
      if (sync.cursor !== undefined) {
        const cursor = sync.cursor;
        if (!isObjectRecord(cursor)
            || !isNonEmptyString(cursor.kind)
            || !(WORK_ENTITY_CURSOR_KINDS as readonly string[]).includes(cursor.kind)
            || !isNonEmptyString(cursor.arg)
            || !isNonEmptyString(cursor.remote_field)) {
          add('error', 'WORK_ENTITY_SOURCES_SYNC_INVALID', `${p}.sync.cursor`,
            `sync.cursor must declare kind (${WORK_ENTITY_CURSOR_KINDS.join('|')}), arg, and remote_field`);
        }
      }
    }
    if (mode === 'read_only' && declaredWriteSlots.length > 0) {
      add('error', 'WORK_ENTITY_SOURCES_OP_INVALID', `${p}.ops`,
        `read_only Source declares write ops (${declaredWriteSlots.join(', ')}) — drop them or declare read_write`);
    }
    if (mode === 'read_write' && declaredWriteSlots.length === 0) {
      add('error', 'WORK_ENTITY_SOURCES_OP_INVALID', `${p}.ops`,
        'read_write Source declares no write op — declare create/update/delete/complete or use read_only');
    }
    // D-192 CORE #8c (codex adversarial fold) — a version-kind 'none'
    // Source admits NO targeted writes (update/delete/complete): with
    // no version signal there is no token for the preflight-to-write
    // race AND the read-before-write compare loses its token precision
    // (hash compare misses vendor edits between sync and write on
    // anything the bounded lanes don't store). Vendors whose API
    // demands preconditions make it concrete: Planner's own update ops
    // REQUIRE header.If-Match, so a tokenless declaration could never
    // satisfy them. Create is admissible — no existing record, no
    // race. A future read_write+none vendor is a deliberate contract
    // change with its own safety design, not a default.
    if (versionKindNone) {
      const targetedWrites = declaredWriteSlots.filter((s) => s !== 'create');
      if (targetedWrites.length > 0) {
        add('error', 'WORK_ENTITY_SOURCES_OP_INVALID', `${p}.ops`,
          `remote.version.kind 'none' admits no targeted write ops (declared: ${targetedWrites.join(', ')}) — a tokenless Source cannot close the preflight-to-write race; declare read_only or create-only, or declare the version signal the writes rely on`);
      }
    }

    // ── read_resolution ──
    const rr = d.read_resolution;
    if (!isObjectRecord(rr)) {
      add('error', 'WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID', `${p}.read_resolution`,
        'read_resolution is required');
    } else {
      if (rr.default !== 'local_rich_meta') {
        add('error', 'WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID', `${p}.read_resolution.default`,
          "read_resolution.default must be 'local_rich_meta'");
      }
      const remoteWhen = rr.remote_when;
      if (!Array.isArray(remoteWhen) || remoteWhen.length === 0
          || !remoteWhen.every((r) => isNonEmptyString(r) && WORK_ENTITY_REMOTE_WHEN_REASON_SET.has(r))) {
        add('error', 'WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID', `${p}.read_resolution.remote_when`,
          'read_resolution.remote_when must be a non-empty array of known escalation reasons');
      } else if (declaredWriteSlots.length > 0 && !remoteWhen.includes('write_preflight')) {
        add('error', 'WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID', `${p}.read_resolution.remote_when`,
          "a write-capable Source must include 'write_preflight' in remote_when — write preflight is always remote");
      }
      const wq = rr.wild_query;
      if (!isObjectRecord(wq)
          || wq.remote_fanout !== 'bounded_targeted'
          || !isPositiveInt(wq.max_sources)
          || !isPositiveInt(wq.max_remote_records)
          || wq.on_exceeds_cap !== 'ask_to_narrow') {
        add('error', 'WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID', `${p}.read_resolution.wild_query`,
          "read_resolution.wild_query must declare remote_fanout 'bounded_targeted', positive max_sources / max_remote_records caps, and on_exceeds_cap 'ask_to_narrow'");
      }
    }

    // ── projection ──
    const canonicalAllowed = WORK_ENTITY_SOURCE_CANONICAL_FIELDS[kind];
    const relationshipLocalFields = WORK_ENTITY_SOURCE_RELATIONSHIP_LOCAL_FIELDS[kind];
    const projection = d.projection;
    const previewKeys = new Set<string>();
    let canonicalKeys: string[] = [];
    // Canonical fields declared as DERIVATIONS (D-192 CORE #8c) — they
    // have no vendor read path, so the writable_fields gate below
    // refuses them.
    const derivedCanonicalFields = new Set<string>();
    // Canonical fields declared as COALESCES (D-192 CORE #8d) — no
    // SINGLE vendor read path, so the writable_fields gate below
    // refuses them too (read-only in v1).
    const coalescedCanonicalFields = new Set<string>();
    if (!isObjectRecord(projection)) {
      add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${p}.projection`, 'projection is required');
    } else {
      const canonical = projection.canonical;
      if (!isObjectRecord(canonical)) {
        add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${p}.projection.canonical`,
          'projection.canonical is required (an object of canonical column ← remote field path)');
      } else {
        canonicalKeys = Object.keys(canonical);
        const derivableFields = WORK_ENTITY_SOURCE_DERIVABLE_CANONICAL[kind];
        const transformableFields = WORK_ENTITY_SOURCE_TRANSFORMABLE_CANONICAL[kind];
        for (const [field, sourcePath] of Object.entries(canonical)) {
          const fp = `${p}.projection.canonical.${field}`;
          if (!canonicalAllowed.includes(field)) {
            const hint = relationshipLocalFields.includes(field)
              ? ' — relationship/FK fields are never projection targets; declare a relationships entry instead'
              : ` — allowed for ${kind}: ${canonicalAllowed.join(', ')} (long-body fields ride the preview lane)`;
            add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
              `'${field}' is not a projectable canonical field${hint}`);
          }
          // D-192 CORE #8d — the array form is an ordered COALESCE of
          // remote field paths (first usable wins), admissible only on
          // the kind's coalescable fields (v1: title).
          if (Array.isArray(sourcePath)) {
            coalescedCanonicalFields.add(field);
            const coalescableFields = WORK_ENTITY_SOURCE_COALESCABLE_CANONICAL[kind];
            if (!coalescableFields.includes(field)) {
              add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
                `'${field}' does not admit a coalesce — coalescable for ${kind}: ${coalescableFields.length > 0 ? coalescableFields.join(', ') : '(none)'}; projection values are remote field paths`);
              continue;
            }
            if (sourcePath.length < 2) {
              add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
                'a coalesce must declare at least two remote field paths in priority order (a single path needs no coalesce)');
            }
            if (!sourcePath.every(isNonEmptyString)) {
              add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
                'coalesce entries must be non-empty remote field paths');
            }
            continue;
          }
          // D-192 CORE #8c/#8e — the object form is a closed derivation
          // (a discriminated union on `kind`). EVERY derivation is
          // READ-ONLY (no single vendor read path for the write
          // executor's patch-target fallback, no closed inverse in v1),
          // so the field joins `derivedCanonicalFields` regardless of
          // kind. Kind is validated FIRST, because applicability is
          // gated PER KIND — `number_equals` (boolean output, CORE #8c)
          // on the derivable set, `transform` (string output, CORE #8e)
          // on the transformable set — so neither kind can target the
          // other's fields. Everything else stays a non-empty remote path.
          if (isObjectRecord(sourcePath)) {
            derivedCanonicalFields.add(field);
            if (!isNonEmptyString(sourcePath.kind)
                || !(WORK_ENTITY_CANONICAL_DERIVE_KINDS as readonly string[]).includes(sourcePath.kind)) {
              add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${fp}.kind`,
                `a canonical derivation must declare kind ${WORK_ENTITY_CANONICAL_DERIVE_KINDS.join('|')}`);
              continue;
            }
            if (sourcePath.kind === 'number_equals') {
              if (!derivableFields.includes(field)) {
                add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
                  `'${field}' does not admit a derivation — derivable for ${kind}: ${derivableFields.length > 0 ? derivableFields.join(', ') : '(none)'}; projection values are remote field paths`);
                continue;
              }
              if (!isNonEmptyString(sourcePath.field)) {
                add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${fp}.field`,
                  'a canonical derivation must declare a non-empty remote field path');
              }
              if (typeof sourcePath.value !== 'number' || !Number.isFinite(sourcePath.value)) {
                add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${fp}.value`,
                  'a number_equals derivation must declare a finite numeric comparand');
              }
            } else {
              // kind === 'transform' (CORE #8e) — a whitelisted pure
              // transform over a remote text path (Confluence
              // `title ← strip_html(body.storage.value)`).
              if (!transformableFields.includes(field)) {
                add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
                  `'${field}' does not admit a transform derivation — transformable for ${kind}: ${transformableFields.length > 0 ? transformableFields.join(', ') : '(none)'}; projection values are remote field paths`);
                continue;
              }
              if (!isNonEmptyString(sourcePath.field)) {
                add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${fp}.field`,
                  'a canonical derivation must declare a non-empty remote field path');
              }
              if (!isNonEmptyString(sourcePath.transform)
                  || !(WORK_ENTITY_CANONICAL_TRANSFORM_FNS as readonly string[]).includes(sourcePath.transform)) {
                add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${fp}.transform`,
                  `a transform derivation must declare transform ${WORK_ENTITY_CANONICAL_TRANSFORM_FNS.join('|')}`);
              }
            }
            continue;
          }
          if (!isNonEmptyString(sourcePath)) {
            add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
              'projection value must be a non-empty remote field path');
          }
        }
        for (const required of WORK_ENTITY_SOURCE_REQUIRED_CANONICAL[kind]) {
          if (!canonicalKeys.includes(required)) {
            add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${p}.projection.canonical`,
              `projection omits required canonical field '${required}' for kind '${kind}'`);
          }
        }
      }

      const preview = projection.preview;
      if (preview !== undefined) {
        if (!isObjectRecord(preview)) {
          add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${p}.projection.preview`,
            'projection.preview must be an object when present');
        } else {
          for (const [field, spec] of Object.entries(preview)) {
            const fp = `${p}.projection.preview.${field}`;
            previewKeys.add(field);
            if (relationshipLocalFields.includes(field) || canonicalAllowed.includes(field)) {
              add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
                `preview field '${field}' collides with a canonical/relationship field — preview names its own bounded text fields (body, description, excerpt)`);
            }
            if (!isObjectRecord(spec) || !isNonEmptyString(spec.field)) {
              add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
                'preview entry must declare a remote source field');
              continue;
            }
            if (spec.max_chars !== undefined
                && (!isPositiveInt(spec.max_chars) || spec.max_chars > WORK_ENTITY_PREVIEW_HARD_MAX_CHARS)) {
              add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${fp}.max_chars`,
                `preview max_chars must be a positive integer ≤ ${WORK_ENTITY_PREVIEW_HARD_MAX_CHARS}`);
            }
          }
        }
      }

      const extension = projection.extension;
      if (extension !== undefined && !isObjectRecord(extension)) {
        add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${p}.projection.extension`,
          'projection.extension must be an object when present');
      } else if (isObjectRecord(extension)) {
        const entries = Object.entries(extension);
        if (entries.length > WORK_ENTITY_EXTENSION_MAX_ENTRIES) {
          add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${p}.projection.extension`,
            `extension declares ${entries.length} entries — max ${WORK_ENTITY_EXTENSION_MAX_ENTRIES}`);
        }
        for (const [key, value] of entries) {
          const fp = `${p}.projection.extension.${key}`;
          if (relationshipLocalFields.includes(key) || canonicalAllowed.includes(key)) {
            add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
              `extension key '${key}' collides with a canonical/relationship field`);
          }
          // The projector writes `preview` (the preview lane) and `rel_<field>`
          // (the relationship lane) into the SAME extension blob, so an
          // author-declared extension key of either shape would clobber — or be
          // clobbered by — them (e.g. `projection.extension.preview` overwrites
          // the projected preview map, and the reader then sees no body preview).
          // Reserve both; `detail_fidelity` is the one projector-written key an
          // author may legitimately declare.
          if (key === 'preview' || key.startsWith('rel_')) {
            add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
              `extension key '${key}' is reserved by the projected blob (the preview / rel_* lanes)`);
          }
          // `detail_fidelity` may carry the per-field map form — checked
          // below with the preview lane. Every OTHER value is a declared
          // remote field path or literal marker (a string); what the
          // projected ROW may hold (bounded scalars/small arrays under
          // the WORK_ENTITY_EXTENSION_* caps) is the P3 projection
          // gate's concern, not the declaration's.
          if (key === 'detail_fidelity') continue;
          if (!isNonEmptyString(value) || value.length > WORK_ENTITY_EXTENSION_SCALAR_MAX_CHARS) {
            add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fp,
              `extension values must be non-empty strings ≤ ${WORK_ENTITY_EXTENSION_SCALAR_MAX_CHARS} chars (declared field paths or literal markers — never a raw vendor object)`);
          }
        }
      }

      // Preview fidelity marker: bounded text must be honest about not
      // being the complete body. Two valid forms (spec § Sync depth
      // shows the per-field map; the Contract-shape fragment shows the
      // scalar — Codex review fold): `'preview'` marks every preview
      // field, or a per-field map that must cover EVERY declared
      // preview key with the value 'preview'.
      const fidelity = isObjectRecord(extension) ? extension.detail_fidelity : undefined;
      if (previewKeys.size > 0) {
        const fidelityPath = `${p}.projection.extension.detail_fidelity`;
        if (fidelity === 'preview') {
          // scalar form — covers all preview fields
        } else if (isObjectRecord(fidelity)) {
          for (const [field, marker] of Object.entries(fidelity)) {
            if (marker !== 'preview') {
              add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${fidelityPath}.${field}`,
                "detail_fidelity map values must be 'preview'");
            }
          }
          for (const previewField of previewKeys) {
            if (fidelity[previewField] === undefined) {
              add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fidelityPath,
                `detail_fidelity map omits preview field '${previewField}' — every preview field must carry field-level fidelity metadata`);
            }
          }
        } else {
          add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', fidelityPath,
            "a declaration with preview fields must mark detail_fidelity — 'preview' or a per-field map covering every preview field; preview text must never read as complete content");
        }
      } else if (fidelity !== undefined) {
        add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${p}.projection.extension.detail_fidelity`,
          'detail_fidelity is only valid when preview fields are declared');
      }

      // A note with no canonical title must project at least one
      // preview field (the canonical shape has no other required column).
      if (kind === 'note' && !canonicalKeys.includes('title') && previewKeys.size === 0) {
        add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${p}.projection`,
          'a note Source must project a title or at least one preview field');
      }

      // A task must project a COMPLETION SIGNAL — `done` or `state`
      // (P1b coverage finding: vendors model completion as a state
      // enum as often as a boolean; either satisfies the invariant,
      // and the P3 projection layer normalizes).
      if (kind === 'task' && !canonicalKeys.includes('done') && !canonicalKeys.includes('state')) {
        add('error', 'WORK_ENTITY_SOURCES_PROJECTION_INVALID', `${p}.projection.canonical`,
          "a task Source must project a completion signal — 'done' or 'state'");
      }

      // D-192 CORE #8c (codex adversarial fold) — a DERIVED `done` has
      // no v1 inverse, so a declared ops.complete is a promise the
      // executor can only mis-keep: the mark-done patch carries no
      // pushable completion field, so the op either never dispatches
      // (vendor_relevant: false — silent local-only completion the
      // next sync flips back) or, with a writable completed_at,
      // dispatches a HALF-completion. Reject at publish; completion
      // write-back for numeric-completion vendors is a future
      // inverse-derivation extension.
      if (derivedCanonicalFields.has('done') && declaredOps.has('complete')) {
        add('error', 'WORK_ENTITY_SOURCES_OP_INVALID', `${p}.ops.complete`,
          "ops.complete with a DERIVED 'done' cannot dispatch truthfully — the completion value has no declared inverse; drop the op or project 'done' from a real vendor field");
      }
    }

    // ── writable_fields ──
    const writable = d.writable_fields;
    if (writable !== undefined) {
      if (!Array.isArray(writable) || !writable.every(isNonEmptyString)) {
        add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.writable_fields`,
          'writable_fields must be an array of field names');
      } else {
        if (mode !== 'read_write' && writable.length > 0) {
          add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.writable_fields`,
            'writable_fields requires sync.mode read_write');
        }
        for (const field of writable) {
          if (!canonicalAllowed.includes(field) && !previewKeys.has(field)) {
            add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.writable_fields`,
              `writable field '${field}' is neither a projectable canonical field nor a declared preview (remote-detail) field`);
          }
          // D-192 CORE #8c/#8e — a DERIVED canonical field is read-only
          // (both `number_equals` and `transform` object forms land in
          // this set): it has no single vendor read path for the write
          // executor's patch-target fallback, and no closed inverse
          // exists in v1.
          if (derivedCanonicalFields.has(field)) {
            add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.writable_fields`,
              `writable field '${field}' is projected by a derivation — derived canonical fields are read-only in v1`);
          }
          // D-192 CORE #8d — a COALESCED canonical field is read-only:
          // it has no SINGLE vendor read path for the write executor's
          // patch-target fallback, and which candidate a push should
          // target is a deliberate future contract (write_paths could
          // disambiguate, but no vendor needs it yet).
          if (coalescedCanonicalFields.has(field)) {
            add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.writable_fields`,
              `writable field '${field}' is projected by a coalesce — coalesced canonical fields are read-only in v1`);
          }
          // Codex #8c adversarial fold — a derived `done` also forbids a
          // writable `completed_at`: the mark-done patch is
          // {done, completed_at}, and with `done` underivable-inverse the
          // executor would dispatch a HALF-completion — completed_at
          // pushed while the vendor's actual completion field never
          // moves, so the next sync flips `done` back to false on a
          // record whose completion date claims otherwise. Worse than
          // not dispatching (the pre-existing local-only degrade).
          if (field === 'completed_at' && derivedCanonicalFields.has('done')) {
            add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.writable_fields`,
              "writable field 'completed_at' with a DERIVED 'done' would push a half-completion (a completion date without the completion field) — completion write-back for numeric-completion vendors is a future inverse-derivation extension");
          }
        }
      }
    }
    if (declaredWriteSlots.some((s) => s === 'create' || s === 'update')
        && (!Array.isArray(writable) || writable.length === 0)) {
      add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.writable_fields`,
        'a Source with create/update ops must declare writable_fields');
    }

    // ── write_transforms ──
    // Inverse canonical→vendor value mapping per writable field. The
    // executor applies these at prepare (refusing unmappable values
    // before side effects) — the validator closes the SHAPE: known
    // kinds only, keys must be writable (dead config otherwise), a
    // vocab on a field whose canonical domain is closed must cover
    // that domain exactly, and each kind is restricted to value shapes
    // it can actually transform.
    const transforms = d.write_transforms;
    if (transforms !== undefined) {
      if (!isObjectRecord(transforms)) {
        add('error', 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID', `${p}.write_transforms`,
          'write_transforms must be an object keyed by writable field');
      } else {
        const writableSet = new Set(
          Array.isArray(writable) ? writable.filter(isNonEmptyString) : [],
        );
        const dateFields = WORK_ENTITY_DATE_CANONICAL_FIELDS as readonly string[];
        for (const [field, transform] of Object.entries(transforms)) {
          const tp = `${p}.write_transforms.${field}`;
          if (!writableSet.has(field)) {
            add('error', 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID', tp,
              `write transform targets '${field}', which is not in writable_fields — a transform on an unwritable field is dead config`);
            continue;
          }
          if (!isObjectRecord(transform) || !isNonEmptyString(transform.kind)
              || !(WORK_ENTITY_WRITE_TRANSFORM_KINDS as readonly string[]).includes(transform.kind)) {
            add('error', 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID', tp,
              `a write transform must declare kind ${WORK_ENTITY_WRITE_TRANSFORM_KINDS.join('|')}`);
            continue;
          }
          if (transform.kind === 'date_format') {
            if (!dateFields.includes(field)) {
              add('error', 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID', tp,
                `date_format transforms only apply to date canonical fields (${dateFields.join(', ')})`);
            }
            if (!isNonEmptyString(transform.format)
                || !(WORK_ENTITY_WRITE_DATE_FORMATS as readonly string[]).includes(transform.format)) {
              add('error', 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID', `${tp}.format`,
                `date_format.format must be one of ${WORK_ENTITY_WRITE_DATE_FORMATS.join('|')}`);
            }
            continue;
          }
          // vocab — string-valued fields only.
          if (dateFields.includes(field) || field === 'done' || field === 'progress') {
            add('error', 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID', tp,
              `vocab transforms only apply to string-valued fields — '${field}' is not one`);
            continue;
          }
          const map = transform.map;
          if (!isObjectRecord(map) || Object.keys(map).length === 0
              || !Object.entries(map).every(([k, v]) => isNonEmptyString(k) && isNonEmptyString(v))) {
            add('error', 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID', `${tp}.map`,
              'vocab.map must be a non-empty record of canonical value → vendor value (non-empty strings)');
            continue;
          }
          // Closed canonical domains must be covered EXACTLY: a
          // missing key turns a user-selectable value into a write
          // refusal; an extra key is dead config.
          const closedDomain: readonly string[] | null =
            kind === 'task' && field === 'priority' ? TASK_PRIORITIES
              : kind === 'project' && field === 'state' ? PROJECT_STATES
                : null;
          if (closedDomain !== null) {
            const keys = new Set(Object.keys(map));
            const missing = closedDomain.filter((v) => !keys.has(v));
            const extra = [...keys].filter((k) => !closedDomain.includes(k));
            if (missing.length > 0) {
              add('error', 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID', `${tp}.map`,
                `vocab.map must cover the closed canonical '${field}' domain — missing: ${missing.join(', ')}`);
            }
            if (extra.length > 0) {
              add('error', 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID', `${tp}.map`,
                `vocab.map carries keys outside the closed canonical '${field}' domain: ${extra.join(', ')}`);
            }
          }
        }
      }
    }

    // ── write_paths ──
    // Per-field vendor WRITE target when it differs from the projection
    // READ path (read shape ≠ write shape). Keys must be writable (a
    // write path for an unwritable field is dead config); values are
    // non-empty vendor paths / graphql variable names.
    const writePaths = d.write_paths;
    if (writePaths !== undefined) {
      if (!isObjectRecord(writePaths)) {
        add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.write_paths`,
          'write_paths must be an object keyed by writable field');
      } else {
        const writableSet = new Set(
          Array.isArray(writable) ? writable.filter(isNonEmptyString) : [],
        );
        for (const [field, path] of Object.entries(writePaths)) {
          if (!writableSet.has(field)) {
            add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.write_paths.${field}`,
              `write path targets '${field}', which is not in writable_fields — a write path for an unwritable field is dead config`);
          } else if (!isNonEmptyString(path)) {
            add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.write_paths.${field}`,
              'write_paths value must be a non-empty vendor write path / graphql variable name');
          }
        }
      }
    }

    // ── create_required_fields ──
    const createRequired = d.create_required_fields;
    if (createRequired !== undefined) {
      if (!Array.isArray(createRequired) || !createRequired.every(isNonEmptyString)) {
        add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.create_required_fields`,
          'create_required_fields must be an array of field names');
      } else {
        const writableSet = new Set(Array.isArray(writable) ? writable.filter(isNonEmptyString) : []);
        for (const field of createRequired) {
          // Must be pushable — a vendor-required create field the
          // declaration cannot compose is unsatisfiable (every create
          // would config-refuse).
          if (!writableSet.has(field)) {
            add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.create_required_fields`,
              `create-required field '${field}' is not in writable_fields — a vendor-required create field must be pushable`);
          }
        }
      }
    }

    // ── create_arg_bindings ──
    // Vendor op args a create needs that are NOT canonical fields (Linear
    // `teamId`), resolved from a declared source. Create-only (dead config
    // without an `ops.create`); each binding names a known source + a non-empty
    // key.
    const createArgBindings = d.create_arg_bindings;
    if (createArgBindings !== undefined) {
      if (!isObjectRecord(createArgBindings)) {
        add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.create_arg_bindings`,
          'create_arg_bindings must be an object keyed by the create op arg name');
      } else {
        if (!declaredOps.has('create')) {
          add('error', 'WORK_ENTITY_SOURCES_WRITABLE_INVALID', `${p}.create_arg_bindings`,
            'create_arg_bindings requires an ops.create — a create-arg binding without a create op is dead config');
        }
        for (const [argName, binding] of Object.entries(createArgBindings)) {
          validateConfigArgBinding(
            binding, `${p}.create_arg_bindings.${argName}`,
            'WORK_ENTITY_SOURCES_WRITABLE_INVALID', add,
          );
        }
      }
    }

    // ── op_arg_bindings ──
    // Per-connection SCOPING args the list walk / targeted operation needs but the
    // canonical model has no column for (Asana `query.workspace`, Google Tasks
    // `tasklist_id`). Keyed by op slot (`list` | `read` | `update` | `delete` |
    // `complete`) → the op's own arg key
    // → a `connection_config` binding. Optional (Todoist needs none); when
    // PRESENT the shape is strict, each bound slot's op must be declared, and each
    // binding names source `connection_config` + a non-reserved non-empty key —
    // the same posture as create_arg_bindings.
    const opArgBindings = d.op_arg_bindings;
    if (opArgBindings !== undefined) {
      if (!isObjectRecord(opArgBindings)) {
        add('error', 'WORK_ENTITY_SOURCES_OP_ARG_BINDING_INVALID', `${p}.op_arg_bindings`,
          'op_arg_bindings must be an object keyed by op slot (list | read | update | delete | complete)');
      } else {
        for (const [slot, argMap] of Object.entries(opArgBindings)) {
          const sp = `${p}.op_arg_bindings.${slot}`;
          if (slot !== 'list' && slot !== 'read' && slot !== 'update'
              && slot !== 'delete' && slot !== 'complete') {
            add('error', 'WORK_ENTITY_SOURCES_OP_ARG_BINDING_INVALID', sp,
              `op_arg_bindings slot '${slot}' is not supported — use list, read, update, delete, or complete (create uses create_arg_bindings)`);
            continue;
          }
          if (!declaredOps.has(slot as WorkEntityOpSlot)) {
            add('error', 'WORK_ENTITY_SOURCES_OP_ARG_BINDING_INVALID', sp,
              `op_arg_bindings.${slot} binds args for a slot whose op is not declared in ops — dead config`);
            continue;
          }
          if (!isObjectRecord(argMap)) {
            add('error', 'WORK_ENTITY_SOURCES_OP_ARG_BINDING_INVALID', sp,
              `op_arg_bindings.${slot} must be an object keyed by the op arg name`);
            continue;
          }
          // The record id rides `op_bindings.<slot>.id_arg`; a scoping arg bound to
          // that SAME arg key is dead config — the dispatch writes the id LAST, so
          // it always overrides the config value. Reject at publish (`list`
          // walks a collection and has no id arg). Codex review fold.
          const opBindingsRec = isObjectRecord(d.op_bindings) ? d.op_bindings : undefined;
          const slotBinding = opBindingsRec !== undefined ? opBindingsRec[slot] : undefined;
          const slotIdArg = slot !== 'list' && isObjectRecord(slotBinding)
            ? slotBinding.id_arg
            : undefined;
          const slotPreconditionArg = slot !== 'list' && isObjectRecord(slotBinding)
            ? slotBinding.precondition_arg
            : undefined;
          for (const [argName, binding] of Object.entries(argMap)) {
            const bp = `${sp}.${argName}`;
            if (argName === slotIdArg || argName === slotPreconditionArg) {
              const collision = argName === slotIdArg ? 'id_arg' : 'precondition_arg';
              add('error', 'WORK_ENTITY_SOURCES_OP_ARG_BINDING_INVALID', bp,
                `op_arg_bindings.${slot} arg '${argName}' collides with op_bindings.${slot}.${collision} — the targeted operation owns that argument, so this binding is dead config`);
              continue;
            }
            validateConfigArgBinding(binding, bp, 'WORK_ENTITY_SOURCES_OP_ARG_BINDING_INVALID', add);
          }
        }
      }
    }

    // ── source_dependencies ──
    // INPUT deps on unmodeled vendor container entities (Asana workspace, Linear
    // team, a project). Shape-strict when present: unique refs, a list op + id +
    // label, a create op paired with its name arg, `arg_from` refs an EARLIER dep
    // (top-down, no cycles), `binds` non-empty against a declared op slot, and
    // the resolve mode matches the bound op-role (persist→scopes a list; prompt→
    // attributes a write). Op-key/arg existence stays authoring discipline (the
    // decomposed catalog does not expose op args — same posture as op_bindings).
    const sourceDeps = d.source_dependencies;
    if (sourceDeps !== undefined) {
      if (!Array.isArray(sourceDeps)) {
        add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${p}.source_dependencies`,
          'source_dependencies must be an array when present');
      } else {
        const seenRefs = new Set<string>();
        for (let di = 0; di < sourceDeps.length; di++) {
          const dep = sourceDeps[di];
          const dp = `${p}.source_dependencies[${di}]`;
          if (!isObjectRecord(dep)) {
            add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', dp, 'dependency must be an object');
            continue;
          }
          if (!isNonEmptyString(dep.ref)) {
            add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.ref`, 'ref is required');
            continue;
          }
          if (seenRefs.has(dep.ref)) {
            add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.ref`,
              `duplicate dependency ref '${dep.ref}'`);
          }
          if (!isNonEmptyString(dep.list_op)) {
            add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.list_op`,
              'list_op is required — the catalog op that lists the choices');
          } else if (operations !== undefined) {
            // list_op is auto-admitted to `allowed_operations` when the dependency's
            // bound op is granted (the create-assist container read), so it MUST be a
            // READ — a write masquerading as a container list would over-grant.
            const listSpec = Object.prototype.hasOwnProperty.call(operations, dep.list_op)
              ? (operations as Record<string, unknown>)[dep.list_op]
              : undefined;
            if (isObjectRecord(listSpec) && listSpec.risk_tier !== 'read') {
              add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.list_op`,
                `list_op '${dep.list_op}' must be a read-tier operation (it is '${String(listSpec.risk_tier)}') — a container choice-list is a read; the grant substrate auto-admits it`);
            }
          }
          if (!isNonEmptyString(dep.id_field)) {
            add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.id_field`, 'id_field is required');
          }
          if (!isNonEmptyString(dep.label_field)) {
            add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.label_field`, 'label_field is required');
          }
          // create_op ⇔ create_name_arg (a create the substrate cannot name is
          // unusable; a name arg with no create op is dead config).
          if (dep.create_op !== undefined && !isNonEmptyString(dep.create_op)) {
            add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.create_op`,
              'create_op must be a non-empty op key when present');
          } else if (isNonEmptyString(dep.create_op) && !isNonEmptyString(dep.create_name_arg)) {
            add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.create_name_arg`,
              'create_op requires create_name_arg — the create op arg carrying the new entity name');
          }
          if (dep.create_name_arg !== undefined && !isNonEmptyString(dep.create_op)) {
            add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.create_name_arg`,
              'create_name_arg without a create_op is dead config');
          }
          // arg_from — each references an EARLIER dep (top-down; forward/self/
          // cyclic refs are rejected because `seenRefs` only holds prior refs).
          if (dep.arg_from !== undefined) {
            if (!Array.isArray(dep.arg_from)) {
              add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.arg_from`,
                'arg_from must be an array when present');
            } else {
              for (let ai = 0; ai < dep.arg_from.length; ai++) {
                const af = dep.arg_from[ai];
                const afp = `${dp}.arg_from[${ai}]`;
                if (!isObjectRecord(af) || !isNonEmptyString(af.dependency) || !isNonEmptyString(af.arg)) {
                  add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', afp,
                    'arg_from entry needs a non-empty dependency ref + arg');
                  continue;
                }
                if (!seenRefs.has(af.dependency)) {
                  add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${afp}.dependency`,
                    `arg_from references '${af.dependency}', not an EARLIER declared dependency (parents must precede children; no cycles)`);
                }
                // create_arg — the create op's parent-arg key when it differs from
                // the list op's `arg` (Asana lists projects by `query.workspace`,
                // creates one by `body.data.workspace`). Non-empty when present, and
                // dead config without a `create_op` on THIS dependency.
                if (af.create_arg !== undefined) {
                  if (!isNonEmptyString(af.create_arg)) {
                    add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${afp}.create_arg`,
                      'arg_from.create_arg must be a non-empty op arg name when present');
                  } else if (!isNonEmptyString(dep.create_op)) {
                    add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${afp}.create_arg`,
                      'arg_from.create_arg without a create_op on this dependency is dead config');
                  }
                }
              }
            }
          }
          // binds — non-empty, each a declared op slot + arg.
          const boundOps = new Set<string>();
          if (!Array.isArray(dep.binds) || dep.binds.length === 0) {
            add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.binds`,
              'binds must be a non-empty array — where the resolved id flows');
          } else {
            for (let bi = 0; bi < dep.binds.length; bi++) {
              const bind = dep.binds[bi];
              const bpp = `${dp}.binds[${bi}]`;
              if (!isObjectRecord(bind) || !isNonEmptyString(bind.op) || !isNonEmptyString(bind.arg)) {
                add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', bpp,
                  'a bind needs a non-empty op slot + arg');
                continue;
              }
              if (!(WORK_ENTITY_OP_SLOTS as readonly string[]).includes(bind.op)) {
                add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${bpp}.op`,
                  `bind op '${bind.op}' is not a valid op slot (${WORK_ENTITY_OP_SLOTS.join('|')})`);
                continue;
              }
              if (!declaredOps.has(bind.op as WorkEntityOpSlot)) {
                add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${bpp}.op`,
                  `bind op '${bind.op}' is not declared in ops — the id has nowhere to flow`);
              }
              if (bind.wrap_array !== undefined && typeof bind.wrap_array !== 'boolean') {
                add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${bpp}.wrap_array`,
                  'wrap_array must be a boolean when present');
              }
              boundOps.add(bind.op);
            }
          }
          // resolve + role pairing: a `persist` dep scopes the sync walk (must
          // bind list/read); a `prompt` dep attributes a write (must bind a write
          // op). Catches "persist but only binds create" (unresolvable headless).
          if (!(WORK_ENTITY_DEPENDENCY_RESOLVE_MODES as readonly string[]).includes(dep.resolve as string)) {
            add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.resolve`,
              `resolve must be one of ${WORK_ENTITY_DEPENDENCY_RESOLVE_MODES.join('|')}`);
          } else if (boundOps.size > 0) {
            const scopesRead = boundOps.has('list') || boundOps.has('read');
            const attributesWrite = [...boundOps].some((o) => (WORK_ENTITY_WRITE_OP_SLOTS as readonly string[]).includes(o));
            if (dep.resolve === 'persist' && !scopesRead) {
              add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.resolve`,
                "resolve 'persist' is a stored sync-scope selection — it must bind a list/read op");
            }
            if (dep.resolve === 'prompt' && !attributesWrite) {
              add('error', 'WORK_ENTITY_SOURCES_DEPENDENCY_INVALID', `${dp}.resolve`,
                "resolve 'prompt' is create-time — it must bind a write op (create/update/delete/complete)");
            }
          }
          seenRefs.add(dep.ref);
        }
      }
    }

    // ── relationships ──
    if (d.relationships !== undefined) {
      if (!Array.isArray(d.relationships)) {
        add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', `${p}.relationships`,
          'relationships must be an array when present');
      } else {
        const seenLocalFields = new Set<string>();
        for (let r = 0; r < d.relationships.length; r++) {
          const rp = `${p}.relationships[${r}]`;
          const rel = d.relationships[r];
          if (!isObjectRecord(rel)) {
            add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', rp, 'relationship must be an object');
            continue;
          }
          if (!isNonEmptyString(rel.local_field) || !relationshipLocalFields.includes(rel.local_field)) {
            add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', `${rp}.local_field`,
              `local_field must be one of ${relationshipLocalFields.join(', ')} for kind '${kind}'`);
          } else {
            if (seenLocalFields.has(rel.local_field)) {
              add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', `${rp}.local_field`,
                `duplicate relationship for local_field '${rel.local_field}'`);
            }
            seenLocalFields.add(rel.local_field);
            const expectMany = rel.local_field.endsWith('_ids');
            if (rel.cardinality !== (expectMany ? 'many' : 'one')) {
              add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', `${rp}.cardinality`,
                `cardinality must be '${expectMany ? 'many' : 'one'}' for local_field '${rel.local_field}'`);
            }
          }
          if (!isNonEmptyString(rel.remote_field)) {
            add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', `${rp}.remote_field`,
              'remote_field is required');
          }
          if (!isNonEmptyString(rel.target) || !WORK_ENTITY_RELATIONSHIP_TARGET_SET.has(rel.target)) {
            add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', `${rp}.target`,
              'target must be a supported Recued entity family — unsupported domain nouns stay vendor metadata in the extension lane; file rides data.link attachments, never the work graph');
          }
          if (!isNonEmptyString(rel.pairing) || !(WORK_ENTITY_PAIRING_MODES as readonly string[]).includes(rel.pairing)) {
            add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', `${rp}.pairing`,
              `pairing must be one of ${WORK_ENTITY_PAIRING_MODES.join('|')}`);
          } else {
            if (rel.pairing === 'remote_id' && !isNonEmptyString(rel.remote_entity)) {
              add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', `${rp}.remote_entity`,
                "remote_entity is required for pairing 'remote_id' — remote ids are never global");
            }
            // A lookup with no declared key is resolve-by-guessing —
            // the invariant forbids it (Codex review fold). The full
            // scoped target tuple is DERIVED at resolution from the
            // connection + remote_entity + this key.
            if (rel.pairing === 'lookup') {
              if (!isNonEmptyString(rel.lookup_key)
                  || !(WORK_ENTITY_LOOKUP_KEYS as readonly string[]).includes(rel.lookup_key)) {
                add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', `${rp}.lookup_key`,
                  `pairing 'lookup' requires lookup_key (${WORK_ENTITY_LOOKUP_KEYS.join('|')}) — a lookup must declare what resolves it, never guess`);
              }
            } else if (rel.lookup_key !== undefined) {
              add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', `${rp}.lookup_key`,
                "lookup_key is only valid with pairing 'lookup'");
            }
          }
          if (rel.write_back !== false) {
            add('error', 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID', `${rp}.write_back`,
              'write_back must be false — v1 never mutates vendor graph edges (a stricter validator gates any future opt-in)');
          }
        }
      }
    }

    // ── write_policy ──
    const wp = d.write_policy;
    if (mode === 'read_write') {
      if (!isObjectRecord(wp)) {
        add('error', 'WORK_ENTITY_SOURCES_WRITE_POLICY_INVALID', `${p}.write_policy`,
          'write_policy is required for a read_write Source');
      } else {
        // D-192 — `read_before_write` + `post_write_verify` RETIRED 2026-07-14.
        // Both were unbacked: the validator forced each to `true` while the
        // engine did both steps unconditionally and NOTHING read either flag.
        // A knob that cannot change behaviour is not a policy. The behaviours are
        // now enforced by construction (mandatory preflight read; asserting
        // post-write verify), so there is nothing left to declare.
        const cw = wp.conditional_write;
        if (!isNonEmptyString(cw) || !(WORK_ENTITY_CONDITIONAL_WRITE_KINDS as readonly string[]).includes(cw)) {
          add('error', 'WORK_ENTITY_SOURCES_WRITE_POLICY_INVALID', `${p}.write_policy.conditional_write`,
            `conditional_write must be one of ${WORK_ENTITY_CONDITIONAL_WRITE_KINDS.join('|')}`);
        } else if (versionKindNone && cw !== 'none') {
          // D-192 CORE #8c — a version-kind 'none' Source never mints a
          // source_version_token, so a conditional-write strategy is an
          // unsatisfiable promise: the executor could only ever write
          // unconditionally against a declaration that claimed
          // preconditions. Same fail-at-publish posture as the P4b
          // precondition_arg applicability gate.
          add('error', 'WORK_ENTITY_SOURCES_WRITE_POLICY_INVALID', `${p}.write_policy.conditional_write`,
            `conditional_write '${cw}' is unsatisfiable with remote.version.kind 'none' — a tokenless Source must declare conditional_write 'none'; the engine's unconditional read-before-write + asserting post-write verify carry the safety`);
        } else if (cw !== 'none' && isObjectRecord(d.op_bindings)) {
          // D-192 P4b — a declared conditional-write strategy must be
          // APPLICABLE: every write-slot binding present must name the
          // op argument carrying the token, or the executor could only
          // ever write unconditionally against a declaration that
          // promised preconditions (fail closed at publish, not at the
          // first live write).
          for (const slot of ['update', 'complete', 'delete'] as const) {
            const binding = d.op_bindings[slot];
            if (!isObjectRecord(binding)) continue;
            if (!isNonEmptyString(binding.precondition_arg)) {
              add('error', 'WORK_ENTITY_SOURCES_OP_BINDING_INVALID', `${p}.op_bindings.${slot}.precondition_arg`,
                `write_policy.conditional_write is '${cw}' — the ${slot} binding must declare precondition_arg (the op argument carrying the version token)`);
            }
          }
        }
        for (const field of ['stale_write', 'field_conflicts'] as const) {
          const v = wp[field];
          if (!isNonEmptyString(v) || !(WORK_ENTITY_CONFLICT_RESOLUTIONS as readonly string[]).includes(v)) {
            add('error', 'WORK_ENTITY_SOURCES_WRITE_POLICY_INVALID', `${p}.write_policy.${field}`,
              `${field} must be one of ${WORK_ENTITY_CONFLICT_RESOLUTIONS.join('|')}`);
          }
        }
      }
    } else if (wp !== undefined) {
      add('error', 'WORK_ENTITY_SOURCES_WRITE_POLICY_INVALID', `${p}.write_policy`,
        'write_policy is only valid on a read_write Source');
    }
  }
};

/** D-192 §6 — the EMPIRICAL op proof, and the phantom-field capture harness.
 *
 *  The authority ladder (ratified 2026-07-14) made `contract_source` optional and
 *  put an *empirical* op proof where the documentary one used to stand. Its §6
 *  named a vehicle — `backend/server/scripts/verify-remote-byte-fetch.ts` — that
 *  DOES NOT EXIST and never did. The empirical route had no harness. This is it.
 *
 *  ─────────────────────────────────────────────────────────────────────────────
 *  WHAT IT PROVES
 *
 *  Nothing machine-checks a field path (`validate-work-entity-sources.ts:24` says
 *  so outright), and the failure is SILENT: a phantom `remote.version` means the
 *  sync never observes a change and the mirror is stale forever — no error, no
 *  symptom. Every `remote.hash_fields` path phantom and the record hash is a
 *  CONSTANT, so every row reads "unchanged" and the mirror FREEZES.
 *
 *  This harness calls the vendor for real and answers the one question the pinned
 *  doc cannot: **does the API actually return the paths we declared?**
 *
 *  ⭐ It invokes the DECLARED op — the same `default_base_url` + `path_template` +
 *  `static_query`, composed through the adapter's own `composeApiUrl`. That matters:
 *  it is what catches the SPARSE-FIELDSET trap. HubSpot returns only the properties
 *  you ask for, so a hand-rolled request would "prove" fields the real op never
 *  requests. We prove the DECLARATION, not a convenient query.
 *
 *  ─────────────────────────────────────────────────────────────────────────────
 *  ⛔ WHY IT STORES NO VALUES — read before "improving" this
 *
 *  The ladder says "store what it fetched". Taken literally that would commit the
 *  owner's LIVE CRM DATA — task subjects, note bodies, contact associations — into
 *  a PUBLIC AGPL repo, from the very codebase whose promise is that your data stays
 *  local on machines you control. That is not a trade worth making, and it is not
 *  necessary:
 *
 *  🔑 **What makes a capture phantom-proof is its KEY SET, not its values.** A
 *  phantom is a field the API never RETURNS. To refute one you need the KEY to
 *  appear in a real response — the VALUE is irrelevant to the proof. So we emit the
 *  observed key paths, their value TYPES, and presence counts, and elide every
 *  value. The ladder's property survives exactly: a machine-derived key set from a
 *  live response **cannot contain a phantom by construction** — you cannot
 *  hallucinate a key into it.
 *
 *  ⚠ It must stay MACHINE-EMITTED. Hand-editing the artifact silently demotes it to
 *  `hand_written` — the attestation rung with no validation loop at all. The
 *  authoring document records this in its `derivation` field; keep it honest.
 *
 *  ⚠ ABSENCE IS NOT A PHANTOM. An optional field is simply empty on the records we
 *  sampled (a task with no body). So we union across EVERY record the list returns
 *  and report a never-observed declared path as a CANDIDATE phantom to investigate
 *  — never as a proven one, and never as a silent pass. This is the authoring-time
 *  twin of the shipped runtime tally in `work-entity-source-field-health.ts`.
 *
 *  ─────────────────────────────────────────────────────────────────────────────
 *  USAGE
 *
 *      npx tsx backend/server/scripts/verify-source-live.ts hubspot:task
 *      npx tsx backend/server/scripts/verify-source-live.ts hubspot:note --write
 *
 *  Credentials come from the repository rootdev.env` — OUTSIDE git, never committed.
 *  Nothing here prints a secret, and nothing here prints a record value.
 *  `--write` emits the capture artifact; without it the run is a dry report. */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

import type { WorkEntitySourceDeclaration } from '@recued/contracts';
import { composeApiUrl } from '@recued/ingredients/url-template.js';
import { decomposeComposition } from '@recued/ingredient-authoring';

import { KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS } from '../src/work-entity-source-boot.js';
import { declaredLoadBearingPaths } from '../src/work-entity-source-field-health.js';

const REPO = resolve(process.cwd());

// ── Dev credentials ─────────────────────────────────────────────────────────
// Per-vendor because auth genuinely IS per-vendor. This is a DEV HARNESS under
// `scripts/` — the D-192 anti-hardcode invariant (no `switch (vendor)`) binds the
// shared RUNTIME (`work-entity-*.ts`, `packages/`), which stays fully generic. In
// production the connection adapter decrypts the vault credential; here we inject
// a personal token. Auth differs; WHICH FIELDS COME BACK does not — which is the
// only thing this harness attests.
const DEV_AUTH: Record<string, { envs: string[]; header: (v: string) => [string, string] }> = {
  // ⚠ HUBSPOT_SERVICE_KEY, not HUBSPOT_PERSONAL_ACCESS_KEY. The latter is the
  // HubSpot CLI's personal access key and is NOT an API bearer token — it 401s.
  // The private-app token is the `pat-`-prefixed one. Env names lie; formats don't.
  hubspot: { envs: ['HUBSPOT_SERVICE_KEY'], header: (v) => ['authorization', `Bearer ${v}`] },
  linear: { envs: ['LINEAR_API_KEY'], header: (v) => ['authorization', v] },
  todoist: { envs: ['TODOLIST_API_TOKEN'], header: (v) => ['authorization', `Bearer ${v}`] },
  notion: { envs: ['NOTION_PERSONAL_ACCESS_TOKEN'], header: (v) => ['authorization', `Bearer ${v}`] },

  // Azure DevOps takes EITHER credential — try the short-lived one first.
  //
  //   AZURE_DEVOPS_BEARER — a ~1h Entra token, nothing to revoke afterwards:
  //       az login
  //       az account get-access-token \
  //          --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  //          --query accessToken -o tsv
  //     (that GUID is Azure DevOps' fixed resource id — not a secret, not per-tenant)
  //
  //   AZURE_DEVOPS_PAT — a Personal Access Token from
  //       https://dev.azure.com/<org>/_usersSettings/tokens  (scope: Work Items ▸ Read)
  //     ⚠ ADO sends a PAT as HTTP Basic with an EMPTY username — `base64(":" + pat)`.
  //       A bare `Bearer <pat>` 401s, which is the usual first mistake.
  'azure-devops': {
    envs: ['AZURE_DEVOPS_BEARER', 'AZURE_DEVOPS_PAT'],
    header: (v) => (v.includes('.') && v.split('.').length === 3      // a JWT ⇒ from `az`
      ? ['authorization', `Bearer ${v}`]
      : ['authorization', `Basic ${Buffer.from(`:${v}`).toString('base64')}`]),
  },

  // salesforce — needs an org-scoped OAuth access token; dev.env carries none today.
  //   sfdx force:org:display --json | jq -r .result.accessToken   (a sandbox is fine)
  //   ⚠ the org's INSTANCE URL is the base — see DEV_BASE_URL below.
  salesforce: { envs: ['SALESFORCE_ACCESS_TOKEN'], header: (v) => ['authorization', `Bearer ${v}`] },
};

/** Path args a declared op interpolates. In PRODUCTION these bind from CONNECTION
 *  CONFIG via `op_arg_bindings` (azure-devops needs `organization` + `project`).
 *  A dev harness has no connection store, so they come from dev.env — same values,
 *  different source. */
const DEV_PATH_ARGS: Record<string, Record<string, string>> = {
  'azure-devops': { organization: 'AZURE_DEVOPS_ORG', project: 'AZURE_DEVOPS_PROJECT' },
};

/** Some vendors' base URL is per-tenant and cannot be a catalog constant (a
 *  Salesforce org's instance URL). Overrides the catalog `default_base_url`. */
const DEV_BASE_URL: Record<string, string> = {
  salesforce: 'SALESFORCE_INSTANCE_URL',
};

/** Hydration is one gated read PER ROW — bound it. A capture needs enough records to
 *  distinguish "never returned" from "empty on this one", not the whole backlog. */
const HYDRATE_MAX = 25;

const loadDevEnv = (): Record<string, string> => {
  const path = resolve(REPO, '..', 'dev.env');
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
};

// ── Declaration + catalog resolution ────────────────────────────────────────
const packComposition = (packSlug: string): any => {
  const pack = JSON.parse(
    readFileSync(resolve(REPO, 'community', 'packs', `${packSlug}.json`), 'utf8'),
  );
  const content = (pack.contents ?? []).find((c: any) => c.type === 'composition');
  if (!content) throw new Error(`pack ${packSlug} carries no composition`);
  return content.composition;
};

const resolveCatalog = (packSlug: string): any => {
  const composition = packComposition(packSlug);
  const decomposed = (decomposeComposition as any)[composition.schema_version](composition);
  if (!decomposed.catalog) throw new Error(`pack ${packSlug} decomposed to no catalog`);
  return decomposed.catalog;
};

/** Kernel declarations first (hubspot / salesforce / microsoft), then the pack's
 *  own `work_entity_sources[]`. Exactly the two homes `desiredWorkEntitySourcesFor`
 *  reads from at boot. */
const resolveDeclaration = (vendor: string, kind: string): WorkEntitySourceDeclaration => {
  const kernel = (KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS[vendor] ?? []).find((d) => d.kind === kind);
  if (kernel) return kernel;
  const composition = packComposition(vendor);
  const decl = (composition.work_entity_sources ?? []).find((d: any) => d.kind === kind);
  if (!decl) throw new Error(`no ${kind} Source declared for ${vendor} (kernel or pack)`);
  return decl as WorkEntitySourceDeclaration;
};

// ── The declared field surface ──────────────────────────────────────────────
/** Every remote path the declaration READS. Wider than the shipped runtime tally
 *  (`declaredLoadBearingPaths`), which deliberately excludes `projection.canonical.*`
 *  as runtime noise — a legitimately-empty `due_at` is not an anomaly worth alerting
 *  on. At AUTHORING time the canonical paths are exactly the question, so we include
 *  them and mark which are load-bearing. */
type DeclaredPath = { path: string; roles: string[]; load_bearing: boolean };

const declaredCapturePaths = (d: any): DeclaredPath[] => {
  const loadBearing = new Set(declaredLoadBearingPaths(d).map((p: any) => p.path));
  const out = new Map<string, DeclaredPath>();
  // One path routinely serves SEVERAL roles (HubSpot's `hs_task_subject` is both a
  // hash field and canonical.title). Collect them all — a reader must be able to see
  // what breaks if the path turns out to be a phantom, and "hash" alone hides that
  // the title would fail the row closed too.
  const add = (path: unknown, role: string) => {
    if (typeof path !== 'string' || path === '') return;
    const prior = out.get(path);
    if (prior) { if (!prior.roles.includes(role)) prior.roles.push(role); return; }
    out.set(path, { path, roles: [role], load_bearing: loadBearing.has(path) });
  };

  add(d.remote?.id, 'id');
  add(d.remote?.version?.field, 'version');
  for (const f of d.remote?.hash_fields ?? []) add(f, 'hash');
  if (d.sync?.tombstones === 'native') add(d.sync?.tombstone_field, 'tombstone');

  // canonical: a scalar path, an ordered coalesce ARRAY (CORE #8d), or a derive
  // object (#8c number_equals / #8e transform) — each names remote path(s).
  for (const [key, v] of Object.entries(d.projection?.canonical ?? {})) {
    if (typeof v === 'string') add(v, `canonical.${key}`);
    else if (Array.isArray(v)) for (const c of v) add(c, `canonical.${key}`);
    else if (v && typeof v === 'object') add((v as any).field, `canonical.${key}`);
  }
  for (const [key, v] of Object.entries(d.projection?.preview ?? {})) {
    add((v as any)?.field, `preview.${key}`);
  }
  return [...out.values()];
};

// ── Observation ─────────────────────────────────────────────────────────────
const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/** Flatten a record to `path -> type`. VALUES ARE NEVER READ OUT — only their
 *  presence and their type. Arrays collapse to the key (we do not index into them:
 *  an index is not a schema). */
const observePaths = (obj: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> => {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix === '' ? k : `${prefix}.${k}`;
    out.set(path, typeOf(v));
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) observePaths(v, path, out);
  }
  return out;
};

const atPath = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((a, k) => (a == null ? undefined : (a as any)[k]), obj);

// ── Main ────────────────────────────────────────────────────────────────────
const main = async (): Promise<void> => {
  const [target, ...flags] = process.argv.slice(2);
  const write = flags.includes('--write');
  if (!target || !target.includes(':')) {
    console.error('usage: verify-source-live.ts <vendor>:<kind> [--write]   e.g. hubspot:task');
    process.exit(2);
  }
  const [vendor, kind] = target.split(':');

  const auth = DEV_AUTH[vendor];
  if (!auth) {
    console.error(`\n⛔ No dev credential wired for "${vendor}".`);
    console.error(`   This is NOT a code gap — dev.env simply carries no ${vendor} token.`);
    console.error(`   Add one to DEV_AUTH + dev.env, then re-run. Until a REAL response is`);
    console.error(`   captured, the Source stays honestly phantom_guarded: false.`);
    process.exit(3);
  }
  const env = loadDevEnv();
  // Report WHICH credential is in play. `envs` is ordered, so a stale first entry silently
  // wins over a good second one — and the failure then looks like a vendor problem rather
  // than a config one. Never a mystery: say it out loud. (The value is never printed.)
  const credEnv = auth.envs.find((e) => env[e]);
  const secret = credEnv ? env[credEnv] : undefined;
  if (!secret) {
    console.error(`⛔ dev.env carries none of: ${auth.envs.join(', ')}`);
    process.exit(3);
  }
  if (auth.envs.length > 1) {
    const others = auth.envs.filter((e) => e !== credEnv && env[e]);
    console.log(`\n🔑 credential: ${credEnv}${others.length ? `  (also present, NOT used: ${others.join(', ')})` : ''}`);
  }

  // ⚠ The Azure DevOps ORGANIZATION is a NAME, not a GUID — and the mistake is very easy to
  // make, because `az` hands you a token whose `tid` claim IS a GUID sitting right there. An
  // Entra tenant / directory id is NOT an ADO org: the org is the slug in
  // `https://dev.azure.com/<organization>`, and it must be created at dev.azure.com before it
  // exists at all (having an Azure subscription does not create one). Caught here rather than
  // as a bewildering 404 twelve lines into a WIQL POST.
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const [slot, envName] of Object.entries(DEV_PATH_ARGS[vendor] ?? {})) {
    const v = env[envName];
    if (v && GUID.test(v)) {
      console.error(`\n⛔ ${envName}="${v}" is a GUID.`);
      console.error(`   A ${vendor} ${slot} is a NAME, not an id — the slug in the vendor's own URL.`);
      console.error(`   If you copied this from \`az\`, it is your Entra TENANT/DIRECTORY id, which is`);
      console.error(`   a different thing entirely. An Azure subscription does NOT give you an Azure`);
      console.error(`   DevOps organization; create one at https://aex.dev.azure.com, then use its name.`);
      process.exit(3);
    }
  }

  const decl: any = resolveDeclaration(vendor, kind);
  const catalog = resolveCatalog(vendor);
  const api = catalog.surfaces?.api ?? {};
  const listOp = api.executes?.[decl.ops.list];
  if (!listOp) throw new Error(`catalog has no op ${decl.ops.list}`);

  const [hk, hv] = auth.header(secret);

  /** Invoke ONE declared op exactly as the adapter would: base + path_template
   *  (with `{{arg}}` slots filled) + static_query + static_headers + static_body.
   *
   *  ⚠ `result_path` is PER-OP FIRST, surface default second. HubSpot declares it
   *  only on the surface (`results`); Azure DevOps declares it on the op
   *  (`workItems`) and leaves the surface undefined. Reading only the surface
   *  silently yielded zero rows for ADO — a bug this harness had until 2026-07-14. */
  const invoke = async (opName: string, args: Record<string, string> = {}) => {
    const op = api.executes?.[opName];
    if (!op) throw new Error(`catalog has no op ${opName}`);
    const path = String(op.path_template).replace(/\{\{(\w+)\}\}/g, (_m, k) => {
      const v = args[k] ?? env[(DEV_PATH_ARGS[vendor] ?? {})[k] ?? ''];
      if (!v) {
        throw new Error(
          `op ${opName} needs path arg {{${k}}}. In production it binds from CONNECTION CONFIG `
          + `(op_arg_bindings). For this dev harness, set ${(DEV_PATH_ARGS[vendor] ?? {})[k] ?? `<${k}>`} in dev.env.`,
        );
      }
      return encodeURIComponent(v);
    });
    const base = env[DEV_BASE_URL[vendor] ?? ''] ?? api.default_base_url;
    const url = composeApiUrl(base, path);
    for (const [k, v] of Object.entries(op.static_query ?? {})) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method: op.method,
      headers: { [hk]: hv, accept: 'application/json', ...(op.static_headers ?? {}) },
      ...(op.static_body ? { body: JSON.stringify(op.static_body) } : {}),
    });
    if (!res.ok) {
      console.error(`⛔ ${op.method} ${url.pathname} → ${res.status} ${res.statusText} — the op did NOT prove. (No secret printed.)`);
      process.exit(1);
    }
    // ⚠ Azure DevOps does NOT 401 an unauthenticated call — it 302s to a sign-in PAGE, and
    // `fetch` follows redirects by default, so the response arrives as a cheerful 200 OK
    // full of HTML. `res.ok` is TRUE and the next line explodes on `<!DOCTYPE`. Check the
    // content type, or the failure surfaces as an inscrutable JSON parse error instead of
    // the one fact that matters: the credential is not valid for this org.
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('json')) {
      console.error(`⛔ ${op.method} ${url.pathname} → ${res.status} but content-type is "${ctype.split(';')[0]}", not JSON.`);
      console.error(`   That is a SIGN-IN PAGE: the credential did not authenticate to this org.`);
      console.error(`   Azure DevOps redirects rather than returning 401 — a 200 here means nothing.\n`);
      // Describe the credential's SHAPE (never its value). A wrong-shaped secret is the most
      // common cause and the one you cannot see by staring at dev.env — the value is opaque,
      // so "it's 85 chars and has an '=' in it" is the whole diagnosis.
      console.error(`   credential in use: ${credEnv} — length ${secret.length}, charset:`
        + ` ${/^[A-Za-z0-9]+$/.test(secret) ? 'alphanumeric' : 'NON-alphanumeric'}`);
      if (vendor === 'azure-devops' && credEnv === 'AZURE_DEVOPS_PAT'
          && !(secret.length === 52 && /^[A-Za-z0-9]+$/.test(secret))) {
        console.error(`   🔴 THAT IS NOT AN AZURE DEVOPS PAT. A real one is exactly 52 characters,`);
        console.error(`      letters and digits ONLY — no '=', no symbols. Whatever is in dev.env is`);
        console.error(`      some other secret. Re-copy it from <org> ▸ User settings ▸ Personal access`);
        console.error(`      tokens (it is shown exactly once).`);
      }
      console.error(`   ⚠ Other common cause: an \`az\` token is issued for an ENTRA TENANT, but an org`);
      console.error(`     created under a personal Microsoft account is backed by the MSA directory —`);
      console.error(`     the two do not line up. A PAT is issued BY THE ORG and sidesteps that.`);
      console.error(`   ▶ Confirm your real org name at https://aex.dev.azure.com — it lists YOUR orgs.`);
      process.exit(1);
    }
    const body = await res.json();
    // `result_path` lives on the OPERATION (`catalog.operations[op]`), NOT on the execute
    // binding (`surfaces.api.executes[op]`) — the decomposer keeps them apart. Per-op first,
    // surface default second. The two live vendors sit on OPPOSITE sides of this:
    //   azure-devops  operations['work_item.assigned_to_me.list'].result_path = 'workItems'
    //   hubspot       surfaces.api.result_path                                = 'results'
    // Reading the binding finds NEITHER. The surface fallback made HubSpot work by luck,
    // while ADO silently yielded zero rows and printed "seed a record in the vendor" — which
    // was a LIE: the records were there, we were looking in the wrong place. An empty result
    // must never be reported as an empty VENDOR.
    const rp = catalog.operations?.[opName]?.result_path ?? api.result_path;
    const rows = rp ? atPath(body, rp) : body;
    return { op, url, rows, rp };
  };

  console.log(`\n▶ ${vendor}:${kind} — invoking the DECLARED op ${decl.ops.list}`);
  const list = await invoke(decl.ops.list);
  console.log(`  ${list.op.method} ${list.url.pathname}${list.url.search}`);
  if (list.op.static_body) console.log(`  body: ${JSON.stringify(list.op.static_body).slice(0, 140)}…`);
  console.log(`  (the op's OWN query/body — this is what catches the sparse-fieldset trap)\n`);

  let records = Array.isArray(list.rows) ? list.rows : [];
  if (records.length === 0) {
    console.error(`⛔ list returned 0 records at result_path "${list.rp}".`);
    console.error(`   The ops are proven REACHABLE but NOTHING is attested about the fields.`);
    console.error(`   Seed a record in the vendor and re-run — do NOT record a capture from this.`);
    process.exit(1);
  }

  // ── Reference lists must be HYDRATED, or every field reads as never-observed ──
  //
  // `sync.list_rows: 'reference'` means the list returns identity ONLY (Azure DevOps'
  // WIQL yields `{id, url}` rows). The real fields arrive on the declared READ op. A
  // harness that captured the list alone would honestly report every `System.*` path
  // as never-observed — a SHAPE ARTEFACT, not a phantom — and someone would chase it.
  // So mirror the engine (work-entity-source-sync.ts: hydration, CORE #8b) and read.
  let hydrated = false;
  if (decl.sync?.list_rows === 'reference') {
    hydrated = true;
    const idArg = decl.op_bindings?.read?.id_arg;
    if (!idArg) throw new Error(`reference list needs op_bindings.read.id_arg`);
    const ids = records
      .map((r) => atPath(r, decl.remote.id))
      .filter((v) => v !== undefined && v !== null)
      .slice(0, HYDRATE_MAX);
    console.log(`  ⤷ list_rows: 'reference' — hydrating ${ids.length} of ${records.length} row(s) through ${decl.ops.read}`);
    console.log(`    (identity-only rows; the declared fields live on the READ response)\n`);
    const full: unknown[] = [];
    for (const id of ids) {
      const r = await invoke(decl.ops.read, { [idArg]: String(id) });
      full.push(r.rows);                                    // a read returns ONE record
    }
    records = full;
  }

  // Union the key set across EVERY record — absence on one record is not a phantom.
  const seen = new Map<string, { type: string; present: number }>();
  for (const rec of records) {
    for (const [path, type] of observePaths(rec)) {
      const prior = seen.get(path);
      if (prior) prior.present += 1;
      else seen.set(path, { type, present: 1 });
    }
  }

  const declared = declaredCapturePaths(decl);
  const missing = declared.filter((d) => !seen.has(d.path));

  console.log(`✅ ${records.length} live record(s); ${seen.size} distinct key paths observed.\n`);
  console.log(`── Declared paths ─────────────────────────────────────────────`);
  for (const d of declared) {
    const o = seen.get(d.path);
    const mark = o ? '✅' : '🔴';
    const lb = d.load_bearing ? ' [load-bearing]' : '';
    const count = o ? `${o.present}/${records.length} · ${o.type}` : 'NEVER OBSERVED';
    console.log(`  ${mark} ${d.path.padEnd(34)} ${d.roles.join('+').padEnd(26)} ${count}${lb}`);
  }

  if (missing.length > 0) {
    console.log(`\n⚠  ${missing.length} declared path(s) never observed — CANDIDATE PHANTOMS.`);
    console.log(`   Not proven phantoms: an optional field is simply empty on these records.`);
    console.log(`   Investigate each. A never-observed load-bearing path is the dangerous one`);
    console.log(`   (version ⇒ stale forever; ALL hash fields ⇒ the mirror FREEZES).`);
  }

  if (!write) {
    console.log(`\n(dry run — pass --write to emit the capture artifact)`);
    return;
  }

  const out = {
    _capture: {
      source_id: decl.source_id_template,
      kind,
      op: decl.ops.list,
      method: listOp.method,
      path: listOp.path_template,
      static_query: listOp.static_query ?? {},
      records_observed: records.length,
      derivation:
        `Machine-emitted by backend/server/scripts/verify-source-live.ts from a LIVE ${vendor} `
        + `API response, invoking the DECLARED op (base + path_template + static_query composed `
        + `through the adapter's own composeApiUrl). Re-derive: `
        + `npx tsx backend/server/scripts/verify-source-live.ts ${vendor}:${kind} --write`,
      elided:
        'VALUES ARE ELIDED. This file records only WHICH KEYS the live API returned, their value '
        + 'types, and how many sampled records carried each. It contains ZERO user data by '
        + 'construction — and it does not need any: a phantom is a field the API never RETURNS, so '
        + 'refuting one needs the KEY, never the VALUE. Do not hand-edit: a hand-written artifact '
        + 'is attestation rung `hand_written`, which has no validation loop at all.',
    },
    declared_paths: Object.fromEntries(
      declared.map((d) => {
        const o = seen.get(d.path);
        return [d.path, {
          roles: d.roles,
          load_bearing: d.load_bearing,
          observed: o !== undefined,
          ...(o ? { type: o.type, present_in: o.present, of: records.length } : {}),
        }];
      }),
    ),
    observed_paths: Object.fromEntries(
      [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([p, o]) => [p, { type: o.type, present_in: o.present, of: records.length }]),
    ),
  };

  const file = resolve(REPO, 'docs', 'sources', 'captures', `${vendor}-${kind}.capture.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`\n📄 wrote ${file.replace(REPO, '.')}`);
  console.log(`   Values elided. Safe to commit.`);
};

main().catch((e) => {
  console.error(`⛔ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

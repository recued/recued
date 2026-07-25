/** D-118 Phase 8 — service template loader.
 *
 *  Reads `kind: 'service'` ingredient manifests out of the
 *  `ManifestRegistry`, flattens each `input.service.*` block into
 *  the dispatcher-friendly `ServiceTemplate` shape, and exposes a
 *  `ServiceTemplateResolver` the Phase 7 enroll handlers + Phase 6
 *  `ServiceBundleResolver` consume.
 *
 *  template_slug grammar: `<slug>` or `<slug>@<version>`. The
 *  `@<version>` pin is informational at this layer — the resolver
 *  strips it before looking up the manifest. Marketplace install
 *  policy enforces version pinning; the runtime just routes by slug.
 *
 *  Caps derive deterministically from the manifest shape (per spec
 *  line 414): `install/upgrade/uninstall` arrays present → caps:
 *  'yes'; `start/stop` non-null → caps: 'yes'; `invoke` map keys →
 *  caps.invoke list; `health_check` kind → caps.health. Cached
 *  per-template at parse time so callers never re-walk. */

import type { IngredientManifest } from '@recued/contracts';
import type {
  ServiceCheckKind,
  ServiceCollectionCaps,
  ServiceRestartPolicy,
} from '@recued/contracts';
import {
  SERVICE_CHECK_KINDS,
  SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  SERVICE_RESTART_POLICIES,
  SERVICE_STARTUP_GRACE_MS_DEFAULT,
} from '@recued/contracts';

import type { ServiceTemplate, ServiceTemplateResolver } from './enroll.js';
import { isPrototypeSensitiveKey, setSafeKey } from './key-safety.js';
import type {
  BundleStartSpec,
  BundleStopSpec,
  ConfigFieldSchema,
  InvokeFieldSchema,
  ExposeSpec,
  InvokeOpSpec,
} from './dispatcher/types.js';

interface RawManifest {
  slug?: unknown;
  kind?: unknown;
  author?: unknown;
  input?: { service?: unknown } & Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isServiceManifest = (raw: unknown): raw is RawManifest => {
  if (!isRecord(raw)) return false;
  if ((raw as RawManifest).kind !== 'service') return false;
  const input = (raw as RawManifest).input;
  return isRecord(input) && isRecord(input.service);
};

const parseStartSpec = (raw: unknown): BundleStartSpec | null => {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return null;
  const argv = Array.isArray(raw.argv) ? raw.argv.filter((v): v is string => typeof v === 'string') : [];
  if (argv.length === 0) return null;
  const spec: BundleStartSpec = { argv };
  if (isRecord(raw.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v === 'string') setSafeKey(env, k, v);
    }
    spec.env = env;
  }
  if (typeof raw.cwd === 'string') spec.cwd = raw.cwd;
  if (typeof raw.detach === 'boolean') spec.detach = raw.detach;
  if (
    typeof raw.restart_policy === 'string' &&
    (SERVICE_RESTART_POLICIES as readonly string[]).includes(raw.restart_policy)
  ) {
    spec.restart_policy = raw.restart_policy as ServiceRestartPolicy;
  }
  if (typeof raw.restart_on_server_start === 'boolean') {
    spec.restart_on_server_start = raw.restart_on_server_start;
  }
  return spec;
};

const parseStopSpec = (raw: unknown): BundleStopSpec | null => {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return null;
  const spec: BundleStopSpec = {};
  if (typeof raw.signal === 'string') spec.signal = raw.signal as NodeJS.Signals;
  if (typeof raw.grace_ms === 'number' && Number.isFinite(raw.grace_ms)) {
    spec.grace_ms = raw.grace_ms;
  }
  if (Array.isArray(raw.argv)) {
    const argv = raw.argv.filter((v): v is string => typeof v === 'string');
    if (argv.length > 0) spec.argv = argv;
  }
  return spec;
};

const parseInvokeMap = (raw: unknown): Record<string, InvokeOpSpec> => {
  if (!isRecord(raw)) return {};
  const out: Record<string, InvokeOpSpec> = {};
  for (const [op, value] of Object.entries(raw)) {
    if (isPrototypeSensitiveKey(op)) continue;
    if (!isRecord(value)) continue;
    const argv = Array.isArray(value.argv)
      ? value.argv.filter((v): v is string => typeof v === 'string')
      : [];
    if (argv.length === 0) continue;
    const spec: InvokeOpSpec = {
      argv,
      timeout_ms: typeof value.timeout_ms === 'number' ? value.timeout_ms : 30_000,
      input: parseInvokeInput(value.input),
      output: parseStringMap(value.output),
    };
    if (Array.isArray(value.exit_codes_ok)) {
      spec.exit_codes_ok = value.exit_codes_ok.filter(
        (n): n is number => typeof n === 'number',
      );
    }
    if (isRecord(value.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(value.env)) {
        if (typeof v === 'string') setSafeKey(env, k, v);
      }
      spec.env = env;
    }
    if (typeof value.cwd === 'string') spec.cwd = value.cwd;
    setSafeKey(out, op, spec);
  }
  return out;
};

const parseInvokeInput = (raw: unknown): Record<string, InvokeFieldSchema> => {
  if (!isRecord(raw)) return {};
  const out: Record<string, InvokeFieldSchema> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (isPrototypeSensitiveKey(field)) continue;
    if (!isRecord(value)) continue;
    const type = value.type;
    if (
      typeof type !== 'string' ||
      !['string', 'number', 'boolean', 'enum', 'file_ref', 'url'].includes(type)
    ) {
      continue;
    }
    const entry: InvokeFieldSchema = { type: type as InvokeFieldSchema['type'] };
    if (typeof value.required === 'boolean') entry.required = value.required;
    if (Array.isArray(value.values)) {
      entry.values = value.values.filter((v): v is string => typeof v === 'string');
    }
    if (typeof value.allow_flag_like === 'boolean') entry.allow_flag_like = value.allow_flag_like;
    if (typeof value.write === 'boolean') entry.write = value.write;
    setSafeKey(out, field, entry);
  }
  return out;
};

const parseStringMap = (raw: unknown): Record<string, string> => {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') setSafeKey(out, key, value);
  }
  return out;
};

const parseConfigSchema = (raw: unknown): Record<string, ConfigFieldSchema> => {
  if (!isRecord(raw)) return {};
  const out: Record<string, ConfigFieldSchema> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (isPrototypeSensitiveKey(field)) continue;
    if (!isRecord(value)) continue;
    const type = value.type;
    if (
      typeof type !== 'string' ||
      !['string', 'number', 'boolean', 'enum', 'file_ref', 'vault_ref'].includes(type)
    ) {
      continue;
    }
    const entry: ConfigFieldSchema = { type: type as ConfigFieldSchema['type'] };
    if (typeof value.public === 'boolean') entry.public = value.public;
    if (typeof value.optional === 'boolean') entry.optional = value.optional;
    if (value.default !== undefined) entry.default = value.default;
    if (Array.isArray(value.values)) {
      entry.values = value.values.filter((v): v is string => typeof v === 'string');
    }
    setSafeKey(out, field, entry);
  }
  return out;
};

const parseExposes = (raw: unknown): Record<string, ExposeSpec> => {
  if (!isRecord(raw)) return {};
  const out: Record<string, ExposeSpec> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isPrototypeSensitiveKey(key)) continue;
    if (!isRecord(value)) continue;
    const entry: ExposeSpec = {};
    if (typeof value.template === 'string') entry.template = value.template;
    if (typeof value.source === 'string') entry.source = value.source;
    if (entry.template !== undefined || entry.source !== undefined) setSafeKey(out, key, entry);
  }
  return out;
};

const deriveCaps = (service: Record<string, unknown>): ServiceCollectionCaps => {
  const installArr = Array.isArray(service.install) ? service.install : null;
  const upgradeArr = Array.isArray(service.upgrade) ? service.upgrade : null;
  const uninstallArr = Array.isArray(service.uninstall) ? service.uninstall : null;
  const installHint = typeof service.install_hint === 'string' && service.install_hint.length > 0;
  const lifecycle = isRecord(service.lifecycle) ? service.lifecycle : {};
  const start = lifecycle.start;
  const stop = lifecycle.stop;
  const invoke = parseInvokeMap(lifecycle.invoke);
  const healthCheck = isRecord(service.health_check) ? service.health_check : null;
  let health: ServiceCollectionCaps['health'] = 'none';
  if (healthCheck !== null) {
    const kind = healthCheck.kind;
    if (kind === 'install_check') {
      health = 'install_check';
    } else if (
      typeof kind === 'string' &&
      (SERVICE_CHECK_KINDS as readonly string[]).includes(kind)
    ) {
      health = kind as ServiceCheckKind;
    }
  }
  const restartPolicy =
    isRecord(start) &&
    typeof start.restart_policy === 'string' &&
    (SERVICE_RESTART_POLICIES as readonly string[]).includes(start.restart_policy)
      ? (start.restart_policy as ServiceRestartPolicy)
      : 'on-crash';
  return {
    install:
      installArr !== null && installArr.length > 0
        ? 'yes'
        : installHint
          ? 'hint_only'
          : 'no',
    upgrade: upgradeArr !== null && upgradeArr.length > 0 ? 'yes' : 'no',
    uninstall: uninstallArr !== null && uninstallArr.length > 0 ? 'yes' : 'no',
    start: isRecord(start) ? 'yes' : 'no',
    stop: isRecord(stop) ? 'yes' : 'no',
    invoke: Object.keys(invoke),
    health,
    restart: restartPolicy,
  };
};

const versionSuffix = (version: unknown): string => {
  if (typeof version === 'number' && Number.isFinite(version)) return `@${version}`;
  return '';
};

/** Parse a raw IngredientManifest (or a record with the same shape)
 *  into a `ServiceTemplate`. Returns null when the manifest isn't
 *  service-shaped. Loose validation — anything malformed defaults to
 *  the safest variant rather than throwing. */
export const parseServiceTemplate = (raw: unknown): ServiceTemplate | null => {
  if (!isServiceManifest(raw)) return null;
  const slug = typeof raw.slug === 'string' ? raw.slug : null;
  if (!slug) return null;
  const author = typeof raw.author === 'string' ? raw.author : 'recued';
  const service = (raw.input!.service as Record<string, unknown>);
  const platform = service.platform;
  if (platform !== 'macos' && platform !== 'linux' && platform !== 'windows') {
    return null;
  }
  const variant_group =
    typeof service.variant_group === 'string' ? service.variant_group : slug;
  const lifecycle = isRecord(service.lifecycle) ? service.lifecycle : {};
  const binary_version = typeof service.binary_version === 'string' && service.binary_version.length > 0
    ? service.binary_version
    : null;
  return {
    template_slug: `${slug}${versionSuffix((raw as { version?: unknown }).version)}`,
    binary_version,
    publisher_id: author,
    platform,
    variant_group,
    caps: deriveCaps(service),
    install_check: isRecord(service.install_check)
      ? (service.install_check as Record<string, unknown>)
      : { kind: 'binary_in_path', binary: '' },
    install_hint: typeof service.install_hint === 'string' ? service.install_hint : null,
    install: Array.isArray(service.install)
      ? (service.install as ServiceTemplate['install'])
      : null,
    upgrade: Array.isArray(service.upgrade)
      ? (service.upgrade as ServiceTemplate['upgrade'])
      : null,
    uninstall: Array.isArray(service.uninstall)
      ? (service.uninstall as ServiceTemplate['uninstall'])
      : null,
    health_check: isRecord(service.health_check)
      ? (service.health_check as Record<string, unknown>)
      : null,
    startup_check: Array.isArray(service.startup_check)
      ? (service.startup_check as Record<string, unknown>[])
      : null,
    startup_grace_ms:
      typeof service.startup_grace_ms === 'number'
        ? service.startup_grace_ms
        : SERVICE_STARTUP_GRACE_MS_DEFAULT,
    health_check_interval_ms: Math.max(
      typeof service.health_check === 'object' &&
        service.health_check !== null &&
        typeof (service.health_check as Record<string, unknown>).interval_ms === 'number'
        ? ((service.health_check as Record<string, unknown>).interval_ms as number)
        : SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
      SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
    ),
    config_schema: parseConfigSchema(service.config_schema),
    exposes: parseExposes(service.exposes),
    start: parseStartSpec(lifecycle.start),
    stop: parseStopSpec(lifecycle.stop),
    invoke: parseInvokeMap(lifecycle.invoke),
  };
};

/** Walk a `ManifestRegistry` and build a `ServiceTemplateResolver`
 *  keyed by ingredient slug. The resolver strips the `@<version>`
 *  pin from queries before lookup so recipe authors can pin
 *  templates without forcing the runtime to enumerate every
 *  version. */
export const buildServiceTemplateResolver = (
  manifests: { slugs(): string[]; get(slug: string): IngredientManifest | null },
): ServiceTemplateResolver => {
  const cache = new Map<string, ServiceTemplate>();
  for (const slug of manifests.slugs()) {
    const manifest = manifests.get(slug);
    if (!manifest) continue;
    const template = parseServiceTemplate(manifest as unknown);
    if (template) cache.set(slug, template);
  }
  return {
    get: (template_slug: string): ServiceTemplate | null => {
      const at = template_slug.indexOf('@');
      const baseSlug = at >= 0 ? template_slug.slice(0, at) : template_slug;
      const cached = cache.get(baseSlug);
      if (!cached) return null;
      // Echo the user-supplied template_slug so the durable row
      // captures the requested pin verbatim, even though the runtime
      // doesn't enforce it.
      return {
        ...cached,
        template_slug: template_slug || cached.template_slug,
      };
    },
    list: (): ServiceTemplate[] => [...cache.values()],
  };
};

/** D-261 follow-on — a human phrase for a catalog operation, composed from the
 *  identifier the operation already has.
 *
 *  🔑 THE WORDS ARE ALREADY THERE. `recued-core/salesforce-catalog.opportunity.delete`
 *  contains the vendor, the entity and the verb; an owner ask that prints the raw
 *  id is withholding English it is already holding. This composes rather than
 *  invents — no authored label, and nothing lifted out of `OperationSpec.description`,
 *  which is publisher-facing prose about gateway routing and path templates and
 *  reads badly when truncated into a label.
 *
 *  ⚠ MEASURED, NOT ASSUMED, over the 26,491 shipped catalog operations:
 *    · 20,221 (76%) are `entity.action`; of those 79% have an action starting
 *      with a known verb — 60% of ALL ops compose.
 *    · the rest are single-token blobs (`post_hiring_applications_search`),
 *      3+ segments, or noun-led (`indices.*`, `ml.*`, `service.*`).
 *  A closed verb list matching the WHOLE action reached only 16%, because the
 *  long tail is snake_case phrases — `delete_webhook`, `get_all_properties_for_
 *  a_resource` — which already read as English once the underscores go.
 *
 *  ⛔ FALLING BACK IS FREE, WHICH IS WHY THE VERB LIST STAYS CLOSED. An
 *  unrecognised shape returns the exact `operation_id` — precisely what these
 *  asks print today — so a miss costs nothing and a wrong guess ("Version a
 *  Salesforce opportunity", "Current a…") would cost the owner's trust in the
 *  sentence. Never widen this list to make coverage look better. */

/** Action heads that read as imperatives. Composition happens only for these;
 *  everything else keeps the exact id. */
const OPERATION_VERBS = new Set([
  'search', 'read', 'create', 'update', 'delete', 'list', 'get', 'count', 'query', 'send',
  'upsert', 'add', 'cancel', 'remove', 'archive', 'download', 'upload', 'move', 'copy',
  'assign', 'complete', 'fetch', 'find', 'set', 'start', 'stop', 'close', 'open', 'submit',
  'approve', 'reject', 'sync', 'import', 'export', 'enable', 'disable', 'rename', 'duplicate',
  'restore', 'check', 'show', 'retrieve', 'transfer', 'post', 'put', 'patch',
]);

const words = (segment: string): string[] => segment.split('_').filter(Boolean);

/** How a catalog slug's word is written where capitalising its first letter
 *  gets it wrong: `hubspot` is "HubSpot", not "Hubspot"; `api` is "API".
 *
 *  ⚠ MEASURED, NOT RECALLED: each entry is how a shipped pack's own name writes
 *  that word of its catalog's slug (119 words over 896 catalogs, 2026-10-19, no
 *  two packs disagreeing). `operation-phrase-pack-names.test.ts` measures it
 *  again from the packs, so a new pack whose name spells a word this list lacks
 *  fails there rather than reaching an approval as "Hubspot". */
const CATALOG_WORD_CASING: Readonly<Record<string, string>> = {
  ai: 'AI', api: 'API', aps: 'APS', assemblyai: 'AssemblyAI', bamboohr: 'BambooHR',
  bigcommerce: 'BigCommerce', bigquery: 'BigQuery', bim: 'BIM', circleci: 'CircleCI',
  clamav: 'ClamAV', cli: 'CLI', clickhouse: 'ClickHouse', clickpipes: 'ClickPipes',
  clickstack: 'ClickStack', clickup: 'ClickUp', cockroachdb: 'CockroachDB', crm: 'CRM',
  csvcut: 'CSVCut', csvgrep: 'CSVGrep', csvkit: 'CSVKit', csvstat: 'CSVStat',
  deeptutor: 'DeepTutor', devops: 'DevOps', dig: 'DiG', digitalocean: 'DigitalOcean',
  dns: 'DNS', docusign: 'DocuSign', e2b: 'E2B', edgar: 'EDGAR', elevenlabs: 'ElevenLabs',
  emsc: 'EMSC', eslint: 'ESLint', exiftool: 'ExifTool', ffmpeg: 'FFmpeg',
  ffprobe: 'FFprobe', finops: 'FinOps', freshbooks: 'FreshBooks', gitbook: 'GitBook',
  github: 'GitHub', gitlab: 'GitLab', gocardless: 'GoCardless', gpg: 'GPG', hibob: 'HiBob',
  hris: 'HRIS', hubspot: 'HubSpot', imagemagick: 'ImageMagick', it: 'IT', itam: 'ITAM',
  jpegoptim: 'JPEGOptim', launchdarkly: 'LaunchDarkly', libreoffice: 'LibreOffice',
  lp: 'LP', markitdown: 'MarkItDown', mcp: 'MCP', mediainfo: 'MediaInfo',
  mongodb: 'MongoDB', musicbrainz: 'MusicBrainz', mutool: 'MuTool', ocrmypdf: 'OCRmyPDF',
  officecli: 'OfficeCLI', onedrive: 'OneDrive', onesignal: 'OneSignal', openai: 'OpenAI',
  opencode: 'OpenCode', openrouter: 'OpenRouter', opensky: 'OpenSky', openssl: 'OpenSSL',
  openstreetmap: 'OpenStreetMap', osv: 'OSV', oxipng: 'OxiPNG', pagerduty: 'PagerDuty',
  pandadoc: 'PandaDoc', paypal: 'PayPal', pdfgrep: 'PDFGrep', pdfimages: 'PDFImages',
  pdfinfo: 'PDFInfo', pdfseparate: 'PDFSeparate', pdftotext: 'PDFToText',
  pdfunite: 'PDFUnite', planetscale: 'PlanetScale', pmc: 'PMC', posthog: 'PostHog',
  qpdf: 'QPDF', qrencode: 'QRencode', quickbooks: 'QuickBooks', rest: 'REST', rpc: 'RPC',
  rspec: 'RSpec', rubocop: 'RuboCop', rum: 'RUM', runpod: 'RunPod', scim: 'SCIM',
  scp: 'SCP', sec: 'SEC', sendgrid: 'SendGrid', servicenow: 'ServiceNow',
  sharepoint: 'SharePoint', shellcheck: 'ShellCheck', shipstation: 'ShipStation',
  sip: 'SIP', sox: 'SoX', sql: 'SQL', sqlite3: 'SQLite3', surveymonkey: 'SurveyMonkey',
  tar: 'TAR', themealdb: 'TheMealDB', tradingview: 'TradingView', trufflehog: 'TruffleHog',
  typescript: 'TypeScript', vcs: 'VCS', virustotal: 'VirusTotal', weasyprint: 'WeasyPrint',
  woocommerce: 'WooCommerce', wordpress: 'WordPress', workos: 'WorkOS',
  xlsx2csv: 'XLSX2CSV', xmllint: 'XMLLint', youtube: 'YouTube', zip: 'ZIP',
};

/** `salesforce-catalog` → `Salesforce`; `adobe-sign-agreement-workflows` →
 *  `Adobe Sign Agreement Workflows`; `hubspot-catalog` → `HubSpot`. The
 *  `-catalog` suffix is a packaging detail and never part of what the owner
 *  recognises. */
const vendorLabel = (catalogSlug: string): string =>
  catalogSlug.replace(/-catalog$/, '').split('-').filter(Boolean)
    .map(part => Object.hasOwn(CATALOG_WORD_CASING, part)
      ? CATALOG_WORD_CASING[part]!
      : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

/** Compose an owner-facing phrase, or return `operation_id` unchanged when the
 *  identifier does not carry a recognisable verb + entity. */
export const describeCatalogOperation = (input: {
  operation_key: string;
  operation_id: string;
  catalog_slug?: string;
}): string => {
  const segments = input.operation_key.split('.');
  if (segments.length !== 2) return input.operation_id;
  const [entity, action] = segments as [string, string];
  const actionWords = words(action);
  const head = actionWords[0];
  if (!entity || head === undefined || !OPERATION_VERBS.has(head)) return input.operation_id;

  // `webhooks.delete_webhook` must not become "Delete webhook webhooks" — when
  // the action already names its object, the entity segment adds nothing.
  const entityWords = words(entity);
  const restates = entityWords.every(word =>
    actionWords.some(part => part === word || `${part}s` === word || part === `${word}s`));

  // ⚠ THE VENDOR TRAILS AS A QUALIFIER RATHER THAN SITTING INSIDE THE PHRASE.
  // "Delete Salesforce opportunity" reads well and "Get all properties for a
  // resource Acme" does not; one shape has to work for both, and a trailing
  // qualifier is the one that does.
  const subject = [actionWords.join(' '), restates ? '' : entityWords.join(' ')]
    .filter(Boolean).join(' ');
  const vendor = input.catalog_slug ? vendorLabel(input.catalog_slug) : '';
  const sentence = vendor ? `${subject} · ${vendor}` : subject;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};

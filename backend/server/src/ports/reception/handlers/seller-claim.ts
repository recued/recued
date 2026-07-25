/** D-196 S3b — one-time seller-customer claim page.
 *
 * The emailed URL carries a short-lived `recued_claim_*` credential, never the
 * long-lived customer bearer. GET is deliberately non-consuming so ordinary
 * mail-link scanners cannot burn the claim. It renders a same-origin POST form;
 * POST atomically consumes the credential and renders the bearer exactly once,
 * alongside the enabled door endpoints and copy-paste client configuration.
 *
 * No scripts, embeds, third-party assets, cookies, or cacheable responses. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ReceptionAccessAction, ReceptionAccessOutcome } from '@recued/contracts';

import {
  isSellerClaimSecret,
  type SellerClaimPayload,
  type SellerClaimStore,
} from '../../../storage/seller-claim-store.js';
import { verifyReceptionSameOrigin } from './same-origin.js';

export const RECEPTION_SELLER_CLAIM_PATH = '/reception/claim' as const;
export const RECEPTION_SELLER_CLAIM_ENDPOINT_ID = '__seller_claim__' as const;
export const SELLER_CLAIM_TOKEN_PLACEHOLDER = 'YOUR_RECUED_TOKEN' as const;

const MAX_BODY_BYTES = 4 * 1024;
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

const HTML_ESCAPE_TABLE: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const HTML_ESCAPE_RE = /[&<>"']/g;

export const sellerClaimHtmlEscape = (value: string): string =>
  value.replace(HTML_ESCAPE_RE, (character) => HTML_ESCAPE_TABLE[character] ?? character);

const shellSingleQuote = (value: string): string =>
  `'${value.replace(/'/g, `'"'"'`)}'`;

const renderShell = (title: string, body: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'">
<title>${sellerClaimHtmlEscape(title)}</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{margin:0;background:#111827;color:#f9fafb}.shell{max-width:760px;margin:0 auto;padding:48px 20px}.card{background:#1f2937;border:1px solid #374151;border-radius:16px;padding:28px;box-shadow:0 18px 40px #0005}h1,h2{line-height:1.2}h1{margin-top:0}h2{font-size:1rem;margin-top:28px}.muted{color:#cbd5e1}.secret,.endpoint,pre{display:block;overflow-wrap:anywhere;background:#111827;border:1px solid #4b5563;border-radius:10px;padding:12px}pre{white-space:pre-wrap;overflow:auto}button{font:inherit;font-weight:650;color:#111827;background:#f9fafb;border:0;border-radius:10px;padding:11px 16px;cursor:pointer}.warning{color:#fde68a}.footer{margin-top:28px;font-size:.875rem;color:#9ca3af}
</style>
</head>
<body><main class="shell"><section class="card">${body}</section></main></body>
</html>
`;

export interface SellerClaimSetupSnippet {
  readonly id:
    | 'claude_code'
    | 'claude_desktop'
    | 'cursor'
    | 'generic_mcp'
    | 'openai_compatible';
  readonly format: 'code' | 'notice';
  readonly title: string;
  readonly content: string;
}

/** Client snippets use a placeholder so the actual bearer appears once in the
 * page, not once per example. */
export const buildSellerClaimSetupSnippets = (
  payload: SellerClaimPayload,
): readonly SellerClaimSetupSnippet[] => {
  const snippets: SellerClaimSetupSnippet[] = [];
  if (payload.mcp_url !== null) {
    const authorization = `Bearer ${SELLER_CLAIM_TOKEN_PLACEHOLDER}`;
    snippets.push({
      id: 'claude_code',
      format: 'code',
      title: 'Claude Code',
      content: [
        'claude mcp add --transport http \\',
        `  --header ${shellSingleQuote(`Authorization: ${authorization}`)} \\`,
        `  recued ${shellSingleQuote(payload.mcp_url)}`,
      ].join('\n'),
    });
    snippets.push({
      id: 'claude_desktop',
      format: 'notice',
      title: 'Claude Desktop compatibility',
      content: 'Claude Desktop remote connectors do not support this static bearer-header setup. Use the Claude Code or Cursor configuration instead.',
    });
    snippets.push({
      id: 'cursor',
      format: 'code',
      title: 'Cursor (.cursor/mcp.json)',
      content: JSON.stringify({
        mcpServers: {
          recued: {
            url: payload.mcp_url,
            headers: { Authorization: authorization },
          },
        },
      }, null, 2),
    });
    snippets.push({
      id: 'generic_mcp',
      format: 'code',
      title: 'Generic MCP (Streamable HTTP)',
      content: JSON.stringify({
        transport: 'streamable-http',
        url: payload.mcp_url,
        headers: { Authorization: authorization },
      }, null, 2),
    });
  }
  if (payload.llm_gateway_base_url !== null) {
    const model = payload.llm_gateway_model_alias ?? 'recued-seller';
    snippets.push({
      id: 'openai_compatible',
      format: 'code',
      title: 'OpenAI-compatible (Python SDK)',
      content: [
        'from openai import OpenAI',
        '',
        'client = OpenAI(',
        `    base_url=${JSON.stringify(payload.llm_gateway_base_url)},`,
        `    api_key=${JSON.stringify(SELLER_CLAIM_TOKEN_PLACEHOLDER)},`,
        ')',
        'response = client.chat.completions.create(',
        `    model=${JSON.stringify(model)},`,
        '    messages=[{"role": "user", "content": "Hello"}],',
        ')',
        'print(response.choices[0].message.content)',
      ].join('\n'),
    });
  }
  return snippets;
};

export const renderSellerClaimPromptHtml = (claimSecret: string): string =>
  renderShell('Claim your Recued access', `
<h1>Claim your Recued access</h1>
<p class="muted">Reveal your customer token and setup instructions. This link works once.</p>
<p class="warning">Keep the token private. Anyone holding it can use the access your seller granted.</p>
<form method="post" action="${RECEPTION_SELLER_CLAIM_PATH}">
<input type="hidden" name="claim_secret" value="${sellerClaimHtmlEscape(claimSecret)}">
<button type="submit">Reveal access token</button>
</form>
<p class="footer">Opening this page does not consume the link. Revealing the token does.</p>`);

export const renderSellerClaimResultHtml = (payload: SellerClaimPayload): string => {
  const endpoints = [
    payload.mcp_url !== null
      ? `<h2>MCP endpoint</h2><code class="endpoint">${sellerClaimHtmlEscape(payload.mcp_url)}</code>`
      : '',
    payload.llm_gateway_base_url !== null
      ? `<h2>OpenAI-compatible base URL</h2><code class="endpoint">${sellerClaimHtmlEscape(payload.llm_gateway_base_url)}</code>`
      : '',
  ].join('');
  const snippets = buildSellerClaimSetupSnippets(payload)
    .map((snippet) => snippet.format === 'notice'
      ? `<h2>${sellerClaimHtmlEscape(snippet.title)}</h2>
<p class="muted">${sellerClaimHtmlEscape(snippet.content)}</p>`
      : `<h2>${sellerClaimHtmlEscape(snippet.title)}</h2>
<pre><code>${sellerClaimHtmlEscape(snippet.content)}</code></pre>`)
    .join('\n');
  return renderShell('Your Recued access', `
<h1>Your Recued access</h1>
<p class="warning">Copy this token now. This claim page cannot show it again.</p>
<code class="secret">${sellerClaimHtmlEscape(payload.bearer_plaintext)}</code>
${endpoints}
<p class="muted">In the examples below, replace ${SELLER_CLAIM_TOKEN_PLACEHOLDER} with the token above.</p>
${snippets}
<p class="footer">The seller controls this token's grants and can close or reissue access.</p>`);
};

export const renderSellerClaimUnavailableHtml = (): string =>
  renderShell('Claim link unavailable', `
<h1>Claim link unavailable</h1>
<p class="muted">This link is invalid, expired, revoked, or already used. Ask the seller for a new claim link.</p>`);

const writeHtml = (res: ServerResponse, body: string, status: number): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store, max-age=0');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
};

const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  req.on('data', (chunk: Buffer) => {
    if (settled) return;
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      settled = true;
      reject(new Error('body_too_large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    resolve(Buffer.concat(chunks).toString('utf8'));
  });
  req.on('error', (error) => {
    if (settled) return;
    settled = true;
    reject(error);
  });
});

const parseClaimSecret = (raw: string): string | null => {
  const params = new URLSearchParams(raw);
  let claimSecret: string | null = null;
  for (const [key, value] of params) {
    if (key !== 'claim_secret' || claimSecret !== null) return null;
    claimSecret = value;
  }
  return isSellerClaimSecret(claimSecret) ? claimSecret : null;
};

const parseClaimSecretFromGet = (rawUrl: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, 'http://reception.invalid');
  } catch {
    return null;
  }
  const entries = [...parsed.searchParams];
  if (entries.length !== 1 || entries[0]?.[0] !== 't') return null;
  const claimSecret = entries[0][1];
  return isSellerClaimSecret(claimSecret) ? claimSecret : null;
};

export interface SellerClaimHandlerDeps {
  readonly getClaimStore: () => SellerClaimStore;
  readonly now: () => number;
  readonly trustForwardedProto?: boolean;
}

export interface SellerClaimHandlerResult {
  readonly action_taken: ReceptionAccessAction;
  readonly outcome: ReceptionAccessOutcome;
}

export const createSellerClaimHandler = (
  deps: SellerClaimHandlerDeps,
): ((req: IncomingMessage, res: ServerResponse) => Promise<SellerClaimHandlerResult>) => async (
  req,
  res,
) => {
  if (req.method === 'GET') {
    const claimSecret = parseClaimSecretFromGet(req.url ?? RECEPTION_SELLER_CLAIM_PATH);
    if (claimSecret === null) {
      writeHtml(res, renderSellerClaimUnavailableHtml(), 404);
      return { action_taken: 'invalid_token', outcome: 'invalid_token' };
    }
    // Do not inspect or consume here: GET-only mail scanners must be harmless.
    writeHtml(res, renderSellerClaimPromptHtml(claimSecret), 200);
    return { action_taken: 'view', outcome: 'ok' };
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    writeHtml(res, renderSellerClaimUnavailableHtml(), 405);
    return { action_taken: 'reject', outcome: 'rejected' };
  }
  const contentType = req.headers['content-type'];
  const mediaType = typeof contentType === 'string'
    ? contentType.split(';', 1)[0]?.trim().toLowerCase()
    : null;
  if (mediaType !== FORM_CONTENT_TYPE) {
    writeHtml(res, renderSellerClaimUnavailableHtml(), 415);
    return { action_taken: 'reject', outcome: 'rejected' };
  }
  if (!verifyReceptionSameOrigin(req, deps.trustForwardedProto === true)) {
    writeHtml(res, renderSellerClaimUnavailableHtml(), 403);
    return { action_taken: 'reject', outcome: 'rejected' };
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    writeHtml(res, renderSellerClaimUnavailableHtml(), 413);
    return { action_taken: 'reject', outcome: 'rejected' };
  }
  const claimSecret = parseClaimSecret(raw);
  if (claimSecret === null) {
    writeHtml(res, renderSellerClaimUnavailableHtml(), 400);
    return { action_taken: 'reject', outcome: 'rejected' };
  }

  const claimed = deps.getClaimStore().consume(claimSecret, deps.now());
  if (claimed.status !== 'claimed') {
    writeHtml(res, renderSellerClaimUnavailableHtml(), 410);
    if (claimed.status === 'expired') {
      return { action_taken: 'expired', outcome: 'expired' };
    }
    if (claimed.status === 'revoked') {
      return { action_taken: 'revoked', outcome: 'revoked' };
    }
    return { action_taken: 'invalid_token', outcome: 'invalid_token' };
  }
  writeHtml(res, renderSellerClaimResultHtml(claimed.payload), 200);
  return { action_taken: 'submit', outcome: 'ok' };
};

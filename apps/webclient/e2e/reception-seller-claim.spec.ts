import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { createReceptionPortHandler } from '../../../backend/server/src/ports/reception/handler.js';
import { RECEPTION_SELLER_CLAIM_PATH, SELLER_CLAIM_TOKEN_PLACEHOLDER } from '../../../backend/server/src/ports/reception/handlers/seller-claim.js';
import { createReceptionRateLimiter } from '../../../backend/server/src/ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../../../backend/server/src/ports/reception/registry-cache.js';
import { deriveReceptionPepper } from '../../../backend/server/src/ports/reception/server-secret-pepper.js';
import { RECEPTION_PAGE_STYLE_SRC } from '../../../backend/server/src/ports/reception/static-assets.js';
import { createPublicEndpointRegistryStore } from '../../../backend/server/src/storage/public-endpoint-registry-store.js';
import { ensureReceptionSchema } from '../../../backend/server/src/storage/reception-store.js';
import { createSellerClaimStore } from '../../../backend/server/src/storage/seller-claim-store.js';

test.use({ javaScriptEnabled: false, viewport: { width: 1280, height: 620 } });

const now = Date.UTC(2026, 10, 24, 16);
const bearer = `recued_${'z'.repeat(43)}`;
const mcpUrl = 'https://example.test/mcp';
const gatewayUrl = 'https://example.test/v1';

const startClaim = async () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const claims = createSellerClaimStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const pepper = deriveReceptionPepper(Buffer.alloc(32, 0x63));
  const issued = claims.issue({
    customer_id: 'customer-fixture',
    contract_id: 'contract-fixture',
    now,
    payload: {
      bearer_plaintext: bearer,
      mcp_url: mcpUrl,
      llm_gateway_base_url: gatewayUrl,
      llm_gateway_model_alias: 'fixture-model',
    },
  });
  const handler = createReceptionPortHandler({
    getStore: () => registry,
    getCache: () => cache,
    getRateLimiter: () => limiter,
    getPepper: () => pepper,
    getSellerClaimStore: () => claims,
    now: () => now,
  });
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Seller claim listener did not start');
  const postUrl = `http://127.0.0.1:${address.port}${RECEPTION_SELLER_CLAIM_PATH}`;
  return {
    postUrl,
    url: `${postUrl}?t=${encodeURIComponent(issued.claim_secret)}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
};

test('a claim reveals the token once and opens a usable setup example by keyboard', async ({ page, browserName }) => {
  const claim = await startClaim();
  try {
    const stylesheetUrl = new URL(RECEPTION_PAGE_STYLE_SRC, claim.url).href;
    const styleLoaded = page.waitForResponse(response => response.url() === stylesheetUrl);
    const prompt = await page.goto(claim.url);
    expect(prompt?.status()).toBe(200);
    expect(await prompt?.text()).not.toContain(bearer);
    const stylesheet = await styleLoaded;
    expect(stylesheet.ok()).toBe(true);
    expect(await stylesheet.request().headerValue('referer')).toBeNull();

    const reveal = page.getByRole('button', { name: 'Reveal access token', exact: true });
    const tab = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
    const submitClaim = async () => {
      await page.keyboard.press(tab);
      await expect(reveal).toBeFocused();
      const posted = page.waitForResponse(response => response.url() === claim.postUrl
        && response.request().method() === 'POST' && response.request().isNavigationRequest());
      await page.keyboard.press('Enter');
      return posted;
    };
    const claimed = await submitClaim();
    expect(claimed.status()).toBe(200);
    expect(await claimed.headerValue('cache-control')).toContain('no-store');
    expect((await claimed.text()).split(bearer)).toHaveLength(2);
    await expect(page.getByRole('heading', { name: 'Your Recued access', level: 1 })).toBeVisible();
    const access = page.getByRole('region', { name: 'Access token' });
    await expect(access.getByText(bearer, { exact: true })).toBeVisible();
    await expect(access.getByText(mcpUrl, { exact: true })).toBeVisible();
    await expect(access.getByText(gatewayUrl, { exact: true })).toBeVisible();

    const setup = page.getByRole('region', { name: 'Client setup' });
    const example = setup.locator('details').filter({ hasText: 'Cursor (.cursor/mcp.json)' });
    const exampleTitle = example.getByText('Cursor (.cursor/mcp.json)', { exact: true });
    const config = example.locator('pre');
    await expect(config).toBeHidden();
    await exampleTitle.press('Space');
    await expect(config).toBeVisible();
    expect(JSON.parse(await config.innerText())).toEqual({
      mcpServers: { recued: { url: mcpUrl, headers: { Authorization: `Bearer ${SELLER_CLAIM_TOKEN_PLACEHOLDER}` } } },
    });

    expect((await page.goto(claim.url))?.status()).toBe(200);
    const replay = await submitClaim();
    expect(replay.status()).toBe(410);
    expect(await replay.text()).not.toContain(bearer);
    await expect(page.getByRole('heading', { name: 'Claim link unavailable', level: 1 })).toBeVisible();
  } finally {
    await claim.close();
  }
});

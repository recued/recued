/** D-148 P9 § A.13 — repository scan: cloud relay code deleted.
 *
 *  Spec acceptance line 2204: "Cloud relay code deleted — repository
 *  scan asserts no `cloud/slack-relay` or `cloud/telegram-relay`
 *  directory exists in the repo."
 *
 *  D-146 absorbed: no cloud-mediated relay; no token custody at cloud;
 *  no message content at cloud. Slack/Telegram now POST directly to
 *  the user's server (Pro: `https://<handle>.recued.cloud/webhooks/
 *  {slack,telegram}` / free: `https://<user-domain>/webhooks/{slack,
 *  telegram}`); the cloud worker hosts only the six narrowed endpoint
 *  families per spec § A.14.
 *
 *  This test ratchets the deletion: any future PR that re-introduces
 *  cloud-side Slack/Telegram code under `backend/api/src/routes/` or
 *  the legacy `backend/cloud/{slack,telegram}-relay/` directories trips
 *  the scan. */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

describe('D-148 P9 — cloud relay code deletion', () => {
  it('repo scan: no cloud/slack-relay directory', () => {
    const path = join(REPO_ROOT, 'backend', 'cloud', 'slack-relay');
    expect(existsSync(path)).toBe(false);
  });

  it('repo scan: no cloud/telegram-relay directory', () => {
    const path = join(REPO_ROOT, 'backend', 'cloud', 'telegram-relay');
    expect(existsSync(path)).toBe(false);
  });

  it('repo scan: no cloud-side slack route file', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'routes', 'slack.ts');
    expect(existsSync(path)).toBe(false);
  });

  it('repo scan: no cloud-side slack-oauth route file', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'routes', 'slack-oauth.ts');
    expect(existsSync(path)).toBe(false);
  });

  it('repo scan: no cloud-side telegram-webhook route file', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'routes', 'telegram-webhook.ts');
    expect(existsSync(path)).toBe(false);
  });

  it('repo scan: no cloud-side telegram-bind route file', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'routes', 'telegram-bind.ts');
    expect(existsSync(path)).toBe(false);
  });

  it('repo scan: no cloud-side slack-auth shared helper', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'shared', 'slack-auth.ts');
    expect(existsSync(path)).toBe(false);
  });

  it('repo scan: no cloud-side slack-blocks shared helper', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'shared', 'slack-blocks.ts');
    expect(existsSync(path)).toBe(false);
  });

  it('repo scan: no cloud-side slack-tokens shared helper', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'shared', 'slack-tokens.ts');
    expect(existsSync(path)).toBe(false);
  });

  it('repo scan: no cloud-side telegram/ helpers directory', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'telegram');
    expect(existsSync(path)).toBe(false);
  });

  it('repo scan: no cloud-side approval slash command handler', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'approvals', 'worker-endpoints.ts');
    expect(existsSync(path)).toBe(false);
  });

  it('cloud router does not import any deleted slack/telegram module', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'sync-worker.ts');
    const content = readFileSyncIfExists(path);
    expect(content).not.toMatch(/from ['"][^'"]*\/routes\/slack/);
    expect(content).not.toMatch(/from ['"][^'"]*\/routes\/slack-oauth/);
    expect(content).not.toMatch(/from ['"][^'"]*\/routes\/telegram-webhook/);
    expect(content).not.toMatch(/from ['"][^'"]*\/routes\/telegram-bind/);
    expect(content).not.toMatch(/from ['"][^'"]*\/shared\/slack-auth/);
    expect(content).not.toMatch(/from ['"][^'"]*\/shared\/slack-blocks/);
    expect(content).not.toMatch(/from ['"][^'"]*\/shared\/slack-tokens/);
    expect(content).not.toMatch(/from ['"][^'"]*\/telegram\/api/);
    expect(content).not.toMatch(/from ['"][^'"]*\/telegram\/parser/);
    expect(content).not.toMatch(/from ['"][^'"]*\/approvals\/worker-endpoints/);
  });

  it('cloud router does not register /v1/slack/* or /v1/telegram/* routes', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'sync-worker.ts');
    const content = readFileSyncIfExists(path);
    // Allowlist a handful of strings that are commentary about the
    // retired routes — but no `path === '/v1/slack/*'` or
    // `path === '/v1/telegram/*'` route handler must remain.
    expect(content).not.toMatch(/path === '\/v1\/slack\//);
    expect(content).not.toMatch(/path === '\/v1\/telegram\//);
  });

  it('result route does not import deleted slack/telegram helpers', () => {
    const path = join(REPO_ROOT, 'backend', 'api', 'src', 'routes', 'result.ts');
    const content = readFileSyncIfExists(path);
    expect(content).not.toMatch(/from ['"][^'"]*\/shared\/slack-blocks/);
    expect(content).not.toMatch(/from ['"][^'"]*\/telegram\/api/);
    expect(content).not.toMatch(/sendTelegramMessage/);
    expect(content).not.toMatch(/buildResultMessage/);
  });
});

const readFileSyncIfExists = (path: string): string => {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
};

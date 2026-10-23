import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import config from './playwright.config.js';

const settings: unknown = JSON.parse(readFileSync(new URL('./settings-specs.json', import.meta.url), 'utf8'));
const fullApp: string[] = JSON.parse(readFileSync(new URL('./full-app-specs.json', import.meta.url), 'utf8'));
if (!Array.isArray(settings) || settings.length === 0
  || settings.some(spec => typeof spec !== 'string' || !fullApp.includes(spec))
  || new Set(settings).size !== settings.length) {
  throw new Error('settings-specs.json must contain unique full-app manifest filenames.');
}

// Build selectors in full-app manifest order. Absolute, escaped
// patterns exclude nested specs with the same filename in any checkout path.
const selected = new Set(settings);
const directory = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  ...config,
  testMatch: fullApp.filter(spec => selected.has(spec)).map(spec => new RegExp('^'
    + resolve(directory, spec).replace(/[.*+?^$()[\]{}\\]/g, '\\$&') + '$')),
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});

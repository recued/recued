import { defineConfig } from '@playwright/test';
import config from './playwright.config.js';

// WebKit exercises Safari engine behavior. Native Safari remains a separate gate.
export default defineConfig({
  ...config,
  projects: [{ name: 'webkit', use: { browserName: 'webkit' } }],
});

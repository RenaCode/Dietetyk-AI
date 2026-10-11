const fs = require('fs');
const os = require('os');
const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

// A second backend with single sign-on switched on (SSO_NAGLOWKI=1), for e2e-tests/sso.spec.js.
// Its own database directory, so the SSO run neither sees nor changes the main one; a fixed
// path rather than mkdtemp because this file is evaluated again in every worker, and each
// evaluation must point at the server that is already running. The tests send the Remote-*
// headers themselves - here they play the part of Traefik + Authelia.
const SSO_DB_DIR = path.join(os.tmpdir(), 'dietetyk-e2e-sso');
fs.mkdirSync(SSO_DB_DIR, { recursive: true });

module.exports = defineConfig({
  testDir: './e2e-tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Run sequentially to avoid SQLite locking problems
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm start',
      cwd: './backend',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 15000,
      env: {
        NODE_ENV: 'test',
      },
    },
    {
      command: 'npm start',
      cwd: './backend',
      url: 'http://localhost:3001/api/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 15000,
      env: {
        NODE_ENV: 'test',
        PORT: '3001',
        DATABASE_DIR: SSO_DB_DIR,
        ADMIN_EMAIL: 'owner@sso-e2e.invalid',
        SSO_NAGLOWKI: '1',
        SSO_LOGOUT_URL: 'https://auth.renacode.com/logout?rd=http%3A%2F%2Flocalhost%3A3001%2F',
      },
    },
  ],
});

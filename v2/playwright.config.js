const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './test',
  timeout: 120000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list'
});

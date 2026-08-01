const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: '.',
  timeout: 600000,
  workers: 1,
  reporter: 'list'
});

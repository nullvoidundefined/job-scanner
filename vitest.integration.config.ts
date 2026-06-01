import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { app: path.resolve(__dirname, './src') } },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/__tests__/integration/**/*.test.ts'],
    setupFiles: ['src/__tests__/helpers/setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});

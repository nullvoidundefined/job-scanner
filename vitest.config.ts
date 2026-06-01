import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { app: path.resolve(__dirname, './src') },
  },
  test: {
    coverage: {
      exclude: [
        'dist/**',
        'migrations/**',
        'scripts/**',
        '*.config.*',
        '**/config/**',
        '**/db/**',
        '**/utils/**',
        '**/*.d.ts',
        'src/__tests__/**',
        'src/index.ts', // thin env-loader shim; no logic to test
        'src/app.ts', // server bootstrap: app.listen, pool setup - not unit-testable
      ],
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    environment: 'node',
    exclude: [
      ...configDefaults.exclude,
      'migrations/**',
      'src/__tests__/integration/**',
    ],
    include: ['src/__tests__/**/*.test.ts'],
    globals: true,
    setupFiles: ['src/__tests__/helpers/setup.ts'],
  },
});

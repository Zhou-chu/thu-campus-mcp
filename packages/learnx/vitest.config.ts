import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/**/*.test.ts'], testTimeout: 20000,
  coverage: {
    provider: 'v8', include: ['src/**/*.ts'],
    exclude: ['**/*.d.ts', '**/*.test.ts', '**/*.spec.ts', '**/test/**', '**/tests/**', '**/__tests__/**', '**/vendor/**', '**/runtime/**', '**/node_modules/**'],
    reporter: ['json'], reportsDirectory: '../../coverage/vitest/learnx', reportOnFailure: true,
  },
} });

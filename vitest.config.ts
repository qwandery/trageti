import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      trageti: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: [
        'src/index.ts',
        'src/contracts/**', // type-only re-exports
        'src/defaults/index.ts', // barrel
        'src/domain/types.ts', // type-only
      ],
      // v0.3 thresholds (spec §coverage). Raised from v0.2 (90/90/75/90).
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 85,
        statements: 95,
      },
    },
  },
})

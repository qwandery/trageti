import { defineConfig } from 'vitest/config'

export default defineConfig({
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
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 75,
        statements: 90,
      },
    },
  },
})

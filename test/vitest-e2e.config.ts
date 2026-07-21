import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: false,
  test: {
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
  },
  plugins: [swc.vite()],
});

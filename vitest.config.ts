import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// unplugin-swc reemplaza el transform por defecto (esbuild) de Vitest:
// esbuild no emite metadata de decoradores (`emitDecoratorMetadata`), que
// Nest necesita en runtime (vía reflect-metadata) para resolver
// dependencias por tipo en `Test.createTestingModule()`. SWC sí la emite.
export default defineConfig({
  // Vitest 4 introdujo Oxc como transformador por defecto (reemplazo de
  // esbuild); unplugin-swc solo deshabilita esbuild, así que hay que apagar
  // Oxc explícitamente para que SWC sea el único transform (y siga emitiendo
  // la metadata de decoradores que Nest necesita).
  oxc: false,
  test: {
    root: './',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/main.ts', 'src/generate-contract.ts'],
    },
  },
  plugins: [swc.vite()],
});

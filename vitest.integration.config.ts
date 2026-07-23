import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Tests con K3s real vía testcontainers (AGENTS.md 6.2). Requieren
// Docker corriendo. K3s-en-Docker tarda más que un Postgres en
// testcontainers — timeouts generosos, sobre todo con cache frío de
// imágenes (K3s + Deno + http-echo).
//
// LIMITACIÓN CONOCIDA: la red anidada de un containerd-en-Docker (K3s
// dentro de un contenedor) puede ser notablemente más lenta/inestable
// que el pull directo desde el host para la MISMA imagen y registro
// (verificado: pull directo ~6s, pull anidado entre 13s y >180s en
// corridas distintas). prepullImage ya reintenta; este timeout da
// margen para esos reintentos sin ocultar un fallo real de más de
// 5 minutos.
export default defineConfig({
  oxc: false,
  test: {
    root: './',
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // Cada archivo levanta su propio clúster K3s: en paralelo compiten
    // por CPU/red en cache frío. Secuencial es más lento pero confiable.
    fileParallelism: false,
  },
  plugins: [swc.vite()],
});

import { Test, type TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JinErrorFilter } from '../src/common/filters/jin-error.filter';
import { AppModule } from '../src/app.module';

// Solo ejercita los caminos que retornan/lanzan ANTES de tocar
// Kubernetes o Modal (rechazo RBAC, validación Zod) — no necesita un
// clúster real ni credenciales reales de Modal. El camino feliz de
// ejecución local vive en
// src/pod-lifecycle/pod-lifecycle.service.integration.spec.ts (K3s
// real); el camino remoto real (Modal) en src/modal/modal.service.spec.ts
// (SDK mockeado) — acá no se manda `language: 'python'` a propósito,
// porque el AppModule real de este test usa un ModalService real que sí
// llamaría a la API de Modal de verdad.
describe('POST /execute (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new JinErrorFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rechaza con 403 una tool fuera de la whitelist del Executor', () => {
    return request(app.getHttpServer())
      .post('/execute')
      .send({
        tool: 'deleteEverything',
        code: 'x',
        language: 'typescript',
        timeout: 30,
      })
      .expect(403)
      .expect((res: { body: { code: string } }) => {
        expect(res.body.code).toBe('RBAC_TOOL_NOT_WHITELISTED');
      });
  });

  it('rechaza con 400 un body que no cumple el schema de Zod', () => {
    return request(app.getHttpServer())
      .post('/execute')
      .send({ tool: 'runCode' }) // faltan code, language y timeout
      .expect(400);
  });

  it('rechaza con 400 un timeout fuera de rango', () => {
    return request(app.getHttpServer())
      .post('/execute')
      .send({
        tool: 'runCode',
        code: 'x',
        language: 'typescript',
        timeout: -1,
      })
      .expect(400);
  });

  it('rechaza con 400 un language fuera del enum', () => {
    return request(app.getHttpServer())
      .post('/execute')
      .send({ tool: 'runCode', code: 'x', language: 'ruby', timeout: 30 })
      .expect(400);
  });
});

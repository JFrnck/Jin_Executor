import { Test, type TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { YormunErrorFilter } from '../src/common/filters/yormun-error.filter';
import { AppModule } from '../src/app.module';

// Solo ejercita los caminos que retornan/lanzan ANTES de tocar Kubernetes
// (rechazo RBAC, validación Zod, stub de Modal) — no necesita un clúster
// real. El camino feliz de ejecución local vive en
// src/pod-lifecycle/pod-lifecycle.service.integration.spec.ts (K3s real).
describe('POST /execute (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new YormunErrorFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rechaza con 403 una tool fuera de la whitelist del Executor', () => {
    return request(app.getHttpServer())
      .post('/execute')
      .send({ tool: 'deleteEverything', code: 'x', timeout: 30 })
      .expect(403)
      .expect((res: { body: { code: string } }) => {
        expect(res.body.code).toBe('RBAC_TOOL_NOT_WHITELISTED');
      });
  });

  it('rechaza con 400 un body que no cumple el schema de Zod', () => {
    return request(app.getHttpServer())
      .post('/execute')
      .send({ tool: 'runCode' }) // faltan code y timeout
      .expect(400);
  });

  it('rechaza con 400 un timeout fuera de rango', () => {
    return request(app.getHttpServer())
      .post('/execute')
      .send({ tool: 'runCode', code: 'x', timeout: -1 })
      .expect(400);
  });

  it('remote:true devuelve 501 (Modal es un stub — BLUEPRINT 4.5, Fase 5)', () => {
    return request(app.getHttpServer())
      .post('/execute')
      .send({ tool: 'runCode', code: 'x', timeout: 30, remote: true })
      .expect(501)
      .expect((res: { body: { code: string } }) => {
        expect(res.body.code).toBe('MODAL_NOT_IMPLEMENTED');
      });
  });
});

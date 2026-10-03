import { Body, Controller, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { configureBodyParsers } from './body-parsers';

@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: { text?: string }): { bytes: number } {
    return { bytes: (body.text ?? '').length };
  }
}

async function appWith(configure: boolean): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [EchoController],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: !configure,
  });
  if (configure) configureBodyParsers(app);
  await app.init();
  return app;
}

describe('configureBodyParsers', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('un Publicar de ~300 KB (JSON escapado) entra; con el parser por defecto era 413', async () => {
    const text = 'a"b\n'.repeat(75_000); // 300 KB de texto que el JSON duplica al escapar

    app = await appWith(false);
    await request(app.getHttpServer()).post('/echo').send({ text }).expect(413);
    await app.close();

    app = await appWith(true);
    const response = await request(app.getHttpServer())
      .post('/echo')
      .send({ text })
      .expect(201);
    expect((response.body as { bytes: number }).bytes).toBe(text.length);
  });

  it('el tope sigue existiendo: un cuerpo de más de 1 MB se rechaza con 413', async () => {
    app = await appWith(true);
    await request(app.getHttpServer())
      .post('/echo')
      .send({ text: 'x'.repeat(1_200_000) })
      .expect(413);
  });
});

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { AppConfigService } from './config';
import { JinErrorFilter } from './common/filters/jin-error.filter';
import { configureBodyParsers } from './common/body-parsers';
import { loadSecrets } from './config/secrets-loader';

async function bootstrap() {
  // Fase 8.1: debe correr ANTES de que se evalúe `AppModule`, no solo antes de
  // `NestFactory.create()`. `ConfigModule.forRoot({ validate })` se ejecuta al
  // IMPORTAR su archivo, así que un `import { AppModule }` estático arriba corre
  // `validateEnv()` antes de que los secretos de Infisical estén en process.env
  // (CrashLoopBackOff en el primer despliegue real, 2026-09-20). Ver
  // Jin_Core/src/main.ts. Por eso el import es dinámico y va después.
  await loadSecrets();
  const { AppModule } = await import('./app.module.js');

  // El body parser por defecto de Express corta en 100 KB; "Publicar" admite hasta 256 KB.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  configureBodyParsers(app);
  app.useGlobalFilters(new JinErrorFilter());

  const config = new DocumentBuilder()
    .setTitle('Jin Executor API')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const configService = app.get<AppConfigService>(ConfigService);
  await app.listen(configService.get<number>('PORT'));
}
bootstrap().catch((error: unknown) => {
  // Antes era una promesa suelta: el mismo efecto (el proceso termina con error),
  // pero ahora el motivo sale con un mensaje claro y el código de salida es explícito.
  console.error('El Executor no pudo arrancar:', error);
  process.exit(1);
});

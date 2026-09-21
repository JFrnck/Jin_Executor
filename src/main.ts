import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { AppConfigService } from './config';
import { JinErrorFilter } from './common/filters/jin-error.filter';
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

  const app = await NestFactory.create(AppModule);
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
bootstrap();

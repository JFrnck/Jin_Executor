import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import type { AppConfigService } from './config';
import { JinErrorFilter } from './common/filters/jin-error.filter';
import { loadSecrets } from './config/secrets-loader';

async function bootstrap() {
  // Fase 8.1: ver el comentario equivalente en Jin_Core/src/main.ts --
  // debe correr antes de NestFactory.create para que validateEnv() vea
  // los secretos de Infisical ya en process.env.
  await loadSecrets();

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

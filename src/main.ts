import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import type { AppConfigService } from './config';
import { YormunErrorFilter } from './common/filters/yormun-error.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new YormunErrorFilter());

  const config = new DocumentBuilder()
    .setTitle('Yormun Executor API')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const configService = app.get<AppConfigService>(ConfigService);
  await app.listen(configService.get<number>('PORT'));
}
bootstrap();

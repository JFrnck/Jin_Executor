import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config';
import { ExecuteModule } from './execute/execute.module';
import { PreviewServiceModule } from './preview-service/preview-service.module';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    ExecuteModule,
    PreviewServiceModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

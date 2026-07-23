import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config';
import { ExecuteModule } from './execute/execute.module';

@Module({
  imports: [ConfigModule, ExecuteModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

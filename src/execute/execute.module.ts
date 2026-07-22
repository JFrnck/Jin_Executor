import { Module } from '@nestjs/common';
import { PodLifecycleModule } from '../pod-lifecycle/pod-lifecycle.module';
import { ExecuteController } from './execute.controller';

@Module({
  imports: [PodLifecycleModule],
  controllers: [ExecuteController],
})
export class ExecuteModule {}

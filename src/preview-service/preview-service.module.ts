import { Module } from '@nestjs/common';
import { K8sModule } from '../k8s/k8s.module';
import { RbacModule } from '../rbac/rbac.module';
import { PreviewServiceController } from './preview-service.controller';
import { PreviewServiceReaperService } from './preview-service-reaper.service';
import { PreviewServiceLifecycleService } from './preview-service.service';

@Module({
  imports: [K8sModule, RbacModule],
  controllers: [PreviewServiceController],
  providers: [PreviewServiceLifecycleService, PreviewServiceReaperService],
  exports: [PreviewServiceLifecycleService],
})
export class PreviewServiceModule {}

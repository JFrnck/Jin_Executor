import { Module } from '@nestjs/common';
import { K8sModule } from '../k8s/k8s.module';
import { ModalModule } from '../modal/modal.module';
import { RbacModule } from '../rbac/rbac.module';
import { PodLifecycleService } from './pod-lifecycle.service';

@Module({
  imports: [K8sModule, ModalModule, RbacModule],
  providers: [PodLifecycleService],
  exports: [PodLifecycleService],
})
export class PodLifecycleModule {}

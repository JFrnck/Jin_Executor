import { Module } from '@nestjs/common';
import { K8sModule } from '../k8s/k8s.module';
import { RbacModule } from '../rbac/rbac.module';
import { TerminalReaperService } from './terminal-reaper.service';
import { TerminalController } from './terminal.controller';
import { TerminalSessionService } from './terminal.service';

@Module({
  imports: [K8sModule, RbacModule],
  controllers: [TerminalController],
  providers: [TerminalSessionService, TerminalReaperService],
  exports: [TerminalSessionService],
})
export class TerminalModule {}

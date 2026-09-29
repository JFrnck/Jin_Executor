import { Module } from '@nestjs/common';
import { K8sModule } from '../k8s/k8s.module';
import { RbacModule } from '../rbac/rbac.module';
import { TerminalPtyService } from './terminal-pty.service';
import { TerminalReaperService } from './terminal-reaper.service';
import { TerminalController } from './terminal.controller';
import { TerminalWorkspaceService } from './terminal.service';

@Module({
  imports: [K8sModule, RbacModule],
  controllers: [TerminalController],
  providers: [
    TerminalWorkspaceService,
    TerminalPtyService,
    TerminalReaperService,
  ],
  exports: [TerminalWorkspaceService],
})
export class TerminalModule {}

import { Module } from '@nestjs/common';
import { K8sModule } from '../k8s/k8s.module';
import { PreviewServiceModule } from '../preview-service/preview-service.module';
import { RbacModule } from '../rbac/rbac.module';
import { TerminalModule } from '../terminal/terminal.module';
import { GithubAppService } from './github-app.service';
import { GithubDemosService } from './github-demos.service';
import { GithubReposService } from './github-repos.service';
import { GithubController, GithubReposController } from './github.controller';
import { PodWorkspaceFs, WORKSPACE_FS } from './workspace-fs';

@Module({
  imports: [PreviewServiceModule, RbacModule, K8sModule, TerminalModule],
  controllers: [GithubController, GithubReposController],
  providers: [
    GithubAppService,
    GithubDemosService,
    GithubReposService,
    PodWorkspaceFs,
    { provide: WORKSPACE_FS, useExisting: PodWorkspaceFs },
  ],
  exports: [GithubDemosService, GithubReposService],
})
export class GithubModule {}

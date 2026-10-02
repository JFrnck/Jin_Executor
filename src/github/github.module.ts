import { Module } from '@nestjs/common';
import { PreviewServiceModule } from '../preview-service/preview-service.module';
import { RbacModule } from '../rbac/rbac.module';
import { GithubAppService } from './github-app.service';
import { GithubDemosService } from './github-demos.service';
import { GithubController } from './github.controller';

@Module({
  imports: [PreviewServiceModule, RbacModule],
  controllers: [GithubController],
  providers: [GithubAppService, GithubDemosService],
  exports: [GithubDemosService],
})
export class GithubModule {}

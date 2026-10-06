import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import type { InstalledRepo } from './github-app.service';
import {
  GithubReposService,
  type CloneResult,
  type PushResult,
  type RepoStatus,
} from './github-repos.service';
import {
  GithubDemosService,
  type GithubDemoBranch,
  type SaveDemoResult,
} from './github-demos.service';
import {
  CheckoutRequestSchema,
  CloneRequestSchema,
  ListDemosQuerySchema,
  PullRequestSchema,
  PushRequestSchema,
  RepoDirQuerySchema,
  type CheckoutRequest,
  type CloneRequest,
  type PullRequest,
  type PushRequest,
  type RepoDirQuery,
  SaveDemoRequestSchema,
  type ListDemosQuery,
  type SaveDemoRequest,
} from './github-request.schema';

@ApiTags('github')
@Controller('github/demos')
export class GithubController {
  constructor(private readonly demos: GithubDemosService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Guarda una demo en una rama huérfana demo/<slug> del repo de demos (sin --force)',
  })
  async save(
    @Body(new ZodValidationPipe(SaveDemoRequestSchema)) body: SaveDemoRequest,
  ): Promise<SaveDemoResult> {
    return this.demos.save(body);
  }

  @Get()
  @ApiOperation({ summary: 'Lista las ramas demo/* del repo de demos' })
  async list(
    @Query(new ZodValidationPipe(ListDemosQuerySchema)) query: ListDemosQuery,
  ): Promise<GithubDemoBranch[]> {
    return this.demos.list(query.repo);
  }
}

/** Repos de GitHub en el disco del workspace de una terminal (ADR 0022). */
@ApiTags('github')
@Controller('github')
export class GithubReposController {
  constructor(private readonly repos: GithubReposService) {}

  @Get('repos')
  @ApiOperation({ summary: 'Repos donde está instalada la GitHub App' })
  async list(): Promise<InstalledRepo[]> {
    return this.repos.listRepos();
  }

  @Post('workspaces/:workspaceId/clone')
  @HttpCode(200)
  @ApiOperation({ summary: 'Clona un repo en una carpeta vacía del workspace' })
  async clone(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body(new ZodValidationPipe(CloneRequestSchema)) body: CloneRequest,
  ): Promise<CloneResult> {
    return this.repos.clone({ workspaceId, ...body });
  }

  @Get('workspaces/:workspaceId/status')
  @ApiOperation({ summary: 'Rama, commit y archivos cambiados del repo' })
  async status(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Query(new ZodValidationPipe(RepoDirQuerySchema)) query: RepoDirQuery,
  ): Promise<RepoStatus> {
    return this.repos.status({ workspaceId, ...query });
  }

  @Get('workspaces/:workspaceId/branches')
  @ApiOperation({ summary: 'Ramas locales y remotas' })
  async branches(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Query(new ZodValidationPipe(RepoDirQuerySchema)) query: RepoDirQuery,
  ): Promise<{ current: string; local: string[]; remote: string[] }> {
    return this.repos.branches({ workspaceId, ...query });
  }

  @Post('workspaces/:workspaceId/checkout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cambia (o crea) una rama' })
  async checkout(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body(new ZodValidationPipe(CheckoutRequestSchema)) body: CheckoutRequest,
  ): Promise<{ branch: string; head: string }> {
    return this.repos.checkout({ workspaceId, ...body });
  }

  @Post('workspaces/:workspaceId/pull')
  @HttpCode(200)
  @ApiOperation({ summary: 'Actualiza la rama actual en avance rápido' })
  async pull(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body(new ZodValidationPipe(PullRequestSchema)) body: PullRequest,
  ): Promise<{ branch: string; head: string; updated: boolean }> {
    return this.repos.pull({ workspaceId, ...body });
  }

  @Post('workspaces/:workspaceId/push')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Commit de lo cambiado y push a una rama (nunca main, sin --force)',
  })
  async push(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body(new ZodValidationPipe(PushRequestSchema)) body: PushRequest,
  ): Promise<PushResult> {
    return this.repos.push({ workspaceId, ...body });
  }
}

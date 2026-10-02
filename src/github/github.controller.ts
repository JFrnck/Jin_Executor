import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  GithubDemosService,
  type GithubDemoBranch,
  type SaveDemoResult,
} from './github-demos.service';
import {
  ListDemosQuerySchema,
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

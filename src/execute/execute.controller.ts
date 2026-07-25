import { Body, Controller, HttpCode, Post, UsePipes } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PodLifecycleService } from '../pod-lifecycle/pod-lifecycle.service';
import {
  ExecuteRequestSchema,
  type ExecuteRequest,
} from './execute-request.schema';
import type { ExecutionResult } from './execution-result';

@ApiTags('execute')
@Controller('execute')
export class ExecuteController {
  constructor(private readonly podLifecycle: PodLifecycleService) {}

  @Post()
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(ExecuteRequestSchema))
  @ApiOperation({
    summary:
      'Ejecuta código en un pod Deno aislado (language: typescript) o en un sandbox de Modal (language: python) — la decisión de tier es automática según el language, no la declara el caller (BLUEPRINT 4.5)',
  })
  @ApiResponse({ status: 200, description: 'Ejecución completada' })
  @ApiResponse({
    status: 403,
    description: 'Tool fuera de la whitelist del Executor',
  })
  @ApiResponse({
    status: 502,
    description: 'Fallo real de la API de Modal (tier remoto)',
  })
  @ApiResponse({
    status: 504,
    description: 'El pod no terminó dentro del timeout (tier local)',
  })
  async execute(@Body() body: ExecuteRequest): Promise<ExecutionResult> {
    return this.podLifecycle.run(body);
  }
}

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
      'Ejecuta código en un pod aislado (o lo envía a Modal con remote:true)',
  })
  @ApiResponse({ status: 200, description: 'Ejecución completada' })
  @ApiResponse({
    status: 403,
    description: 'Tool fuera de la whitelist del Executor',
  })
  @ApiResponse({
    status: 504,
    description: 'El pod no terminó dentro del timeout',
  })
  async execute(@Body() body: ExecuteRequest): Promise<ExecutionResult> {
    return this.podLifecycle.run(body);
  }
}

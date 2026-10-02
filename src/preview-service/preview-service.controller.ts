import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ExtendPreviewServiceRequestSchema,
  StartPreviewServiceRequestSchema,
  type ExtendPreviewServiceRequest,
  type StartPreviewServiceRequest,
} from './preview-service-request.schema';
import type { PreviewServiceInfo } from './preview-service.types';
import { PreviewServiceLifecycleService } from './preview-service.service';
import {
  ExportTerminalQuerySchema,
  type ExportTerminalQuery,
} from '../terminal/terminal-request.schema';
import type { TerminalExportResult } from '../terminal/terminal.types';

@ApiTags('services')
@Controller('services')
export class PreviewServiceController {
  constructor(
    private readonly previewService: PreviewServiceLifecycleService,
  ) {}

  @Post()
  @HttpCode(200)
  @UsePipes(new ZodValidationPipe(StartPreviewServiceRequestSchema))
  @ApiOperation({
    summary:
      'Levanta un pod de servicio de larga vida expuesto bajo https://<slug>.jinserver.com (Fase 5.5)',
  })
  @ApiResponse({ status: 200, description: 'Servicio creado' })
  @ApiResponse({
    status: 403,
    description: 'Tool fuera de la whitelist del Executor',
  })
  @ApiResponse({
    status: 429,
    description: 'Límite de servicios concurrentes alcanzado',
  })
  async start(
    @Body() body: StartPreviewServiceRequest,
  ): Promise<PreviewServiceInfo> {
    return this.previewService.start(body);
  }

  @Post(':id/extend')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Alarga la vida de un pod de servicio activo (hasta el tope de PREVIEW_SERVICE_MAX_TTL_SECONDS desde que se creó)',
  })
  @ApiResponse({ status: 200, description: 'Nuevo vencimiento' })
  @ApiResponse({ status: 404, description: 'No existe o ya venció' })
  @ApiResponse({ status: 409, description: 'Ya está en el tope de vida' })
  async extend(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ExtendPreviewServiceRequestSchema))
    body: ExtendPreviewServiceRequest,
  ): Promise<PreviewServiceInfo> {
    return this.previewService.extend(id, body.extraSeconds);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Detiene y destruye un pod de servicio activo' })
  async stop(@Param('id') id: string): Promise<void> {
    await this.previewService.stop(id);
  }

  @Get(':id/files')
  @ApiOperation({
    summary:
      'Archivos de texto del pod (sin node_modules, .git ni .jin), para traerlos al editor',
  })
  async exportFiles(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(ExportTerminalQuerySchema))
    query: ExportTerminalQuery,
  ): Promise<TerminalExportResult> {
    return this.previewService.exportFiles(id, query.dir);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista los pods de servicio activos y su TTL restante',
  })
  async list(): Promise<PreviewServiceInfo[]> {
    return this.previewService.list();
  }
}

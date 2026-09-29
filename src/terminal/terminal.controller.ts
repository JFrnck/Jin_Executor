import {
  All,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ExecTerminalRequestSchema,
  ExportTerminalQuerySchema,
  ExposeTerminalRequestSchema,
  ImportTerminalRequestSchema,
  StartServiceRequestSchema,
  StartTerminalRequestSchema,
  WorkspaceIdSchema,
  parsePort,
  type ExecTerminalRequest,
  type ExportTerminalQuery,
  type ExposeTerminalRequest,
  type ImportTerminalRequest,
  type StartServiceRequest,
  type StartTerminalRequest,
} from './terminal-request.schema';
import { TerminalWorkspaceService } from './terminal.service';
import type {
  TerminalExportResult,
  TerminalExposure,
  TerminalServiceInfo,
  TerminalServiceStart,
  TerminalStreamEvent,
  TerminalWorkspaceInfo,
} from './terminal.types';

/** ADR 0016 ampliada. Solo lo llama Jin_Core (`allow-from-jin`): nunca el modelo ni el owner directo. */
@ApiTags('terminal')
@Controller('terminal/workspaces')
export class TerminalController {
  constructor(private readonly terminal: TerminalWorkspaceService) {}

  @Get()
  @ApiOperation({
    summary:
      'Todos los workspaces (proyectos con disco propio), corriendo o no',
  })
  async list(): Promise<TerminalWorkspaceInfo[]> {
    return this.terminal.list();
  }

  @Post(':workspaceId/start')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Inicia (o reanuda) el pod del workspace de un proyecto (ADR 0016 ampliada)',
  })
  async start(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body(new ZodValidationPipe(StartTerminalRequestSchema))
    body: StartTerminalRequest,
  ): Promise<TerminalWorkspaceInfo> {
    return this.terminal.start(this.workspaceIdOrFail(rawWorkspaceId), body);
  }

  @Delete(':workspaceId/pod')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Detiene el pod del workspace (el disco no se toca)',
  })
  async stopPod(@Param('workspaceId') rawWorkspaceId: string): Promise<void> {
    await this.terminal.stopPod(this.workspaceIdOrFail(rawWorkspaceId));
  }

  @Delete(':workspaceId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Elimina el disco del workspace (irreversible)',
  })
  async deleteWorkspace(
    @Param('workspaceId') rawWorkspaceId: string,
  ): Promise<void> {
    await this.terminal.deleteWorkspace(this.workspaceIdOrFail(rawWorkspaceId));
  }

  /**
   * Corre un comando y devuelve la salida como NDJSON (`application/x-ndjson`):
   * una línea JSON por evento (`out`, `err`) y una final (`exit` o `error`).
   */
  @Post(':workspaceId/exec')
  @ApiOperation({
    summary: 'Ejecuta un comando en el workspace (salida en streaming NDJSON)',
  })
  async exec(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body(new ZodValidationPipe(ExecTerminalRequestSchema))
    body: ExecTerminalRequest,
    @Res() res: Response,
  ): Promise<void> {
    const workspaceId = this.workspaceIdOrFail(rawWorkspaceId);
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let started = false;
    const emit = (event: TerminalStreamEvent): void => {
      if (!started) {
        started = true;
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }
      res.write(`${JSON.stringify(event)}\n`);
    };

    // Los errores anteriores al primer byte (404, 409, 400) salen como HTTP
    // normal por el filtro global; la excepción se relanza mientras no haya
    // empezado el stream.
    try {
      await this.terminal.exec(workspaceId, body, emit, controller.signal);
    } catch (error) {
      if (started) {
        emit({
          t: 'error',
          message: error instanceof Error ? error.message : 'Falló el comando.',
        });
      } else {
        throw error;
      }
    }
    if (!started) {
      emit({ t: 'error', message: 'El comando no produjo resultado.' });
    }
    res.end();
  }

  @Get(':workspaceId/files')
  @ApiOperation({
    summary: 'Archivos de texto del workspace (para traerlos al editor)',
  })
  async exportFiles(
    @Param('workspaceId') rawWorkspaceId: string,
    @Query(new ZodValidationPipe(ExportTerminalQuerySchema))
    query: ExportTerminalQuery,
  ): Promise<TerminalExportResult> {
    return this.terminal.exportFiles(
      this.workspaceIdOrFail(rawWorkspaceId),
      query.dir,
    );
  }

  @Put(':workspaceId/files')
  @ApiOperation({ summary: 'Copia archivos del editor al workspace' })
  async importFiles(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body(new ZodValidationPipe(ImportTerminalRequestSchema))
    body: ImportTerminalRequest,
  ): Promise<{ written: number }> {
    return this.terminal.importFiles(
      this.workspaceIdOrFail(rawWorkspaceId),
      body.files,
    );
  }

  // ── Servidores en segundo plano y vista previa ───────────────────────

  @Post(':workspaceId/services')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Lanza un servidor en segundo plano dentro del workspace y espera a que el puerto responda',
  })
  async startService(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body(new ZodValidationPipe(StartServiceRequestSchema))
    body: StartServiceRequest,
  ): Promise<TerminalServiceStart> {
    return this.terminal.startService(
      this.workspaceIdOrFail(rawWorkspaceId),
      body,
    );
  }

  @Get(':workspaceId/services')
  @ApiOperation({ summary: 'Servidores en segundo plano del workspace' })
  async listServices(
    @Param('workspaceId') rawWorkspaceId: string,
  ): Promise<TerminalServiceInfo[]> {
    return this.terminal.listServices(this.workspaceIdOrFail(rawWorkspaceId));
  }

  @Delete(':workspaceId/services/:port')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Detiene un servidor en segundo plano (mata su grupo de procesos)',
  })
  async stopService(
    @Param('workspaceId') rawWorkspaceId: string,
    @Param('port') rawPort: string,
  ): Promise<void> {
    await this.terminal.stopService(
      this.workspaceIdOrFail(rawWorkspaceId),
      this.portOrFail(rawPort),
    );
  }

  @Get(':workspaceId/services/:port/logs')
  @ApiOperation({ summary: 'Últimas líneas de la salida de un servidor' })
  async serviceLogs(
    @Param('workspaceId') rawWorkspaceId: string,
    @Param('port') rawPort: string,
  ): Promise<{ log: string }> {
    return {
      log: await this.terminal.serviceLogs(
        this.workspaceIdOrFail(rawWorkspaceId),
        this.portOrFail(rawPort),
      ),
    };
  }

  /**
   * Reenvía la petición al puerto de un servidor del workspace (vista previa
   * en vivo). Solo lo llama Jin_Core, con el JWT del owner ya verificado.
   */
  @All([':workspaceId/proxy/:port', ':workspaceId/proxy/:port/*rest'])
  @ApiOperation({
    summary: 'Proxy HTTP a un puerto de un servidor del workspace',
  })
  async proxy(
    @Param('workspaceId') rawWorkspaceId: string,
    @Param('port') rawPort: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const workspaceId = this.workspaceIdOrFail(rawWorkspaceId);
    const port = this.portOrFail(rawPort);
    const prefix = `/terminal/workspaces/${encodeURIComponent(rawWorkspaceId)}/proxy/${rawPort}`;
    const rest = req.originalUrl.startsWith(prefix)
      ? req.originalUrl.slice(prefix.length)
      : '';
    const path = rest === '' || rest.startsWith('?') ? `/${rest}` : rest;

    const upstream = await this.terminal.proxy(workspaceId, port, {
      method: req.method,
      path,
      headers: forwardedRequestHeaders(req, port),
      body: await requestBody(req),
    });

    res.status(upstream.status);
    // Marca lo que viene del servidor del owner: un 404 de su app no es un 404 del proxy.
    res.setHeader('x-jin-proxied', '1');
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value !== undefined && RESPONSE_HEADERS.has(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    }
    upstream.body.on('error', () => res.destroy());
    res.on('close', () => upstream.body.destroy());
    upstream.body.pipe(res);
  }

  @Post(':workspaceId/expose')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Publica un directorio del workspace bajo https://<slug>.jinserver.com',
  })
  async expose(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body(new ZodValidationPipe(ExposeTerminalRequestSchema))
    body: ExposeTerminalRequest,
  ): Promise<TerminalExposure> {
    return this.terminal.expose(this.workspaceIdOrFail(rawWorkspaceId), body);
  }

  private portOrFail(raw: string): number {
    const port = parsePort(raw);
    if (port === null)
      throw new BadRequestException('Puerto no válido (1024–65535).');
    return port;
  }

  /** Valida y normaliza el id de proyecto ANTES de que llegue a nombrar un recurso de Kubernetes. */
  private workspaceIdOrFail(raw: string): string {
    const result = WorkspaceIdSchema.safeParse(raw);
    if (!result.success)
      throw new BadRequestException('Id de proyecto inválido.');
    return result.data;
  }
}

/** Cabeceras que se reenvían al servidor: el resto (cookies, autorización, host) no. */
const REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'range',
  'user-agent',
];
/** Cabeceras de la respuesta que se devuelven. Sin `set-cookie`, sin las de conexión. */
const RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'location',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'x-content-type-options',
]);
/** Tope del cuerpo de una petición reenviada. */
const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;

function forwardedRequestHeaders(
  req: Request,
  port: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    // El servidor de desarrollo ve una petición local: Vite rechaza otros `Host`.
    host: `localhost:${port}`,
    // Sin compresión: el cliente recibe el cuerpo tal cual.
    'accept-encoding': 'identity',
  };
  for (const name of REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

/** Cuerpo de la petición: el JSON que Nest ya leyó, o el stream crudo (con tope). */
async function requestBody(req: Request): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (
    req.body !== undefined &&
    req.body !== null &&
    typeof req.body === 'object' &&
    Object.keys(req.body as object).length > 0
  ) {
    return Buffer.from(JSON.stringify(req.body));
  }
  if (req.readableEnded || req.complete === false) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_PROXY_BODY_BYTES)
      throw new BadRequestException('Cuerpo demasiado grande.');
    chunks.push(buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

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
  FsDeleteQuerySchema,
  FsListQuerySchema,
  FsMkdirBodySchema,
  FsReadQuerySchema,
  FsWriteBodySchema,
  OpenPtyRequestSchema,
  PtyIdSchema,
  PtyInputRequestSchema,
  ResizePtyRequestSchema,
  ExecTerminalRequestSchema,
  ExportTerminalQuerySchema,
  ExposeTerminalRequestSchema,
  ImportTerminalRequestSchema,
  StartServiceRequestSchema,
  StartTerminalRequestSchema,
  WorkspaceIdSchema,
  parsePort,
  type FsDeleteQuery,
  type FsListQuery,
  type FsMkdirBody,
  type FsReadQuery,
  type FsWriteBody,
  type OpenPtyRequest,
  type PtyInputRequest,
  type ResizePtyRequest,
  type ExecTerminalRequest,
  type ExportTerminalQuery,
  type ExposeTerminalRequest,
  type ImportTerminalRequest,
  type StartServiceRequest,
  type StartTerminalRequest,
} from './terminal-request.schema';
import {
  TerminalPtyService,
  type PtyStreamEvent,
} from './terminal-pty.service';
import { TerminalWorkspaceService } from './terminal.service';
import type {
  TerminalExportResult,
  TerminalFsFile,
  TerminalFsList,
  TerminalFsWritten,
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
  constructor(
    private readonly terminal: TerminalWorkspaceService,
    private readonly pty: TerminalPtyService,
  ) {}

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

  // ── Terminal interactiva (PTY) ────────────────────────────────────────
  // Solo la usa Jin_Core; el Executor transporta bytes y no audita (Core sí).

  @Post(':workspaceId/pty')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Abre una terminal interactiva (TTY) en el workspace',
  })
  async openPty(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body(new ZodValidationPipe(OpenPtyRequestSchema)) body: OpenPtyRequest,
  ): Promise<{ ptyId: string }> {
    return this.pty.open(this.workspaceIdOrFail(rawWorkspaceId), body);
  }

  /**
   * Salida de la terminal como NDJSON: `{t:'out', d:<base64>}` por chunk y una
   * línea final (`exit` o `error`). Si el cliente se va, la sesión sigue viva y
   * puede volver a pedir este stream.
   */
  @Get(':workspaceId/pty/:ptyId/output')
  @ApiOperation({
    summary: 'Salida en vivo de la terminal interactiva (NDJSON)',
  })
  async ptyOutput(
    @Param('workspaceId') rawWorkspaceId: string,
    @Param('ptyId') rawPtyId: string,
    @Res() res: Response,
  ): Promise<void> {
    const workspaceId = this.workspaceIdOrFail(rawWorkspaceId);
    const ptyId = this.ptyIdOrFail(rawPtyId);
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let started = false;
    const listener = (event: PtyStreamEvent): boolean => {
      if (!started) {
        started = true;
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }
      res.write(`${JSON.stringify(event)}\n`);
      return res.writableLength < MAX_PTY_PENDING_OUTPUT_BYTES;
    };

    try {
      await this.pty.subscribe(workspaceId, ptyId, listener, controller.signal);
    } catch (error) {
      if (started) {
        listener({
          t: 'error',
          message:
            error instanceof Error ? error.message : 'Falló la terminal.',
        });
      } else {
        throw error;
      }
    }
    if (!started) {
      // Suscripción cortada por el cliente antes de que hubiera salida.
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    }
    res.end();
  }

  @Post(':workspaceId/pty/:ptyId/input')
  @HttpCode(204)
  @ApiOperation({ summary: 'Manda bytes del teclado a la terminal (base64)' })
  ptyInput(
    @Param('workspaceId') rawWorkspaceId: string,
    @Param('ptyId') rawPtyId: string,
    @Body(new ZodValidationPipe(PtyInputRequestSchema)) body: PtyInputRequest,
  ): void {
    this.pty.write(
      this.workspaceIdOrFail(rawWorkspaceId),
      this.ptyIdOrFail(rawPtyId),
      Buffer.from(body.data, 'base64'),
    );
  }

  @Post(':workspaceId/pty/:ptyId/resize')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cambia el tamaño de la terminal interactiva' })
  ptyResize(
    @Param('workspaceId') rawWorkspaceId: string,
    @Param('ptyId') rawPtyId: string,
    @Body(new ZodValidationPipe(ResizePtyRequestSchema))
    body: ResizePtyRequest,
  ): void {
    this.pty.resize(
      this.workspaceIdOrFail(rawWorkspaceId),
      this.ptyIdOrFail(rawPtyId),
      body,
    );
  }

  @Delete(':workspaceId/pty/:ptyId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cierra la terminal interactiva' })
  ptyClose(
    @Param('workspaceId') rawWorkspaceId: string,
    @Param('ptyId') rawPtyId: string,
  ): void {
    this.pty.close(
      this.workspaceIdOrFail(rawWorkspaceId),
      this.ptyIdOrFail(rawPtyId),
    );
  }

  // ── Explorador de archivos del pod ────────────────────────────────────

  @Get(':workspaceId/fs/list')
  @ApiOperation({ summary: 'Lista una carpeta del disco del proyecto' })
  fsList(
    @Param('workspaceId') rawWorkspaceId: string,
    @Query(new ZodValidationPipe(FsListQuerySchema)) query: FsListQuery,
  ): Promise<TerminalFsList> {
    return this.terminal.fsList(
      this.workspaceIdOrFail(rawWorkspaceId),
      query.path,
    );
  }

  @Get(':workspaceId/fs/file')
  @ApiOperation({
    summary: 'Lee un archivo de texto (UTF-8, hasta 512 KB) con su sha256',
  })
  fsRead(
    @Param('workspaceId') rawWorkspaceId: string,
    @Query(new ZodValidationPipe(FsReadQuerySchema)) query: FsReadQuery,
  ): Promise<TerminalFsFile> {
    return this.terminal.fsRead(
      this.workspaceIdOrFail(rawWorkspaceId),
      query.path,
    );
  }

  @Put(':workspaceId/fs/file')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Crea o guarda un archivo de texto (atómico). Con expectedSha256, 409 si cambió en el pod',
  })
  fsWrite(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body(new ZodValidationPipe(FsWriteBodySchema)) body: FsWriteBody,
  ): Promise<TerminalFsWritten> {
    return this.terminal.fsWrite(this.workspaceIdOrFail(rawWorkspaceId), body);
  }

  @Post(':workspaceId/fs/dir')
  @HttpCode(204)
  @ApiOperation({ summary: 'Crea una carpeta (y las que falten)' })
  async fsMkdir(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body(new ZodValidationPipe(FsMkdirBodySchema)) body: FsMkdirBody,
  ): Promise<void> {
    await this.terminal.fsMkdir(
      this.workspaceIdOrFail(rawWorkspaceId),
      body.path,
    );
  }

  @Delete(':workspaceId/fs/entry')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Borra un archivo o una carpeta vacía (no recursivo)',
  })
  async fsDelete(
    @Param('workspaceId') rawWorkspaceId: string,
    @Query(new ZodValidationPipe(FsDeleteQuerySchema)) query: FsDeleteQuery,
  ): Promise<void> {
    await this.terminal.fsDelete(
      this.workspaceIdOrFail(rawWorkspaceId),
      query.path,
    );
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
  private ptyIdOrFail(raw: string): string {
    const result = PtyIdSchema.safeParse(raw);
    if (!result.success)
      throw new BadRequestException('Id de terminal inválido.');
    return result.data;
  }

  private workspaceIdOrFail(raw: string): string {
    const result = WorkspaceIdSchema.safeParse(raw);
    if (!result.success)
      throw new BadRequestException('Id de proyecto inválido.');
    return result.data;
  }
}

/** Salida sin consumir que se tolera hacia Core antes de cerrar la terminal (no se acumula memoria sin límite). */
const MAX_PTY_PENDING_OUTPUT_BYTES = 1024 * 1024;

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

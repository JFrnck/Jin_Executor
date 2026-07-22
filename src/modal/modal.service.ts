import { Injectable } from '@nestjs/common';
import type { ExecutionResult } from '../execute/execution-result';
import type { ExecutorToolDefinition } from '../rbac/tool-whitelist';
import { ModalNotImplementedError } from './errors';

/**
 * Cliente de Modal (BLUEPRINT 4.5) para `remote: true`. Stub por diseño
 * (PROMPTS.md 2.3) — el SDK real y la lógica de cuándo escalar a Modal
 * (tarea >5min, >4GB RAM, librerías Python científicas, GPU) llegan en
 * la Fase 5.
 */
@Injectable()
export class ModalService {
  runRemote(
    _tool: ExecutorToolDefinition,
    _code: string,
    _env: Readonly<Record<string, string>>,
  ): Promise<ExecutionResult> {
    throw new ModalNotImplementedError();
  }
}

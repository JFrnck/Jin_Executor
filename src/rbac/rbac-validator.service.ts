import { Injectable } from '@nestjs/common';
import { ForbiddenToolError } from './errors';
import {
  getExecutorToolDefinition,
  type ExecutorToolDefinition,
} from './tool-whitelist';

/**
 * Única puerta de entrada: ninguna tool corre sin pasar por aquí primero
 * (BLUEPRINT 4.2). Fail-safe — tool no encontrada = rechazo, nunca default
 * permisivo (AGENTS.md 1.4).
 */
@Injectable()
export class RbacValidatorService {
  validate(toolName: string): ExecutorToolDefinition {
    const tool = getExecutorToolDefinition(toolName);
    if (!tool) {
      throw new ForbiddenToolError(toolName);
    }
    return tool;
  }
}

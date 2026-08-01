import { describe, expect, it } from 'vitest';
import { ForbiddenToolError } from './errors';
import { RbacValidatorService } from './rbac-validator.service';
import { isRunToCompletionTool } from './tool-whitelist';

describe('RbacValidatorService', () => {
  const service = new RbacValidatorService();

  it('acepta runCode y devuelve su definición completa', () => {
    const tool = service.validate('runCode');
    expect(tool.name).toBe('runCode');
    if (!isRunToCompletionTool(tool)) {
      throw new Error('runCode debe ser una tool run-to-completion');
    }
    expect(tool.maxTimeoutSeconds).toBe(300);
  });

  it('acepta startPreviewService (Fase 5.5) como service tool', () => {
    const tool = service.validate('startPreviewService');
    expect(tool.name).toBe('startPreviewService');
    expect(tool.isServiceTool).toBe(true);
  });

  it('rechaza con ForbiddenToolError (403) una tool fuera de whitelist', () => {
    expect(() => service.validate('deleteEverything')).toThrow(
      ForbiddenToolError,
    );

    let caught: unknown;
    try {
      service.validate('deleteEverything');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenToolError);
    expect((caught as ForbiddenToolError).httpStatus).toBe(403);
    expect((caught as ForbiddenToolError).code).toBe(
      'RBAC_TOOL_NOT_WHITELISTED',
    );
  });
});

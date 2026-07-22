import { describe, expect, it } from 'vitest';
import { ForbiddenToolError, UnresolvedEgressWhitelistError } from './errors';

describe('ForbiddenToolError', () => {
  it('lleva code RBAC_TOOL_NOT_WHITELISTED y httpStatus 403', () => {
    const error = new ForbiddenToolError('deleteEverything');
    expect(error.code).toBe('RBAC_TOOL_NOT_WHITELISTED');
    expect(error.httpStatus).toBe(403);
    expect(error.message).toContain('deleteEverything');
  });
});

describe('UnresolvedEgressWhitelistError', () => {
  // Ninguna tool registrada hoy tiene egressWhitelist no vacío (ver
  // tool-whitelist.ts), así que este camino no se ejercita a través de
  // PodLifecycleService con el registry real — se prueba la clase en
  // sí misma directamente.
  it('lleva code RBAC_EGRESS_UNRESOLVED y httpStatus 501, mencionando los dominios', () => {
    const error = new UnresolvedEgressWhitelistError('futureTool', [
      'api.example.com',
    ]);
    expect(error.code).toBe('RBAC_EGRESS_UNRESOLVED');
    expect(error.httpStatus).toBe(501);
    expect(error.message).toContain('futureTool');
    expect(error.message).toContain('api.example.com');
  });
});

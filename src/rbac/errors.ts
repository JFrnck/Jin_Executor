import { YormunError } from '../common/errors/yormun-error';

/** Tool fuera de whitelist (BLUEPRINT 4.2). Mapeada a HTTP 403 por el exception filter global. */
export class ForbiddenToolError extends YormunError {
  constructor(toolName: string) {
    super(`Tool "${toolName}" no está en la whitelist del Executor.`, {
      code: 'RBAC_TOOL_NOT_WHITELISTED',
      httpStatus: 403,
    });
  }
}

/**
 * Se lanza si una tool declarara `egressWhitelist` no vacío: no existe
 * todavía resolución dominio→CIDR (ver tool-whitelist.ts). Fail-safe: es
 * preferible que el request falle ruidosamente a que el egreso se
 * conceda de forma incorrecta o silenciosamente amplia.
 */
export class UnresolvedEgressWhitelistError extends YormunError {
  constructor(toolName: string, domains: readonly string[]) {
    super(
      `La tool "${toolName}" declara egressWhitelist [${domains.join(', ')}] pero no existe ` +
        'resolución dominio→CIDR todavía (pendiente para Fase 5). No se crea el pod.',
      { code: 'RBAC_EGRESS_UNRESOLVED', httpStatus: 501 },
    );
  }
}

import { InfisicalSDK } from '@infisical/sdk';

// Ver Jin_Core/src/config/secrets-loader.ts para el diseño completo
// (misma mecánica en ambos repos, Fase 8.1). Acá solo cambian las claves
// que este servicio necesita: Executor solo habla con Modal, no con
// ninguna de las 13 de Jin_Core -- identidad de máquina propia y separada
// en Infisical (menor privilegio, ver AGENTS.md §5.3).
const REQUIRED_SECRET_KEYS = ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'] as const;

function requireVar(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(
      `Infisical: falta la variable de configuración ${key} (requerida cuando INFISICAL_ENABLED=true)`,
    );
  }
  return value;
}

/**
 * Carga los secretos reales de Jin_Executor desde Infisical y los vuelca
 * a `process.env`. No-op si `INFISICAL_ENABLED` no es `'true'` -- el
 * camino de desarrollo local con `.env` queda intacto.
 */
export async function loadSecrets(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.INFISICAL_ENABLED !== 'true') return;

  const clientId = requireVar(env, 'INFISICAL_CLIENT_ID');
  const clientSecret = requireVar(env, 'INFISICAL_CLIENT_SECRET');
  const projectId = requireVar(env, 'INFISICAL_PROJECT_ID');
  const environment = env.INFISICAL_ENVIRONMENT ?? 'prod';

  // REQUERIDA, sin fallback: si no está, el SDK apunta por defecto a
  // `app.infisical.com` — la nube de un TERCERO — y le manda estas
  // credenciales. Pasó en el primer despliegue real (2026-09-21): el
  // Deployment no la definía, el default de Zod no aplica acá (esto corre
  // antes de que Nest exista) y ambos servicios mandaron su clientId/secret
  // a Infisical Cloud, que respondió 401. Jin es self-hosted (BLUEPRINT §11):
  // una configuración incompleta tiene que fallar ruidosamente, nunca
  // filtrar credenciales a un servicio externo por omisión.
  const siteUrl = requireVar(env, 'INFISICAL_SITE_URL');

  const client = new InfisicalSDK({ siteUrl });
  await client.auth().universalAuth.login({ clientId, clientSecret });
  const { secrets } = await client
    .secrets()
    .listSecrets({ projectId, environment });

  const byKey = new Map(secrets.map((s) => [s.secretKey, s.secretValue]));
  const missing = REQUIRED_SECRET_KEYS.filter((key) => !byKey.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Infisical: faltan secretos requeridos en el proyecto/environment configurado: ${missing.join(', ')}`,
    );
  }

  for (const key of REQUIRED_SECRET_KEYS) {
    env[key] = byKey.get(key);
  }
}

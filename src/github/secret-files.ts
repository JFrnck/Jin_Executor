/**
 * Archivos que parecen secretos (`.env*`, claves, `.npmrc`…): no se suben a GitHub desde Jin. Las MISMAS
 * reglas que Jin_Core (preview-template.logic.ts) y la app; `.env.example|sample|template` se permiten.
 */
const SECRET_FILE_PATTERN =
  /^(\.env(\..+)?|.+\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\..*)?|\.npmrc|\.netrc|brevo\.json)$/i;
const TEMPLATE_SUFFIX = /\.(example|sample|template)$/i;

export function findSecretPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const base = path.split('/').pop() ?? path;
    return SECRET_FILE_PATTERN.test(base) && !TEMPLATE_SUFFIX.test(base);
  });
}

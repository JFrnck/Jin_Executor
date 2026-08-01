import { randomBytes } from 'node:crypto';

// DNS-1035: label alfanumérico en minúscula, empieza con letra, guiones
// solo internos, <=63 chars. Un Service/Pod name de K8s ya exige esto —
// se aplica acá temprano para fallar con un mensaje claro, no un 422 de
// la API de Kubernetes.
const MAX_LABEL_LENGTH = 63;
const RANDOM_SUFFIX_LENGTH = 6;
// Separador (1) + sufijo — lo que le queda disponible a la parte legible.
const MAX_READABLE_LENGTH = MAX_LABEL_LENGTH - RANDOM_SUFFIX_LENGTH - 1;
const DEFAULT_READABLE = 'preview';

function toKebabCase(input: string): string {
  const kebab = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (kebab.length === 0) {
    return DEFAULT_READABLE;
  }
  // DNS-1035 (validación real de un Service de Kubernetes) exige empezar
  // con una letra — un hint que arranca en dígito ("123demo") no alcanza.
  return /^[a-z]/.test(kebab) ? kebab : `p-${kebab}`;
}

/** Base36, en minúscula, sin el riesgo de mayúsculas que rompería DNS-1035. */
function randomSuffix(): string {
  return randomBytes(8).toString('hex').slice(0, RANDOM_SUFFIX_LENGTH);
}

/**
 * `<nombre-legible>-<sufijo aleatorio>` (ADR 0006 punto 9). El sufijo es
 * la ÚNICA barrera real contra quien adivine la URL — no hay login
 * delante de una preview — así que un slug derivado solo de `hint`
 * (predecible) queda explícitamente prohibido por diseño: siempre se
 * agrega el sufijo, sin excepción ni override.
 */
export function generateSlug(hint?: string): string {
  const readable = toKebabCase(hint ?? DEFAULT_READABLE).slice(
    0,
    MAX_READABLE_LENGTH,
  );
  return `${readable}-${randomSuffix()}`;
}

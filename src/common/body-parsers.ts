import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Tope del cuerpo JSON de cualquier endpoint del Executor. El de Express por defecto es
 * 100 KB y cortaba con 413 un "Publicar" válido: el proyecto admite hasta 256 KB de
 * archivos (Jin_Core PUBLISH_MAX_TOTAL_BYTES) y el JSON los escapa (comillas, saltos de
 * línea, `\u00XX`), así que el cuerpo real puede acercarse al doble. 1 MB deja holgura
 * sin abrir la puerta a cuerpos arbitrarios (el límite sigue existiendo).
 */
export const JSON_BODY_LIMIT = '1mb';

/** Requiere crear la app con `{ bodyParser: false }` para que este sea el único parser. */
export function configureBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
}

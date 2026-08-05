import { gzipSync } from 'node:zlib';

// Formato USTAR (POSIX tar) armado a mano — cero dependencias nuevas
// (ADR 0006 punto 12 ya agrega @nestjs/schedule; no sumar una segunda).
// Alcance deliberadamente acotado a lo que necesita esta fase: archivos
// de texto plano regulares, sin symlinks/permisos especiales, rutas
// <=100 bytes (el campo `prefix` de USTAR para rutas más largas no está
// implementado — falla ruidoso si se excede, ver `buildTarGzBase64`).
const BLOCK_SIZE = 512;
const NAME_FIELD_LENGTH = 100;
const MAX_FILE_SIZE_OCTAL = 0o7_777_777_777; // 12 dígitos octales, ~8GiB

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function writeString(
  buf: Buffer,
  offset: number,
  value: string,
  length: number,
): void {
  buf.write(value, offset, length, 'utf-8');
}

function buildHeader(path: string, size: number, mtime: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  writeString(header, 0, path, NAME_FIELD_LENGTH);
  writeString(header, 100, '0000644\0', 8); // mode: rw-r--r--
  writeString(header, 108, '0000000\0', 8); // uid
  writeString(header, 116, '0000000\0', 8); // gid
  writeString(header, 124, octal(size, 12), 12);
  writeString(header, 136, octal(mtime, 12), 12);
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder: 8 espacios
  header.write('0', 156, 1, 'ascii'); // typeflag: archivo regular
  writeString(header, 257, 'ustar\0', 6); // magic
  writeString(header, 263, '00', 2); // version
  writeString(header, 265, 'jin', 32); // uname
  writeString(header, 297, 'jin', 32); // gname

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  // Formato estándar del campo chksum: 6 dígitos octales + NUL + espacio
  // (8 bytes) — NO los 7 dígitos + NUL que usa octal() para el resto de
  // los campos numéricos.
  writeString(header, 148, checksum.toString(8).padStart(6, '0') + '\0 ', 8);

  return header;
}

function padToBlockBoundary(buf: Buffer): Buffer {
  const remainder = buf.length % BLOCK_SIZE;
  if (remainder === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(BLOCK_SIZE - remainder)]);
}

/**
 * Zip-slip (docs/RECOMENDACIONES.md #10): una clave de `files` como
 * `"../../app/evil.js"` escribiría fuera de `/workspace` al extraerse —
 * el `hitlLevel: confirm` de `startPreviewService` no lo cubre, el owner
 * aprueba un `planSummary`, no audita cada clave del mapa. Por segmento,
 * no por substring: `"foo..bar.js"` es un nombre de archivo legítimo,
 * `"sub/../../escape.js"` no lo es.
 */
export function isSafeRelativePath(path: string): boolean {
  return !path.startsWith('/') && !path.split('/').includes('..');
}

/**
 * Empaqueta `files` (ruta relativa -> contenido) a un tar.gz, devuelto
 * como base64 — mismo espíritu que el `data:` URL de `buildPodSpec`
 * (Fase 2.3): un solo string, `args` de Kubernetes nunca pasa por una
 * shell, sin necesidad de ConfigMap.
 */
export function buildTarGzBase64(
  files: Readonly<Record<string, string>>,
): string {
  const mtime = Math.floor(Date.now() / 1000);
  const entries: Buffer[] = [];

  for (const [path, content] of Object.entries(files)) {
    if (!isSafeRelativePath(path)) {
      throw new Error(
        `tar-payload: la ruta "${path}" es insegura (absoluta o contiene ".."): escaparía de /workspace al extraerse.`,
      );
    }
    if (Buffer.byteLength(path, 'utf-8') >= NAME_FIELD_LENGTH) {
      throw new Error(
        `tar-payload: la ruta "${path}" excede ${NAME_FIELD_LENGTH - 1} bytes (sin soporte de prefix largo).`,
      );
    }
    const contentBuf = Buffer.from(content, 'utf-8');
    if (contentBuf.length > MAX_FILE_SIZE_OCTAL) {
      throw new Error(
        `tar-payload: "${path}" excede el tamaño máximo soportado.`,
      );
    }
    entries.push(buildHeader(path, contentBuf.length, mtime));
    entries.push(padToBlockBoundary(contentBuf));
  }

  // Fin de archivo: dos bloques de 512 bytes en cero.
  entries.push(Buffer.alloc(BLOCK_SIZE * 2));

  const tar = Buffer.concat(entries);
  return gzipSync(tar).toString('base64');
}

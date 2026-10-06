import { Injectable } from '@nestjs/common';
import { K8sService } from '../k8s/k8s.service';
import { TERMINAL_CONTAINER_NAME } from '../k8s/labels';
import { TerminalWorkspaceService } from '../terminal/terminal.service';
import { GithubInvalidInputError } from './errors';

/**
 * Disco del workspace de una terminal visto como "archivos que van y vienen en un tar". Es lo único que
 * el Executor necesita para correr git sobre una COPIA temporal: ni git ni salida a GitHub dentro del pod
 * (ADR 0019). Una interfaz para poder probar la lógica de git sin Kubernetes.
 */
export interface WorkspaceFs {
  /** tar del contenido de `dir` (sin node_modules ni cachés), con su `.git`. */
  exportTar(workspaceId: string, dir: string): Promise<Buffer>;
  /** Reemplaza el contenido de `dir` por el del tar, conservando node_modules y las carpetas del entorno. */
  replaceFromTar(workspaceId: string, dir: string, tar: Buffer): Promise<void>;
  /** ¿`dir` no existe o está vacío? */
  isEmpty(workspaceId: string, dir: string): Promise<boolean>;
}

export const WORKSPACE_FS = Symbol('WORKSPACE_FS');

/** Carpetas del entorno del workspace que nunca viajan ni se pisan. */
export const PRESERVED_NAMES = [
  'node_modules',
  '.jin',
  '.npm',
  '.cache',
  '.vite',
  '.turbo',
  '.home',
  '.npm-global',
] as const;

/** Tope de lo que se copia del pod al Executor (memoria del Executor). */
export const MAX_TAR_BYTES = 200 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 5 * 60_000;

const ROOT = '/workspace';

/**
 * Script de `sh` que reemplaza el contenido de `$1` por el tar de stdin, conservando lo preservado.
 * Extrae primero a un temporal del mismo disco (si tar falla, no se toca nada: `set -e`), borra lo viejo
 * y mueve lo nuevo. Exportado para probarlo con `sh` de verdad.
 */
export function buildReplaceScript(root: string): string {
  const keep = PRESERVED_NAMES.map((name) => `! -name '${name}'`).join(' ');
  return [
    'set -e',
    'd="$1"',
    'mkdir -p "$d"',
    `t="$(mktemp -d ${root}/.jin-tmp-XXXXXX)"`,
    `trap 'rm -rf "$t"' EXIT`,
    'tar -xf - -C "$t"',
    `find "$d" -mindepth 1 -maxdepth 1 ! -name '.jin-tmp-*' ${keep} -exec rm -rf {} +`,
    'find "$t" -mindepth 1 -maxdepth 1 -exec mv {} "$d"/ \\;',
  ].join('\n');
}

export function workspacePath(dir: string): string {
  if (dir === '.' || dir === '') return ROOT;
  const parts = dir.split('/');
  if (
    dir.startsWith('/') ||
    dir.includes('\\') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new GithubInvalidInputError(`Carpeta no válida: ${dir}`);
  }
  return `${ROOT}/${dir}`;
}

interface BinaryExec {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

@Injectable()
export class PodWorkspaceFs implements WorkspaceFs {
  constructor(
    private readonly k8s: K8sService,
    private readonly terminals: TerminalWorkspaceService,
  ) {}

  async exportTar(workspaceId: string, dir: string): Promise<Buffer> {
    const pod = await this.terminals.requirePodForPty(workspaceId);
    const excludes = PRESERVED_NAMES.flatMap((name) => [
      '--exclude',
      `./${name}`,
    ]);
    const result = await this.exec(
      pod,
      ['tar', '-cf', '-', ...excludes, '-C', workspacePath(dir), '.'],
      undefined,
      MAX_TAR_BYTES,
    );
    if (result.code !== 0) {
      throw new GithubInvalidInputError(
        `No se pudo leer la carpeta del proyecto: ${result.stderr.slice(0, 200)}`,
      );
    }
    return result.stdout;
  }

  async replaceFromTar(
    workspaceId: string,
    dir: string,
    tar: Buffer,
  ): Promise<void> {
    const pod = await this.terminals.requirePodForPty(workspaceId);
    const script = buildReplaceScript(ROOT);
    const result = await this.exec(
      pod,
      ['sh', '-c', script, 'sh', workspacePath(dir)],
      tar,
      1024,
    );
    if (result.code !== 0) {
      throw new GithubInvalidInputError(
        `No se pudieron escribir los archivos en el proyecto: ${result.stderr.slice(0, 200)}`,
      );
    }
  }

  async isEmpty(workspaceId: string, dir: string): Promise<boolean> {
    const pod = await this.terminals.requirePodForPty(workspaceId);
    const result = await this.exec(
      pod,
      [
        'sh',
        '-c',
        'if [ -d "$1" ]; then find "$1" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .jin ! -name .home ! -name .npm ! -name .cache ! -name .npm-global ! -name data ! -name dist ! -name \'.jin-tmp-*\' | head -1; fi',
        'sh',
        workspacePath(dir),
      ],
      undefined,
      4096,
    );
    return result.code === 0 && result.stdout.toString('utf8').trim() === '';
  }

  private async exec(
    pod: string,
    command: readonly string[],
    stdin: Buffer | undefined,
    maxStdoutBytes: number,
  ): Promise<BinaryExec> {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let stderr = '';
    const execution = await this.k8s.execInPod(pod, {
      container: TERMINAL_CONTAINER_NAME,
      command,
      ...(stdin ? { stdin } : {}),
      onStdout: (chunk) => {
        size += chunk.length;
        if (size > maxStdoutBytes) {
          overflow = true;
          return;
        }
        chunks.push(chunk);
      },
      onStderr: (chunk) => {
        if (stderr.length < 2048) stderr += chunk.toString('utf8');
      },
    });
    const watchdog = setTimeout(() => execution.abort(), EXEC_TIMEOUT_MS);
    try {
      const code = await execution.exitCode;
      if (overflow) {
        throw new GithubInvalidInputError(
          `El proyecto supera el tope de ${Math.round(maxStdoutBytes / 1024 / 1024)} MB para operar con git. Excluye lo que no sea código (builds, datos).`,
        );
      }
      return { code, stdout: Buffer.concat(chunks), stderr };
    } finally {
      clearTimeout(watchdog);
    }
  }
}

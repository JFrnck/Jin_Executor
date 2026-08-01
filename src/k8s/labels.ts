/** Label compartido entre el Pod y su NetworkPolicy — la correlación entre ambos. */
export const RUN_ID_LABEL = 'jin.io/run-id';

export function podNameForRun(runId: string): string {
  return `agent-run-${runId}`;
}

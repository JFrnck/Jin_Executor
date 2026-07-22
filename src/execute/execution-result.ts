export interface ExecutionResult {
  readonly runId: string;
  readonly succeeded: boolean;
  readonly logs: string;
}

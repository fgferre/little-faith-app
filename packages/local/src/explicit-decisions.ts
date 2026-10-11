const executions = new Map<string, Promise<unknown>>();

export function assertApprovalOnline(decision: string): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(`Conecte-se à internet para confirmar ${decision}. A proposta continua salva.`);
  }
}

export function receiptNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}

/** Decision callers require a human; the evidence namespace only uploads original files. */
export function withExplicitDecisionLock<T>(
  namespace: string,
  databaseName: string,
  key: string,
  execute: () => Promise<T>,
): Promise<T> {
  const lockName = `bolao-${namespace}:${databaseName}:${key}`;
  const running = executions.get(lockName);
  if (running) return running as Promise<T>;
  const task = (async () => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(lockName, execute);
    }
    return execute();
  })();
  const tracked = task.finally(() => {
    if (executions.get(lockName) === tracked) executions.delete(lockName);
  });
  executions.set(lockName, tracked);
  return tracked;
}

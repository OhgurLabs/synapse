export function attachProcessAbort(promise, signal, abort = promise.abort) {
  if (!signal || !abort) return promise;
  const onAbort = () => abort();
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const result = promise.finally(() => signal.removeEventListener('abort', onAbort));
  result.abort = abort;
  return result;
}

export function terminateProcessGroup(child, graceMs) {
  if (!child?.pid) return;
  const pid = child.pid;
  try { process.kill(-pid, 'SIGTERM'); } catch { return; }
  const timer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
  }, graceMs);
  timer.unref();
}

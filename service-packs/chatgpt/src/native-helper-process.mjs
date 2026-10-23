import { execFileSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BUFFER_BYTES = 262_144;

export function runNativeHelperProcess(executable, args, { input, env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('NATIVE_HELPER_TIMEOUT_INVALID');
  }
  try {
    return execFileSync(executable, args, {
      env,
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch (cause) {
    const timedOut = cause?.code === 'ETIMEDOUT' || cause?.killed === true;
    const exited = Number.isInteger(cause?.status);
    const error = new Error(timedOut ? 'NATIVE_HELPER_TIMEOUT'
      : exited ? 'NATIVE_HELPER_EXIT' : 'NATIVE_HELPER_LAUNCH_FAILED');
    error.code = timedOut ? 'NATIVE_HELPER_TIMEOUT'
      : exited ? 'NATIVE_HELPER_EXIT' : 'NATIVE_HELPER_LAUNCH_FAILED';
    error.providerCause = timedOut ? 'ETIMEDOUT'
      : exited ? 'HELPER_EXIT' : cause?.code ? 'PROCESS_LAUNCH_OR_EXIT' : 'HELPER_FAILURE';
    if (exited) error.exitStatus = cause.status;
    if (typeof cause?.stderr === 'string') error.stderr = cause.stderr;
    throw error;
  }
}


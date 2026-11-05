export class AppError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); this.name = "AppError"; }
}
export function failure(error: unknown) {
  return { code: error instanceof AppError ? error.code : "EXECUTION_FAILED", message: error instanceof Error ? error.message : String(error) };
}
export function check(condition: unknown, code: string, message: string, statusCode?: number): asserts condition {
  if (!condition) throw new AppError(code, message, statusCode);
}

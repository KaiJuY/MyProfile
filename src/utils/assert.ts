/**
 * Tiny assertion helper. Throws a labeled Error in dev so we fail fast instead
 * of silently producing NaN matrices or null derefs. Intentionally narrow type:
 * accepts any truthy value as the assertion subject.
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[assert] ${message}`);
  }
}

/** Asserts a value is non-null and non-undefined, narrowing the type. */
export function assertDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(`[assertDefined] ${message}`);
  }
  return value;
}

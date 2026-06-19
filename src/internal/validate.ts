export function positiveIntegerOptionError(value: unknown, label: string): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return `${label} must be a positive integer, got ${String(value)}`;
  }
  return null;
}

export function finiteNumberError(value: unknown, label: string): string | null {
  if (!Number.isFinite(value)) {
    return `${label} must be a finite number, got ${String(value)}`;
  }
  return null;
}

export function nonNegativeIntegerOptionError(value: unknown, label: string): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return `${label} must be a non-negative integer, got ${String(value)}`;
  }
  return null;
}

export function literalOptionError<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): string | null {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return `${label} must be one of ${allowed.map((v) => `'${v}'`).join(', ')}, got ${String(value)}`;
  }
  return null;
}

export function stringArrayOptionError(value: unknown, label: string): string | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return `${label} must be an array of strings`;
  }
  return null;
}

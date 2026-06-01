export function positiveIntegerOptionError(value: number, label: string): string | null {
  if (!Number.isInteger(value) || value <= 0) {
    return `${label} must be a positive integer, got ${String(value)}`;
  }
  return null;
}

export function finiteNumberError(value: number, label: string): string | null {
  if (!Number.isFinite(value)) {
    return `${label} must be a finite number, got ${String(value)}`;
  }
  return null;
}

export function nonNegativeIntegerOptionError(value: number, label: string): string | null {
  if (!Number.isInteger(value) || value < 0) {
    return `${label} must be a non-negative integer, got ${String(value)}`;
  }
  return null;
}

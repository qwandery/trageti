import { ErrorCode, TragetiError } from '../errors/index.js';

export type VectorLike = Float32Array | number[];

export function vectorValidationError(
  vector: VectorLike,
  expectedDimension: number | null,
  label: string,
): string | null {
  if (expectedDimension !== null && vector.length !== expectedDimension) {
    return `${label} length ${String(vector.length)} does not match expected dimension ${String(expectedDimension)}`;
  }
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `${label}[${String(i)}] must be a finite number, got ${String(value)}`;
    }
  }
  return null;
}

export function toFloat32Array(vector: VectorLike): Float32Array {
  return vector instanceof Float32Array ? vector : new Float32Array(vector);
}

export function assertVec0DimensionInvariant(dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new TragetiError(
      ErrorCode.INTERNAL_INVARIANT,
      `Invalid vec0 dimension ${String(dimension)} reached DDL generation`,
    );
  }
}

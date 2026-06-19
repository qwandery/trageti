import { join } from 'node:path';
import type { NewEpisodeInput } from 'trageti';
import { atomicWriteJson, readJsonStrict } from './state.js';

export const PREPARED_ARTIFACT_VERSION = 1;

export interface PreparedIngestionUnit {
  id: string;
  episode: NewEpisodeInput;
  document: string;
  citationSources: Record<string, string>;
  imageSources?: Record<string, PreparedImageSource>;
  metadata?: Record<string, unknown>;
}

export interface PreparedDemoArtifact {
  artifactVersion: number;
  scenario: string;
  namespace: string;
  preparedAt: string;
  dataVersion: string;
  units: PreparedIngestionUnit[];
  metadata?: Record<string, unknown>;
}

export interface PreparedImageSource {
  path: string;
  mimeType: string;
}

export function preparedArtifactPath(scenario: string): string {
  return join('demos', '.local', 'prepared', scenario, 'prepared.json');
}

export function writePreparedArtifact(path: string, artifact: PreparedDemoArtifact): void {
  atomicWriteJson(path, validatePreparedArtifact(artifact, path));
}

export function readPreparedArtifact(path: string): PreparedDemoArtifact {
  return readJsonStrict(path, validatePreparedArtifact);
}

export function validatePreparedArtifact(value: unknown, path = 'prepared artifact'): PreparedDemoArtifact {
  if (value === null || typeof value !== 'object') throw new Error(`${path} is not a JSON object`);
  const artifact = value as Partial<PreparedDemoArtifact>;
  if (artifact.artifactVersion !== PREPARED_ARTIFACT_VERSION) {
    throw new Error(
      `${path} has unsupported artifactVersion ${String(artifact.artifactVersion)}; expected ${String(
        PREPARED_ARTIFACT_VERSION,
      )}`,
    );
  }
  if (!nonEmpty(artifact.scenario)) throw new Error(`${path} is missing scenario`);
  if (!nonEmpty(artifact.namespace)) throw new Error(`${path} is missing namespace`);
  if (!nonEmpty(artifact.dataVersion)) throw new Error(`${path} is missing dataVersion`);
  if (!Array.isArray(artifact.units)) throw new Error(`${path} is missing units[]`);
  for (const unit of artifact.units) validatePreparedUnit(unit, path);
  return artifact as PreparedDemoArtifact;
}

function validatePreparedUnit(unit: unknown, path: string): void {
  if (unit === null || typeof unit !== 'object') throw new Error(`${path} contains a non-object unit`);
  const row = unit as Partial<PreparedIngestionUnit>;
  if (!nonEmpty(row.id)) throw new Error(`${path} contains a unit without id`);
  if (!nonEmpty(row.document)) throw new Error(`${path} unit ${row.id} is missing document`);
  if (row.episode === null || typeof row.episode !== 'object') {
    throw new Error(`${path} unit ${row.id} is missing episode`);
  }
  if (row.citationSources === null || typeof row.citationSources !== 'object') {
    throw new Error(`${path} unit ${row.id} is missing citationSources`);
  }
  if (row.imageSources !== undefined && (row.imageSources === null || typeof row.imageSources !== 'object')) {
    throw new Error(`${path} unit ${row.id} has invalid imageSources`);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

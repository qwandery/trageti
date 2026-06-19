import { existsSync } from 'node:fs';
import { TragetiStore } from 'trageti';
import {
  preparedArtifactPath,
  readPreparedArtifact,
  writePreparedArtifact,
  type PreparedDemoArtifact,
} from './artifacts.js';
import { createDemoLogger, createLlmTraceOptions, printBanner, printResolvedProviderSummary } from './output.js';
import type { ResolvedDemoProviders } from './providers.js';
import { ingestPreparedUnits, prepareDemoStore, type DemoRunLogger } from './runtime.js';
import { warmupDemoProviders } from './cli.js';
import type { ExtractionResult } from './ingest.js';
import type { Assertion, NewEpisodeInput } from 'trageti';

export type DemoPhase = 'prepare' | 'ingest' | 'retrieve' | 'run';

/** Stages a run can be resumed from (every phase except the composite 'run'). */
export type ResumeStage = 'prepare' | 'ingest' | 'retrieve';

const STAGE_TITLES: Record<ResumeStage, string> = {
  prepare: 'Prepare',
  ingest: 'Ingest',
  retrieve: 'Retrieve',
};

/**
 * Wraps a failure with the concrete stage that failed so the entry point can
 * print friendly resume instructions. During a `run`, the carried stage is the
 * sub-phase that failed (e.g. ingest), so the resume command points there and
 * not at `run`.
 */
export class DemoStageError extends Error {
  readonly demoTitle: string;
  readonly stageTitle: string;
  readonly scenarioName: string;
  readonly stageName: ResumeStage;

  constructor(scenario: DemoScenario, stageName: ResumeStage, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message, { cause });
    this.name = 'DemoStageError';
    this.demoTitle = scenario.title;
    this.stageTitle = STAGE_TITLES[stageName];
    this.scenarioName = scenario.name;
    this.stageName = stageName;
  }
}

async function runStage(scenario: DemoScenario, stageName: ResumeStage, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof DemoStageError) throw err;
    throw new DemoStageError(scenario, stageName, err);
  }
}

export interface DemoScenario {
  name: string;
  title: string;
  namespace: string;
  prepare(context: DemoScenarioContext): Promise<PreparedDemoArtifact>;
  resolveProviders(context: DemoScenarioContext, artifact: PreparedDemoArtifact): ResolvedDemoProviders;
  databasePath(context: DemoScenarioContext, artifact: PreparedDemoArtifact, providers: ResolvedDemoProviders): string;
  expectedFixtureAssertionIds?(
    artifact: PreparedDemoArtifact,
    providers: ResolvedDemoProviders,
  ): readonly string[] | undefined;
  sanitizeExtractionResult?(result: ExtractionResult, context: DemoSanitizerContext): ExtractionResult;
  sanitizeParsedExtractionResult?(result: ExtractionResult, context: DemoSanitizerContext): ExtractionResult;
  retrieve(
    context: DemoScenarioContext,
    artifact: PreparedDemoArtifact,
    providers: ResolvedDemoProviders,
    store: TragetiStore,
  ): Promise<void>;
}

export interface DemoSanitizerContext {
  episode: NewEpisodeInput;
  existingAssertions: readonly Assertion[];
  citationSources: Record<string, string>;
}

export interface DemoScenarioContext {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  trace: ReturnType<typeof createLlmTraceOptions>;
  logger: DemoRunLogger;
  artifactPath: string;
}

export async function runSharedDemoCli(options: {
  scenarios: readonly DemoScenario[];
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const { scenario, phase, scenarioArgv } = parseSharedDemoCommand(argv, options.scenarios);
  const trace = createLlmTraceOptions([...argv.slice(0, 2), ...scenarioArgv], env);
  const logger = createDemoLogger();
  const artifactPath = preparedArtifactPath(scenario.name);
  const context: DemoScenarioContext = {
    argv: [...argv.slice(0, 2), ...scenarioArgv],
    env,
    trace,
    logger,
    artifactPath,
  };

  printBanner(`${scenario.title} - ${phase}`);

  if (phase === 'prepare') {
    await runStage(scenario, 'prepare', () => preparePhase(scenario, context));
    logger.success('Demo preparation complete');
    return;
  }

  if (phase === 'run') {
    await runStage(scenario, 'prepare', () => preparePhase(scenario, context));
    await runStage(scenario, 'ingest', () => ingestPhase(scenario, context));
    await runStage(scenario, 'retrieve', () => retrievePhase(scenario, context));
    logger.success('Demo complete');
    return;
  }

  if (phase === 'ingest') {
    await runStage(scenario, 'ingest', () => ingestPhase(scenario, context));
    logger.success('Demo ingestion complete');
    return;
  }

  await runStage(scenario, 'retrieve', () => retrievePhase(scenario, context));
  logger.success('Demo retrieval complete');
}

async function preparePhase(scenario: DemoScenario, context: DemoScenarioContext): Promise<void> {
  context.logger.step('Preparing ingestion content');
  context.logger.detail(`Prepared artifact path: ${context.artifactPath}`);
  const artifact = await scenario.prepare(context);
  writePreparedArtifact(context.artifactPath, artifact);
  context.logger.success(
    `Prepared ${String(artifact.units.length)} ingestion unit(s) for ${artifact.scenario} (${artifact.dataVersion})`,
  );
}

async function ingestPhase(scenario: DemoScenario, context: DemoScenarioContext): Promise<void> {
  const artifact = readPreparedArtifact(context.artifactPath);
  assertScenarioArtifact(scenario, artifact, context.artifactPath);
  const providers = scenario.resolveProviders(context, artifact);
  const database = scenario.databasePath(context, artifact, providers);
  printResolvedProviderSummary({
    providers,
    namespace: artifact.namespace,
    database,
    rateLimitSeconds: rateLimitFromArgv(context.argv),
  });
  if (context.argv.includes('--warmup')) await warmupDemoProviders({ providers, logger: context.logger });
  const store = await prepareDemoStore({
    database,
    demoName: scenario.name,
    dataVersion: artifact.dataVersion,
    namespace: artifact.namespace,
    providers,
    logger: context.logger,
  });
  try {
    const expectedFixtureAssertionIds = scenario.expectedFixtureAssertionIds?.(artifact, providers);
    const sanitizeExtractionResult = scenario.sanitizeExtractionResult
      ? (result: ExtractionResult, sanitizeContext: DemoSanitizerContext) =>
          scenario.sanitizeExtractionResult?.(result, sanitizeContext) ?? result
      : undefined;
    const sanitizeParsedExtractionResult = scenario.sanitizeParsedExtractionResult
      ? (result: ExtractionResult, sanitizeContext: DemoSanitizerContext) =>
          scenario.sanitizeParsedExtractionResult?.(result, sanitizeContext) ?? result
      : undefined;
    await ingestPreparedUnits({
      store,
      namespace: artifact.namespace,
      units: artifact.units,
      providers,
      logger: context.logger,
      trace: context.trace,
      artifactPath: context.artifactPath,
      ...(expectedFixtureAssertionIds !== undefined ? { expectedFixtureAssertionIds } : {}),
      ...(sanitizeParsedExtractionResult ? { sanitizeParsedExtractionResult } : {}),
      ...(sanitizeExtractionResult ? { sanitizeExtractionResult } : {}),
    });
  } finally {
    context.logger.step('Closing TragetiStore');
    await store.close();
  }
}

async function retrievePhase(scenario: DemoScenario, context: DemoScenarioContext): Promise<void> {
  const artifact = readPreparedArtifact(context.artifactPath);
  assertScenarioArtifact(scenario, artifact, context.artifactPath);
  const providers = scenario.resolveProviders(context, artifact);
  const database = scenario.databasePath(context, artifact, providers);
  if (!existsSync(database)) {
    throw new Error(
      `Demo DB does not exist at ${database}. Run "${scenario.name} ingest" or "${scenario.name} run" first.`,
    );
  }
  printResolvedProviderSummary({
    providers,
    namespace: artifact.namespace,
    database,
    rateLimitSeconds: rateLimitFromArgv(context.argv),
  });
  if (context.argv.includes('--warmup')) await warmupDemoProviders({ providers, logger: context.logger });
  context.logger.step('Opening TragetiStore for retrieval');
  const store = await TragetiStore.create({
    database,
    namespace: artifact.namespace,
    embeddingDimension: providers.embedder.provider.dimension,
    embeddingProvider: providers.embedder.provider,
  });
  try {
    await scenario.retrieve(context, artifact, providers, store);
  } finally {
    context.logger.step('Closing TragetiStore');
    await store.close();
  }
}

function parseSharedDemoCommand(
  argv: readonly string[],
  scenarios: readonly DemoScenario[],
): { scenario: DemoScenario; phase: DemoPhase; scenarioArgv: readonly string[] } {
  const scenarioName = argv[2];
  const phase = argv[3];
  const scenario = scenarios.find((candidate) => candidate.name === scenarioName);
  if (!scenario || !isPhase(phase)) {
    const names = scenarios.map((candidate) => candidate.name).join('|');
    throw new Error(`Usage: trageti-demo ${names} prepare|ingest|retrieve|run [options]`);
  }
  return { scenario, phase, scenarioArgv: argv.slice(4) };
}

function isPhase(value: string | undefined): value is DemoPhase {
  return value === 'prepare' || value === 'ingest' || value === 'retrieve' || value === 'run';
}

function assertScenarioArtifact(scenario: DemoScenario, artifact: PreparedDemoArtifact, path: string): void {
  if (artifact.scenario !== scenario.name) {
    throw new Error(`${path} is for scenario "${artifact.scenario}", not "${scenario.name}"`);
  }
}

function rateLimitFromArgv(argv: readonly string[]): number | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') {
      const value = argv[i + 1];
      return value === undefined ? null : Number(value);
    }
    if (arg?.startsWith('--limit=')) return Number(arg.slice('--limit='.length));
  }
  return null;
}

import 'dotenv/config';
import { runSharedDemoCli } from '../shared/demo-runner.js';
import { bigBrotherScenario } from './scenario.js';

runSharedDemoCli({
  scenarios: [bigBrotherScenario],
  argv: [process.argv[0] ?? 'node', process.argv[1] ?? 'index.ts', 'big-brother', 'run', ...process.argv.slice(2)],
}).then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

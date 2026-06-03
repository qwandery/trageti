import 'dotenv/config';
import { runSharedDemoCli } from '../shared/demo-runner.js';
import { knowThyselfScenario } from './scenario.js';

runSharedDemoCli({
  scenarios: [knowThyselfScenario],
  argv: [process.argv[0] ?? 'node', process.argv[1] ?? 'index.ts', 'know-thyself', 'run', ...process.argv.slice(2)],
}).then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

import 'dotenv/config';
import { runSharedDemoCli } from './shared/demo-runner.js';
import { alexPlaceScenario } from './alex-place/scenario.js';
import { knowThyselfScenario } from './know-thyself/scenario.js';

runSharedDemoCli({
  scenarios: [alexPlaceScenario, knowThyselfScenario],
}).then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);

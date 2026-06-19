import 'dotenv/config';
import { runSharedDemoCli, DemoStageError } from './shared/demo-runner.js';
import { printDemoStageFailure } from './shared/output.js';
import { alexPlaceScenario } from './alex-place/scenario.js';
import { knowThyselfScenario } from './know-thyself/scenario.js';
import { bigBrotherScenario } from './big-brother/scenario.js';

runSharedDemoCli({
  scenarios: [alexPlaceScenario, knowThyselfScenario, bigBrotherScenario],
}).then(
  () => process.exit(0),
  (err: unknown) => {
    if (err instanceof DemoStageError) {
      printDemoStageFailure({
        demoTitle: err.demoTitle,
        stageTitle: err.stageTitle,
        scenarioName: err.scenarioName,
        stageName: err.stageName,
        error: err.cause,
      });
    } else {
      // CLI-usage errors and anything escaping a stage: print raw.
      console.error(err);
    }
    process.exit(1);
  },
);

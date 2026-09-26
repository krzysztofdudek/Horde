// The suite's preflight: which Yggdrasil CLI the tests will run against, or one refusal before any of
// them runs. `npm test` runs it first; importing the helpers is the whole check — they stop with the
// reason when the CLI found is older than Horde's floor.
import { requireYg } from './helpers.mjs';

try {
  const found = requireYg();
  console.log(`Yggdrasil for the suite: ${found}`);
} catch (e) {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
}

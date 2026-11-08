// Maintainer CLI uses exactly the browser pipeline; stdout is a JSON result.
import { resolveList, fetchListText, PIPELINE_VERSION, CAPABILITIES, sha256 } from '../argon/adblock/updater.mjs';
const result = await resolveList(process.argv[2], fetchListText);
console.log(JSON.stringify({ ...result, sha256: await sha256(result.text), pipelineVersion: PIPELINE_VERSION, capabilities: CAPABILITIES }));

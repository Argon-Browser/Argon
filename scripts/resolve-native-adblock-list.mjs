// Maintainer CLI uses exactly the browser pipeline; stdout is a JSON result.
import { resolveList, fetchListText, PIPELINE_VERSION, CAPABILITIES, sha256 } from '../argon/adblock/updater.mjs';

async function resolveOne(url) {
  const result = await resolveList(url, fetchListText);
  return {
    ...result,
    sha256: await sha256(result.text),
    pipelineVersion: PIPELINE_VERSION,
    capabilities: CAPABILITIES,
  };
}

async function resolveWithFallbacks(item) {
  const errors = [];
  for (const url of item.urls || []) {
    try {
      const resolved = await resolveOne(url);
      return { id: item.id, url, resolved };
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${item.id}: ${JSON.stringify(errors)}`);
}

if (process.argv.includes('--batch')) {
  let rawStdin = '';
  for await (const chunk of process.stdin) {
    rawStdin += chunk;
  }
  const items = JSON.parse(rawStdin);
  const results = new Array(items.length);
  const concurrency = Math.min(6, Math.max(1, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await resolveWithFallbacks(items[index]);
      }
    }),
  );
  console.log(JSON.stringify(results));
} else {
  console.log(JSON.stringify(await resolveOne(process.argv[2])));
}

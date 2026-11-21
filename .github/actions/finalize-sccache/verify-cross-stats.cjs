const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(name => /^stats\..+\.json$/.test(name));
if (files.length === 0) throw new Error('No in-container sccache statistics; cross build did not use the canonical cache');
let misses = 0, hits = 0, requests = 0;
for (const file of files) {
  const { stats } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  if (!stats || !Number.isInteger(stats.cache_read_errors) || !Number.isInteger(stats.cache_write_errors)) {
    throw new Error('Invalid in-container sccache stats: ' + file);
  }
  if (stats.cache_read_errors || stats.cache_write_errors) {
    throw new Error('In-container sccache backend errors: ' + file);
  }
  misses += Object.values(stats.cache_misses?.counts ?? {}).reduce((a, b) => a + b, 0);
  hits += Object.values(stats.cache_hits?.counts ?? {}).reduce((a, b) => a + b, 0);
  requests += stats.compile_requests ?? 0;
}
if (!requests || !(misses + hits)) throw new Error('No cacheable compiler requests observed inside cross containers');
console.log(`cross compiler-cache totals: ${requests} requests, ${hits} hits, ${misses} misses`);
fs.appendFileSync(process.env.GITHUB_ENV, `CODEANDSOLDER_SCCACHE_REFRESH=${misses > 0}\n`);

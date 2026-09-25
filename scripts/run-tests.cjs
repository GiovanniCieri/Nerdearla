const { readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return discover(fullPath);
    return /\.test\.(?:cjs|js|mjs)$/u.test(entry.name) ? [fullPath] : [];
  });
}

const files = discover(path.join(process.cwd(), 'tests')).sort();
if (!files.length) {
  console.error('No encontramos pruebas *.test.js, *.test.cjs o *.test.mjs en tests/.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

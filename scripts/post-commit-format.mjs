import { spawnSync } from 'node:child_process';

const root = process.cwd();
const changed = spawnSync(
  'git',
  ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=ACMR', '-r', '-z', 'HEAD'],
  { cwd: root, encoding: 'buffer' },
);

if (changed.status !== 0) {
  process.exit(changed.status ?? 1);
}

const files = changed.stdout.toString('utf8').split('\0').filter(Boolean);
if (files.length === 0) {
  process.exit(0);
}

const result = spawnSync(
  'pnpm',
  ['exec', 'biome', 'format', '--write', '--files-ignore-unknown=true', '--', ...files],
  { cwd: root, stdio: 'inherit' },
);

if (result.status !== 0) {
  console.error('Post-commit Biome formatting failed. The commit was not changed.');
  process.exit(result.status ?? 1);
}

console.log(`Formatted ${files.length} file(s) from the latest commit. Review and commit the formatting changes.`);

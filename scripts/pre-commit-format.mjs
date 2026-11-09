import { spawnSync } from 'node:child_process';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    console.error(`Unable to run ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const staged = spawnSync(
  'git',
  ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
  { cwd: process.cwd(), encoding: 'buffer' },
);

if (staged.error || staged.status !== 0) {
  console.error('Unable to read the staged file list.');
  process.exit(staged.status ?? 1);
}

const files = staged.stdout.toString('utf8').split('\0').filter(Boolean);

if (files.length === 0) {
  process.exit(0);
}

console.log(`Formatting ${files.length} staged file(s) with Biome...`);

run('pnpm', [
  'exec',
  'biome',
  'format',
  '--write',
  '--files-ignore-unknown=true',
  '--',
  ...files,
]);

run('git', ['add', '--', ...files]);

console.log('Verifying staged file formatting...');

run('pnpm', [
  'exec',
  'biome',
  'format',
  '--files-ignore-unknown=true',
  '--',
  ...files,
]);

console.log('Biome formatting passed. Commit may proceed.');

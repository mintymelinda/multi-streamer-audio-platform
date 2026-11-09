import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
if (!existsSync(resolve(root, '.git'))) {
  process.exit(0);
}

const result = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
  cwd: root,
  stdio: 'inherit',
});

if (result.status !== 0) {
  console.error('Unable to configure the repository Git hooks path.');
  process.exit(result.status ?? 1);
}

console.log('Installed repository Git hooks from .githooks.');

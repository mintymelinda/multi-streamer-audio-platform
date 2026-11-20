#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const lintableExtensions = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

export function getLintableFiles(changedFiles, fileExists = existsSync) {
  return [...new Set(changedFiles)]
    .filter((file) => lintableExtensions.has(file.slice(file.lastIndexOf('.')).toLowerCase()))
    .filter(fileExists)
    .sort();
}

export function getChangedFiles({ eventName, baseSha, headSha }, runGit = execFileSync) {
  if (!headSha) throw new Error('A CI head commit SHA is required.');

  let args;
  if (eventName === 'pull_request') {
    if (!baseSha) throw new Error('A pull-request base commit SHA is required.');
    args = ['diff', '--name-only', '-z', baseSha + '...' + headSha];
  } else if (eventName === 'push' && baseSha && !/^0+$/.test(baseSha)) {
    args = ['diff', '--name-only', '-z', baseSha, headSha];
  } else if (eventName === 'push') {
    args = ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', headSha];
  } else {
    throw new Error('Changed-file lint supports pull_request and push events only.');
  }

  return String(runGit('git', args, { encoding: 'utf8' })).split('\0').filter(Boolean);
}

export function lintChangedFiles(files, runBiome = spawnSync) {
  if (files.length === 0) {
    process.stdout.write('No changed Biome-supported files to lint.\n');
    return 0;
  }

  const result = runBiome('pnpm', ['exec', 'biome', 'lint', ...files], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function main() {
  const changedFiles = getChangedFiles({
    eventName: process.env.GITHUB_EVENT_NAME,
    baseSha: process.env.GITHUB_BASE_SHA,
    headSha: process.env.GITHUB_HEAD_SHA,
  });
  process.exitCode = lintChangedFiles(getLintableFiles(changedFiles));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : 'Changed-file lint failed.') + '\n');
    process.exitCode = 1;
  });
}

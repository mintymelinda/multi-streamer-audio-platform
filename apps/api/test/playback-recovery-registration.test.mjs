import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appModule = readFileSync(new URL('../src/app.module.ts', import.meta.url), 'utf8');

test('registers workspace playback recovery in the API application', () => {
  assert.match(
    appModule,
    /import\s*\{\s*PlaybackRecoveryModule\s*\}\s*from\s*['"]\.\/playback\/playback-recovery\.module\.js['"]/,
  );
  assert.match(
    appModule,
    /imports\s*:\s*\[[\s\S]*?PlaybackRecoveryModule[\s\S]*?\]/,
  );
});

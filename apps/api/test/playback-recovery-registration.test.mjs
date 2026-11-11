import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { AppModule } from '../dist/app.module.js';
import { PlaybackRecoveryModule } from '../dist/playback/playback-recovery.module.js';

test('registers workspace playback recovery and policy endpoints in the API application', () => {
  const imports = Reflect.getMetadata('imports', AppModule) ?? [];
  assert.ok(
    imports.includes(PlaybackRecoveryModule),
    'PlaybackRecoveryModule must be imported by AppModule so its recovery controllers are reachable',
  );
});

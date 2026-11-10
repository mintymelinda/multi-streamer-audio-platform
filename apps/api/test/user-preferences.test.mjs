import assert from 'node:assert/strict';
import test from 'node:test';
import { UserPreferencesService } from '../dist/user-preferences/user-preferences.service.js';

function harness(rows = []) {
  const calls = [];
  const database = {
    transaction: async (context, operation) => {
      calls.push({ context });
      return operation({
        query: async (sql, values = []) => {
          calls.push({ sql, values });
          if (sql.includes('SELECT theme, accent_color')) return { rows, rowCount: rows.length };
          if (sql.includes('RETURNING theme, accent_color')) {
            return {
              rows: [{
                theme: values[1] ?? rows[0]?.theme ?? 'dark',
                accent_color: values[2] ?? rows[0]?.accent_color ?? 'violet',
              }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
      });
    },
  };
  return { service: new UserPreferencesService(database), calls };
}

test('returns account-wide default appearance preferences for a new user', async () => {
  const { service, calls } = harness();
  assert.deepEqual(await service.getAppearance('user-a'), { theme: 'dark', accentColor: 'violet' });
  assert.deepEqual(calls[0].context, { userId: 'user-a' });
  assert.match(calls[1].sql, /user_appearance_preferences/);
});

test('loads persisted appearance preferences for the signed-in user', async () => {
  const { service } = harness([{ theme: 'light', accent_color: 'teal' }]);
  assert.deepEqual(await service.getAppearance('user-a'), { theme: 'light', accentColor: 'teal' });
});

test('updates one setting without overwriting the other setting', async () => {
  const { service, calls } = harness([{ theme: 'light', accent_color: 'teal' }]);
  assert.deepEqual(
    await service.updateAppearance('user-a', { accentColor: 'rose' }),
    { theme: 'light', accentColor: 'rose' },
  );
  const write = calls.find((call) => call.sql?.includes('ON CONFLICT (user_id)'));
  assert.deepEqual(write.values, ['user-a', null, 'rose']);
  assert.match(write.sql, /theme = COALESCE\(\$2, user_appearance_preferences\.theme\)/);
});

test('persists both appearance settings for a user without an existing row', async () => {
  const { service, calls } = harness();
  assert.deepEqual(
    await service.updateAppearance('user-a', { theme: 'light', accentColor: 'blue' }),
    { theme: 'light', accentColor: 'blue' },
  );
  const write = calls.find((call) => call.sql?.includes('ON CONFLICT (user_id)'));
  assert.deepEqual(write.values, ['user-a', 'light', 'blue']);
});

test('rejects unsupported theme and accent values before writing', async () => {
  const { service, calls } = harness();
  await assert.rejects(service.updateAppearance('user-a', { theme: 'system' }), /Theme must be dark or light/);
  await assert.rejects(service.updateAppearance('user-a', { accentColor: '#ffffff' }), /supported accent color/);
  assert.equal(calls.some((call) => call.sql?.includes('INSERT INTO user_appearance_preferences')), false);
});

test('uses a self-scoped database transaction for writes', async () => {
  const { service, calls } = harness();
  await service.updateAppearance('user-a', { theme: 'light' });
  assert.deepEqual(calls[0].context, { userId: 'user-a' });
});

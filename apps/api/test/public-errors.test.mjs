import assert from 'node:assert/strict';
import test from 'node:test';
import { mapPublicError } from '../src/public-errors.ts';

test('maps expected HTTP failures to stable public error codes', () => {
  assert.deepEqual(mapPublicError(400), {
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed.',
  });
  assert.deepEqual(mapPublicError(403), {
    code: 'FORBIDDEN',
    message: 'You do not have permission to perform this action.',
  });
  assert.deepEqual(mapPublicError(503), {
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'A required service is temporarily unavailable.',
  });
});

test('never exposes internal server error details', () => {
  assert.deepEqual(mapPublicError(500), {
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred.',
  });
});

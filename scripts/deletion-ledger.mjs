#!/usr/bin/env node
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const [command, inputPath] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;
const hmacKey = process.env.DELETION_LEDGER_HMAC_KEY;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!['export', 'replay'].includes(command) || !inputPath) {
  fail('Usage: node scripts/deletion-ledger.mjs <export|replay> <ledger.json>');
}
if (!databaseUrl) fail('DATABASE_URL must point to the target PostgreSQL database.');
if (!hmacKey || Buffer.byteLength(hmacKey, 'utf8') < 32) {
  fail('DELETION_LEDGER_HMAC_KEY must contain at least 32 bytes and be stored independently of backups.');
}

function signature(bytes) {
  return createHmac('sha256', hmacKey).update(bytes).digest();
}

function runPsql(args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('psql', ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', ...args, databaseUrl], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`psql exited with status ${code}`));
      else resolvePromise(Buffer.concat(chunks));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

const ledgerPath = resolve(inputPath);
const signaturePath = `${ledgerPath}.hmac`;

if (command === 'export') {
  const output = await runPsql(
    ['--quiet', '--tuples-only', '--no-align', '--command', 'SELECT export_platform_deletion_ledger();'],
  );
  const document = Buffer.from(output.toString('utf8').trim(), 'utf8');
  const parsed = JSON.parse(document.toString('utf8'));
  if (
    parsed.format !== 'multi-streamer-audio-platform.deletion-ledger' ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.entries)
  ) {
    fail('The database returned an unsupported deletion ledger document.');
  }
  const temporaryPath = `${ledgerPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, document, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, ledgerPath);
  const temporarySignaturePath = `${signaturePath}.tmp-${process.pid}`;
  await writeFile(temporarySignaturePath, `${signature(document).toString('hex')}\n`, { mode: 0o600 });
  await chmod(temporarySignaturePath, 0o600);
  await rename(temporarySignaturePath, signaturePath);
  process.stdout.write(`Exported and signed ${parsed.entries.length} deletion-ledger event(s).\n`);
} else {
  const document = await readFile(ledgerPath);
  const suppliedHex = (await readFile(signaturePath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) fail('The deletion ledger HMAC file is malformed.');
  const supplied = Buffer.from(suppliedHex, 'hex');
  const expected = signature(document);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    fail('Deletion ledger signature verification failed; refusing to replay it.');
  }
  const parsed = JSON.parse(document.toString('utf8'));
  if (
    parsed.format !== 'multi-streamer-audio-platform.deletion-ledger' ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.entries)
  ) {
    fail('The signed deletion ledger has an unsupported format.');
  }
  const delimiter = `$deletion_ledger_${randomBytes(16).toString('hex')}$`;
  const sql = `SELECT replay_platform_deletion_ledger(${delimiter}${document.toString('utf8')}${delimiter}::jsonb);\n`;
  const result = await runPsql([], sql);
  process.stdout.write(result.toString('utf8'));
  process.stdout.write('Verified deletion ledger replay completed.\n');
}

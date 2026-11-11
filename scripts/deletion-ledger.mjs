#!/usr/bin/env node
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createDeletionLedgerS3Client } from './lib/deletion-ledger-s3.mjs';

const [command, inputPath] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;
const hmacKey = process.env.DELETION_LEDGER_HMAC_KEY;

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

if (!['export', 'replay', 'export-s3', 'replay-s3'].includes(command)) {
  fail('Usage: node scripts/deletion-ledger.mjs <export|replay> <ledger.json> | <export-s3> | <replay-s3> <export-id>');
}
if (['export', 'replay', 'replay-s3'].includes(command) && !inputPath) {
  fail('A ledger path or S3 export ID is required for this command.');
}
if (!databaseUrl) fail('DATABASE_URL must point to the target PostgreSQL database.');
if (!hmacKey || Buffer.byteLength(hmacKey, 'utf8') < 32) {
  fail('DELETION_LEDGER_HMAC_KEY must contain at least 32 bytes and be stored independently of backups.');
}

function signature(bytes) {
  return createHmac('sha256', hmacKey).update(bytes).digest();
}

function validateLedgerDocument(document) {
  const parsed = JSON.parse(document.toString('utf8'));
  if (
    parsed.format !== 'multi-streamer-audio-platform.deletion-ledger' ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.entries)
  ) {
    fail('The deletion ledger has an unsupported format.');
  }
  return parsed;
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
      if (code !== 0) reject(new Error('psql exited with status ' + code));
      else resolvePromise(Buffer.concat(chunks));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function exportLedgerDocument() {
  const output = await runPsql(
    ['--quiet', '--tuples-only', '--no-align', '--command', 'SELECT export_platform_deletion_ledger();'],
  );
  const document = Buffer.from(output.toString('utf8').trim(), 'utf8');
  const parsed = validateLedgerDocument(document);
  return { document, parsed };
}

async function replayLedgerDocument(document, suppliedHex) {
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) fail('The deletion ledger HMAC is malformed.');
  const supplied = Buffer.from(suppliedHex, 'hex');
  const expected = signature(document);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    fail('Deletion ledger signature verification failed; refusing to replay it.');
  }
  validateLedgerDocument(document);
  const delimiter = '$deletion_ledger_' + randomBytes(16).toString('hex') + '$';
  const sql = 'SELECT replay_platform_deletion_ledger(' + delimiter
    + document.toString('utf8') + delimiter + '::jsonb);\n';
  const result = await runPsql([], sql);
  process.stdout.write(result.toString('utf8'));
  process.stdout.write('Verified deletion ledger replay completed.\n');
}

function createS3Client(mode) {
  const modePrefix = 'DELETION_LEDGER_S3_' + mode.toUpperCase() + '_';
  const accessKey = process.env[modePrefix + 'ACCESS_KEY'] || process.env.DELETION_LEDGER_S3_ACCESS_KEY;
  const secretKey = process.env[modePrefix + 'SECRET_KEY'] || process.env.DELETION_LEDGER_S3_SECRET_KEY;
  const prefix = process.env.DELETION_LEDGER_S3_PREFIX || 'v1/exports';
  if (
    prefix.startsWith('/') ||
    prefix.endsWith('/') ||
    prefix.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    fail('DELETION_LEDGER_S3_PREFIX must be a safe relative object-key prefix.');
  }
  const bucket = process.env.DELETION_LEDGER_S3_BUCKET;
  const client = createDeletionLedgerS3Client({
    endpoint: process.env.DELETION_LEDGER_S3_ENDPOINT,
    bucket,
    accessKey,
    secretKey,
    region: process.env.DELETION_LEDGER_S3_REGION || 'us-east-1',
    allowInsecureHttp: process.env.DELETION_LEDGER_S3_ALLOW_INSECURE_HTTP === 'true',
  });
  return { client, bucket, prefix };
}

const ledgerPath = inputPath ? resolve(inputPath) : null;
const signaturePath = ledgerPath ? ledgerPath + '.hmac' : null;

if (command === 'export') {
  const { document, parsed } = await exportLedgerDocument();
  const temporaryPath = ledgerPath + '.tmp-' + process.pid;
  await writeFile(temporaryPath, document, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, ledgerPath);
  const temporarySignaturePath = signaturePath + '.tmp-' + process.pid;
  await writeFile(temporarySignaturePath, signature(document).toString('hex') + '\n', { mode: 0o600 });
  await chmod(temporarySignaturePath, 0o600);
  await rename(temporarySignaturePath, signaturePath);
  process.stdout.write('Exported and signed ' + parsed.entries.length + ' deletion-ledger event(s).\n');
} else if (command === 'replay') {
  const document = await readFile(ledgerPath);
  const suppliedHex = (await readFile(signaturePath, 'utf8')).trim();
  await replayLedgerDocument(document, suppliedHex);
} else if (command === 'export-s3') {
  const { document, parsed } = await exportLedgerDocument();
  const exportId = randomUUID();
  const bundle = Buffer.from(JSON.stringify({
    format: 'multi-streamer-audio-platform.signed-ledger-bundle',
    version: 1,
    exportId,
    exportedAt: new Date().toISOString(),
    ledger: document.toString('base64'),
    hmac: signature(document).toString('hex'),
  }));
  const { client, bucket, prefix } = createS3Client('write');
  const key = prefix + '/' + exportId + '/ledger.bundle.json';
  await client.putObject(key, bundle, 'application/json');
  process.stdout.write(
    'Exported and signed ' + parsed.entries.length + ' event(s) to s3://' + bucket + '/' + key + '\n'
    + 'Record this export ID for recovery: ' + exportId + '\n',
  );
} else {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(inputPath)) {
    fail('S3 export ID must be a UUID.');
  }
  const { client, prefix } = createS3Client('read');
  const key = prefix + '/' + inputPath.toLowerCase() + '/ledger.bundle.json';
  const bundleBytes = await client.getObject(key);
  let bundle;
  try {
    bundle = JSON.parse(bundleBytes.toString('utf8'));
  } catch {
    fail('The S3 deletion ledger bundle is not valid JSON.');
  }
  if (
    bundle.format !== 'multi-streamer-audio-platform.signed-ledger-bundle' ||
    bundle.version !== 1 ||
    bundle.exportId !== inputPath.toLowerCase() ||
    typeof bundle.ledger !== 'string' ||
    typeof bundle.hmac !== 'string'
  ) {
    fail('The S3 deletion ledger bundle has an unsupported format.');
  }
  const document = Buffer.from(bundle.ledger, 'base64');
  if (document.toString('base64') !== bundle.ledger) {
    fail('The S3 deletion ledger bundle contains invalid base64 data.');
  }
  await replayLedgerDocument(document, bundle.hmac);
}

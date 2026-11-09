import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationsDirectory = resolve('infra/postgres/migrations');
const migrations = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();

if (migrations.length === 0) {
  console.log('No schema migrations exist yet; migration naming convention is ready.');
  process.exit(0);
}

const pattern = /^(\d{4})_[a-z0-9_]+\.sql$/;
const numbers = [];

for (const file of migrations) {
  const match = pattern.exec(file);
  if (!match) {
    throw new Error(`Invalid migration filename: ${file}`);
  }
  numbers.push(Number(match[1]));
}

for (let index = 0; index < numbers.length; index += 1) {
  if (numbers[index] !== index + 1) {
    throw new Error(`Migration sequence gap or duplicate at ${migrations[index]}`);
  }
}

console.log(`Validated ${migrations.length} ordered SQL migration(s).`);

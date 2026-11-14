#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const documentationPattern = /^(?:docs\/|[^/]+\.md$|README(?:\.|$)|CHANGELOG(?:\.|$))/i;
const staticPresentationPattern = /^(?:apps\/(?:dashboard|overlay)\/(?:public\/.*\.(?:css|svg|png|jpe?g|webp|gif|ico|woff2?)|.*\.(?:css|scss)))$/i;

export function classifyChangedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      risk: 'approval-required',
      reason: 'No trustworthy changed-file list is available; defaulting to approval-required.',
      files: [],
    };
  }

  const normalized = files
    .filter((file) => typeof file === 'string' && file.trim())
    .map((file) => file.trim().replaceAll('\\\\', '/'));

  if (normalized.length === 0) {
    return {
      risk: 'approval-required',
      reason: 'No trustworthy changed-file list is available; defaulting to approval-required.',
      files: [],
    };
  }

  const nonDocumentation = normalized.filter((file) => !documentationPattern.test(file));
  if (nonDocumentation.length === 0) {
    return {
      risk: 'no-deploy',
      reason: 'Documentation-only changes do not require an application deployment.',
      files: normalized,
    };
  }

  const unsafe = nonDocumentation.filter((file) => !staticPresentationPattern.test(file));
  if (unsafe.length > 0) {
    return {
      risk: 'approval-required',
      reason: 'At least one changed path is outside the narrow static-presentation allowlist.',
      files: normalized,
      approvalRequiredFiles: unsafe,
    };
  }

  return {
    risk: 'routine',
    reason: 'All runtime changes are limited to dashboard/overlay styles or static presentation assets.',
    files: normalized,
  };
}

async function main() {
  const input = await readFile(0, 'utf8');
  const files = input.split(/\\r?\\n/).filter(Boolean);
  process.stdout.write(JSON.stringify(classifyChangedFiles(files)) + '\\n');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Unable to classify release changes.\\n');
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {auditMigrationCohort} from './lib/vm-migration-cohort-audit.mjs';

const PROJECT = 'pi-agents-cloud';
const FLAGS = new Set(['--project', '--report', '--output', '--confirm']);

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = argv.slice(index, index + 2);
    if (!FLAGS.has(flag) || !value || options.has(flag)) throw Error('migration_cohort_audit_arguments_invalid');
    options.set(flag, value);
  }
  if (options.size !== FLAGS.size || options.get('--project') !== PROJECT || options.get('--confirm') !== 'migration-cohort-audit') {
    throw Error('migration_cohort_audit_arguments_invalid');
  }
  return options;
}

try {
  const options = parseOptions(process.argv.slice(2));
  const report = JSON.parse(await readFile(options.get('--report'), 'utf8'));
  const audit = auditMigrationCohort(report);
  const output = options.get('--output');
  await mkdir(path.dirname(output), {recursive: true});
  await writeFile(output, JSON.stringify(audit, null, 2), {mode: 0o600, flag: 'wx'});
  console.log(JSON.stringify({ok: true, readOnly: true, readyForCompletion: audit.readyForCompletion,
    counts: audit.counts, orphaned: audit.orphaned.length, report: output}));
} catch (error) {
  const reason = /^(?:migration_cohort_)[a-z_]+$/.test(error.message) ? error.message : 'migration_cohort_audit_failed';
  console.error(JSON.stringify({status: 'blocked', reason, readyForCompletion: false, sourceRetained: true}));
  process.exitCode = 1;
}


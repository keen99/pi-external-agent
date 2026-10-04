#!/usr/bin/env node
// Syncs per-version "pi tested" release tags with the latest matrix results.
//
// Reads .matrix-cache/matrix-results.json (written by release-matrix.mjs —
// one {version, ok} entry per tested release) and reconciles GitHub releases:
//   pass → release tag exists (create if missing)
//   fail → release tag deleted (release + tag)
// so the badge (newest surviving tag) never claims a version the current
// code fails on. All gh failures are loud — no swallowing.
//
// Usage: node test/sync-tested-tags.mjs [--dry-run]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const dry = process.argv.includes('--dry-run');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const resultsPath = join(root, '.matrix-cache', 'matrix-results.json');
if (!existsSync(resultsPath)) {
	console.error(`no matrix-results.json at ${resultsPath}`);
	console.error(`cwd=${process.cwd()}`);
	try {
		console.error('workspace .matrix-cache listing:');
		for (const f of readdirSync(join(root, '.matrix-cache'))) console.error('  ' + f);
	} catch (e) {
		console.error(`  .matrix-cache unreadable: ${e.message}`);
	}
	process.exit(1);
}
const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
const repo = process.env.GH_REPO ?? 'keen99/pi-external-agent';

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' });
// One paginated list call instead of a view per version.
const existing = new Set(
	gh(['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--jq', '.[].tag_name'])
		.split('\n')
		.filter(Boolean),
);
const exists = (tag) => existing.has(tag);

let created = 0;
let deleted = 0;
for (const { version, ok } of results) {
	const have = exists(version);
	if (ok && !have) {
		console.log(`create pi-tested release ${version}`);
		created++;
		if (!dry) {
			gh(['release', 'create', version, '--repo', repo, '--title', `pi tested 0.75.0 → ${version}`, '--notes', `Release matrix green through pi 0.75.0 → ${version} (${results.length} releases tested)`]);
			existing.add(version);
		}
	} else if (!ok && have) {
		console.log(`delete pi-tested release ${version} (matrix FAIL)`);
		deleted++;
		if (!dry) {
			gh(['release', 'delete', version, '--repo', repo, '--yes', '--cleanup-tag']);
			existing.delete(version);
		}
	}
}
console.log(`sync done: ${results.length} versions, ${created} created, ${deleted} deleted${dry ? ' (dry-run)' : ''}`);

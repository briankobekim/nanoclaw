// Read-only preflight for this installation after a directory move.
// Run from the NanoClaw root: node scripts/check-atlas-echo-paths.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const home = '/Users/kobekim';
const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-',
  `${home}/Library/LaunchAgents/com.nanoclaw-v2-eacf8390.plist`], { encoding: 'utf8' }));
assert.equal(plist.WorkingDirectory, root, 'Service working directory differs from this checkout');
assert.equal(plist.ProgramArguments[1], path.join(root, 'dist/index.js'));
for (const p of plist.ProgramArguments) assert.ok(fs.existsSync(p), `Missing executable: ${p}`);
for (const p of [plist.StandardOutPath, plist.StandardErrorPath]) {
  assert.equal(path.dirname(p), path.join(root, 'logs'));
  assert.ok(fs.statSync(path.dirname(p)).isDirectory());
}
const allowlist = JSON.parse(fs.readFileSync(`${home}/.config/nanoclaw/mount-allowlist.json`, 'utf8'));
assert.equal(allowlist.nonMainReadOnly, true, 'Read-only protection changed');
const { initDb, closeDb } = await import('../dist/db/connection.js');
const { getDefaultContainerImage } = await import('../dist/install-slug.js');
const db = await initDb(undefined, { role: 'tool', readonly: true });
try {
  const ids = ['ag-1787323600795-bvj1pt', 'ag-f5d8ac4b-40c5-4dcc-967d-4fcfb298447f'];
  for (const [i, id] of ids.entries()) {
    const row = await db.get('SELECT additional_mounts FROM container_configs WHERE agent_group_id = ?', id);
    assert.ok(row, `Missing configured agent: ${id}`);
    const mounts = JSON.parse(row.additional_mounts);
    assert.equal(mounts.length, 2, 'Review any change to the mount scope');
    for (const [name, expectedPath, readonly] of [
      ['quiveriq', path.resolve(root, '../quiveriq-claude'), i === 1],
      ['projects', path.join(root, 'projects'), true],
    ]) {
      const mount = mounts.find(m => m.containerPath === name);
      assert.ok(mount, `Missing mount: ${name}`);
      assert.equal(mount.hostPath, expectedPath);
      assert.equal(mount.readonly, readonly, `Changed access: ${name}`);
      assert.ok(fs.statSync(expectedPath).isDirectory(), `Missing mount directory: ${name}`);
      const rule = allowlist.allowedRoots.find(r => r.path === expectedPath);
      assert.ok(rule, `Mount is not allowlisted: ${name}`);
      assert.equal(rule.allowReadWrite, name === 'quiveriq');
    }
    console.log(`PASS ${i === 0 ? 'Atlas' : 'Echo'}: relocated mounts and original access flags`);
  }
} finally { await closeDb(); }
const image = getDefaultContainerImage(root);
execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' });
console.log('PASS service executable, working directory, log paths and existing image');
console.log('Readiness preflight passed; this does not test Slack or model responses.');

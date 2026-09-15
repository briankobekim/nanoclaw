// Read-only recurrence tripwire. No tokens, env values or raw logs are printed.
import { spawn, spawnSync } from 'node:child_process';
const expected = 'sha256:392c2a9c358f01607c9bc841c7458c83f23f8343b6949b3260ca5b35a7131b5a';
const inspect = () => {
  const r = spawnSync('docker', ['inspect', 'onecli'], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw Error('Docker inspect unavailable');
  return JSON.parse(r.stdout)[0];
};
// A busy gateway can emit more than a capture buffer in one hour. Scan both
// streams incrementally, keeping only enough overlap for a split signature.
const regressionAbsent = () => new Promise((resolve, reject) => {
  const child = spawn('docker', ['logs', '--since', '1h', 'onecli'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let found = false;
  const scan = stream => {
    let tail = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      const text = tail + chunk;
      if (/Missing ['"]client_id['"]|missing_required_parameter/.test(text)) found = true;
      tail = text.slice(-128);
    });
  };
  scan(child.stdout); scan(child.stderr);
  const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
  child.once('error', () => { clearTimeout(timer); reject(Error('Docker logs unavailable')); });
  child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(!found) : reject(Error('Docker logs incomplete')); });
});
try {
  const state = inspect();
  const checks = {
    approvedRefreshFixImage: state.Image === expected,
    running: state.State.Running === true,
    healthy: state.State.Health?.Status === 'healthy',
    noMissingClientIdRegression: await regressionAbsent(),
  };
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), checks }));
  if (Object.values(checks).some(v => !v)) process.exitCode = 1;
} catch {
  console.error('Echo gateway check unavailable; inspect Docker access/status without exposing credentials.');
  process.exitCode = 2;
}

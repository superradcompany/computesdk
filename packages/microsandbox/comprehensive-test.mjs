// Comprehensive provider validation beyond the shared conformance suite.
// Run: node comprehensive-test.mjs   (from packages/microsandbox, after build)
import { microsandbox } from './dist/index.mjs';

const results = [];
let current = null;

async function check(phase, name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ phase, name, pass: true, ms: Date.now() - started, detail: detail ?? '' });
  } catch (error) {
    results.push({ phase, name, pass: false, ms: Date.now() - started, detail: String(error?.message ?? error) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const provider = microsandbox({ image: 'alpine:3.21', cpus: 1, memoryMib: 512 });
const created = [];

async function make(options) {
  const sb = await provider.sandbox.create(options);
  created.push(sb.sandboxId);
  return sb;
}

// ---------- A. provider identity ----------
await check('identity', 'provider name is microsandbox', async () => {
  assert(provider.name === 'microsandbox', `got ${provider.name}`);
});
await check('identity', 'snapshot manager present (feature detection)', async () => {
  assert(!!provider.snapshot, 'provider.snapshot is undefined');
});
await check('identity', 'template manager absent by design', async () => {
  assert(!provider.template, 'template manager unexpectedly present');
});

// ---------- B. lifecycle ----------
let sb;
await check('lifecycle', 'create with metadata + envs', async () => {
  sb = await make({ metadata: { purpose: 'report', run: '42' }, envs: { GREETING: 'hello-env' } });
  assert(sb.sandboxId.startsWith('csdk-'), `id ${sb.sandboxId} lacks csdk- prefix`);
  return sb.sandboxId;
});
await check('lifecycle', 'getInfo: running, metadata roundtrip, isolation tag', async () => {
  const info = await sb.getInfo();
  assert(info.status === 'running', `status ${info.status}`);
  assert(info.provider === 'microsandbox', `provider ${info.provider}`);
  assert(info.metadata?.purpose === 'report', 'metadata.purpose lost');
  assert(info.metadata?.isolation?.includes('microVM'), 'isolation tag missing');
  assert(info.createdAt instanceof Date, 'createdAt not a Date');
});
await check('lifecycle', 'create-time envs visible in guest', async () => {
  const r = await sb.runCommand('echo -n "$GREETING"');
  assert(r.exitCode === 0 && r.stdout === 'hello-env', `got "${r.stdout}" (exit ${r.exitCode})`);
});
await check('lifecycle', 'explicit name becomes sandboxId', async () => {
  const named = await make({ name: 'csdk-named-test' });
  assert(named.sandboxId === 'csdk-named-test', named.sandboxId);
  await named.destroy();
  created.splice(created.indexOf('csdk-named-test'), 1);
});

// ---------- C. exec options ----------
await check('exec', 'cwd honored', async () => {
  const r = await sb.runCommand('pwd', { cwd: '/etc' });
  assert(r.stdout.trim() === '/etc', `pwd -> ${r.stdout.trim()}`);
});
await check('exec', 'per-command env honored', async () => {
  const r = await sb.runCommand('echo -n "$FOO-$BAR"', { env: { FOO: 'a', BAR: 'b' } });
  assert(r.stdout === 'a-b', `got "${r.stdout}"`);
});
await check('exec', 'pipes, quoting, nonzero exit preserved', async () => {
  const r1 = await sb.runCommand(`printf 'x\\ny\\nz\\n' | wc -l`);
  assert(r1.stdout.trim() === '3', `wc -> ${r1.stdout.trim()}`);
  const r2 = await sb.runCommand('exit 42');
  assert(r2.exitCode === 42, `exit ${r2.exitCode}`);
});
await check('exec', 'timeout interrupts a hung command', async () => {
  const started = Date.now();
  const r = await sb.runCommand('sleep 30', { timeout: 1500 });
  const took = Date.now() - started;
  assert(took < 10000, `took ${took}ms — timeout not enforced`);
  assert(r.exitCode !== 0, `exit ${r.exitCode} — expected failure`);
  return `returned in ${took}ms, exit ${r.exitCode}`;
});
await check('exec', 'background returns fast, work completes later', async () => {
  const r = await sb.runCommand('sleep 2 && echo done > /tmp/bg-proof.txt', { background: true });
  assert(r.exitCode === 0, `bg submit exit ${r.exitCode}`);
  assert(r.durationMs < 1500, `bg submit took ${r.durationMs}ms`);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const proof = await sb.runCommand('cat /tmp/bg-proof.txt');
  assert(proof.stdout.trim() === 'done', `proof "${proof.stdout.trim()}"`);
});

// ---------- D. filesystem ----------
await check('filesystem', 'writeFile creates parent dirs', async () => {
  await sb.filesystem.writeFile('/tmp/deep/nested/dir/file.txt', 'nested-content');
  const back = await sb.filesystem.readFile('/tmp/deep/nested/dir/file.txt');
  assert(back === 'nested-content', `got "${back}"`);
});
await check('filesystem', 'exists true/false', async () => {
  assert((await sb.filesystem.exists('/tmp/deep/nested/dir/file.txt')) === true, 'expected true');
  assert((await sb.filesystem.exists('/tmp/nope-never')) === false, 'expected false');
});
await check('filesystem', 'readdir distinguishes files and directories', async () => {
  await sb.filesystem.mkdir('/tmp/rd/adir');
  await sb.filesystem.writeFile('/tmp/rd/afile', 'x');
  const entries = await sb.filesystem.readdir('/tmp/rd');
  const dir = entries.find((e) => e.name === 'adir');
  const file = entries.find((e) => e.name === 'afile');
  assert(dir?.type === 'directory', `adir -> ${dir?.type}`);
  assert(file?.type === 'file', `afile -> ${file?.type}`);
});
await check('filesystem', 'remove works on trees', async () => {
  await sb.filesystem.remove('/tmp/deep');
  assert((await sb.filesystem.exists('/tmp/deep')) === false, 'still exists');
});

// ---------- E. recovery & listing ----------
await check('recovery', 'getById returns fresh handle, lazy connect works', async () => {
  const again = await provider.sandbox.getById(sb.sandboxId);
  assert(again !== null, 'getById returned null');
  const r = await again.runCommand('echo -n reconnected');
  assert(r.stdout === 'reconnected', `got "${r.stdout}"`);
});
await check('recovery', 'metadata recovered from labels via getById', async () => {
  const again = await provider.sandbox.getById(sb.sandboxId);
  const info = await again.getInfo();
  assert(info.metadata?.purpose === 'report', `metadata lost: ${JSON.stringify(info.metadata)}`);
});
await check('recovery', 'list scoped to provider-created sandboxes only', async () => {
  const listed = await provider.sandbox.list();
  const ids = listed.map((s) => s.sandboxId);
  assert(ids.includes(sb.sandboxId), 'our sandbox missing from list');
  const foreign = ids.filter((id) => !id.startsWith('csdk-'));
  assert(foreign.length === 0, `foreign sandboxes leaked into list: ${foreign.join(',')}`);
  return `${ids.length} listed, all ours`;
});
await check('recovery', 'getById of nonexistent returns null', async () => {
  const missing = await provider.sandbox.getById('csdk-does-not-exist-xyz');
  assert(missing === null, `expected null, got ${missing}`);
});
await check('recovery', 'destroy of nonexistent resolves quietly', async () => {
  await provider.sandbox.destroy('csdk-does-not-exist-xyz');
});

// ---------- F. getUrl ----------
await check('getUrl', 'mapped guest port resolves to localhost URL', async () => {
  const withPorts = await make({ ports: [{ host: 39876, guest: 8080 }] });
  const url = await withPorts.getUrl({ port: 8080 });
  assert(url === 'http://127.0.0.1:39876', url);
  await withPorts.destroy();
  created.splice(created.indexOf(withPorts.sandboxId), 1);
  return url;
});
await check('getUrl', 'unmapped port throws actionable error', async () => {
  try {
    await sb.getUrl({ port: 9999 });
    throw new Error('did not throw');
  } catch (error) {
    assert(String(error.message).includes('ports'), `unhelpful error: ${error.message}`);
  }
});

// ---------- G. snapshots ----------
const snapName = `csdk-report-snap-${Date.now().toString(36)}`;
await check('snapshot', 'create snapshot of running sandbox', async () => {
  await sb.runCommand('echo -n snapshot-state > /root/state.txt');
  await provider.snapshot.create(sb.sandboxId, { name: snapName });
});
await check('snapshot', 'snapshot appears in list', async () => {
  const snaps = await provider.snapshot.list();
  assert(snaps.some((s) => s.snapshotId === snapName), `${snapName} not in ${snaps.length} snapshots`);
});
let restored;
await check('snapshot', 'RESTORE: new sandbox boots from snapshot with state intact', async () => {
  restored = await make({ snapshotId: snapName });
  const r = await restored.runCommand('cat /root/state.txt');
  assert(r.stdout === 'snapshot-state', `state "${r.stdout}" (exit ${r.exitCode})`);
});
await check('snapshot', 'snapshot delete', async () => {
  await provider.snapshot.delete(snapName);
  const snaps = await provider.snapshot.list();
  assert(!snaps.some((s) => s.snapshotId === snapName), 'still listed after delete');
});

// ---------- H. teardown ----------
await check('teardown', 'destroy all, getById confirms gone, list empty', async () => {
  for (const id of created) {
    await provider.sandbox.destroy(id);
    assert((await provider.sandbox.getById(id)) === null, `${id} still exists`);
  }
  const remaining = await provider.sandbox.list();
  assert(remaining.length === 0, `${remaining.length} sandboxes leaked`);
});

// ---------- report ----------
const pass = results.filter((r) => r.pass).length;
console.log(JSON.stringify({ pass, fail: results.length - pass, total: results.length, results }, null, 1));
process.exit(results.some((r) => !r.pass) ? 1 : 0);

import { randomUUID } from 'node:crypto';
import { runProviderTestSuite } from '@computesdk/test-utils';
import { describe, expect, it } from 'vitest';
import { microsandbox } from '../index.js';

const runIntegration = process.env.MSB_RUN_INTEGRATION === '1';
// Cloud when credentials are present (CI); MSB_BACKEND=local forces the
// runtime on this machine, which needs KVM.
const backend = process.env.MSB_BACKEND === 'local' || !process.env.MSB_API_KEY ? 'local' : 'cloud';
const local = backend === 'local';

runProviderTestSuite({
  name: 'microsandbox',
  provider: local ? microsandbox({ backend, ports: [3000, 8080] }) : microsandbox({ backend }),
  supportsFilesystem: true,
  supportsStreaming: true,
  supportsProcesses: true,
  expectProcessRuntime: { streaming: 'native', processes: local ? 'native' : 'shell' },
  // Published ports are a local-backend feature.
  supportsGetUrl: local,
  ...(local ? { ports: [3000, 8080] } : {}),
  // Local fixed host ports [3000, 8080] collide when runProviderTestSuite creates a second
  // concurrent sandbox inside beforeEach; local snapshots and pause/resume run port-free below.
  supportsSnapshots: !local,
  supportsPauseResume: false,
  skipIntegration: !runIntegration,
  timeout: 120_000,
});

describe.runIf(runIntegration && local)('microsandbox local lifecycle', () => {
  it('pauses and resumes a local sandbox preserving files and live processes', async () => {
    const provider = microsandbox({ backend: 'local' });
    const suffix = randomUUID().slice(0, 8);
    const sandbox = await provider.instances.create({ name: `csdk-pause-${suffix}` });
    try {
      expect(provider.instances.pause).toEqual({ memory: true });
      await sandbox.filesystem.writeFile('/pause-marker.txt', 'kept-across-pause');
      const proc = await sandbox.startProcess('sh -c "echo $$ > /tmp/pause.pid; exec sleep 600"');
      const deadline = Date.now() + 10_000;
      let pid = '';
      while (!pid && Date.now() < deadline) {
        pid = (await sandbox.runCommand('cat /tmp/pause.pid 2>/dev/null')).stdout.trim();
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(pid).toBeTruthy();

      await sandbox.pause!();
      await sandbox.resume!();

      expect(await sandbox.filesystem.readFile('/pause-marker.txt')).toBe('kept-across-pause');
      expect((await sandbox.runCommand(`kill -0 ${pid} && echo alive`)).stdout.trim()).toBe('alive');
      await proc.kill('SIGKILL').catch(() => {});
    } finally {
      await sandbox.destroy();
    }
  }, 120_000);

  it('restores filesystem state through the ComputeSDK snapshot API', async () => {
    const provider = microsandbox({ backend: 'local' });
    const suffix = randomUUID().slice(0, 8);
    const original = await provider.instances.create({ name: `csdk-snapshot-source-${suffix}`, ephemeral: false });
    let restored: Awaited<ReturnType<typeof provider.instances.create>> | undefined;
    let snapshotId: string | undefined;

    try {
      // /tmp is a guest tmpfs and intentionally is not part of disk snapshots.
      await original.filesystem.writeFile('/from-snapshot.txt', 'persisted');
      const snapshot = await provider.snapshot!.create(original.instanceId, {
        name: `csdk-snapshot-${suffix}`,
      });
      snapshotId = snapshot.id;
      restored = await provider.instances.create({
        name: `csdk-snapshot-restored-${suffix}`,
        snapshotId,
      });

      expect(await restored.filesystem.readFile('/from-snapshot.txt')).toBe('persisted');
    } finally {
      if (restored) await restored.destroy();
      await original.destroy();
      if (snapshotId) await provider.snapshot!.delete(snapshotId);
    }
  }, 120_000);
});

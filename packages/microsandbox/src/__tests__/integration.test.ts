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

  it('captures live full snapshots with memory, forks into independent instances, and handles unmapped mounts and parent deletion', async () => {
    const provider = microsandbox({ backend: 'local' });
    const suffix = randomUUID().slice(0, 8);
    const volName = `csdk-snap-vol-${suffix}`;
    let original: Awaited<ReturnType<typeof provider.instances.create>> | undefined;
    let first: Awaited<ReturnType<typeof provider.instances.create>> | undefined;
    let second: Awaited<ReturnType<typeof provider.instances.create>> | undefined;
    let firstSnapId: string | undefined;
    let secondSnapId: string | undefined;

    try {
      expect(provider.snapshot?.capabilities).toEqual({
        scope: 'rootfs',
        memory: true,
        destroysSource: false,
        source: 'kept',
        fork: true,
        readiness: 'immediate',
      });

      await provider.volume!.create({
        name: volName,
        sizeBytes: 32 * 1024 * 1024,
        labels: { suite: 'integration' },
      });
      expect(await provider.volume!.list({ limit: 1 })).toHaveLength(1);

      original = await provider.instances.create({
        name: `csdk-snapshot-source-${suffix}`,
        volumes: [{ volume: { name: volName }, mountPath: '/mnt/src', readOnly: true }],
      });

      await original.filesystem.writeFile('/from-snapshot.txt', 'persisted');
      // Full capture preserves guest memory/tmpfs and regular guest processes; active managed
      // `startProcess` jobs must be stopped before full capture.
      await original.runCommand('sh -c "echo $$ > /tmp/snap.pid; exec sleep 600"', {
        background: true,
      });
      const deadline = Date.now() + 10_000;
      let pid = '';
      while (!pid && Date.now() < deadline) {
        pid = (await original.runCommand('cat /tmp/snap.pid 2>/dev/null')).stdout.trim();
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(pid).toBeTruthy();

      const snap1 = await provider.snapshot!.create(original.instanceId, {
        name: `csdk-snapshot-1-${suffix}`,
      });
      firstSnapId = snap1.id;
      expect(snap1.metadata.scope).toBe('full');

      // Second snapshot from the same source creates a parent-child ancestry entry.
      const snap2 = await provider.snapshot!.create(original.instanceId, {
        name: `csdk-snapshot-2-${suffix}`,
      });
      secondSnapId = snap2.id;

      // Restoring without re-binding /mnt/src succeeds cleanly via allowMissingResources()
      // and forks into two independent instances with live memory + process preserved.
      first = await provider.instances.create({
        name: `csdk-snapshot-fork-a-${suffix}`,
        snapshotId: firstSnapId,
      });
      second = await provider.instances.create({
        name: `csdk-snapshot-fork-b-${suffix}`,
        snapshotId: firstSnapId,
      });

      expect(await first.filesystem.readFile('/from-snapshot.txt')).toBe('persisted');
      expect((await first.runCommand(`kill -0 ${pid} && echo alive`)).stdout.trim()).toBe('alive');
      await first.filesystem.writeFile('/from-snapshot.txt', 'mutated-in-a');
      expect(await second.filesystem.readFile('/from-snapshot.txt')).toBe('persisted');
      expect((await second.runCommand(`kill -0 ${pid} && echo alive`)).stdout.trim()).toBe('alive');

      // Deleting parent snapshot before child must succeed (force: true) and be idempotent.
      await provider.snapshot!.delete(firstSnapId);
      await provider.snapshot!.delete(firstSnapId);
      firstSnapId = undefined;
    } finally {
      if (second) await second.destroy();
      if (first) await first.destroy();
      if (original) await original.destroy();
      if (firstSnapId) await provider.snapshot!.delete(firstSnapId);
      if (secondSnapId) await provider.snapshot!.delete(secondSnapId);
      await provider.volume!.delete(volName);
      // Repeated volume delete must be idempotent.
      await provider.volume!.delete(volName);
    }
  }, 120_000);
});

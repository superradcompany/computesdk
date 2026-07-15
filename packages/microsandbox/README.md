# @computesdk/microsandbox

[Microsandbox](https://microsandbox.dev) provider for ComputeSDK — run code in **local Linux microVMs** with hardware-level isolation (libkrun: KVM on Linux, Hypervisor.framework on macOS). No cloud account, no API key, no network round-trips.

## Features

- **Local-first**: sandboxes boot as microVMs on your machine — works offline, no credentials required
- **Hardware isolation**: a real VM boundary per sandbox, not a container namespace
- **Any OCI image**: `templateId` accepts any image reference (`alpine:3.21`, `python:3.12`, your own)
- **Real snapshots**: full `snapshot.create/list/delete` support, and `snapshotId` on create performs a genuine state **restore** — not an image re-boot
- **Filesystem**: native guest filesystem operations (read/write/mkdir/exists/remove)
- **Fast boots**: microVM cold starts measured in hundreds of milliseconds

## Prerequisites

- The [microsandbox](https://microsandbox.dev) runtime installed locally
- Virtualization support: `/dev/kvm` on Linux, or macOS (Apple Silicon or Intel)

## Installation

```bash
npm install @computesdk/microsandbox
```

## Usage

```typescript
import { createCompute } from 'computesdk';
import { microsandbox } from '@computesdk/microsandbox';

const compute = createCompute({
  provider: microsandbox({ image: 'alpine:3.21', cpus: 2, memoryMib: 2048 }),
});

const sandbox = await compute.sandbox.create();
const result = await sandbox.runCommand('echo "hello from a microVM"');
console.log(result.stdout);
await sandbox.destroy();
```

### Snapshot and restore

```typescript
const snapshot = await provider.snapshot.create(sandbox.sandboxId, { name: 'warm' });
// ...later: boots from the saved state, not from the image
const restored = await compute.sandbox.create({ snapshotId: 'warm' });
```

## Configuration

| Option | Default | Description |
|---|---|---|
| `image` | `alpine:3.21` | OCI image booted when `create()` has no `templateId` |
| `cpus` | `1` | Guest vCPUs |
| `memoryMib` | `512` | Guest memory (MiB) |
| `rootDiskMib` | runtime default | Writable root disk size (MiB) |
| `workdir` | image default | Working directory in the guest |
| `namePrefix` | `csdk-` | Prefix for generated sandbox names/ids |
| `ports` | none | Boot-time TCP port maps `{ host, guest }` — required for `getUrl()` |
| `timeout` | `300000` | Reported timeout (informational; local sandboxes do not expire) |
| `pullPolicy` | runtime default | Image pull policy |

No environment variables are required.

## Limitations

- `snapshot.create()` on a running sandbox currently quiesces it (stop → capture → restart): disk state survives the capture, in-guest processes do not. This is interim behavior — microsandbox is adding pause/resume and resumable snapshotting, after which capture will preserve running state. Snapshot a stopped sandbox to avoid the restart in the meantime.
- `getUrl()` resolves only guest ports declared via `ports` at create time (microVM port maps are set at boot). Streaming callbacks (`onStdout`/`onStderr`) depend on `getUrl`, so declare the daemon port if you need them.
- Create-time `timeout` is reported in `getInfo()` but not enforced — local sandboxes do not bill and are not auto-expired.
- `metadata` persists via sandbox labels; complex values are stringified.

## Testing

```bash
npm test                       # unit tests against the shared mock
MSB_RUN_INTEGRATION=1 npm test # boots real local microVMs
```

---
description: >-
  Microsandbox provider for ComputeSDK with hardware-isolated local and cloud microVM backends.
layout:
  width: default
  title:
    visible: true
  description:
    visible: false
  tableOfContents:
    visible: true
  outline:
    visible: true
  pagination:
    visible: true
  metadata:
    visible: true
  tags:
    visible: true
  actions:
    visible: true
---

# Microsandbox

Microsandbox runs hardware-isolated Linux microVMs through one SDK. The ComputeSDK provider supports both the embedded local runtime and microsandbox cloud without changing the sandbox, command, or filesystem API.

Each `microsandbox(...)` provider creates its own isolated `LocalContext` or `RemoteContext`, so multiple API keys, cloud profiles, endpoints, and mixed local/cloud providers run concurrently in the same Node.js process.

## Installation

Microsandbox requires Node.js 22 or newer.

```bash
npm install computesdk @computesdk/microsandbox
```

## Cloud backend

Cloud is the default backend and does not require virtualization on the caller's machine. Pass an API key directly or let the provider resolve `MSB_API_KEY` (with optional `MSB_API_URL`) or `MSB_PROFILE`:

```typescript
import { compute } from 'computesdk';
import { microsandbox } from '@computesdk/microsandbox';

compute.setConfig({
  provider: microsandbox({
    apiKey: process.env.MSB_API_KEY,
    image: 'python:3.12',
    computeType: 'standard',
  }),
});

const sandbox = await compute.instances.create();
console.log((await sandbox.runCommand('python --version')).stdout);
await sandbox.destroy();
```

You can also select a configured cloud profile with `microsandbox({ profile: 'production' })`. Calling `microsandbox()` with no configuration checks `MSB_API_KEY` and `MSB_PROFILE`. If neither resolves, the provider reports how to configure cloud or select local mode instead of silently running locally.

## Local backend

Select local execution explicitly when the sandbox should run on the calling machine. It does not require credentials:

```typescript
compute.setConfig({
  provider: microsandbox({
    backend: 'local',
    image: 'python:3.12',
    ports: [{ host: 8000, guest: 8000 }],
  }),
});
```

You can also pass `home` or `configPath` to isolate local runtime storage and configuration. The local runtime requires supported hardware virtualization: Hypervisor.framework on Apple Silicon macOS, KVM on Linux, or Windows Hypervisor Platform.

## Commands, processes, and files

Both backends support command execution, working directories, environment variables, timeouts, background commands, live stdout and stderr callbacks, named volumes (including `readOnly` mounts), and native filesystem access.

- On `local`, `runCommand` runs directly over `execWith` and `startProcess` uses the native `Job` API with live streams, stdin, signals, and status inspection.
- On `cloud`, `runCommand` uses a relay-safe detached worker so long-running commands survive relay session limits, and `startProcess` uses ComputeSDK's shell runtime fallback.

```typescript
await sandbox.filesystem.mkdir('/workspace');
await sandbox.filesystem.writeFile('/workspace/app.js', 'console.log("hello")');

const result = await sandbox.runCommand('node app.js', {
  cwd: '/workspace',
  onStdout: (chunk) => process.stdout.write(chunk),
});
```

## Pause, ports, and snapshots

- **Pause/resume:** Exposed on `backend: 'local'` only (`pause()`/`resume()` suspend the resident VM and preserve memory and processes). Cloud providers omit `pause`/`resume` from their capability surface.
- **Published ports:** Local-only via `ports` declared before sandbox creation. Cloud does not currently expose published guest ports and returns an explicit error on `getUrl`.
- **Snapshots:** Supported on both local and cloud backends. `snapshot.create` tries a live full-scope checkpoint first; when the backend does not support live full capture, it falls back to stopping the source (which requires `{ ephemeral: false }`), capturing the writable root disk, and restarting the source via `ensureRunning()`.

```typescript
const provider = microsandbox({
  backend: 'local',
  ports: [{ host: 3000, guest: 3000 }],
});

compute.setConfig({ provider });
const sandbox = await compute.instances.create({ ephemeral: false });
console.log(await sandbox.getUrl({ port: 3000 }));

const snapshot = await provider.snapshot.create(sandbox.instanceId, {
  name: 'configured',
});
const restored = await compute.instances.create({ snapshotId: snapshot.id });
```

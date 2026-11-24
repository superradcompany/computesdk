# @computesdk/microsandbox

Microsandbox provider for ComputeSDK. It runs the same sandbox API against hardware-isolated local microVMs or microsandbox cloud.

## Requirements

- Node.js 22 or newer
- Cloud backend: microsandbox cloud access and an API key (or configured profile)
- Local backend: macOS on Apple Silicon, Linux with KVM, or Windows with Windows Hypervisor Platform

## Installation

```bash
npm install computesdk @computesdk/microsandbox
```

## Cloud quick start

Cloud is the default backend. Pass an API key directly or omit it to resolve `MSB_API_KEY` (with optional `MSB_API_URL`) or `MSB_PROFILE`:

```typescript
import { compute } from 'computesdk';
import { microsandbox } from '@computesdk/microsandbox';

compute.setConfig({
  provider: microsandbox({
    apiKey: process.env.MSB_API_KEY,
    image: 'node:22',
  }),
});

const sandbox = await compute.instances.create();
const result = await sandbox.runCommand('node --version');
console.log(result.stdout);
await sandbox.destroy();
```

## Local quick start

Select the local backend explicitly when the sandbox should run on the calling machine. Local mode does not require an account or API key:

```typescript
import { compute } from 'computesdk';
import { microsandbox } from '@computesdk/microsandbox';

compute.setConfig({
  provider: microsandbox({
    backend: 'local',
    image: 'node:22',
    ports: [{ host: 3000, guest: 3000 }],
  }),
});

const sandbox = await compute.instances.create();
await sandbox.filesystem.writeFile('/tmp/hello.js', 'console.log("hello")');
console.log((await sandbox.runCommand('node /tmp/hello.js')).stdout);
await sandbox.destroy();
```

Calling `microsandbox()` with no configuration uses cloud through `MSB_API_KEY` or `MSB_PROFILE`. If neither resolves, the provider reports how to configure cloud or opt into `backend: 'local'`; it never silently falls back to local.

Use a named cloud profile instead of an API key when appropriate:

```typescript
const provider = microsandbox({ profile: 'production' });
```

Each provider instance owns an isolated `LocalContext` or `RemoteContext` from `microsandbox@0.8.1`, so multiple tenants, profiles, endpoints, and mixed local/cloud providers run concurrently in the same Node.js process with no shared process-wide backend state.

## Configuration

```typescript
interface MicrosandboxConfig {
  backend?: 'cloud' | 'local';         // Defaults to cloud
  apiKey?: string;                     // Falls back to MSB_API_KEY
  apiUrl?: string;                     // Optional endpoint override; requires apiKey
  profile?: string;                    // Named cloud profile; mutually exclusive with apiKey/apiUrl
  computeType?: 'standard' | 'shared'; // Cloud compute tier (cloud backend only)
  requestTimeoutMs?: number;           // Cloud HTTP request timeout in ms (cloud backend only)
  home?: string;                       // Custom local home directory (local backend only)
  configPath?: string;                 // Custom local config file path (local backend only)
  image?: string;
  cpus?: number;
  memoryMib?: number;
  rootDiskMib?: number;
  ephemeral?: boolean;                 // Delete on stop; defaults to true
  workdir?: string;
  namePrefix?: string;
  ports?: Array<number | { host: number; guest: number; bind?: string }>;
  timeout?: number;                    // Idle and command timeout in milliseconds; defaults to 900_000 (15 minutes)
  pullPolicy?: 'always' | 'if-missing' | 'never';
  networkEnabled?: boolean;
}
```

Per-sandbox `image`, `templateId`, `runtime` (`node` or `python`), `snapshotId`, `cpus`, `vcpus`, `memory`, `memoryMb`, `memoryMiB`, `memoryMib`, `memMiB`, `rootDiskMib`, `ephemeral`, `timeout`, `name`, `directory`, `envs`, `metadata`, `volumes` (including `readOnly`), and `ports` options override or extend provider defaults where applicable.

`sandbox.getInstance()` returns the native `microsandbox` `Sandbox` handle directly.

## Backend support

| Method | Local | Cloud |
|---|---|---|
| `create`, `getById`, `list`, `destroy` | Yes | Yes |
| `runCommand` and live output callbacks | Yes (direct `execWith` / `execStreamWith`) | Yes (relay-safe detached worker / `execStreamWith`) |
| `startProcess` | Native `Job`-backed | Shell runtime fallback |
| `pause` / `resume` | Yes (resident VM suspend) | Not exposed (local-only) |
| `filesystem` | Yes | Yes |
| `volume` | Yes (directory `.quota()` or `kind: 'disk'`, labels, `list({ limit })`) | Yes (directory volumes with whole-GiB `.quota()`, labels, `list({ limit })`) |
| `snapshot` | Yes (live full memory + rootfs, CoW multi-restore `fork: true`, keeps source running) | Yes (disk-only capture, stops/restarts persistent `ephemeral: false` source) |
| `getInfo` | Yes | Yes |
| `getUrl` | Yes, for ports declared before create | Not currently available |

Sandboxes are ephemeral by default and are deleted when they stop. Their default idle timeout is 15 minutes, configured through the native SDK's `idleTimeoutSeconds(900)`. Set `ephemeral: false` to retain a sandbox after stopping (required for disk-only snapshot fallback), and use `timeout` (milliseconds) to override the idle timeout and default command timeout.

## License

MIT

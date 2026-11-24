---
"@computesdk/microsandbox": patch
---

Upgrade `@computesdk/microsandbox` to `microsandbox@0.8.1` with per-provider `LocalContext` and `RemoteContext` isolation for concurrent multi-tenant and mixed local/cloud usage, direct local `execWith` command execution, native local `Job`-backed `startProcess`, backend-scoped `pause`/`resume` and `snapshot.capabilities` (live full memory + CoW fork on local, disk snapshots on cloud), native `Sandbox` handles from `getInstance()`, safe local restore (`allowMissingResources()`), idempotent snapshot/volume/file deletion, and volume quota/label/limit support.

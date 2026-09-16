# OpenCode Execd Worker Design

## Goal

Provide a standalone execution sandbox service: one deployable, fixed image that runs the official
OpenSandbox `execd` daemon plus the small amount of admission, path policy, and output normalization
needed to serve command execution over HTTP. It embeds `execd`, the in-container data plane, and
deliberately does not deploy the OpenSandbox Server control plane, which would need Docker or
Kubernetes privileges to create sandbox containers. A service replica may execute several sessions
concurrently, and it neither creates nor manages containers.

The reference client is the OpenCode plugin in the separate
[opencode-execd-plugin](https://github.com/jerolei999/opencode-execd-plugin) repository; the service
contract is generic, so any client that can send JSON over HTTP can use it. Shared storage supplies
the workspace, so the worker only validates and forwards absolute workspace paths. Placement,
authentication, session lifecycle, and routing stay outside this service.

## Boundary

```text
client (plugin, CLI, or any tooling)
        |  POST /execute, POST /release, GET /health
        v
Execd Worker service  (one container = one sandbox)
        |  admission, path policy, concurrency, session dirs
        v
OpenSandbox execd :44772
        |
        v
shell process on the mounted workspace
```

Command bytes go straight from the client to this service and never through an intermediate control
plane. Replicas are interchangeable for admission, but they are not interchangeable for session
state: `/execute` and `/release` for one session must reach the same replica, so a load balancer in
front of several replicas has to keep sessions pinned.


## Deployment model

- One image contains Bun, the worker service, and the official OpenSandbox `execd` binary.
- One deployed replica is one execution node. `OPENCODE_WORKER_CAPACITY` controls concurrent commands per replica.
- Multiple logical sessions share the replica's kernel and image. Each session receives deterministic `HOME` and temp paths, while its supplied workspace path resolves under `OPENCODE_WORKSPACE_ROOT` (the shared workspace mount).
- Scaling the SaaS service creates physical replicas. The plugin uses one stable internal service URL; normal SaaS load balancing distributes requests.
- The image uses the stateless `execd /command` API. OpenCode already sends full command, cwd, shell, and environment on every invocation; persistent shell state is neither required nor implied by the existing worker contract.

## Request lifecycle

1. Validate authentication, request shape, session concurrency, capacity, and workspace containment.
2. Reserve a slot and create the session's private home/temp directories.
3. Safely quote `shell -lc command`, then send it with cwd, environment, and timeout to the pinned `execd` command API.
4. Parse both standards-compliant SSE `data:` frames and legacy bare-JSON frames. `execd` streams one newline-stripped line per stdout/stderr event, so the terminator is restored while accumulating stdout, stderr, and interleaved output with bounded memory.
5. Read the final exit code from `GET /command/status/{commandID}`. `execd` also reports every non-zero exit as an `error` event and as `status.error` containing only the exit code, so the recorded exit code is authoritative and a failing command stays a normal result.
6. On client cancellation, timeout, release, or shutdown, cancel the HTTP stream and call `DELETE /command?id={commandID}`.
7. Release capacity and heartbeat the new status.

## Security and resource semantics

This is a multi-tenant execution pool, not a hostile-code security boundary. Sessions can be separated by directories and admission state, but they share a Unix identity, process namespace, network namespace, and the replica's CPU/memory limits. The shared storage's own permissions remain the authoritative filesystem boundary.

The practical controls are:

- absolute workdirs constrained beneath one configured workspace root;
- optional bearer authentication on the worker API and a separate loopback-only execd token;
- one active command per OpenCode session;
- bounded node concurrency and bounded captured output;
- SaaS-level CPU/memory limits per replica;
- explicit cancellation and cleanup.

Per-session hard CPU quotas require platform cgroups, separate containers, or a stronger runtime and are outside this design. Capacity is therefore load control, not a CPU quota.

## Compatibility

The reference client is maintained in the separate [opencode-execd-plugin](https://github.com/jerolei999/opencode-execd-plugin) repository and only depends on the contract below. No client, OpenCode Core, or control-plane change is required to adopt this service.

The execution service retains the small worker HTTP contract:

- `GET /health`
- `POST /execute`
- `POST /release`

The plugin supplies optional bearer authentication and maps the native OpenCode bash arguments (`command`, `timeout`, and `workdir`) to this contract. OpenCode Core needs no code changes. File tools stay local and operate on the same mounted workspace.

## Operations

- Readiness fails when `execd` is unreachable.
- SIGTERM cancels active executions before the replica exits.
- Session home/temp data is node-local and removed by `/release`; project data remains on the shared mount.
- Metrics initially expose worker capacity in `/health`; platform CPU/memory metrics remain available at the replica level, and raw execd metrics stay on loopback.

## Upstream references

- [OpenSandbox execd documentation](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/components/execd.md)
- [OpenSandbox execd OpenAPI](https://github.com/opensandbox-group/OpenSandbox/blob/main/specs/execd-api.yaml)

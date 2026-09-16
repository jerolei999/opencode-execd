# OpenCode Execd Worker Design

## Goal

Provide an OpenCode plugin plus a deployable, fixed-image SaaS execution service. The plugin transparently replaces OpenCode's built-in `bash` tool and delegates every shell command to a service backed by a colocated OpenSandbox `execd` process. A service replica may execute several OpenCode sessions concurrently. CubeFS supplies the shared workspace, so the worker only validates and forwards absolute workspace paths.

This project intentionally does not deploy the OpenSandbox control plane and does not create nested containers. It is designed for platforms that can deploy an ordinary private image but cannot grant a Docker socket, privileged mode, writable cgroups, or Kubernetes API access.

## Boundary

```text
OpenCodeBridge (existing auth/control plane)
        |
        v
OpenCode server + plugin ---- POST /execute ----> Execd Worker service
                                          | admission, path policy,
                                          | concurrency, session dirs
                                          v
                                  OpenSandbox execd :44772
                                          |
                                          v
                                  shell process on CubeFS
```

The Bridge remains unchanged and command bytes do not pass through it. The plugin calls the configured internal execution-service URL directly. The SaaS service or its load balancer spreads stateless command requests across replicas.

## Deployment model

- One image contains Bun, the worker service, and the official OpenSandbox `execd` binary.
- One deployed replica is one execution node. `OPENCODE_WORKER_CAPACITY` controls concurrent commands per replica.
- Multiple logical sessions share the replica's kernel and image. Each session receives deterministic `HOME` and temp paths, while its supplied workspace path resolves under `OPENCODE_WORKSPACE_ROOT` (the CubeFS mount).
- Scaling the SaaS service creates physical replicas. The plugin uses one stable internal service URL; normal SaaS load balancing distributes requests.
- The image uses the stateless `execd /command` API. OpenCode already sends full command, cwd, shell, and environment on every invocation; persistent shell state is neither required nor implied by the existing worker contract.

## Request lifecycle

1. Validate authentication, request shape, session concurrency, capacity, and workspace containment.
2. Reserve a slot and create the session's private home/temp directories.
3. Send `argv: [shell, "-lc", command]`, cwd, environment, and timeout to `execd`.
4. Parse both standards-compliant SSE `data:` frames and legacy bare-JSON frames. Accumulate stdout, stderr, and interleaved output with bounded memory.
5. Read the final exit code from `GET /command/status/{commandID}`.
6. On client cancellation, timeout, release, or shutdown, cancel the HTTP stream and call `DELETE /command?id={commandID}`.
7. Release capacity and heartbeat the new status.

## Security and resource semantics

This is a multi-tenant execution pool, not a hostile-code security boundary. Sessions can be separated by directories and admission state, but they share a Unix identity, process namespace, network namespace, and the replica's CPU/memory limits. CubeFS permissions remain the authoritative filesystem boundary.

The practical controls are:

- absolute workdirs constrained beneath one configured CubeFS root;
- optional bearer authentication on the worker API and a separate loopback-only execd token;
- one active command per OpenCode session;
- bounded node concurrency and bounded captured output;
- SaaS-level CPU/memory limits per replica;
- explicit cancellation and cleanup.

Per-session hard CPU quotas require platform cgroups, separate containers, or a stronger runtime and are outside this design. Capacity is therefore load control, not a CPU quota.

## Compatibility

The execution service retains the small worker HTTP contract:

- `GET /health`
- `POST /execute`
- `POST /release`

The plugin supplies optional bearer authentication and maps the native OpenCode bash arguments (`command`, `timeout`, and `workdir`) to this contract. OpenCode Core and Bridge need no code changes. File tools stay local and operate on the same CubeFS mount.

## Operations

- Readiness fails when `execd` is unreachable.
- SIGTERM cancels active executions before the replica exits.
- Session home/temp data is node-local and removed by `/release`; project data remains on CubeFS.
- Metrics initially expose worker capacity in `/health`; platform CPU/memory metrics remain available at the replica level, and raw execd metrics stay on loopback.

## Upstream references

- [OpenSandbox execd documentation](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/components/execd.md)
- [OpenSandbox execd OpenAPI](https://github.com/opensandbox-group/OpenSandbox/blob/main/specs/execd-api.yaml)

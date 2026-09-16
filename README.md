# OpenCode Execd

A standalone execution sandbox service. One ordinary OCI image runs the official OpenSandbox `execd`
daemon together with a small admission and output-normalization service, and exposes a tiny HTTP
contract for executing shell commands inside that container.

```text
client (the OpenCode plugin, or any other tooling)
        |
        |  POST /execute   POST /release   GET /health
        v
  opencode-execd   <-- one container is one sandbox
        +-- admission, path policy, per-session dirs, env sanitisation, output normalization
        +-- OpenSandbox execd on 127.0.0.1:44772
        v
  shell processes inside the container, acting on the mounted workspace
```

It is meant for environments where you can build and deploy a private service image but cannot grant
Docker socket access, privileged mode, writable cgroups, or Kubernetes API access. The workspace is
expected to be mounted at the same absolute path on the client and inside the sandbox (shared
storage such as CubeFS, or a bind mount for local use).

## What this is, and what it is not

- It **embeds `execd`**, the OpenSandbox data-plane daemon that executes commands inside an
already-running container. That is the piece which fits a restricted platform: the container itself
is the sandbox, so nothing creates nested containers.
- It **does not deploy OpenSandbox Server** (`opensandbox serve`). That is the control plane which
creates sandbox containers through Docker or Kubernetes, and it needs exactly the privileges a fixed
SaaS platform does not grant. Only the `execd` binary from the published OpenSandbox image is used.
- **Placement, authentication, session lifecycle, and routing are out of scope.** The service only
executes commands for a `sessionID`. Front it with whatever control plane or load balancer you
already run; when several replicas sit behind one URL, a request must stay on the replica that owns
the session (the [plugin repository](https://github.com/jerolei999/opencode-execd-plugin) contains a
sticky gateway example and the measured failure modes of round robin).

On top of `execd` this service adds the `/health`, `/execute`, and `/release` contract, admission
(node capacity plus one in-flight command per session), workspace containment, per-session
`HOME`/temp directories, environment sanitisation, SSE normalization (dual framing, line
terminators, bounded output), exit-code semantics, and cancellation plumbing. In code and
configuration the service is also called the *worker*, and its operational variables are prefixed
`OPENCODE_EXECD_WORKER_`.

## Client

The reference client is [opencode-execd-plugin](https://github.com/jerolei999/opencode-execd-plugin),
which overrides OpenCode's built-in `bash` tool and forwards commands here. It follows the same
transparent tool-override pattern as the Daytona OpenCode plugin, but only redirects `bash`:
`read`, `write`, `edit`, `grep`, `glob`, patching, and LSP stay inside OpenCode and see the same files
directly. There is no Git or file synchronization layer.


## Deploy the worker service

Build and push the image through the normal company CI/CD process:

```bash
docker build -t registry.example.com/infra/opencode-execd:0.1.0 .
docker push registry.example.com/infra/opencode-execd:0.1.0
```

Deploy it like any other HTTP service. The required settings are:

```text
EXECD_ACCESS_TOKEN=<random internal secret>
OPENCODE_EXECD_WORKER_ACCESS_TOKEN=<plugin-to-worker bearer token>
OPENCODE_WORKSPACE_ROOT=/cubefs/workspaces
OPENCODE_EXECD_WORKER_CAPACITY=4
```

Mount the shared workspace at the same absolute path in the client and in this service. Expose port `9010` only on the internal service network. Do not expose execd port `44772`; it is consumed on loopback by the worker.

The platform-level CPU and memory limits apply to a worker replica. `OPENCODE_EXECD_WORKER_CAPACITY` bounds concurrent commands inside that replica. Start with capacity close to the replica CPU limit and tune from measured workloads.

## Configure the plugin

Install [opencode-execd-plugin](https://github.com/jerolei999/opencode-execd-plugin) in the OpenCode deployment and point it at this service:

```json
{
  "plugin": [
    [
      "opencode-execd-plugin",
      {
        "endpoint": "http://opencode-execd.internal:9010",
        "token": "{env:OPENCODE_EXECD_WORKER_TOKEN}"
      }
    ]
  ]
}
```

When the company platform exposes replicas behind one stable service URL, use that URL. Requests are stateless with respect to the project because the workspace mount is shared. If commands rely on files in `HOME` across calls, either configure sticky routing or place `OPENCODE_SESSION_ROOT` on shared storage.

## Plugin behavior

The plugin is maintained in [opencode-execd-plugin](https://github.com/jerolei999/opencode-execd-plugin). It replaces OpenCode's built-in `bash` tool, keeps the native `command`, `timeout`, and `workdir` arguments, calls OpenCode's `bash` permission check before dispatch, sends cancellation when a tool call is aborted, and best-effort calls `/release` when a session is deleted. All filesystem tools stay local because both sides see the same workspace mount.

Only environment variables explicitly supplied in plugin option `env` are forwarded. The container starts execd with a clean environment, and worker/execd credentials are stripped before command execution.

## Service API

### `GET /health`

Reports `READY`, `BUSY`, or `BROKEN`, current capacity, leases, and active executions. `BROKEN` means the colocated execd process is unavailable.

### `POST /execute`

Accepts the existing OpenCode worker-shaped request:

```json
{
  "sessionID": "session-id",
  "workspaceID": "workspace-id",
  "root": "/cubefs/workspaces/acme/repo",
  "cwd": "/cubefs/workspaces/acme/repo/packages/api",
  "command": "bun test",
  "shell": "/bin/bash",
  "env": {},
  "timeoutMs": 120000,
  "maxOutputBytes": 1048576
}
```

The service rejects roots outside `OPENCODE_WORKSPACE_ROOT`, workdirs outside the request root, concurrent commands for the same session, and requests beyond node capacity.

A non-zero command exit is a normal result: the response is `200` with `exitCode` and the captured output, not an HTTP error. Error responses are reserved for admission failures, transport failures, and commands that `execd` could not start at all.

### `POST /release`

Cancels an active command for the session and removes its private home/temp directory.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXECD_ACCESS_TOKEN` | required | Loopback worker-to-execd secret |
| `OPENCODE_EXECD_WORKER_ACCESS_TOKEN` | unset | Optional bearer token required by `/execute` and `/release` |
| `OPENCODE_EXECD_WORKER_HOST` | `0.0.0.0` | HTTP bind host |
| `OPENCODE_EXECD_WORKER_PORT` | `9010` | HTTP port |
| `OPENCODE_EXECD_WORKER_ID` | hostname and port | Node identity returned to the plugin |
| `OPENCODE_EXECD_WORKER_CAPACITY` | `4` | Maximum concurrent commands |
| `OPENCODE_EXECD_WORKER_MAX_OUTPUT_BYTES` | `16777216` | Server-side output ceiling per stream |
| `OPENCODE_EXECD_WORKER_MAX_TIMEOUT_MS` | `1800000` | Server-side command timeout ceiling |
| `OPENCODE_WORKSPACE_ROOT` | `/workspace` | Allowed workspace root |
| `OPENCODE_SESSION_ROOT` | `/tmp/opencode-sessions` | Per-session home/temp root |
| `OPENSANDBOX_EXECD_URL` | `http://127.0.0.1:44772` | Internal execd address |

## Isolation statement

This is a multi-tenant execution pool, not a hostile-code sandbox. Logical sessions share the service container's kernel, process namespace, network namespace, Unix identity, and replica resource limits. A session may affect another session through those shared facilities. Use the platform's replica isolation, network policy, shared-storage ACLs, short-lived credentials, and client permissions as additional layers.

If untrusted-code isolation later becomes mandatory, keep the plugin contract and replace the service implementation with a real OpenSandbox Server backed by Kubernetes, Kata, gVisor, or microVM workers. The OpenCode integration does not need to change.

## Development

```bash
bun install
bun test
bun run typecheck
docker build -t opencode-execd:test .
```

The CI workflow additionally starts the built image and executes a real command through the packaged OpenSandbox `execd` process.

## Related repositories

- [opencode-execd-plugin](https://github.com/jerolei999/opencode-execd-plugin) - the OpenCode plugin that calls this service.

## License

MIT. The image copies the official Apache-2.0-licensed OpenSandbox `execd` binary from its published OCI image.

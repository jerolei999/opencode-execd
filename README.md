# OpenCode Execd

Transparent remote shell execution for OpenCode in fixed SaaS environments.

This repository contains the service half of the pair: a normal OCI image that runs the HTTP worker and OpenSandbox `execd` together. The OpenCode-side plugin lives in [opencode-execd-plugin](https://github.com/jerolei999/opencode-execd-plugin).

It is intended for environments where you can build and deploy private service images but cannot grant Docker socket access, privileged mode, writable cgroups, or Kubernetes API access. The workspace is expected to be mounted at the same absolute CubeFS path in OpenCode and the worker service.

## Why this shape

The full OpenSandbox Server needs a Docker or Kubernetes runtime capable of creating sandbox workloads. Running it inside an ordinary restricted SaaS container does not remove that requirement. This project reuses the mature `execd` data plane instead and adds the small amount of admission, authentication, path policy, and concurrency control needed for a shared execution node.

The plugin follows the same transparent tool-override pattern as the Daytona OpenCode plugin, but only redirects `bash`. `read`, `write`, `edit`, `grep`, `glob`, patching, and LSP stay inside OpenCode and see the same CubeFS files directly. There is no Git or file synchronization layer. Plugin behavior is documented in the [plugin repository](https://github.com/jerolei999/opencode-execd-plugin).

## Request path

```text
user -> OpenCodeBridge -> OpenCode serve
                              |
                        OpenCode plugin
                              |
                         POST /execute
                              |
                    opencode-execd service
                              |
                    OpenSandbox execd
                              |
                    command on CubeFS
```

The Bridge remains the existing authenticated control plane. Command traffic goes directly from OpenCode to the internal execution service.

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

Mount CubeFS at `/cubefs/workspaces` in both the OpenCode and worker deployments. Expose port `9010` only on the internal service network. Do not expose execd port `44772`; it is consumed on loopback by the worker.

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

When the company platform exposes replicas behind one stable service URL, use that URL. Requests are stateless with respect to the project because CubeFS is shared. If commands rely on files in `HOME` across calls, either configure sticky routing or place `OPENCODE_SESSION_ROOT` on shared storage.

## Plugin behavior

The plugin is maintained in [opencode-execd-plugin](https://github.com/jerolei999/opencode-execd-plugin). It replaces OpenCode's built-in `bash` tool, keeps the native `command`, `timeout`, and `workdir` arguments, calls OpenCode's `bash` permission check before dispatch, sends cancellation when a tool call is aborted, and best-effort calls `/release` when a session is deleted. All filesystem tools stay local because both sides see the same CubeFS mount.

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
| `OPENCODE_WORKSPACE_ROOT` | `/workspace` | Allowed CubeFS root |
| `OPENCODE_SESSION_ROOT` | `/tmp/opencode-sessions` | Per-session home/temp root |
| `OPENSANDBOX_EXECD_URL` | `http://127.0.0.1:44772` | Internal execd address |

## Isolation statement

This is a multi-tenant execution pool, not a hostile-code sandbox. Logical sessions share the service container's kernel, process namespace, network namespace, Unix identity, and replica resource limits. A session may affect another session through those shared facilities. Use the SaaS platform's replica isolation, network policy, CubeFS ACLs, short-lived credentials, and OpenCode permissions as additional layers.

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

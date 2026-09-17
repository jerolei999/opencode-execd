# Verification scripts

Used by [docs/test-report.md](../docs/test-report.md). They drive the plugin's `/execute`
contract against a running worker, an OpenSandbox deployment, or both.

| Script | Purpose | Needs |
| --- | --- | --- |
| `opensandbox-adapter.ts` | Exposes `/health`, `/execute`, `/release` on top of the OpenSandbox Lifecycle API, one sandbox per session (reuses `src/execd.ts`) | `SANDBOX_SERVER`, `SANDBOX_IMAGE`, `SANDBOX_WORKSPACE_ROOT`, `ADAPTER_ACCESS_TOKEN` |
| `scenario-matrix.sh` | 40 core scenarios on both backends (cwd/workdir, exit codes, output shape, truncation, timeout, admission, shared-mount round trip, release semantics) | `WORKER`/`WORKER_TOKEN`, `ADAPTER`/`ADAPTER_TOKEN`, `WS` |
| `edge-matrix2.sh` | Byte-level edge cases (NUL/CRLF/ANSI, invalid UTF-8, 100KB command, argument bounds, detached process, egress, memory) | same as above |
| `p0-failover.ts`, `p0-failover-local.ts` | Replica failure failover with a shared vs node-local session root (needs the plugin repo for its harness) | `OPENCODE_EXECD_TEST_*` |
| `p0-release.ts` | `session.deleted` -> `/release` -> sandbox deleted | same |

The workspace must be mounted at the same absolute path on both sides. On macOS the CubeFS FUSE
mount is only visible inside containers, so the mount is created in the VM namespace
(`--privileged --pid=host nsenter -t 1 -m ... -mountPoint=/host_mnt/<macOS path>`); host processes
still cannot see it.

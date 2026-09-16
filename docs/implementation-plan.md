# Implementation Plan

1. Specify and test an OpenCode plugin that transparently overrides `bash`, preserves permission checks and cancellation, and calls the execution service directly. Delivered in the separate [opencode-execd-plugin](https://github.com/jerolei999/opencode-execd-plugin) repository.
2. Specify and test an `execd` client for authenticated command execution, dual SSE framing, output limits, exit status, and cancellation.
3. Implement the worker HTTP service with workspace validation, per-session admission, capacity, deterministic session directories, authentication, and graceful shutdown.
4. Package the official `execd` binary and worker into one ordinary OCI image with a supervised entrypoint and readiness check.
5. Add contract tests, configuration documentation, local smoke tooling, and CubeFS deployment guidance.
6. Run tests, type checking, container build, and an end-to-end command smoke test before publishing the repository.


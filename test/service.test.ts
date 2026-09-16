import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ExecdRunInput, ExecdRunResult } from "../src/execd.ts"
import { WorkerService } from "../src/service.ts"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("WorkerService", () => {
  test("validates auth and workspace paths before delegating to execd", async () => {
    const workspaceRoot = await tempdir()
    const root = path.join(workspaceRoot, "tenant", "repo")
    const cwd = path.join(root, "packages", "api")
    await mkdir(cwd, { recursive: true })
    let delegated: ExecdRunInput | undefined
    const service = new WorkerService({
      workerID: "node-1",
      capacity: 2,
      workspaceRoot,
      sessionRoot: await tempdir(),
      accessToken: "worker-secret",
      execd: {
        async health() {},
        async interrupt() {},
        async run(input) {
          delegated = input
          return result()
        },
      },
    })

    const unauthorized = await service.fetch(executeRequest({ root, cwd }))
    expect(unauthorized.status).toBe(401)

    const response = await service.fetch(
      executeRequest({ root, cwd, command: `printf '%s' "it's"` }, "worker-secret"),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sandboxID: "node-1",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      output: "ok",
      outputTruncated: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    })
    expect(delegated?.command).toBe(`exec '/bin/bash' -lc 'printf '"'"'%s'"'"' "it'"'"'s"'`)
    expect(delegated?.cwd).toBe(cwd)
    expect(delegated?.env.USER_VALUE).toBe("visible")
    expect(delegated?.env.EXECD_ACCESS_TOKEN).toBeUndefined()
    expect(delegated?.env.OPENCODE_SESSION_ID).toBe("session-1")

    const outside = await service.fetch(
      executeRequest({ root, cwd: path.join(workspaceRoot, "other") }, "worker-secret"),
    )
    expect(outside.status).toBe(400)
  })

  test("enforces capacity and one active command per session", async () => {
    const workspaceRoot = await tempdir()
    const root = path.join(workspaceRoot, "repo")
    await mkdir(root)
    let finish = () => {}
    const blocked = new Promise<void>((resolve) => {
      finish = resolve
    })
    const service = new WorkerService({
      workerID: "node-1",
      capacity: 1,
      workspaceRoot,
      sessionRoot: await tempdir(),
      execd: {
        async health() {},
        async interrupt() {},
        async run() {
          await blocked
          return result()
        },
      },
    })

    const first = service.fetch(executeRequest({ root, cwd: root }))
    await Bun.sleep(10)
    const sameSession = await service.fetch(executeRequest({ root, cwd: root }))
    const capacity = await service.fetch(executeRequest({ root, cwd: root, sessionID: "session-2" }))
    expect(sameSession.status).toBe(503)
    expect(capacity.status).toBe(503)
    finish()
    expect((await first).status).toBe(200)
  })

  test("release aborts the active execd request", async () => {
    const workspaceRoot = await tempdir()
    const root = path.join(workspaceRoot, "repo")
    await mkdir(root)
    let aborted = false
    const service = new WorkerService({
      workerID: "node-1",
      capacity: 1,
      workspaceRoot,
      sessionRoot: await tempdir(),
      execd: {
        async health() {},
        async interrupt() {},
        async run(input) {
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener(
              "abort",
              () => {
                aborted = true
                resolve()
              },
              { once: true },
            )
          })
          throw new DOMException("aborted", "AbortError")
        },
      },
    })

    const running = service.fetch(executeRequest({ root, cwd: root }))
    await Bun.sleep(10)
    const released = await service.fetch(
      new Request("http://worker/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID: "session-1" }),
      }),
    )

    expect(released.status).toBe(200)
    expect(await released.json()).toEqual({ released: true })
    expect(aborted).toBe(true)
    expect((await running).status).toBe(499)
  })
})

async function tempdir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-execd-"))
  dirs.push(dir)
  return dir
}

function executeRequest(
  override: Partial<{
    sessionID: string
    root: string
    cwd: string
    command: string
  }>,
  token?: string,
) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  return new Request("http://worker/execute", {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionID: override.sessionID ?? "session-1",
      workspaceID: "workspace-1",
      root: override.root,
      cwd: override.cwd,
      command: override.command ?? "bun test",
      shell: "/bin/bash",
      env: { USER_VALUE: "visible", EXECD_ACCESS_TOKEN: "must-not-win" },
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    }),
  })
}

function result(): ExecdRunResult {
  return {
    commandID: "cmd-1",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    output: "ok",
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

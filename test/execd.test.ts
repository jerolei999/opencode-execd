import { afterEach, describe, expect, test } from "bun:test"
import { ExecdClient } from "../src/execd.ts"

const servers: Bun.Server<unknown>[] = []

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
})

describe("ExecdClient", () => {
  test("runs the quoted command through execd and combines legacy and standard SSE frames", async () => {
    let commandBody: unknown
    const received: { token?: string | null } = {}
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === "/command") {
          commandBody = await request.json()
          received.token = request.headers.get("x-execd-access-token")
          return new Response(
            [
              JSON.stringify({ type: "init", text: "cmd-1" }),
              `data: ${JSON.stringify({ type: "stdout", text: "hello" })}`,
              JSON.stringify({ type: "stderr", text: "warn" }),
              JSON.stringify({ type: "stdout", text: "world" }),
              // execd v1.1.0 ends a non-zero exit with an error event whose text is the exit code,
              // and it never sends execution_complete for that case.
              JSON.stringify({
                type: "error",
                error: { ename: "CommandExecError", evalue: "7", traceback: ["exit status 7"] },
              }),
              "",
            ].join("\n\n"),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        if (request.method === "GET" && url.pathname === "/command/status/cmd-1") {
          return Response.json({ id: "cmd-1", running: false, exit_code: 7, error: "7" })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    const result = await new ExecdClient({ url: server.url.toString(), accessToken: "secret" }).run({
      command: "exec '/bin/bash' -lc 'build'",
      cwd: "/workspace/project",
      env: { CI: "1" },
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    })

    expect(received.token).toBe("secret")
    expect(commandBody).toEqual({
      command: "exec '/bin/bash' -lc 'build'",
      cwd: "/workspace/project",
      background: false,
      timeout: 5000,
      envs: { CI: "1" },
    })
    expect(result).toEqual({
      commandID: "cmd-1",
      exitCode: 7,
      stdout: "hello\nworld\n",
      stderr: "warn\n",
      output: "hello\nwarn\nworld\n",
      outputTruncated: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    })
  })

  test("bounds each captured stream without buffering unlimited output", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === "/command") {
          return new Response(
            [
              JSON.stringify({ type: "init", text: "cmd-2" }),
              JSON.stringify({ type: "stdout", text: "abcdefgh" }),
              JSON.stringify({ type: "stderr", text: "12345678" }),
              JSON.stringify({ type: "execution_complete" }),
              "",
            ].join("\n\n"),
          )
        }
        if (url.pathname === "/command/status/cmd-2") {
          return Response.json({ id: "cmd-2", running: false, exit_code: 0 })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    const result = await new ExecdClient({ url: server.url.toString(), accessToken: "secret" }).run({
      command: "exec 'sh' -lc 'output'",
      cwd: "/workspace",
      env: {},
      maxOutputBytes: 5,
    })

    expect(result.stdout).toBe("abcde")
    expect(result.stderr).toBe("12345")
    expect(result.output).toBe("abcde")
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.outputTruncated).toBe(true)
  })

  test("restores the line terminators that execd strips from each output event", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === "/command") {
          return new Response(
            [
              JSON.stringify({ type: "init", text: "cmd-5" }),
              JSON.stringify({ type: "stdout", text: "first" }),
              JSON.stringify({ type: "stdout", text: "second" }),
              JSON.stringify({ type: "execution_complete" }),
              "",
            ].join("\n\n"),
          )
        }
        if (url.pathname === "/command/status/cmd-5") {
          return Response.json({ id: "cmd-5", running: false, exit_code: 0 })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    const result = await new ExecdClient({ url: server.url.toString(), accessToken: "secret" }).run({
      command: "exec '/bin/bash' -lc 'two lines'",
      cwd: "/workspace",
      env: {},
    })

    expect(result.stdout).toBe("first\nsecond\n")
    expect(result.output).toBe("first\nsecond\n")
  })

  test("reports a failure when execd records no exit code", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === "/command") {
          return new Response(
            [
              JSON.stringify({ type: "init", text: "cmd-4" }),
              JSON.stringify({
                type: "error",
                error: { ename: "CommandExecError", evalue: "fork/exec /bin/bash: no such file or directory" },
              }),
              "",
            ].join("\n\n"),
          )
        }
        if (url.pathname === "/command/status/cmd-4") {
          return Response.json({ id: "cmd-4", running: false, error: "fork/exec /bin/bash: no such file or directory" })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    const running = new ExecdClient({ url: server.url.toString(), accessToken: "secret" }).run({
      command: "exec '/bin/bash' -lc 'build'",
      cwd: "/workspace",
      env: {},
    })

    await expect(running).rejects.toThrow(/fork\/exec/)
  })

  test("interrupts the initialized execd command when aborted", async () => {
    let interrupted = false
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === "/command") {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "init", text: "cmd-3" })}\n\n`))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        if (request.method === "DELETE" && url.pathname === "/command" && url.searchParams.get("id") === "cmd-3") {
          interrupted = true
          return Response.json({})
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    const controller = new AbortController()
    const running = new ExecdClient({ url: server.url.toString(), accessToken: "secret" }).run({
      command: "exec 'sh' -lc 'sleep 60'",
      cwd: "/workspace",
      env: {},
      signal: controller.signal,
    })
    await Bun.sleep(20)
    controller.abort()

    await expect(running).rejects.toThrow()
    expect(interrupted).toBe(true)
  })
})

/**
 * OpenSandbox adapter: exposes the plugin's /health, /execute, /release contract on top of the
 * OpenSandbox Lifecycle API, so the plugin stays unchanged and the backend becomes
 * "one sandbox container per session" instead of "one shared worker container".
 *
 *   plugin ──/execute──▶ adapter ──POST /v1/sandboxes──▶ OpenSandbox server ──▶ sandbox container
 *                              └────/v1/sandboxes/{id}/proxy/44772/command────▶ execd in that sandbox
 *
 * Session -> sandbox mapping (and the sandbox itself) is adapter-owned state; the server never
 * learns about sessions. Cancellation, line-terminator restoration, output bounds, and exit-code
 * semantics are the same ones the worker uses, because the adapter drives the same execd API.
 */
import path from "node:path"
import { createHash } from "node:crypto"
import { ExecdClient } from "/Users/jero/Documents/code/opencode-execd/src/execd.ts"

const server = (process.env.SANDBOX_SERVER ?? "http://127.0.0.1:8080").replace(/\/$/, "")
const sandboxImage = process.env.SANDBOX_IMAGE ?? "opensandbox-sandbox:local"
const execdImage = process.env.SANDBOX_EXECD_IMAGE ?? "opensandbox/execd:v1.1.0"
const workspaceRoot = path.resolve(process.env.SANDBOX_WORKSPACE_ROOT ?? "/private/tmp/workspace")
const mountPath = process.env.SANDBOX_MOUNT_PATH ?? workspaceRoot
const accessToken = process.env.ADAPTER_ACCESS_TOKEN
const capacity = Number(process.env.ADAPTER_CAPACITY ?? "4")
const sandboxTimeout = Number(process.env.SANDBOX_TIMEOUT_SECONDS ?? "1800")
const port = Number(process.env.ADAPTER_PORT ?? "19050")

type Sandbox = { id: string; execd: ExecdClient; commandID?: string; controller: AbortController }
const sandboxes = new Map<string, Sandbox>()
// Same admission rule as the worker: one in-flight command per session.
const busy = new Set<string>()

const json = (value: unknown, status = 200) => Response.json(value, { status })

async function createSandbox(sessionID: string, workspaceID: string) {
  const response = await fetch(`${server}/v1/sandboxes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      image: { uri: sandboxImage },
      entrypoint: ["tail", "-f", "/dev/null"],
      timeout: sandboxTimeout,
      resourceLimits: { cpu: "2", memory: "2Gi" },
      env: { OPENCODE_SESSION_ID: sessionID, OPENCODE_WORKSPACE_ID: workspaceID },
      volumes: [{ name: `ws-${createHash("sha256").update(sessionID).digest("hex").slice(0, 8)}`, mountPath, host: { path: mountPath } }],
    }),
  })
  if (!response.ok) throw new Error(`sandbox create failed: ${response.status} ${await response.text()}`)
  const created = (await response.json()) as { id: string; status: { state: string } }
  const id = created.id

  for (let attempt = 0; attempt < 60; attempt++) {
    const status = (await (await fetch(`${server}/v1/sandboxes/${id}`)).json()) as { status: { state: string } }
    if (status.status.state === "Running") break
    if (status.status.state === "Failed") throw new Error(`sandbox ${id} failed to start`)
    await Bun.sleep(250)
  }

  // Sandbox execd is reached through the server proxy on loopback of the sandbox, so no token is needed.
  const execd = new ExecdClient({ url: `${server}/v1/sandboxes/${id}/proxy/44772`, accessToken: "" })
  const sandbox: Sandbox = { id, execd, controller: new AbortController() }
  sandboxes.set(sessionID, sandbox)
  console.log(`[adapter] session ${sessionID} -> sandbox ${id}`)
  return sandbox
}

async function pruneDeadSandboxes() {
  // A sandbox can disappear underneath us (server restart, TTL, manual docker rm). Drop those
  // entries so a stale map does not hold capacity forever.
  for (const [sessionID, sandbox] of [...sandboxes]) {
    const response = await fetch(`${server}/v1/sandboxes/${sandbox.id}`)
    if (response.status === 404) {
      sandboxes.delete(sessionID)
      console.log(`[adapter] pruned stale session ${sessionID} (sandbox ${sandbox.id} is gone)`)
    }
  }
}

async function ensureSandbox(sessionID: string, workspaceID: string) {
  const existing = sandboxes.get(sessionID)
  if (existing) return existing
  if (sandboxes.size >= capacity) {
    await pruneDeadSandboxes()
    if (sandboxes.size >= capacity) throw new Error("capacity is exhausted")
  }
  return createSandbox(sessionID, workspaceID)
}

Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    const url = new URL(request.url)

    if (request.method === "GET" && url.pathname === "/health") {
      const upstream = await fetch(`${server}/health`).then((r) => r.json()).catch(() => undefined)
      return json({ id: "opensandbox-adapter", status: upstream ? "READY" : "BROKEN", capacity, leased: sandboxes.size, executing: [...sandboxes.values()].filter((s) => s.commandID).length })
    }

    if (accessToken && request.headers.get("authorization") !== `Bearer ${accessToken}`) {
      return json({ error: "unauthorized" }, 401)
    }

    if (request.method === "POST" && url.pathname === "/execute") {
      const input = (await request.json()) as {
        sessionID: string
        workspaceID: string
        root: string
        cwd: string
        command: string
        shell?: string
        env?: Record<string, string>
        timeoutMs?: number
        maxOutputBytes?: number
      }
      const root = path.resolve(input.root)
      const cwd = path.resolve(input.cwd)
      const contained = (base: string, target: string) => {
        const relative = path.relative(base, target)
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      }
      if (!contained(workspaceRoot, root)) return json({ error: `workspace root ${root} is outside ${workspaceRoot}` }, 400)
      if (!contained(root, cwd)) return json({ error: `cwd ${cwd} is outside workspace root ${root}` }, 400)

      if (busy.has(input.sessionID)) return json({ error: "session is already executing on this node" }, 503)
      busy.add(input.sessionID)
      try {
        const sandbox = await ensureSandbox(input.sessionID, input.workspaceID)
        const shell = input.shell ?? "/bin/bash"
        const result = await sandbox.execd.run({
          command: `exec ${quote(shell)} -lc ${quote(input.command)}`,
          cwd,
          // The sandbox already carries the workspace mount, so only caller env is forwarded.
          env: { ...input.env, OPENCODE_SESSION_ID: input.sessionID, OPENCODE_WORKSPACE_ID: input.workspaceID },
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes,
          signal: AbortSignal.any([request.signal, sandbox.controller.signal]),
          onCommandID(commandID) {
            sandbox.commandID = commandID
          },
        })
        return json({ sandboxID: sandbox.id, ...result })
      } catch (error) {
        console.error("[adapter] execute failed", error)
        return json({ error: error instanceof Error ? error.message : String(error) }, 500)
      } finally {
        busy.delete(input.sessionID)
        const sandbox = sandboxes.get(input.sessionID)
        if (sandbox) sandbox.commandID = undefined
      }
    }

    if (request.method === "POST" && url.pathname === "/release") {
      const { sessionID } = (await request.json()) as { sessionID?: string }
      if (!sessionID) return json({ error: "sessionID is required" }, 400)
      const sandbox = sandboxes.get(sessionID)
      sandboxes.delete(sessionID)
      if (!sandbox) return json({ released: false })
      sandbox.controller.abort()
      await fetch(`${server}/v1/sandboxes/${sandbox.id}`, { method: "DELETE" }).catch(() => undefined)
      console.log(`[adapter] released sandbox ${sandbox.id} for ${sessionID}`)
      return json({ released: true, sandboxID: sandbox.id })
    }

    return json({ error: "not found" }, 404)
  },
})

function quote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

console.log(`[adapter] listening on http://0.0.0.0:${port} -> ${server}, image ${sandboxImage}, workspace ${mountPath}`)

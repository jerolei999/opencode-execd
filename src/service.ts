import { createHash, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import type { ExecdClient, ExecdRunInput, ExecdRunResult } from "./execd.ts"

type Execd = Pick<ExecdClient, "health" | "interrupt" | "run">

type ExecuteInput = {
  readonly sessionID: string
  readonly workspaceID: string
  readonly root: string
  readonly command: string
  readonly cwd: string
  readonly shell?: string
  readonly env: Record<string, string>
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

type Active = {
  readonly controller: AbortController
  commandID?: string
}

export class WorkerService {
  readonly #workerID: string
  readonly #capacity: number
  readonly #workspaceRoot: string
  readonly #sessionRoot: string
  readonly #accessToken?: string
  readonly #maxOutputBytes: number
  readonly #maxTimeoutMs: number
  readonly #execd: Execd
  readonly #active = new Map<string, Active>()
  readonly #reserved = new Set<string>()

  constructor(input: {
    workerID: string
    capacity: number
    workspaceRoot: string
    sessionRoot: string
    accessToken?: string
    maxOutputBytes?: number
    maxTimeoutMs?: number
    execd: Execd
  }) {
    this.#workerID = input.workerID
    this.#capacity = Math.max(1, input.capacity)
    this.#workspaceRoot = path.resolve(input.workspaceRoot)
    this.#sessionRoot = path.resolve(input.sessionRoot)
    this.#accessToken = input.accessToken
    this.#maxOutputBytes = input.maxOutputBytes ?? 16 * 1024 * 1024
    this.#maxTimeoutMs = input.maxTimeoutMs ?? 30 * 60 * 1000
    this.#execd = input.execd
  }

  async fetch(request: Request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") return this.#health()
    if (!this.#authorized(request)) return json({ error: "unauthorized" }, 401)
    if (request.method === "POST" && url.pathname === "/execute") return this.#executeRequest(request)
    if (request.method === "POST" && url.pathname === "/release") return this.#releaseRequest(request)
    return json({ error: "not found" }, 404)
  }

  async shutdown() {
    this.#active.forEach((active) => active.controller.abort())
    await Promise.all(
      [...this.#active.values()]
        .map((active) => active.commandID)
        .filter((commandID): commandID is string => commandID !== undefined)
        .map((commandID) => this.#execd.interrupt(commandID).catch(() => undefined)),
    )
  }

  status() {
    const executing = this.#active.size
    const leased = executing + this.#reserved.size
    const available = Math.max(0, this.#capacity - leased)
    return {
      id: this.#workerID,
      status: available > 0 ? ("READY" as const) : ("BUSY" as const),
      capacity: this.#capacity,
      available,
      leased,
      executing,
    }
  }

  async #health() {
    try {
      await this.#execd.health()
      return json(this.status())
    } catch (error) {
      return json(
        {
          ...this.status(),
          status: "BROKEN",
          error: error instanceof Error ? error.message : String(error),
        },
        503,
      )
    }
  }

  async #executeRequest(request: Request) {
    try {
      return json(await this.#execute(parseExecuteInput(await request.json()), request.signal))
    } catch (error) {
      if (isAbort(error)) return json({ error: "execution cancelled" }, 499)
      if (error instanceof RequestError) return json({ error: error.message }, error.status)
      console.error("[opencode-execd] execution failed", error)
      return json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }

  async #execute(input: ExecuteInput, requestSignal: AbortSignal) {
    if (this.#active.has(input.sessionID) || this.#reserved.has(input.sessionID)) {
      throw new RequestError(503, "session is already executing on this worker")
    }
    if (this.#active.size + this.#reserved.size >= this.#capacity) {
      throw new RequestError(503, "worker capacity is exhausted")
    }
    this.#reserved.add(input.sessionID)

    const root = path.resolve(input.root)
    const cwd = path.resolve(input.cwd)
    if (!contained(this.#workspaceRoot, root) || !contained(root, cwd)) {
      this.#reserved.delete(input.sessionID)
      throw new RequestError(400, `workspace path is outside worker root ${this.#workspaceRoot}`)
    }

    const sessionDir = path.join(
      this.#sessionRoot,
      createHash("sha256").update(input.sessionID).digest("hex").slice(0, 32),
    )
    const home = path.join(sessionDir, "home")
    const tmp = path.join(sessionDir, "tmp")
    try {
      await Promise.all([mkdir(home, { recursive: true }), mkdir(tmp, { recursive: true })])
    } catch (error) {
      this.#reserved.delete(input.sessionID)
      throw error
    }

    const controller = new AbortController()
    const signal = AbortSignal.any([requestSignal, controller.signal])
    const active: Active = { controller }
    this.#reserved.delete(input.sessionID)
    this.#active.set(input.sessionID, active)

    try {
      const result = await this.#execd.run({
        argv: [resolveShell(input.shell), "-lc", input.command],
        cwd,
        env: {
          ...baseEnvironment(),
          ...safeEnvironment(input.env),
          OPENCODE_SESSION_ID: input.sessionID,
          OPENCODE_WORKSPACE_ID: input.workspaceID,
          HOME: home,
          TMPDIR: tmp,
          TMP: tmp,
          TEMP: tmp,
        },
        timeoutMs: bounded(input.timeoutMs, this.#maxTimeoutMs),
        maxOutputBytes: bounded(input.maxOutputBytes, this.#maxOutputBytes) ?? this.#maxOutputBytes,
        signal,
        onCommandID(commandID) {
          active.commandID = commandID
        },
      })
      return response(this.#workerID, result)
    } finally {
      if (this.#active.get(input.sessionID) === active) this.#active.delete(input.sessionID)
    }
  }

  async #releaseRequest(request: Request) {
    const value = (await request.json()) as { sessionID?: unknown }
    if (typeof value.sessionID !== "string" || !value.sessionID) {
      return json({ error: "sessionID is required" }, 400)
    }
    const active = this.#active.get(value.sessionID)
    active?.controller.abort()
    if (active?.commandID) await this.#execd.interrupt(active.commandID).catch(() => undefined)
    await rm(
      path.join(this.#sessionRoot, createHash("sha256").update(value.sessionID).digest("hex").slice(0, 32)),
      { recursive: true, force: true },
    )
    return json({ released: active !== undefined })
  }

  #authorized(request: Request) {
    if (!this.#accessToken) return true
    const expected = Buffer.from(`Bearer ${this.#accessToken}`)
    const received = Buffer.from(request.headers.get("authorization") ?? "")
    return expected.length === received.length && timingSafeEqual(expected, received)
  }
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function parseExecuteInput(value: unknown): ExecuteInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, "invalid JSON body")
  const input = value as Record<string, unknown>
  for (const field of ["sessionID", "workspaceID", "root", "command", "cwd"] as const) {
    if (typeof input[field] !== "string" || !input[field]) throw new RequestError(400, `${field} is required`)
  }
  const env = input.env
  if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env))) {
    throw new RequestError(400, "env must be an object")
  }
  const entries = Object.entries((env ?? {}) as Record<string, unknown>)
  if (entries.some((entry) => typeof entry[1] !== "string")) throw new RequestError(400, "env values must be strings")
  return {
    sessionID: input.sessionID as string,
    workspaceID: input.workspaceID as string,
    root: input.root as string,
    command: input.command as string,
    cwd: input.cwd as string,
    shell: typeof input.shell === "string" ? input.shell : undefined,
    env: Object.fromEntries(entries) as Record<string, string>,
    timeoutMs: optionalPositiveInteger(input.timeoutMs, "timeoutMs"),
    maxOutputBytes: optionalPositiveInteger(input.maxOutputBytes, "maxOutputBytes"),
  }
}

function optionalPositiveInteger(value: unknown, name: string) {
  if (value === undefined) return
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
  throw new RequestError(400, `${name} must be a positive integer`)
}

function bounded(value: number | undefined, max: number) {
  return value === undefined ? undefined : Math.min(value, max)
}

function contained(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function resolveShell(requested = "/bin/bash") {
  if (path.isAbsolute(requested) && existsSync(requested)) return requested
  const name = path.basename(requested)
  return [`/bin/${name}`, `/usr/bin/${name}`, "/bin/sh"].find(existsSync) ?? "/bin/sh"
}

function baseEnvironment() {
  return Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TZ"]
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function safeEnvironment(env: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^(EXECD_|OPENCODE_EXECD_|OPENCODE_WORKER_|OPENCODE_SERVER_)/.test(name)),
  )
}

function response(workerID: string, result: ExecdRunResult) {
  return {
    sandboxID: workerID,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.output,
    outputTruncated: result.outputTruncated,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  }
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status })
}

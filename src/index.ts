import os from "node:os"
import { mkdir } from "node:fs/promises"
import { ExecdClient } from "./execd.ts"
import { WorkerService } from "./service.ts"

const host = process.env.OPENCODE_EXECD_WORKER_HOST ?? "0.0.0.0"
const port = integer(process.env.OPENCODE_EXECD_WORKER_PORT, 9010)
const workerID = process.env.OPENCODE_EXECD_WORKER_ID ?? `${os.hostname()}-${port}`
const workspaceRoot = process.env.OPENCODE_WORKSPACE_ROOT ?? "/workspace"
const sessionRoot = process.env.OPENCODE_SESSION_ROOT ?? "/tmp/opencode-sessions"
const execdToken = process.env.EXECD_ACCESS_TOKEN
if (!execdToken) throw new Error("EXECD_ACCESS_TOKEN is required")

await mkdir(sessionRoot, { recursive: true })

const service = new WorkerService({
  workerID,
  capacity: integer(process.env.OPENCODE_EXECD_WORKER_CAPACITY, 4),
  workspaceRoot,
  sessionRoot,
  accessToken: process.env.OPENCODE_EXECD_WORKER_ACCESS_TOKEN,
  maxOutputBytes: integer(process.env.OPENCODE_EXECD_WORKER_MAX_OUTPUT_BYTES, 16 * 1024 * 1024),
  maxTimeoutMs: integer(process.env.OPENCODE_EXECD_WORKER_MAX_TIMEOUT_MS, 30 * 60 * 1000),
  execd: new ExecdClient({
    url: process.env.OPENSANDBOX_EXECD_URL ?? "http://127.0.0.1:44772",
    accessToken: execdToken,
  }),
})

const server = Bun.serve({
  hostname: host,
  port,
  fetch: (request) => service.fetch(request),
})

console.log(`[opencode-execd] ${workerID} listening on ${server.url}`)
console.log(`[opencode-execd] workspace root: ${workspaceRoot}`)
console.log(`[opencode-execd] capacity: ${service.status().capacity}`)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[opencode-execd] received ${signal}, cancelling active commands`)
  server.stop(false)
  await service.shutdown()
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

function integer(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  throw new Error(`Expected a positive integer, received ${value}`)
}


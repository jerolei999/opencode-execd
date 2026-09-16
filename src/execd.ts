type StreamEvent = {
  readonly type?: string
  readonly text?: string
  readonly error?: {
    readonly ename?: string
    readonly evalue?: string
    readonly traceback?: string[]
  }
}

type CommandStatus = {
  readonly running?: boolean
  readonly exit_code?: number | null
  readonly error?: string
}

export type ExecdRunInput = {
  readonly command: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly signal?: AbortSignal
  readonly onCommandID?: (commandID: string) => void
}

export type ExecdRunResult = {
  readonly commandID: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly output: string
  readonly outputTruncated: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export class ExecdClient {
  readonly #url: string
  readonly #headers: Record<string, string>

  constructor(input: { url: string; accessToken: string }) {
    this.#url = input.url.replace(/\/$/, "")
    this.#headers = {
      "content-type": "application/json",
      "x-execd-access-token": input.accessToken,
    }
  }

  async health() {
    const response = await fetch(`${this.#url}/ping`, { headers: this.#headers })
    if (!response.ok) throw new Error(`execd health returned ${response.status}: ${await response.text()}`)
  }

  async interrupt(commandID: string) {
    const response = await fetch(`${this.#url}/command?id=${encodeURIComponent(commandID)}`, {
      method: "DELETE",
      headers: this.#headers,
    })
    if (!response.ok) throw new Error(`execd interrupt returned ${response.status}: ${await response.text()}`)
  }

  async run(input: ExecdRunInput): Promise<ExecdRunResult> {
    const max = input.maxOutputBytes ?? 1024 * 1024
    if (!Number.isSafeInteger(max) || max <= 0) throw new Error("maxOutputBytes must be a positive integer")

    const stdout = new BoundedOutput(max)
    const stderr = new BoundedOutput(max)
    const output = new BoundedOutput(max)
    let commandID: string | undefined
    let executionError: string | undefined

    try {
      const response = await fetch(`${this.#url}/command`, {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify({
          command: input.command,
          cwd: input.cwd,
          background: false,
          ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
          envs: input.env,
        }),
        signal: input.signal,
      })
      if (!response.ok) throw new Error(`execd command returned ${response.status}: ${await response.text()}`)
      if (!response.body) throw new Error("execd command returned no event stream")

      await readEvents(response.body, (event) => {
        if (event.type === "init" && event.text) {
          commandID = event.text
          input.onCommandID?.(commandID)
          return false
        }
        if (event.type === "stdout" && event.text) {
          appendLine(stdout, output, event.text)
          return false
        }
        if (event.type === "stderr" && event.text) {
          appendLine(stderr, output, event.text)
          return false
        }
        if (event.type === "error") {
          executionError = event.error?.evalue ?? event.error?.ename ?? event.text ?? "execd execution failed"
          return true
        }
        return event.type === "execution_complete"
      })

      if (!commandID) throw new Error("execd event stream did not provide a command ID")
      const status = await this.#status(commandID, input.signal)
      // execd reports every non-zero exit both as an `error` event and as `status.error`
      // whose only content is the exit code itself (traceback `exit status N`), and it
      // skips `execution_complete`. A non-zero exit is a normal command result, so the
      // recorded exit code wins and the error text only matters when execd never
      // produced one, for example when the shell could not be started at all.
      const exitCode = status.exit_code ?? undefined
      if (exitCode === undefined) {
        const reason = status.error ?? executionError
        throw new Error(
          reason
            ? `execd command ${commandID} failed: ${reason}`
            : `execd command ${commandID} completed without an exit code`,
        )
      }

      return {
        commandID,
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        output: output.text(),
        outputTruncated: output.truncated,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      }
    } finally {
      if (input.signal?.aborted && commandID) await this.interrupt(commandID).catch(() => undefined)
    }
  }

  async #status(commandID: string, signal?: AbortSignal): Promise<CommandStatus> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetch(`${this.#url}/command/status/${encodeURIComponent(commandID)}`, {
        headers: this.#headers,
        signal,
      })
      if (!response.ok) throw new Error(`execd status returned ${response.status}: ${await response.text()}`)
      const status = (await response.json()) as CommandStatus
      if (!status.running) return status
      await Bun.sleep(25)
    }
    throw new Error(`execd command ${commandID} still reports running after completion`)
  }
}

// execd streams one newline-stripped line per stdout/stderr event, so the line terminator
// is restored here. Without it, multi-line output such as `bun test` collapses into one run.
function appendLine(stream: BoundedOutput, merged: BoundedOutput, text: string) {
  stream.append(`${text}\n`)
  merged.append(`${text}\n`)
}

class BoundedOutput {
  readonly #max: number
  readonly #chunks: Buffer[] = []
  #stored = 0
  #seen = 0

  constructor(max: number) {
    this.#max = max
  }

  append(value: string) {
    const bytes = Buffer.from(value)
    this.#seen += bytes.length
    const remaining = this.#max - this.#stored
    if (remaining <= 0) return
    const chunk = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes
    this.#chunks.push(chunk)
    this.#stored += chunk.length
  }

  get truncated() {
    return this.#seen > this.#max
  }

  text() {
    return Buffer.concat(this.#chunks, this.#stored).toString()
  }
}

async function readEvents(stream: ReadableStream<Uint8Array>, onEvent: (event: StreamEvent) => boolean) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const result = await reader.read()
      buffer += decoder.decode(result.value, { stream: !result.done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ""
      for (const frame of frames) {
        const event = parseEvent(frame)
        if (event && onEvent(event)) {
          await reader.cancel()
          return
        }
      }
      if (result.done) break
    }

    const event = parseEvent(buffer)
    if (event) onEvent(event)
  } finally {
    reader.releaseLock()
  }
}

function parseEvent(frame: string): StreamEvent | undefined {
  const lines = frame.split(/\r?\n/)
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  const payload = (data || frame).trim()
  if (!payload || payload.startsWith(":")) return
  return JSON.parse(payload) as StreamEvent
}

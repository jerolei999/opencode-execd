import { expectResult, open } from "/Users/jero/Documents/code/opencode-execd-plugin/test/integration/harness.ts"
const project = "/private/tmp/execd-it/project"
const replicas = [
  { url: "http://127.0.0.1:19023", container: "opencode-execd-it-3" },
  { url: "http://127.0.0.1:19024", container: "opencode-execd-it-4" },
]
const docker = (...args: string[]) => Bun.spawnSync(["docker", ...args]).stdout.toString().trim()
const node = (id: string) => replicas.find((r) => id.includes(r.container.slice(-1) === "3" ? "local-3" : "local-4"))
const session = await open({ session: "p0-local-home", endpoints: replicas.map((r) => r.url), directory: project, root: project })
const first = expectResult(await session.run({ command: 'printf marker > "$HOME/marker.txt"; printf "%s|written" "$(hostname)"' }))
const before = expectResult(await session.run({ command: 'cat "$HOME/marker.txt"' }))
const victim = node(first.sandboxID)
const out: Record<string, unknown> = { pinned: first.sandboxID, marker_before: before.output.trim() }
if (victim) {
  docker("stop", victim.container)
  await Bun.sleep(1500)
  const after = await session.run({ command: 'printf "%s|" "$(hostname)"; cat "$HOME/marker.txt" 2>/dev/null || echo marker-missing' })
  out.after_kill = after.kind === "result" ? `${after.output.trim()} on ${after.sandboxID}` : `ERROR: ${after.message.slice(0, 90)}`
  docker("start", victim.container)
}
console.log(JSON.stringify(out, null, 2))

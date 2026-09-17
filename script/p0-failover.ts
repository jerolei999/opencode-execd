/**
 * P0-1: replica failure failover.
 *
 * a) plugin with an explicit endpoint list -> does it move the session to the surviving replica,
 *    and what happens to node-local session HOME state?
 * b) plugin pointed at the sticky gateway -> what happens when the replica the session hashes to
 *    dies (nginx retry, affinity, release target)?
 */
import { expectResult, open } from "/Users/jero/Documents/code/opencode-execd-plugin/test/integration/harness.ts"

const ws = process.env.P0_WS ?? "/private/tmp/execd-it"
const project = `${ws}/project`
const replicas = [
  { url: "http://127.0.0.1:19021", container: "opencode-execd-it-1" },
  { url: "http://127.0.0.1:19022", container: "opencode-execd-it-2" },
]
const sticky = "http://127.0.0.1:19031"
const node = (sandboxID: string) => {
  if (sandboxID.includes("replica-1")) return replicas[0]
  if (sandboxID.includes("replica-2")) return replicas[1]
  return undefined
}
const docker = (...args: string[]) => {
  const proc = Bun.spawnSync(["docker", ...args])
  return proc.stdout.toString().trim()
}

const out: Record<string, unknown> = {}

// ---------- a) explicit endpoint list ----------
{
  const session = await open({ session: "p0-failover", endpoints: replicas.map((r) => r.url), directory: project, root: project })
  const first = expectResult(await session.run({ command: 'printf marker > "$HOME/marker.txt"; printf "%s|written" "$(hostname)"' }))
  const home1 = expectResult(await session.run({ command: 'cat "$HOME/marker.txt"' }))
  const victim = node(first.sandboxID)
  out.a_pinned_to = first.sandboxID
  out.a_home_marker_before = home1.output.trim()

  if (victim) {
    docker("stop", victim.container)
    await Bun.sleep(1500)
    const during = await session.run({ command: 'printf "%s|" "$(hostname)"; cat "$HOME/marker.txt" 2>/dev/null || echo marker-missing' })
    const after = await session.run({ command: 'printf "%s|still-here" "$(hostname)"' })
    out.a_after_kill = during.kind === "result" ? during.output.trim() : `ERROR: ${during.message.slice(0, 80)}`
    out.a_after_kill_node = during.kind === "result" ? during.sandboxID : undefined
    out.a_second_call = after.kind === "result" ? `${after.output.trim()} on ${after.sandboxID}` : `ERROR: ${after.message.slice(0, 80)}`
    docker("start", victim.container)
    await Bun.sleep(4000)
  }
}

// ---------- b) sticky gateway with a dead replica ----------
{
  const session = await open({ session: "p0-sticky-dead", endpoint: sticky, directory: project, root: project })
  const warm = expectResult(await session.run({ command: 'printf marker > "$HOME/marker.txt"; printf "%s|written" "$(hostname)"' }))
  const victim = node(warm.sandboxID)
  out.b_pinned_to = warm.sandboxID
  if (victim) {
    docker("stop", victim.container)
    await Bun.sleep(1500)
    const during = await session.run({ command: 'printf "%s|" "$(hostname)"; cat "$HOME/marker.txt" 2>/dev/null || echo marker-missing' })
    out.b_after_kill = during.kind === "result" ? `${during.output.trim()} on ${during.sandboxID}` : `ERROR: ${during.message.slice(0, 100)}`
    const released = await session.release().then(() => "release-sent")
    out.b_release = released
    docker("start", victim.container)
    await Bun.sleep(4000)
  }
}

console.log(JSON.stringify(out, null, 2))

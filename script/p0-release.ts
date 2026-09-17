import { expectResult, open } from "/Users/jero/Documents/code/opencode-execd-plugin/test/integration/harness.ts"
const ws = "/private/tmp/workspace"
const session = await open({ session: "p0-release", endpoint: "http://127.0.0.1:19050", directory: `${ws}/users/user01`, root: `${ws}/users/user01` })
const r = expectResult(await session.run({ command: "hostname" }))
console.log("sandboxID=", r.sandboxID)
await session.release()
console.log("release sent")

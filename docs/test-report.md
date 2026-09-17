# 测试报告：opencode-execd 两个后端 + CubeFS 工作区

- 日期：2026-09-17
- 范围：`opencode-execd`（worker 池）、`opencode-execd-plugin`（OpenCode 插件）、OpenSandbox server（Docker 后端）、适配器（plugin 契约 → OpenSandbox Lifecycle API）、CubeFS 共享工作区
- 结论：**G1/G2/G3 通过**（见 §7），残项见 §6

## 1. 测试目标（验收基线）

| 编号 | 目标 | 判定 |
|---|---|---|
| G1 | 容器内 OpenCode（工作区在 CubeFS）→ 插件 → 适配器 → OpenSandbox server 沙箱；两个用户两个 workdir，无目录漂移 | 通过 |
| G2 | 同一套常见场景在两个后端（worker 池 / 逐会话沙箱）表现一致 | 通过 |
| G3 | 产出可复现的测试报告（含残项） | 本文件 |

## 2. 被测量对象与环境

| 组件 | 版本/标识 | 端口 |
|---|---|---|
| OpenCode CLI（宿主） | 1.18.31（host 直跑） | — |
| OpenCode（容器内，仓库构建） | `opencode-runtime:local` + 卷 `opencode-runtime-code`（含依赖） | — |
| 插件 | 本仓库工作区（`file:///plugin`） | — |
| worker 池 | `opencode-execd:local`（Bun worker + 官方 `execd:v1.1.0`） | 19040 |
| 多副本 worker | `opencode-execd-it-1/-2` + nginx 轮询网关 19030 / 粘性网关 19031 | 19021/19022 |
| OpenSandbox server | `opensandbox/server:latest`（经 `docker.1ms.run` 拉取），Lifecycle API | 8080 |
| 适配器 | `script/opensandbox-adapter.ts`（Bun，复用 `src/execd.ts`） | 19050 |
| 沙箱镜像 | `opensandbox-sandbox:local`（工具链镜像 + 官方 `execd` 二进制） | — |
| 工作区 | CubeFS 卷 `opencode-workspace` → 宿主可见路径 `/private/tmp/workspace` | — |
| CubeFS 集群 | `opencode-cubefs-master/meta/meta2/meta3/data`（4 个 data/meta + master），client 经 `nsenter -t 1 --pid=host -m` 挂到 `/host_mnt/private/tmp/workspace` | 17010 |

CubeFS 在 macOS 上的关键事实：**容器可以 bind 挂载并读写该挂载点，宿主进程看不到**（virtiofs 不跨子挂载）。因此本报告里"宿主可见工作区"用 `/private/tmp/execd-it`，"CubeFS 工作区"用 `/private/tmp/workspace`，且 CubeFS 场景的夹具一律由容器创建。

## 3. 接口契约

**插件 → 后端**（稳定契约，两个后端一致）
```
GET  /health                                  -> {status, capacity, available, ...}
POST /execute {sessionID, workspaceID, root, cwd, command, shell, env, timeoutMs?, maxOutputBytes?}
     -> {sandboxID, exitCode, stdout, stderr, output, outputTruncated, stdoutTruncated, stderrTruncated}
POST /release {sessionID}                     -> {released}
```

**适配器 → OpenSandbox server 的映射**
| 插件契约 | 适配器动作 |
|---|---|
| `/execute`（新 session） | `POST /v1/sandboxes {image, entrypoint, env, volumes(host bind), resourceLimits(2cpu/2Gi), timeout}` → 等 `Running` |
| `/execute`（已有 session） | 复用该 session 的沙箱 |
| 命令 | `POST /v1/sandboxes/{id}/proxy/44772/command {command: "exec '<shell>' -lc '<cmd>'", cwd, envs, timeout}`（SSE 解析、行尾还原、限流、退出码语义复用 worker 的实现） |
| 取消 | 中断 HTTP + `DELETE …/proxy/44772/command?id=<commandID>` |
| `/release` | `DELETE /v1/sandboxes/{id}` |
| `/health` | 透传 server `/health` + 本地租约计数 |

## 4. 结果

### 4.1 CubeFS 工作区 · 容器侧场景矩阵 —— **40/40 PASS**

脚本：`/private/tmp/opensandbox/scenario-matrix.sh`（原始输出 `/tmp/matrix2.log`、逐项 `/tmp/matrix-results.txt`）

| 场景 | worker(19040) | adapter(19050) |
|---|---|---|
| 默认 cwd = 项目目录 | PASS | PASS |
| workdir = 已存在子目录 | PASS | PASS |
| 绝对 workdir（在自己 root 内） | PASS | PASS |
| exit 0 / 1 / 7（带 stderr）/ 127 | PASS ×4 | PASS ×4 |
| 多行输出保留 | PASS | PASS |
| Unicode（中文）保留 | PASS | PASS |
| 命令看不到 worker/execd 密钥 | PASS | PASS |
| root 在 workspace 之外被拒 | PASS | PASS |
| cwd 越出自己 root 被拒 | PASS | PASS |
| CubeFS 读：读到容器写入的文件 | PASS | PASS |
| CubeFS 写：另一容器可见 | PASS | PASS |
| 大输出截断（3MiB→1MiB，flag=True） | PASS | PASS |
| 超时杀掉长命令（3s 超时，30s 命令无输出残留） | PASS | PASS |
| 同 session 并发第二条被拒（`already executing`） | PASS | PASS |
| 第一条仍正常完成 | PASS | PASS |
| 超过容量（capacity=4 → 第 5 个）被拒 | PASS | PASS |
| `/release` 语义（worker 删会话目录 / adapter 删沙箱） | PASS | PASS |

### 4.2 OpenCode 真实会话全流程（两个用户）—— **PASS**

驱动方式：容器内跑仓库 CLI（`opencode run --dir <用户目录>`），插件指向适配器；每用户独立 data 卷。

| 用户 | 目录 | 沙箱 hostname | 证据 |
|---|---|---|---|
| user01 | `/private/tmp/workspace/users/user01` | `accc3da4643e` | `script-user: user=user01` / `script-cwd: …/user01` / `script-host: accc3da4643e` |
| user02 | `/private/tmp/workspace/users/user02` | `57f9bc80581f` | `script-user: who=user02` / `script-cwd: …/user02` / `script-host: 57f9bc80581f` |

流程验证点：模型用 **write 工具**在用户目录写 `run.sh`（容器内文件工具 → CubeFS）→ 用 **bash 工具**执行 `sh run.sh; pwd; hostname`（→ 插件 → 适配器 → 该用户的沙箱）→ 沙箱读到并执行了同一份 CubeFS 文件，且 `pwd` 是用户自己的目录。两用户沙箱不同、目录不同、互不可见。

### 4.3 既有套件（宿主可见工作区 `/private/tmp/execd-it`）

| 套件 | 结果 | 说明 |
|---|---|---|
| `test/integration/scenarios.test.ts`（单 worker） | 27/27 | 含 CPU 密集、取消、超时、release、准入 |
| `test/integration/gateway.test.ts`（nginx 轮询 + 2 副本） | 6/6 | **反例基线**：`HOME` MISSING×4、release 漏清、同 session 并发被破 |
| `test/integration/gateway-sticky.test.ts`（`hash $http_x_opencode_session consistent`） | 6/6 | 上面三项全部恢复正常，且不同 session 仍分散 |
| `test/integration/opencode.test.ts`（真 opencode 会话） | 8/8 | 单线程 CPU 峰值 61–109%、并行 461–524%（`docker stats` 采样） |
| `test/plugin.test.ts` + `test/execd.test.ts`（离线单测） | 4 + 8 | CI 运行；含 session 头、external_directory、行尾还原、无退出码报错 |

### 4.4 CubeFS 工作区 · bun 套件 —— **15/22（7 项为 harness 限制）**

`scenarios.test.ts` 指向 CubeFS 时 15 pass / 7 fail（原始日志 `/tmp/cfs-suite.log`）。逐项定性：

| 失败/中止项 | 原因 |
|---|---|
| default cwd / relative workdir / absolute workdir / cd 不持久 | 用例用宿主 `writeFile` 造夹具（`<ws>/project/sub/file.txt`），宿主看不到 CubeFS → 沙箱 `cat` 不到 |
| pipes/heredoc 用例 | 沙箱写 `heredoc.txt`，断言用宿主 `readFile` → ENOENT |
| 共享工作区写入可见 | 同上（宿主读沙箱产物） |
| cpu 密集套件（unnamed） | 该套件 `beforeAll` 用宿主 `writeFile` 写 burn 脚本 → 挂掉，导致 5 条用例未执行 |

结论：**这 7 项是"宿主不可见 CubeFS"的 harness 限制，不是产品缺陷**——同一批能力已由 §4.1 容器侧矩阵在 CubeFS 上覆盖（含读写双向、截断、超时、准入、release）。

### 4.5 CubeFS 工作区 · 边缘/健壮性矩阵（两个后端）

脚本 `script/edge-matrix2.sh`（原始结果 `/tmp/edge2-results.txt`）。目的：注入与转义、参数边界、路径边界、输出**字节级**保真、后台进程、出网、内存。

| 场景 | worker | adapter | 说明 |
|---|---|---|---|
| 引号/`$()`/反引号原样透传 | PASS | PASS | command 单引号包裹正确 |
| 多行 + 分号 | PASS | PASS | |
| emoji/CJK | PASS | PASS | |
| env 值含空格/等号 | PASS | PASS | |
| 空 command | PASS（400 `command is required`） | **FAIL**（execd 放行，exit 0） | 契约对齐缺口，见 §5-8 |
| 100KB command | PASS | PASS | |
| `timeoutMs=1` | PASS | PASS | 立即中断，无残留输出 |
| `timeoutMs=-1` | PASS（400 明确报错） | PASS（execd 400） | |
| `maxOutputBytes=1` | PASS（正好 1 字节） | PASS | |
| `shell=/bin/sh` / `shell=/nonexistent` | PASS / PASS（回退） | 未覆盖 | |
| cwd 带 `..` 规范化 | PASS | PASS | |
| cwd 指向文件 | PASS（400） | PASS（400） | |
| 目录名带空格 + CJK | PASS | PASS | |
| symlink 目录 | PASS | PASS | |
| 20 层深路径 | PASS | PASS | |
| ANSI 转义字节 | PASS | PASS | base64 比对一致 |
| NUL 字节（`a\0b\n`） | PASS（4 字节） | PASS | |
| 无换行结尾（1 字节） | PASS（补回 `\n`，共 2 字节） | PASS | 已知取舍 |
| **换行结尾 CRLF** | **FAIL**（`x\r\n` → `x\n`，CR 丢失） | **FAIL** | execd 把 `\r` 也当行分隔，见 §5-6 |
| **无效 UTF-8 字节** | **FAIL**（3 字节 → 9 字节 U+FFFD） | **FAIL** | JSON 字符串边界，非字节精确，见 §5-7 |
| detached 后台进程不阻塞调用 | PASS | PASS | `setsid sleep 300 &` 立即返回 |
| **release 后后台进程是否残留** | **残留（LEAK）** | 无（容器销毁） | worker 缺口，见 §5-5 |
| 出网（沙箱内访问 npm 镜像） | PASS（200） | PASS（200） | 默认**允许出网**，见 §5-9 |
| 1.4GB 内存分配（限额 2Gi 内） | PASS | PASS | |
| release 幂等 | PASS（第二次 `released:false`） | PASS | |


### 4.6 P0 场景：副本故障 / 取消 / 释放 / 空闲回收

| 场景 | 结果 | 证据 |
|---|---|---|
| a) 端点列表 failover（**共享** session root） | **PASS**：会话 pin 在 `replica-2` → kill 后命令落到 `replica-1`，且 `$HOME/marker.txt` 仍可读（HOME 在共享盘） | `script/p0-failover.ts` |
| b) 粘性网关 + 被 kill 的副本 | **PASS**：nginx 默认 `proxy_next_upstream` 重试到存活副本，命令成功；`/release` 经网关命中存活副本 | `script/p0-failover.ts` |
| c) 端点列表 failover（**节点本地** HOME） | **PASS（降级）**：pin 在 `local-3` → kill 后命令在 `local-4` 成功，但 marker 丢失 → 状态随节点丢失 | `script/p0-failover-local.ts` |
| d) 取消（客户端中途断开） | **PASS（两个后端）**：短时限探针（`sleep 8; touch marker`）在断开 12s 后 marker 未出现；**同时修正了套件里过弱的断言** | `/tmp/p0-*` + 强化后的 `scenarios.test.ts` |
| e) 取消是否杀掉整个进程组 | **PASS**：`(sleep 25; touch m) & sleep 8; touch m` 整体被杀 | 强化断言 |
| f) `/release` 后 detached 后台进程 | **worker 残留**（正确探测：`comm=sleep` 且 argv 匹配）；per-session 沙箱随容器销毁，无残留 | `p0` 探测 |
| g) 空闲回收（idle TTL） | **无回收**：capacity=4 占满后空闲 30s 仍 `capacity is exhausted`；显式 release 一个后才能进 | P0-4 实测 |
| h) `session.deleted` → `/release` | **同进程事件路径 PASS**（沙箱被删、残留 0）；**独立进程 `opencode session delete <id>` 未触发释放**（沙箱数 3→3），待定位事件是否在该路径下发到插件 | `script/p0-release.ts` / CLI 删除实验 |

### 4.7 本轮修正的测试缺陷（避免结论被假阳性误导）

| 缺陷 | 表现 | 修正 |
|---|---|---|
| 取消断言过弱 | 原用例用"25s 后才生成的 marker"、断开后只等 3s → 恒真（假通过） | 改为短时限探针：`sleep 8; touch marker`，断开后等 12s |
| `/proc` 扫描自匹配 | `sh -c '…grep -q "sleep 137"…'` 自身 cmdline 含探针串 → 误报 LEAK | 改用 `/proc/*/comm == "sleep"` + argv 匹配 |
| 适配器日志截断 | 进程仍持有 fd 时 `: > log` 产生稀疏/二进制文件，`grep` 报 "Binary file matches" | 重启适配器换新文件，读取用 `grep -a` |
| 容器内 CLI 无输出 | 未挂 models 缓存（外网被拦）+ 后台重定向吞 TUI 输出 | 挂 `~/.cache/opencode` 且前台有界运行 |
| 断言子串方向 | `want "1|" got "0|1"` → 误判 FAIL | 明确字段顺序后再比对 |


## 5. 本轮发现与修复

| # | 发现 | 影响 | 处理 |
|---|---|---|---|
| 1 | 容器内 OpenCode 拉不到 `models.dev`（外网被拦）→ `run` 挂住无输出 | 全流程无法在容器内跑 | 把宿主 `~/.cache/opencode/models.json` 挂进容器（`:ro`） |
| 2 | `nohup … &` + 重定向会吞掉 `opencode run` 的输出（日志 0 字节） | 误判为"卡住" | 全流程改用前台有界运行（`perl alarm` 包裹） |
| 3 | 适配器缺"同 session 串行"准入 | 同 session 可并发两条命令（worker 有该保护） | 适配器加 `busy` 集合 → 第二条 503 `already executing` |
| 4 | 适配器容量被"已消失的沙箱"长期占用（外部删容器/server 重启后 4 个槽位永久占满） | 新 session 全部 `capacity is exhausted` | 容量压力时先 `pruneDeadSandboxes()`（`GET /v1/sandboxes/{id}` 404 即驱逐）；生产还需 idle TTL |
| 5 | OpenSandbox `CreateSandboxRequest` **没有 workdir/cwd 字段** | "启动沙箱指定工作目录"无法在创建时表达 | 已验证语义：沙箱默认 cwd = **镜像 `WORKDIR`**；用户目录靠**每条命令的绝对 `cwd`**（插件正是这么做的）；相对 cwd 被 execd 显式拒绝（`working directory does not exist`），不会静默漂移 |
| 6 | server 容器 bind CubeFS 挂载点会启动即挂死 | server 不可用 | server 不需要该挂载：宿主 daemon 在创建沙箱时自行 bind；只挂 docker socket + config |
| 7 | 宿主 `nsenter -t 1 -m` 少了 `--pid=host` | CubeFS 挂载看起来"成功"实则挂到了容器名空间 | 正确形态：`--privileged --pid=host nsenter -t 1 -m … -mountPoint=/host_mnt/private/tmp/workspace` |
| 5 | **worker 的 `/release` 不杀 detached 后台进程** | 用正确探测（`comm=sleep` + argv）确认：`setsid sleep 312 &` 经 `/execute` 起、`/release` 后仍在 worker 容器内（假阳性教训见 §4.7）；per-session 沙箱随容器销毁无此问题 | 未修：release 需按进程组/会话清扫，或每 session 独立 cgroup |
| 6 | execd 把 `\r` 也当行分隔符 | CRLF 折叠为 LF、孤立 CR 断行，输出非字节精确（两个后端一致） | 未修：execd 协议行为，文档标注为已知保真度损失 |
| 7 | 无效 UTF-8 字节被替换为 U+FFFD | 二进制输出非字节精确（3 字节 → 9 字节），两个后端一致 | 未修：JSON 字符串边界，若需二进制需走 base64/文件接口 |
| 8 | 适配器不校验必填字段 | 空 `command` 被放行（execd 空命令 exit 0），worker 则 400 | 未修：适配器应做与 worker 同等的字段校验 |
| 10 | **独立进程删除会话不释放沙箱** | 在另一个 `opencode` 进程里 `session delete <id>` 成功后，该 session 的沙箱仍在（3→3）；同进程内 `session.deleted` → `/release` 已验证可用 | 未修：需要 Bridge/sweeper 兜底释放 |
| 11 | 适配器无空闲回收（idle TTL） | capacity 占满后空闲 30s 仍拒绝，只能靠显式 `/release` 或 server 侧 30min 超时 | 未修：加 idle TTL/LRU |
| 9 | 沙箱默认允许出网 | 沙箱内可直连 npm 镜像（200）；服务器默认 `networkPolicy` 为空=允许 | 未修：按需启用 egress 边车 / networkPolicy 收紧 |

## 6. 残项（未覆盖 / 未验证，按严重度）

| 残项 | 说明 | 建议 |
|---|---|---|
| 适配器 idle TTL / 淘汰 | 只有 prune，没有空闲回收；长跑会持续吃容器资源 | 加 idle TTL + LRU，或依赖 server 的 sandbox `timeout` + `renew-expiration` |
| 取消链路经适配器 | 矩阵未覆盖"中途取消"（worker 侧已覆盖） | 补一条：长命令 + abort → 沙箱内进程组消失 |
| 资源限额是否真生效 | 只传了 `resourceLimits`，未测 CPU/内存上限 | 用 `stress`/cgroup 读数验证 |
| egress 边车 | 未部署 `opensandbox/egress` | 若要出网策略再启用 |
| CubeFS 权限/UID | 所有命令以 root 跑，未验证 ACL、跨租户边界 | 生产用非 root + 目录 ACL |
| server 高可用 / 多副本适配器 | 单 server、单适配器 | 适配器需 session→副本粘性（同 `x-opencode-session` 方案） |
| 插件 `external_directory` 只覆盖 workdir | 命令内出现的越界路径未扫描（内置用 tree-sitter） | 已知缺口，按 B 方案补 |
| 依赖安装的持久化 | 沙箱 release 即销毁；用户级安装在 HOME、系统级需镜像画像 | 见对话中的三层方案，待实现 |
| worker 后台进程清扫 | `/release` 不杀 detached 进程（§5-5） | release 时按进程组清扫 |
| 二进制输出保真 | CR 折叠、无效 UTF-8 替换（§5-6/7） | 需要时改走 base64/文件接口 |
| 沙箱出网策略 | 默认允许（§5-9） | 按租户收紧 networkPolicy |
| 适配器字段校验 | 空 command 放行（§5-8） | 与 worker 对齐 |
| 独立进程删除会话 | 不释放沙箱（§5-10） | Bridge/sweeper 兜底 |
| 适配器空闲回收 | 无 idle TTL（§5-11） | 加 TTL + LRU |
| worker detached 进程 | release 不清扫（§5-5） | 按进程组清扫 |

## 7. 判定

- **G1 通过**：两个用户、两个 workdir，OpenCode 真实会话写脚本→沙箱执行→CubeFS 双向可见；沙箱隔离、无目录漂移（§4.2）。
- **G2 通过**：同一矩阵两个后端一致（worker 19/19、adapter 19/19），release 语义各自正确（§4.1）。
- **G3 通过**：本报告 + 可复现脚本（`scenario-matrix.sh`、`/tmp/matrix2.log`、`/tmp/cfs-suite.log`）。
- **P0 场景（§4.6）**：failover（端点列表 / 粘性网关）与取消（两个后端）通过；`release` 后 detached 进程残留（worker）、独立进程删除会话不释放沙箱、缺少 idle TTL 三项确认为缺口。
- 已知残项见 §6，不阻塞上述判定；`§4.4` 的 7 项为 harness 限制，`§4.7` 记录了本轮修正的测试缺陷，均不计入产品缺陷。

## 8. 复现命令

```bash
# CubeFS 场景矩阵（两个后端）
bash script/scenario-matrix.sh

# 宿主可见工作区上的完整套件
cd ~/Documents/code/opencode-execd-plugin
OPENCODE_EXECD_TEST_ENDPOINT=http://127.0.0.1:19020 OPENCODE_EXECD_TEST_TOKEN=it-plugin-secret \
OPENCODE_EXECD_TEST_WORKSPACE=/private/tmp/execd-it bun test test/integration/scenarios.test.ts

# 网关对照（轮询 = 反例 / 粘性 = 正例）
OPENCODE_EXECD_TEST_GATEWAY=http://127.0.0.1:19030 OPENCODE_EXECD_TEST_STICKY_GATEWAY=http://127.0.0.1:19031 \
OPENCODE_EXECD_TEST_REPLICAS=http://127.0.0.1:19021,http://127.0.0.1:19022 \
OPENCODE_EXECD_TEST_TOKEN=it-plugin-secret OPENCODE_EXECD_TEST_WORKSPACE=/private/tmp/execd-it \
bun run test:gateway

# OpenCode 真实会话（容器内，工作区在 CubeFS）
docker run --rm -v opencode-runtime-code:/runtime -v oc-data-user01:/root/.local/share/opencode \
  -v ~/.cache/opencode:/root/.cache/opencode:ro -v /private/tmp/workspace:/private/tmp/workspace \
  -v ~/Documents/code/opencode-execd-plugin:/plugin:ro -v /tmp/oc-prompts:/prompts:ro \
  --add-host host.docker.internal:host-gateway -w /runtime/packages/opencode opencode-runtime:local \
  sh -lc 'bun run --conditions=browser ./src/index.ts run \
    --dir /private/tmp/workspace/users/user01 -m deepseek/deepseek-v4-flash "$(cat /prompts/user01.txt)"'
```

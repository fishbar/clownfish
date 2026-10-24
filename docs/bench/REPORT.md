# Clownfish vs Claude Code — 基准对战报告

生成时间：2026-09-02T15:41:39.268Z

## 方法

- **两边跑同一个模型后端**（GLM Anthropic 兼容代理），所以比较的是 *harness*（提示词、工具、委派机制），不是模型能力。
- Claude Code 侧：`claude -p --model sonnet --dangerously-skip-permissions`，并用 `--append-system-prompt` 显式鼓励用 Task 子代理（因为 Clownfish 的 orchestrator 提示词本身就在推委派，不补这一句对手方吃亏）。配置目录隔离，避免本机插件/MCP 影响结果。
- 每个任务、每一轮都从**全新种子工作区**开始，轮次之间互不继承。
- 评分用**智能体从未见过的隐藏测试**：改可见测试来蒙混过关会直接得零分。

## 总分

| 轮次 | clownfish·正确性 | claude-code·正确性 | clownfish·效率 | claude-code·效率 |
|---|---|---|---|---|
| round 1 | 19/19 (100%) | 19/19 (100%) | 15/15 (100%) | 2/15 (13%) |
| round 2 | 17/17 (100%) | 17/17 (100%) | 15/15 (100%) | 1/15 (7%) |
| round 3 | 5/5 (100%) | 5/5 (100%) | 3/3 (100%) | 1/3 (33%) |
| round 4 | 9/9 (100%) | 9/9 (100%) | 6/6 (100%) | 2/6 (33%) |
| round 5 | 44/45 (98%) | 45/45 (100%) | 34/36 (94%) | 3/36 (8%) |
| round 6 | 13/14 (93%) | 13/14 (93%) | 9/9 (100%) | 4/9 (44%) |
| round 7 | 13/14 (93%) | – | 9/9 (100%) | – |
| round 8 | 13/14 (93%) | – | 9/9 (100%) | – |
| round 9 | 24/24 (100%) | 24/24 (100%) | 36/36 (100%) | 24/36 (67%) |
| round 10 | 14/14 (100%) | – | 2/9 (22%) | – |

正确性 = 智能体没见过的隐藏测试；效率 = 用时 / token / 费用三项各自与该题声明的预算（par）比较，**两者分开计分**——又快又便宜但做错了，不算做完。

> **效率通过率要打折看。** 每题的预算按「目前观测到的最佳运行 × 2」标定，而每一题的最佳都恰好是 Clownfish，所以它 100% 通过里有一部分是构造出来的。不受这个偏置影响的是**原始比值**——用时、token、费用的倍数——请以下面每轮的用量表为准。

## Round 1

模型：clownfish `glm-5.2` · claude-code `sonnet` 档 → `glm-5.2`

| 任务 | clownfish | claude-code | 备注 |
|---|---|---|---|
| `async-queue` | 4/4 · 29s | 4/4 · 207s | 并发队列的竞态：修 bug 并补回归测试 |
| `hot-path` | 4/4 · 53s | 4/4 · 65s | 性能热点：O(n²) 改造，且不能改坏语义 |
| `god-module` | 4/4 · 79s | 4/4 · 121s | 重构：拆掉巨型模块，公共 API 一字不变 |
| `broken-repo` | 3/3 · 34s | 3/3 · 85s | 运维排障：让这个仓库重新跑起来 |
| `semver-range` | 4/4 · 212s | 4/4 · 848s | 按规格实现：semver 区间匹配（隐藏测试） |
| `swe-patch` | – | – |  |
| `terminal-ops` | – | – |  |
| `polyglot` | – | – |  |
| `security-fix` | – | – |  |
| `flaky-ci` | – | – |  |
| `callback-migration` | – | – |  |
| `api-versioning` | – | – |  |
| `heisenbug` | – | – |  |
| `perf-bisect` | – | – |  |
| `needle-in-haystack` | – | – |  |
| `polyglot-python-zebra-puzzle` | – | – |  |
| `polyglot-go-zebra-puzzle` | – | – |  |
| `polyglot-rust-xorcism` | – | – |  |
| `polyglot-python-proverb` | – | – |  |
| `polyglot-go-kindergarten-garden` | – | – |  |
| `polyglot-rust-luhn-from` | – | – |  |
| `polyglot-python-phone-number` | – | – |  |
| `polyglot-go-matrix` | – | – |  |
| `polyglot-rust-parallel-letter-frequency` | – | – |  |
| `polyglot-python-scale-generator` | – | – |  |
| `polyglot-go-scale-generator` | – | – |  |
| `polyglot-rust-decimal` | – | – |  |

用时合计：clownfish 408s · claude-code 1326s（3.3×）

| 效率（用时 / token / 费用） | clownfish | claude-code |
|---|---|---|
| `async-queue` | ✅29s · ✅29.3k · ✅¥0.085 | ❌207s · ❌326.2k · ❌¥1.061 |
| `hot-path` | ✅53s · ✅63.9k · ✅¥0.185 | ✅65s · ❌260.5k · ❌¥0.682 |
| `god-module` | ✅79s · ✅98.7k · ✅¥0.361 | ✅121s · ❌314.1k · ❌¥0.864 |
| `broken-repo` | ✅34s · ✅54.6k · ✅¥0.181 | ❌85s · ❌375.9k · ❌¥0.991 |
| `semver-range` | ✅212s · ✅179.8k · ✅¥0.943 | ❌848s · ❌666.0k · ❌¥3.267 |

| 用量（1 轮合计） | clownfish | claude-code |
|---|---|---|
| 总 token | 426.2k | 1.94M |
| 提示 token | 405.8k | 1.85M |
| 其中命中缓存 | 343.8k | 1.76M |
| 缓存命中率 | 84.7% | 95.0% |
| 输出 token | 20.4k | 93.4k |
| 费用（GLM 价目表） | ¥1.755 | ¥6.866 |

> 费用是把**两边的 token 过同一张 GLM 价目表**算出来的（输入 ¥8 / 命中缓存 ¥2 / 输出 ¥28 每百万 token），不是采用各自 provider 自报的金额——那两个数分别按错误的模型价目表算，互不可比。价目表见 `scripts/bench/pricing.mjs`，可用 `CLOWNFISH_BENCH_PRICES` 覆盖。

Clownfish 行为：工具调用 46 次，子代理委派 1 次，写计划 2 次。
计划卫生度：共 2 步，其中委派 1 步、收尾 2 步、遗留 pending 0 步。

## Round 2

模型：clownfish `glm-5.2` · claude-code `sonnet` 档 → `glm-5.2`

| 任务 | clownfish | claude-code | 备注 |
|---|---|---|---|
| `async-queue` | – | – |  |
| `hot-path` | – | – |  |
| `god-module` | – | – |  |
| `broken-repo` | – | – |  |
| `semver-range` | – | – |  |
| `swe-patch` | 3/3 · 23s | 3/3 · 186s | SWE 式补丁：三个特性交互处的状态机缺陷 |
| `terminal-ops` | 5/5 · 37s | 5/5 · 47s | 终端运维：从 reflog 里救回丢失的提交并修好构建 |
| `polyglot` | 3/3 · 100s | 3/3 · 226s | 跨语言一致性：同一规格的 JS 与 Python 实现 |
| `security-fix` | 2/2 · 50s | 2/2 · 469s | 安全修复：目录穿越 + 原型污染，且不能改坏功能 |
| `flaky-ci` | 4/4 · 36s | 4/4 · 241s | 根因排查：让测试真正稳定，而不是把失败掩盖过去 |
| `callback-migration` | – | – |  |
| `api-versioning` | – | – |  |
| `heisenbug` | – | – |  |
| `perf-bisect` | – | – |  |
| `needle-in-haystack` | – | – |  |
| `polyglot-python-zebra-puzzle` | – | – |  |
| `polyglot-go-zebra-puzzle` | – | – |  |
| `polyglot-rust-xorcism` | – | – |  |
| `polyglot-python-proverb` | – | – |  |
| `polyglot-go-kindergarten-garden` | – | – |  |
| `polyglot-rust-luhn-from` | – | – |  |
| `polyglot-python-phone-number` | – | – |  |
| `polyglot-go-matrix` | – | – |  |
| `polyglot-rust-parallel-letter-frequency` | – | – |  |
| `polyglot-python-scale-generator` | – | – |  |
| `polyglot-go-scale-generator` | – | – |  |
| `polyglot-rust-decimal` | – | – |  |

用时合计：clownfish 245s · claude-code 1169s（4.8×）

| 效率（用时 / token / 费用） | clownfish | claude-code |
|---|---|---|
| `swe-patch` | ✅23s · ✅29.1k · ✅¥0.116 | ❌186s · ❌350.3k · ❌¥1.132 |
| `terminal-ops` | ✅37s · ✅28.0k · ✅¥0.111 | ✅47s · ❌246.8k · ❌¥0.636 |
| `polyglot` | ✅100s · ✅79.8k · ✅¥0.401 | ❌226s · ❌651.0k · ❌¥1.972 |
| `security-fix` | ✅50s · ✅44.8k · ✅¥0.249 | ❌469s · ❌755.6k · ❌¥2.445 |
| `flaky-ci` | ✅36s · ✅30.2k · ✅¥0.132 | ❌241s · ❌632.3k · ❌¥1.945 |

| 用量（2 轮合计） | clownfish | claude-code |
|---|---|---|
| 总 token | 211.8k | 2.64M |
| 提示 token | 202.1k | 2.56M |
| 其中命中缓存 | 146.7k | 2.41M |
| 缓存命中率 | 72.6% | 94.2% |
| 输出 token | 9.7k | 75.6k |
| 费用（GLM 价目表） | ¥1.009 | ¥8.130 |

> 费用是把**两边的 token 过同一张 GLM 价目表**算出来的（输入 ¥8 / 命中缓存 ¥2 / 输出 ¥28 每百万 token），不是采用各自 provider 自报的金额——那两个数分别按错误的模型价目表算，互不可比。价目表见 `scripts/bench/pricing.mjs`，可用 `CLOWNFISH_BENCH_PRICES` 覆盖。

Clownfish 行为：工具调用 27 次，子代理委派 1 次，写计划 0 次。

## Round 3

模型：clownfish `glm-5.2` · claude-code `sonnet` 档 → `glm-5.2`

| 任务 | clownfish | claude-code | 备注 |
|---|---|---|---|
| `async-queue` | – | – |  |
| `hot-path` | – | – |  |
| `god-module` | – | – |  |
| `broken-repo` | – | – |  |
| `semver-range` | – | – |  |
| `swe-patch` | – | – |  |
| `terminal-ops` | – | – |  |
| `polyglot` | – | – |  |
| `security-fix` | – | – |  |
| `flaky-ci` | – | – |  |
| `callback-migration` | 5/5 · 153s | 5/5 · 206s | 长时程迁移：12 个模块从回调改为 Promise，语义一字不变 |
| `api-versioning` | – | – |  |
| `heisenbug` | – | – |  |
| `perf-bisect` | – | – |  |
| `needle-in-haystack` | – | – |  |
| `polyglot-python-zebra-puzzle` | – | – |  |
| `polyglot-go-zebra-puzzle` | – | – |  |
| `polyglot-rust-xorcism` | – | – |  |
| `polyglot-python-proverb` | – | – |  |
| `polyglot-go-kindergarten-garden` | – | – |  |
| `polyglot-rust-luhn-from` | – | – |  |
| `polyglot-python-phone-number` | – | – |  |
| `polyglot-go-matrix` | – | – |  |
| `polyglot-rust-parallel-letter-frequency` | – | – |  |
| `polyglot-python-scale-generator` | – | – |  |
| `polyglot-go-scale-generator` | – | – |  |
| `polyglot-rust-decimal` | – | – |  |

用时合计：clownfish 153s · claude-code 206s（1.3×）

| 效率（用时 / token / 费用） | clownfish | claude-code |
|---|---|---|
| `callback-migration` | ✅153s · ✅172.9k · ✅¥0.636 | ✅206s · ❌597.9k · ❌¥1.777 |

| 用量（3 轮合计） | clownfish | claude-code |
|---|---|---|
| 总 token | 172.9k | 597.9k |
| 提示 token | 168.1k | 582.4k |
| 其中命中缓存 | 140.4k | 552.8k |
| 缓存命中率 | 83.5% | 94.9% |
| 输出 token | 4.8k | 15.5k |
| 费用（GLM 价目表） | ¥0.636 | ¥1.777 |

> 费用是把**两边的 token 过同一张 GLM 价目表**算出来的（输入 ¥8 / 命中缓存 ¥2 / 输出 ¥28 每百万 token），不是采用各自 provider 自报的金额——那两个数分别按错误的模型价目表算，互不可比。价目表见 `scripts/bench/pricing.mjs`，可用 `CLOWNFISH_BENCH_PRICES` 覆盖。

Clownfish 行为：工具调用 13 次，子代理委派 1 次，写计划 2 次。

## Round 4

模型：clownfish `glm-5.2` · claude-code `sonnet` 档 → `glm-5.2`

| 任务 | clownfish | claude-code | 备注 |
|---|---|---|---|
| `async-queue` | – | – |  |
| `hot-path` | – | – |  |
| `god-module` | – | – |  |
| `broken-repo` | – | – |  |
| `semver-range` | – | – |  |
| `swe-patch` | – | – |  |
| `terminal-ops` | – | – |  |
| `polyglot` | – | – |  |
| `security-fix` | – | – |  |
| `flaky-ci` | – | – |  |
| `callback-migration` | 5/5 · 140s | 5/5 · 278s | 长时程迁移：12 个模块从回调改为 Promise，语义一字不变 |
| `api-versioning` | 4/4 · 222s | 4/4 · 328s | 横切演进：8 个接口统一加分页与 v2 信封，v1 不能破 |
| `heisenbug` | – | – |  |
| `perf-bisect` | – | – |  |
| `needle-in-haystack` | – | – |  |
| `polyglot-python-zebra-puzzle` | – | – |  |
| `polyglot-go-zebra-puzzle` | – | – |  |
| `polyglot-rust-xorcism` | – | – |  |
| `polyglot-python-proverb` | – | – |  |
| `polyglot-go-kindergarten-garden` | – | – |  |
| `polyglot-rust-luhn-from` | – | – |  |
| `polyglot-python-phone-number` | – | – |  |
| `polyglot-go-matrix` | – | – |  |
| `polyglot-rust-parallel-letter-frequency` | – | – |  |
| `polyglot-python-scale-generator` | – | – |  |
| `polyglot-go-scale-generator` | – | – |  |
| `polyglot-rust-decimal` | – | – |  |

用时合计：clownfish 362s · claude-code 606s（1.7×）

| 效率（用时 / token / 费用） | clownfish | claude-code |
|---|---|---|
| `callback-migration` | ✅140s · ✅174.5k · ✅¥0.631 | ✅278s · ❌742.2k · ❌¥2.108 |
| `api-versioning` | ✅222s · ✅331.2k · ✅¥1.119 | ✅328s · ❌954.9k · ❌¥2.762 |

| 用量（4 轮合计） | clownfish | claude-code |
|---|---|---|
| 总 token | 505.7k | 1.70M |
| 提示 token | 492.1k | 1.66M |
| 其中命中缓存 | 428.2k | 1.58M |
| 缓存命中率 | 87.0% | 95.1% |
| 输出 token | 13.7k | 37.9k |
| 费用（GLM 价目表） | ¥1.750 | ¥4.870 |

> 费用是把**两边的 token 过同一张 GLM 价目表**算出来的（输入 ¥8 / 命中缓存 ¥2 / 输出 ¥28 每百万 token），不是采用各自 provider 自报的金额——那两个数分别按错误的模型价目表算，互不可比。价目表见 `scripts/bench/pricing.mjs`，可用 `CLOWNFISH_BENCH_PRICES` 覆盖。

Clownfish 行为：工具调用 18 次，子代理委派 2 次，写计划 3 次。
计划卫生度：共 4 步，其中委派 2 步、收尾 3 步、遗留 pending 1 步。

## Round 5

模型：clownfish `glm-5.2` · claude-code `opus` 档 → `glm-5.3`

> ⚠️ 这一轮**不是同模型对比**：Claude Code 跑在更高档位上，所以差异里混入了模型能力，不能只当作 harness 的差异读。

| 任务 | clownfish | claude-code | 备注 |
|---|---|---|---|
| `async-queue` | 4/4 · 50s | 4/4 · 416s | 并发队列的竞态：修 bug 并补回归测试 |
| `hot-path` | 4/4 · 31s | 4/4 · 239s | 性能热点：O(n²) 改造，且不能改坏语义 |
| `god-module` | 4/4 · 122s | 4/4 · 150s | 重构：拆掉巨型模块，公共 API 一字不变 |
| `broken-repo` | 3/3 · 50s | 3/3 · 105s | 运维排障：让这个仓库重新跑起来 |
| `semver-range` | 4/4 · 186s | 4/4 · 1500s · timeout | 按规格实现：semver 区间匹配（隐藏测试） |
| `swe-patch` | 3/3 · 33s | 3/3 · 188s | SWE 式补丁：三个特性交互处的状态机缺陷 |
| `terminal-ops` | 5/5 · 29s | 5/5 · 62s | 终端运维：从 reflog 里救回丢失的提交并修好构建 |
| `polyglot` | 3/3 · 48s | 3/3 · 290s | 跨语言一致性：同一规格的 JS 与 Python 实现 |
| `security-fix` | 2/2 · 58s | 2/2 · 435s | 安全修复：目录穿越 + 原型污染，且不能改坏功能 |
| `flaky-ci` | 3/4 · 29s | 4/4 · 277s | 根因排查：让测试真正稳定，而不是把失败掩盖过去 |
| `callback-migration` | 5/5 · 108s | 5/5 · 295s | 长时程迁移：12 个模块从回调改为 Promise，语义一字不变 |
| `api-versioning` | 4/4 · 132s | 4/4 · 561s | 横切演进：8 个接口统一加分页与 v2 信封，v1 不能破 |
| `heisenbug` | – | – |  |
| `perf-bisect` | – | – |  |
| `needle-in-haystack` | – | – |  |
| `polyglot-python-zebra-puzzle` | – | – |  |
| `polyglot-go-zebra-puzzle` | – | – |  |
| `polyglot-rust-xorcism` | – | – |  |
| `polyglot-python-proverb` | – | – |  |
| `polyglot-go-kindergarten-garden` | – | – |  |
| `polyglot-rust-luhn-from` | – | – |  |
| `polyglot-python-phone-number` | – | – |  |
| `polyglot-go-matrix` | – | – |  |
| `polyglot-rust-parallel-letter-frequency` | – | – |  |
| `polyglot-python-scale-generator` | – | – |  |
| `polyglot-go-scale-generator` | – | – |  |
| `polyglot-rust-decimal` | – | – |  |

<details><summary>失败的检查项</summary>

- **clownfish · `flaky-ci`** — hidden: root cause actually fixed, 3 次连续全绿（得 0/3）

  ```
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 90.34175
  
  Command failed: node --test --test-reporter=tap hidden.flaky.test.mjs
  ```

</details>

用时合计：clownfish 875s · claude-code 4519s（5.2×）

| 效率（用时 / token / 费用） | clownfish | claude-code |
|---|---|---|
| `async-queue` | ✅50s · ✅49.3k · ❌¥0.214 | ❌416s · ❌1.15M · ❌¥3.045 |
| `hot-path` | ✅31s · ✅44.2k · ✅¥0.179 | ❌239s · ❌786.7k · ❌¥2.013 |
| `god-module` | ✅122s · ✅159.9k · ✅¥0.583 | ✅150s · ❌446.1k · ❌¥1.203 |
| `broken-repo` | ✅50s · ✅82.1k · ✅¥0.252 | ❌105s · ❌416.0k · ❌¥1.074 |
| `semver-range` | ✅186s · ❌373.3k · ✅¥1.282 | ❌1500s · ❌– · ❌– |
| `swe-patch` | ✅33s · ✅38.6k · ✅¥0.153 | ❌188s · ❌523.5k · ❌¥1.503 |
| `terminal-ops` | ✅29s · ✅34.5k · ✅¥0.128 | ✅62s · ❌270.2k · ❌¥0.681 |
| `polyglot` | ✅48s · ✅60.7k · ✅¥0.238 | ❌290s · ❌518.2k · ❌¥1.699 |
| `security-fix` | ✅58s · ✅46.5k · ✅¥0.251 | ❌435s · ❌995.6k · ❌¥3.063 |
| `flaky-ci` | ✅29s · ✅29.9k · ✅¥0.102 | ❌277s · ❌567.7k · ❌¥1.744 |
| `callback-migration` | ✅108s · ✅185.3k · ✅¥0.658 | ✅295s · ❌785.4k · ❌¥2.115 |
| `api-versioning` | ✅132s · ✅203.8k · ✅¥0.776 | ❌561s · ❌1.42M · ❌¥4.055 |

| 用量（5 轮合计） | clownfish | claude-code |
|---|---|---|
| 总 token | 1.31M | 7.88M |
| 提示 token | 1.27M | 7.71M |
| 其中命中缓存 | 1.07M | 7.39M |
| 缓存命中率 | 83.9% | 95.8% |
| 输出 token | 37.5k | 173.0k |
| 费用（GLM 价目表） | ¥4.817 | ¥22.194 |

> ⚠️ 有 1 次运行没有用量数据（claude-code·semver-range）——进程在预算内没退出，就没打印用量信封。**该侧的 token 与费用合计因此偏低。**

> 费用是把**两边的 token 过同一张 GLM 价目表**算出来的（输入 ¥8 / 命中缓存 ¥2 / 输出 ¥28 每百万 token），不是采用各自 provider 自报的金额——那两个数分别按错误的模型价目表算，互不可比。价目表见 `scripts/bench/pricing.mjs`，可用 `CLOWNFISH_BENCH_PRICES` 覆盖。

Clownfish 行为：工具调用 100 次，子代理委派 6 次，写计划 5 次。
计划卫生度：共 7 步，其中委派 5 步、收尾 7 步、遗留 pending 0 步。

## Round 6

模型：clownfish `glm-5.2` · claude-code `sonnet` 档 → `glm-5.2`

| 任务 | clownfish | claude-code | 备注 |
|---|---|---|---|
| `async-queue` | – | – |  |
| `hot-path` | – | – |  |
| `god-module` | – | – |  |
| `broken-repo` | – | – |  |
| `semver-range` | – | – |  |
| `swe-patch` | – | – |  |
| `terminal-ops` | – | – |  |
| `polyglot` | – | – |  |
| `security-fix` | – | – |  |
| `flaky-ci` | – | – |  |
| `callback-migration` | – | – |  |
| `api-versioning` | – | – |  |
| `heisenbug` | 4/5 · 121s | 4/5 · 669s | 线上偶发 bug：测试全绿，只有一份 CI 日志 |
| `perf-bisect` | 5/5 · 87s | 5/5 · 365s | 性能回归定位：原因在 git 历史里，而直接 revert 会丢功能 |
| `needle-in-haystack` | 4/4 · 58s | 4/4 · 122s | 大文件里的一个字符：6000 行中定位缺陷，且不许重写 |
| `polyglot-python-zebra-puzzle` | – | – |  |
| `polyglot-go-zebra-puzzle` | – | – |  |
| `polyglot-rust-xorcism` | – | – |  |
| `polyglot-python-proverb` | – | – |  |
| `polyglot-go-kindergarten-garden` | – | – |  |
| `polyglot-rust-luhn-from` | – | – |  |
| `polyglot-python-phone-number` | – | – |  |
| `polyglot-go-matrix` | – | – |  |
| `polyglot-rust-parallel-letter-frequency` | – | – |  |
| `polyglot-python-scale-generator` | – | – |  |
| `polyglot-go-scale-generator` | – | – |  |
| `polyglot-rust-decimal` | – | – |  |

<details><summary>失败的检查项</summary>

- **clownfish · `heisenbug`** — hidden: throwing and slow jobs are handled (1p/1f)

  ```
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 59.203041
  
  Command failed: node --test --test-reporter=tap hidden/resilience.test.mjs
  ```
- **claude-code · `heisenbug`** — hidden: throwing and slow jobs are handled (1p/1f)

  ```
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 55.7435
  
  Command failed: node --test --test-reporter=tap hidden/resilience.test.mjs
  ```

</details>

用时合计：clownfish 266s · claude-code 1156s（4.3×）

| 效率（用时 / token / 费用） | clownfish | claude-code |
|---|---|---|
| `heisenbug` | ✅121s · ✅108.7k · ✅¥0.449 | ❌669s · ❌662.0k · ❌¥2.225 |
| `perf-bisect` | ✅87s · ✅115.4k · ✅¥0.393 | ✅365s · ❌970.1k · ❌¥2.802 |
| `needle-in-haystack` | ✅58s · ✅73.2k · ✅¥0.198 | ✅122s · ✅417.7k · ✅¥1.190 |

| 用量（6 轮合计） | clownfish | claude-code |
|---|---|---|
| 总 token | 297.3k | 2.05M |
| 提示 token | 289.8k | 2.00M |
| 其中命中缓存 | 248.0k | 1.87M |
| 缓存命中率 | 85.6% | 93.7% |
| 输出 token | 7.5k | 52.2k |
| 费用（GLM 价目表） | ¥1.040 | ¥6.217 |

> 费用是把**两边的 token 过同一张 GLM 价目表**算出来的（输入 ¥8 / 命中缓存 ¥2 / 输出 ¥28 每百万 token），不是采用各自 provider 自报的金额——那两个数分别按错误的模型价目表算，互不可比。价目表见 `scripts/bench/pricing.mjs`，可用 `CLOWNFISH_BENCH_PRICES` 覆盖。

Clownfish 行为：工具调用 39 次，子代理委派 0 次，写计划 0 次。
计划卫生度：共 0 步，其中委派 0 步、收尾 0 步、遗留 pending 0 步。

## Round 7

模型：clownfish `glm-5.2` · claude-code `sonnet` 档 → `glm-5.2`

| 任务 | clownfish | claude-code | 备注 |
|---|---|---|---|
| `async-queue` | – | – |  |
| `hot-path` | – | – |  |
| `god-module` | – | – |  |
| `broken-repo` | – | – |  |
| `semver-range` | – | – |  |
| `swe-patch` | – | – |  |
| `terminal-ops` | – | – |  |
| `polyglot` | – | – |  |
| `security-fix` | – | – |  |
| `flaky-ci` | – | – |  |
| `callback-migration` | – | – |  |
| `api-versioning` | – | – |  |
| `heisenbug` | 4/5 · 112s | – | 线上偶发 bug：测试全绿，只有一份 CI 日志 |
| `perf-bisect` | 5/5 · 53s | – | 性能回归定位：原因在 git 历史里，而直接 revert 会丢功能 |
| `needle-in-haystack` | 4/4 · 42s | – | 大文件里的一个字符：6000 行中定位缺陷，且不许重写 |
| `polyglot-python-zebra-puzzle` | – | – |  |
| `polyglot-go-zebra-puzzle` | – | – |  |
| `polyglot-rust-xorcism` | – | – |  |
| `polyglot-python-proverb` | – | – |  |
| `polyglot-go-kindergarten-garden` | – | – |  |
| `polyglot-rust-luhn-from` | – | – |  |
| `polyglot-python-phone-number` | – | – |  |
| `polyglot-go-matrix` | – | – |  |
| `polyglot-rust-parallel-letter-frequency` | – | – |  |
| `polyglot-python-scale-generator` | – | – |  |
| `polyglot-go-scale-generator` | – | – |  |
| `polyglot-rust-decimal` | – | – |  |

<details><summary>失败的检查项</summary>

- **clownfish · `heisenbug`** — hidden: throwing and slow jobs are handled (1p/1f)

  ```
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 57.338208
  
  Command failed: node --test --test-reporter=tap hidden/resilience.test.mjs
  ```

</details>

用时合计：clownfish 207s · claude-code 0s

| 效率（用时 / token / 费用） | clownfish | claude-code |
|---|---|---|
| `heisenbug` | ✅112s · ✅174.2k · ✅¥0.584 | – |
| `perf-bisect` | ✅53s · ✅73.5k · ✅¥0.231 | – |
| `needle-in-haystack` | ✅42s · ✅61.6k · ✅¥0.228 | – |

| 用量（7 轮合计） | clownfish | claude-code |
|---|---|---|
| 总 token | 309.3k | 0 |
| 提示 token | 302.0k | 0 |
| 其中命中缓存 | 263.2k | 0 |
| 缓存命中率 | 87.1% | – |
| 输出 token | 7.3k | 0 |
| 费用（GLM 价目表） | ¥1.043 | – |

> 费用是把**两边的 token 过同一张 GLM 价目表**算出来的（输入 ¥8 / 命中缓存 ¥2 / 输出 ¥28 每百万 token），不是采用各自 provider 自报的金额——那两个数分别按错误的模型价目表算，互不可比。价目表见 `scripts/bench/pricing.mjs`，可用 `CLOWNFISH_BENCH_PRICES` 覆盖。

Clownfish 行为：工具调用 34 次，子代理委派 0 次，写计划 0 次。
计划卫生度：共 0 步，其中委派 0 步、收尾 0 步、遗留 pending 0 步。

## Round 8

模型：clownfish `glm-5.2` · claude-code `sonnet` 档 → `glm-5.2`

| 任务 | clownfish | claude-code | 备注 |
|---|---|---|---|
| `async-queue` | – | – |  |
| `hot-path` | – | – |  |
| `god-module` | – | – |  |
| `broken-repo` | – | – |  |
| `semver-range` | – | – |  |
| `swe-patch` | – | – |  |
| `terminal-ops` | – | – |  |
| `polyglot` | – | – |  |
| `security-fix` | – | – |  |
| `flaky-ci` | – | – |  |
| `callback-migration` | – | – |  |
| `api-versioning` | – | – |  |
| `heisenbug` | 4/5 · 338s | – | 线上偶发 bug：测试全绿，只有一份 CI 日志 |
| `perf-bisect` | 5/5 · 115s | – | 性能回归定位：原因在 git 历史里，而直接 revert 会丢功能 |
| `needle-in-haystack` | 4/4 · 107s | – | 大文件里的一个字符：6000 行中定位缺陷，且不许重写 |
| `polyglot-python-zebra-puzzle` | – | – |  |
| `polyglot-go-zebra-puzzle` | – | – |  |
| `polyglot-rust-xorcism` | – | – |  |
| `polyglot-python-proverb` | – | – |  |
| `polyglot-go-kindergarten-garden` | – | – |  |
| `polyglot-rust-luhn-from` | – | – |  |
| `polyglot-python-phone-number` | – | – |  |
| `polyglot-go-matrix` | – | – |  |
| `polyglot-rust-parallel-letter-frequency` | – | – |  |
| `polyglot-python-scale-generator` | – | – |  |
| `polyglot-go-scale-generator` | – | – |  |
| `polyglot-rust-decimal` | – | – |  |

<details><summary>失败的检查项</summary>

- **clownfish · `heisenbug`** — hidden: throwing and slow jobs are handled (1p/1f)

  ```
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 58.243958
  
  Command failed: node --test --test-reporter=tap hidden/resilience.test.mjs
  ```

</details>

用时合计：clownfish 559s · claude-code 0s

| 效率（用时 / token / 费用） | clownfish | claude-code |
|---|---|---|
| `heisenbug` | ✅338s · ✅417.3k · ✅¥1.484 | – |
| `perf-bisect` | ✅115s · ✅120.4k · ✅¥0.463 | – |
| `needle-in-haystack` | ✅107s · ✅139.8k · ✅¥0.466 | – |

| 用量（8 轮合计） | clownfish | claude-code |
|---|---|---|
| 总 token | 677.5k | 0 |
| 提示 token | 658.2k | 0 |
| 其中命中缓存 | 565.6k | 0 |
| 缓存命中率 | 85.9% | – |
| 输出 token | 19.3k | 0 |
| 费用（GLM 价目表） | ¥2.413 | – |

> 费用是把**两边的 token 过同一张 GLM 价目表**算出来的（输入 ¥8 / 命中缓存 ¥2 / 输出 ¥28 每百万 token），不是采用各自 provider 自报的金额——那两个数分别按错误的模型价目表算，互不可比。价目表见 `scripts/bench/pricing.mjs`，可用 `CLOWNFISH_BENCH_PRICES` 覆盖。

Clownfish 行为：工具调用 23 次，子代理委派 1 次，写计划 2 次。
计划卫生度：共 3 步，其中委派 1 步、收尾 3 步、遗留 pending 0 步。

## Round 9

模型：clownfish `glm-5.2` · claude-code `sonnet` 档 → `glm-5.2`

| 任务 | clownfish | claude-code | 备注 |
|---|---|---|---|
| `async-queue` | – | – |  |
| `hot-path` | – | – |  |
| `god-module` | – | – |  |
| `broken-repo` | – | – |  |
| `semver-range` | – | – |  |
| `swe-patch` | – | – |  |
| `terminal-ops` | – | – |  |
| `polyglot` | – | – |  |
| `security-fix` | – | – |  |
| `flaky-ci` | – | – |  |
| `callback-migration` | – | – |  |
| `api-versioning` | – | – |  |
| `heisenbug` | – | – |  |
| `perf-bisect` | – | – |  |
| `needle-in-haystack` | – | – |  |
| `polyglot-python-zebra-puzzle` | 2/2 · 39s | 2/2 · 88s | Polyglot (python) · zebra-puzzle |
| `polyglot-go-zebra-puzzle` | 2/2 · 73s | 2/2 · 100s | Polyglot (go) · zebra-puzzle |
| `polyglot-rust-xorcism` | 2/2 · 72s | 2/2 · 153s | Polyglot (rust) · xorcism |
| `polyglot-python-proverb` | 2/2 · 28s | 2/2 · 17s | Polyglot (python) · proverb |
| `polyglot-go-kindergarten-garden` | 2/2 · 47s | 2/2 · 149s | Polyglot (go) · kindergarten-garden |
| `polyglot-rust-luhn-from` | 2/2 · 32s | 2/2 · 42s | Polyglot (rust) · luhn-from |
| `polyglot-python-phone-number` | 2/2 · 26s | 2/2 · 53s | Polyglot (python) · phone-number |
| `polyglot-go-matrix` | 2/2 · 19s | 2/2 · 39s | Polyglot (go) · matrix |
| `polyglot-rust-parallel-letter-frequency` | 2/2 · 24s | 2/2 · 78s | Polyglot (rust) · parallel-letter-frequency |
| `polyglot-python-scale-generator` | 2/2 · 18s | 2/2 · 48s | Polyglot (python) · scale-generator |
| `polyglot-go-scale-generator` | 2/2 · 28s | 2/2 · 72s | Polyglot (go) · scale-generator |
| `polyglot-rust-decimal` | 2/2 · 90s | 2/2 · 227s | Polyglot (rust) · decimal |

用时合计：clownfish 497s · claude-code 1064s（2.1×）

| 效率（用时 / token / 费用） | clownfish | claude-code |
|---|---|---|
| `polyglot-python-zebra-puzzle` | ✅39s · ✅48.2k · ✅¥0.199 | ✅88s · ❌208.3k · ✅¥0.590 |
| `polyglot-go-zebra-puzzle` | ✅73s · ✅80.1k · ✅¥0.298 | ✅100s · ❌344.8k · ❌¥1.023 |
| `polyglot-rust-xorcism` | ✅72s · ✅176.1k · ✅¥0.534 | ✅153s · ❌816.9k · ❌¥2.148 |
| `polyglot-python-proverb` | ✅28s · ✅45.2k · ✅¥0.127 | ✅17s · ✅142.0k · ✅¥0.379 |
| `polyglot-go-kindergarten-garden` | ✅47s · ✅94.5k · ✅¥0.279 | ✅149s · ❌236.8k · ✅¥0.750 |
| `polyglot-rust-luhn-from` | ✅32s · ✅39.4k · ✅¥0.145 | ✅42s · ✅177.7k · ✅¥0.506 |
| `polyglot-python-phone-number` | ✅26s · ✅62.0k · ✅¥0.171 | ✅53s · ❌213.2k · ✅¥0.581 |
| `polyglot-go-matrix` | ✅19s · ✅34.1k · ✅¥0.111 | ✅39s · ✅184.0k · ✅¥0.507 |
| `polyglot-rust-parallel-letter-frequency` | ✅24s · ✅47.0k · ✅¥0.136 | ✅78s · ❌302.8k · ❌¥0.876 |
| `polyglot-python-scale-generator` | ✅18s · ✅35.9k · ✅¥0.151 | ✅48s · ❌214.9k · ✅¥0.594 |
| `polyglot-go-scale-generator` | ✅28s · ✅48.1k · ✅¥0.183 | ✅72s · ✅188.9k · ✅¥0.571 |
| `polyglot-rust-decimal` | ✅90s · ✅135.2k · ✅¥0.461 | ✅227s · ❌745.7k · ❌¥2.050 |

| 用量（9 轮合计） | clownfish | claude-code |
|---|---|---|
| 总 token | 845.8k | 3.78M |
| 提示 token | 827.6k | 3.72M |
| 其中命中缓存 | 722.9k | 3.47M |
| 缓存命中率 | 87.4% | 93.2% |
| 输出 token | 18.3k | 57.9k |
| 费用（GLM 价目表） | ¥2.795 | ¥10.576 |

> 费用是把**两边的 token 过同一张 GLM 价目表**算出来的（输入 ¥8 / 命中缓存 ¥2 / 输出 ¥28 每百万 token），不是采用各自 provider 自报的金额——那两个数分别按错误的模型价目表算，互不可比。价目表见 `scripts/bench/pricing.mjs`，可用 `CLOWNFISH_BENCH_PRICES` 覆盖。

Clownfish 行为：工具调用 89 次，子代理委派 0 次，写计划 0 次。
计划卫生度：共 0 步，其中委派 0 步、收尾 0 步、遗留 pending 0 步。

## Round 10

模型：clownfish `glm-5.2` · claude-code `sonnet` 档 → `glm-5.2`

| 任务 | clownfish | claude-code | 备注 |
|---|---|---|---|
| `async-queue` | – | – |  |
| `hot-path` | – | – |  |
| `god-module` | – | – |  |
| `broken-repo` | – | – |  |
| `semver-range` | – | – |  |
| `swe-patch` | – | – |  |
| `terminal-ops` | – | – |  |
| `polyglot` | – | – |  |
| `security-fix` | – | – |  |
| `flaky-ci` | – | – |  |
| `callback-migration` | – | – |  |
| `api-versioning` | – | – |  |
| `heisenbug` | 5/5 · 906s · timeout | – | 线上偶发 bug：测试全绿，只有一份 CI 日志 |
| `perf-bisect` | 5/5 · 87s | – | 性能回归定位：原因在 git 历史里，而直接 revert 会丢功能 |
| `needle-in-haystack` | 4/4 · 67s | – | 大文件里的一个字符：6000 行中定位缺陷，且不许重写 |
| `polyglot-python-zebra-puzzle` | – | – |  |
| `polyglot-go-zebra-puzzle` | – | – |  |
| `polyglot-rust-xorcism` | – | – |  |
| `polyglot-python-proverb` | – | – |  |
| `polyglot-go-kindergarten-garden` | – | – |  |
| `polyglot-rust-luhn-from` | – | – |  |
| `polyglot-python-phone-number` | – | – |  |
| `polyglot-go-matrix` | – | – |  |
| `polyglot-rust-parallel-letter-frequency` | – | – |  |
| `polyglot-python-scale-generator` | – | – |  |
| `polyglot-go-scale-generator` | – | – |  |
| `polyglot-rust-decimal` | – | – |  |

用时合计：clownfish 1060s · claude-code 0s

| 效率（用时 / token / 费用） | clownfish | claude-code |
|---|---|---|
| `heisenbug` | ❌906s · ❌– · ❌– | – |
| `perf-bisect` | ✅87s · ❌– · ❌– | – |
| `needle-in-haystack` | ✅67s · ❌– · ❌– | – |

| 用量（10 轮合计） | clownfish | claude-code |
|---|---|---|
| 总 token | 0 | 0 |
| 提示 token | 0 | 0 |
| 其中命中缓存 | 0 | 0 |
| 缓存命中率 | – | – |
| 输出 token | 0 | 0 |
| 费用（GLM 价目表） | – | – |

> 费用是把**两边的 token 过同一张 GLM 价目表**算出来的（输入 ¥8 / 命中缓存 ¥2 / 输出 ¥28 每百万 token），不是采用各自 provider 自报的金额——那两个数分别按错误的模型价目表算，互不可比。价目表见 `scripts/bench/pricing.mjs`，可用 `CLOWNFISH_BENCH_PRICES` 覆盖。

Clownfish 行为：工具调用 46 次，子代理委派 1 次，写计划 0 次。
计划卫生度：共 1 步，其中委派 1 步、收尾 1 步、遗留 pending 0 步。

## Claude Code：sonnet 档 vs opus 档

同样的题、同样的隐藏测试，只换 Claude Code 的模型档位。Clownfish 一列作为不变的参照。

| 任务 | sonnet 正确性/用时/token/费用 | opus 正确性/用时/token/费用 | clownfish（参照） |
|---|---|---|---|
| `async-queue` | 4/4 · 207s · 326.2k · ¥1.061 | 4/4 · 416s · 1.15M · ¥3.045 | 4/4 · 50s · 49.3k · ¥0.214 |
| `hot-path` | 4/4 · 65s · 260.5k · ¥0.682 | 4/4 · 239s · 786.7k · ¥2.013 | 4/4 · 31s · 44.2k · ¥0.179 |
| `god-module` | 4/4 · 121s · 314.1k · ¥0.864 | 4/4 · 150s · 446.1k · ¥1.203 | 4/4 · 122s · 159.9k · ¥0.583 |
| `broken-repo` | 3/3 · 85s · 375.9k · ¥0.991 | 3/3 · 105s · 416.0k · ¥1.074 | 3/3 · 50s · 82.1k · ¥0.252 |
| `semver-range` | 4/4 · 848s · 666.0k · ¥3.267 | 4/4 · 1500s · 0 · – | 4/4 · 186s · 373.3k · ¥1.282 |
| `swe-patch` | 3/3 · 186s · 350.3k · ¥1.132 | 3/3 · 188s · 523.5k · ¥1.503 | 3/3 · 33s · 38.6k · ¥0.153 |
| `terminal-ops` | 5/5 · 47s · 246.8k · ¥0.636 | 5/5 · 62s · 270.2k · ¥0.681 | 5/5 · 29s · 34.5k · ¥0.128 |
| `polyglot` | 3/3 · 226s · 651.0k · ¥1.972 | 3/3 · 290s · 518.2k · ¥1.699 | 3/3 · 48s · 60.7k · ¥0.238 |
| `security-fix` | 2/2 · 469s · 755.6k · ¥2.445 | 2/2 · 435s · 995.6k · ¥3.063 | 2/2 · 58s · 46.5k · ¥0.251 |
| `flaky-ci` | 4/4 · 241s · 632.3k · ¥1.945 | 4/4 · 277s · 567.7k · ¥1.744 | 3/4 · 29s · 29.9k · ¥0.102 |
| `callback-migration` | 5/5 · 278s · 742.2k · ¥2.108 | 5/5 · 295s · 785.4k · ¥2.115 | 5/5 · 108s · 185.3k · ¥0.658 |
| `api-versioning` | 4/4 · 328s · 954.9k · ¥2.762 | 4/4 · 561s · 1.42M · ¥4.055 | 4/4 · 132s · 203.8k · ¥0.776 |
| `heisenbug` | 4/5 · 669s · 662.0k · ¥2.225 | – | 5/5 · 906s · 0 · – |
| `perf-bisect` | 5/5 · 365s · 970.1k · ¥2.802 | – | 5/5 · 87s · 0 · – |
| `needle-in-haystack` | 4/4 · 122s · 417.7k · ¥1.190 | – | 4/4 · 67s · 0 · – |
| `polyglot-python-zebra-puzzle` | 2/2 · 88s · 208.3k · ¥0.590 | – | 2/2 · 39s · 48.2k · ¥0.199 |
| `polyglot-go-zebra-puzzle` | 2/2 · 100s · 344.8k · ¥1.023 | – | 2/2 · 73s · 80.1k · ¥0.298 |
| `polyglot-rust-xorcism` | 2/2 · 153s · 816.9k · ¥2.148 | – | 2/2 · 72s · 176.1k · ¥0.534 |
| `polyglot-python-proverb` | 2/2 · 17s · 142.0k · ¥0.379 | – | 2/2 · 28s · 45.2k · ¥0.127 |
| `polyglot-go-kindergarten-garden` | 2/2 · 149s · 236.8k · ¥0.750 | – | 2/2 · 47s · 94.5k · ¥0.279 |
| `polyglot-rust-luhn-from` | 2/2 · 42s · 177.7k · ¥0.506 | – | 2/2 · 32s · 39.4k · ¥0.145 |
| `polyglot-python-phone-number` | 2/2 · 53s · 213.2k · ¥0.581 | – | 2/2 · 26s · 62.0k · ¥0.171 |
| `polyglot-go-matrix` | 2/2 · 39s · 184.0k · ¥0.507 | – | 2/2 · 19s · 34.1k · ¥0.111 |
| `polyglot-rust-parallel-letter-frequency` | 2/2 · 78s · 302.8k · ¥0.876 | – | 2/2 · 24s · 47.0k · ¥0.136 |
| `polyglot-python-scale-generator` | 2/2 · 48s · 214.9k · ¥0.594 | – | 2/2 · 18s · 35.9k · ¥0.151 |
| `polyglot-go-scale-generator` | 2/2 · 72s · 188.9k · ¥0.571 | – | 2/2 · 28s · 48.1k · ¥0.183 |
| `polyglot-rust-decimal` | 2/2 · 227s · 745.7k · ¥2.050 | – | 2/2 · 90s · 135.2k · ¥0.461 |

合计 — sonnet：5320s · 12.10M · ¥36.66；opus：4519s · 7.88M · ¥22.19

## 轮次间变化

| 任务 | r1 | r2 | r3 | r4 | r5 | r6 | r7 | r8 | r9 | r10 |
|---|---|---|---|---|---|---|---|---|---|---|
| **clownfish** |  |  |  |  |  |  |  |  |  |  |
| `async-queue` | 4/4 | – | – | – | 4/4 | – | – | – | – | – |
| `hot-path` | 4/4 | – | – | – | 4/4 | – | – | – | – | – |
| `god-module` | 4/4 | – | – | – | 4/4 | – | – | – | – | – |
| `broken-repo` | 3/3 | – | – | – | 3/3 | – | – | – | – | – |
| `semver-range` | 4/4 | – | – | – | 4/4 | – | – | – | – | – |
| `swe-patch` | – | 3/3 | – | – | 3/3 | – | – | – | – | – |
| `terminal-ops` | – | 5/5 | – | – | 5/5 | – | – | – | – | – |
| `polyglot` | – | 3/3 | – | – | 3/3 | – | – | – | – | – |
| `security-fix` | – | 2/2 | – | – | 2/2 | – | – | – | – | – |
| `flaky-ci` | – | 4/4 | – | – | 3/4 | – | – | – | – | – |
| `callback-migration` | – | – | 5/5 | 5/5 | 5/5 | – | – | – | – | – |
| `api-versioning` | – | – | – | 4/4 | 4/4 | – | – | – | – | – |
| `heisenbug` | – | – | – | – | – | 4/5 | 4/5 | 4/5 | – | 5/5 |
| `perf-bisect` | – | – | – | – | – | 5/5 | 5/5 | 5/5 | – | 5/5 |
| `needle-in-haystack` | – | – | – | – | – | 4/4 | 4/4 | 4/4 | – | 4/4 |
| `polyglot-python-zebra-puzzle` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-go-zebra-puzzle` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-rust-xorcism` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-python-proverb` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-go-kindergarten-garden` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-rust-luhn-from` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-python-phone-number` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-go-matrix` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-rust-parallel-letter-frequency` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-python-scale-generator` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-go-scale-generator` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-rust-decimal` | – | – | – | – | – | – | – | – | 2/2 | – |
| **claude-code** |  |  |  |  |  |  |  |  |  |  |
| `async-queue` | 4/4 | – | – | – | 4/4 | – | – | – | – | – |
| `hot-path` | 4/4 | – | – | – | 4/4 | – | – | – | – | – |
| `god-module` | 4/4 | – | – | – | 4/4 | – | – | – | – | – |
| `broken-repo` | 3/3 | – | – | – | 3/3 | – | – | – | – | – |
| `semver-range` | 4/4 | – | – | – | 4/4 | – | – | – | – | – |
| `swe-patch` | – | 3/3 | – | – | 3/3 | – | – | – | – | – |
| `terminal-ops` | – | 5/5 | – | – | 5/5 | – | – | – | – | – |
| `polyglot` | – | 3/3 | – | – | 3/3 | – | – | – | – | – |
| `security-fix` | – | 2/2 | – | – | 2/2 | – | – | – | – | – |
| `flaky-ci` | – | 4/4 | – | – | 4/4 | – | – | – | – | – |
| `callback-migration` | – | – | 5/5 | 5/5 | 5/5 | – | – | – | – | – |
| `api-versioning` | – | – | – | 4/4 | 4/4 | – | – | – | – | – |
| `heisenbug` | – | – | – | – | – | 4/5 | – | – | – | – |
| `perf-bisect` | – | – | – | – | – | 5/5 | – | – | – | – |
| `needle-in-haystack` | – | – | – | – | – | 4/4 | – | – | – | – |
| `polyglot-python-zebra-puzzle` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-go-zebra-puzzle` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-rust-xorcism` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-python-proverb` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-go-kindergarten-garden` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-rust-luhn-from` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-python-phone-number` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-go-matrix` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-rust-parallel-letter-frequency` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-python-scale-generator` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-go-scale-generator` | – | – | – | – | – | – | – | – | 2/2 | – |
| `polyglot-rust-decimal` | – | – | – | – | – | – | – | – | 2/2 | – |


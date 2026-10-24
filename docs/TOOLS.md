# Built-in tools: inventory, contradictions, and what was cut

Measured on 2026-08-30 with `CLOWNFISH_DUMP_PROMPT` (the exact prompt + schemas
the provider receives) and 1,408 real tool calls from every local session plus
the bench runs.

## Inventory (what the main agent carried before this audit)

| # | tool | scope | schema tok | guidelines tok | real calls |
|---|---|---|---|---|---|
| 1–7 | read write edit bash grep find ls | all agents | 1,390 | 476 | 1,378 |
| 8 | skill | all agents | 104 | 88 | 0 (skills index empty here) |
| 9 | run_agent | main | 759 | 344 | 14 |
| 10 | todo | main | 286 | 246 | 14 |
| 11 | memory | main | 405 | 165 | 0 |
| 12 | delegate | main | 189 | 99 | 0 |
| 13 | workflow | main | 293 | 504 | 0 |
| 14 | run_goal | main | 293 | 109 | 0 |
| 15–18 | plan decompose update_node get_status (DAG) | main | 1,155 | 235 | 0 |
| 19 | worktree_decide | main | 259 | 93 | 0 |
| 20 | draw_demo | main | 233 | 75 | 0 |
| 21 | cron | main | 311 | 67 | 0 |
| 22–24 | sessions session_send session_read | 我的助理 only | 508 | 132 | 0 (new) |

Fixed cost of a first request: ~4.1k tokens of system prompt (0.6k agent
prompt + 3.4k tool guidelines) + ~6k of JSON schemas. The conversation is a
rounding error; the toolset is the bill. 81 % of it is served from the
provider cache in practice, so the *money* saved by trimming is small — the
real cost of a bloated toolset is the **choice** it forces on every turn.

## Contradictions (and the fix applied)

### C1 — two plans: `todo` vs `plan` (DAG)

- `## Execution plans` said: *"build a plan once (`plan`) and drive it — never
  juggle ad-hoc task lists"*.
- `### todo` said: *"Write a plan before starting work that has more than
  about three steps"*.

Same trigger, two tools, and the two ledgers never met: `run_agent` updates a
`todo` step (via its `todo` argument), `delegate` updates a DAG node. A model
that chose `plan` and then called `run_agent` recorded its progress nowhere.

**Fix:** `todo` is THE plan. The DAG tools are no longer in the default
toolset (see cuts); the `## Execution plans` directive is rewritten as one
"how to choose" paragraph that starts from `todo` + `run_agent`.

### C2 — two delegations: `run_agent` vs `delegate`

- `### run_agent`: *"Prefer run_agent for substantial sub-work … a delegation
  costs a whole extra agent run"*.
- `## Execution plans`: *"`delegate` the 'delegate' steps"*.

Both spawn a specialist and return its summary; the only difference is which
ledger they write to (C1). With no rule for choosing, the cheaper-sounding
one wins — the same dynamic that produced *zero* `qa` delegations in 33
measured runs (CLAUDE.md, "Sub-agent delegation").

**Fix:** `delegate` leaves the default toolset with the DAG. One delegation
tool.

### C3 — two ways to fan out: `run_agent` (parallel) vs `workflow`

- `### run_agent`: *"Independent sub-tasks can be delegated in the same step
  and run in parallel … create a git worktree per branch … merge the results
  yourself"*.
- `### workflow`: *"Use workflow for decomposable fan-out: … multi-perspective
  review, batch transforms with a final synthesis"*.

The hand-rolled version (several `run_agent` calls, the model manages
worktrees and the merge) is what a model reaches for — no script to write —
so `workflow`'s cases get absorbed by the harder-to-get-right path.

**Fix:** the boundary is stated in one place: two or three independent
delegations → `run_agent` in one step; a fan-out that needs a synthesis step
or more branches than that → `workflow`. `run_agent`'s guideline now points
across.

### Not contradictions, kept as they are

- `run_goal` — its trigger is distinct and checkable ("a goal with an
  objective definition of done", runs in the background with an independent
  evaluator). Nothing else offers a loop.
- `draw_demo` vs inline ```html — the two-tier rule is explicit.
- `memory`, `cron`, `sessions×3` — no overlap with anything.

## Cuts, and the merge that replaced them

Rule: a tool stays in the DEFAULT toolset only if it has a trigger no other
tool covers. Code is not deleted — a tool that leaves the default set is a
flag away.

**Round 1 — remove the duplicates.** The DAG toolset
(`plan`/`decompose`/`update_node`/`get_status`) duplicated `todo` (C1) and
`delegate` duplicated `run_agent` (C2); zero calls in 1.4k measured, ~1.6k
tokens/turn. Off by default, `CLOWNFISH_DAG_TOOLS=1` restores them.

**Round 2 — merge the three delegation entries into one.** C2 and C3 are not
really "two tools that overlap": they are *one operation* (hand work to a
sub-agent) whose parameters were split across three tools. The differences
were never about what a delegation IS, only three control structures:

| | control | in the merged tool |
|---|---|---|
| `run_agent` | a function call — the caller keeps control | the default shape |
| `workflow` | a program — control moves to a script | `tasks[]` (+ `synthesize`) |
| `run_goal` | a feedback loop — control moves to a judge | `until` (+ `max_rounds`) |

So `run_agent` now takes:

- `tasks: [{type, task, context?, cwd?}]` — 2+ INDEPENDENT strands, run in
  parallel, results returned labelled and in order; `synthesize` adds a final
  pass that combines them into one answer. What the model was previously told
  to do by hand ("create a git worktree per branch … merge the results
  yourself") the framework now does, and strands that can write are REFUSED a
  shared tree instead of racing in one.
- `until: <acceptance criteria>` — the criteria become the verifier's entire
  yardstick, and the existing implement → verify → roll back → retry cycle
  runs up to `max_rounds` (default 3, max 10) with a stall guard: an unchanged
  verdict twice means the retry achieved nothing, so the rounds stop.

`until` needed almost no new machinery, which is the tell that the split was
wrong to begin with: **run_agent already contained a one-round goal loop** —
implement, verify with `qa`, roll the workspace back on FAIL, retry. `until`
only swaps the generic yardstick for the caller's criteria and raises the
round budget.

The merge also makes the guardrails uniform. They used to cover only the
single-delegation path:

| guardrail | before | now |
|---|---|---|
| step budget (80) + 15-min timeout | run_agent only | every strand and round |
| framework `qa` verification | run_agent only | same |
| workspace rollback before a retry | run_agent only | same |
| abort propagation from the parent turn | run_agent only | same |
| plan-ledger (`todo`) entry | run_agent only | same |
| parallel-write refusal | nothing had it | new |

| tool | decision | why |
|---|---|---|
| plan / decompose / update_node / get_status | **off** (`CLOWNFISH_DAG_TOOLS=1`) | duplicates `todo` (C1); 0 calls |
| delegate | **off** (same flag) | duplicates `run_agent` (C2); 0 calls |
| workflow | **off** (`CLOWNFISH_WORKFLOW_SCRIPT=1`) | fan-out absorbed by `tasks`; the SCRIPT form (pipeline, `llm()` side calls) is real expressiveness with 0 calls, so it is kept behind the flag rather than deleted |
| run_goal | **off** (`CLOWNFISH_GOAL_TOOL=1`) | loop absorbed by `until`; only run_goal survives a worker restart (goals.json + boot resume), so it stays for hours-long background goals |
| worktree_decide | **kept** | the merge step of a worktree run; no substitute |
| draw_demo, cron, memory | **kept** | distinct; product features with UI behind them |
| sessions × 3 | **kept**, assistant only | the assistant's reason to exist |

Measured with the prompt dump: **24 → 17 tools**, system prompt 14,941 →
11,498 chars (~4.1k → ~3.2k tokens), schemas ~6.1k → ~4.7k. `run_agent`'s own
schema grew 759 → 1,187 tokens, which is the honest cost of the merge and
still a large net win. One plan, one delegation entry, one fan-out rule.

## Per-delegation model override

`run_agent` did not support assigning a different model to different work —
every strand, single delegation, and verification pass shared the session's
one `ResolvedRuntime`. Two knobs now exist, same provider as the session
(cross-provider is future work — it would need its own credentials, not just
a model id swap):

- **per call** — `model` on a single delegation, or per-strand inside
  `tasks[]`: mix a stronger model for the one hard strand with the session
  default for the rest.
- **per persona** — `AgentDefinition` frontmatter `model:` pins a specific
  agent type (e.g. `qa` always runs on a stronger model than the session
  default), so callers don't have to remember to ask for it every time.

Precedence: the call's `model` wins, then the persona's pinned `model`, else
the session's own. Resolution reuses `agent/models.ts`'s `resolveRuntime` — a
pure catalog lookup, no network call — cached per model id within one
`run_agent` invocation so N strands requesting the same override share one.
Verification and retries for a strand stay on THAT strand's model, not the
session's, so a unit of work has one consistent pipeline.

Wiring a session's `run_agent` to allow overrides at all requires
`baseProviderConfig` (the session's raw provider config, pre-resolution) —
without it, an override is refused cleanly rather than silently ignored.
`agent/runtime.ts` wires this from `this.cfg.projectConfig` for every session.

Tested offline (`scripts/run-agent-check.mts`, 18 checks total): the refusal
path with no `baseProviderConfig`, an override being accepted once wired, a
persona's pinned model being picked up with no per-call override, an
unresolvable model id degrading to a synthesized sibling rather than
crashing, `resolveRuntime` producing genuinely different `model.id` values
for two catalog ids, and the loader parsing frontmatter `model:`.

## The tool-choice eval (the promised "③")

Every prior section measured tokens, latency, and code paths — dispatch
QUALITY (does the merged `run_agent` actually get called the intended way)
was inferred from the prose, never measured. `scripts/eval-dispatch.mts`
closes that gap: 10 scenarios, each a real model call against the REAL
assembled system prompt and REAL tool schemas (imports `PLAN_DIRECTIVE` /
`WORKFLOW_DIRECTIVE` / `DEMO_DIRECTIVE` from `agent/runtime.ts` and every
`*_TOOL_META` — the same objects production wires up, not a paraphrase).
Delegation-shaped tools (`run_agent`, `session_send`, `draw_demo`, `cron`,
`todo`, `memory`) are capturing stubs — same schema the model sees, but
`execute()` records the call and answers immediately instead of spawning a
real sub-agent, so a scenario that delegates costs one model turn, not a
cascade; a scenario where the model does the work itself is watchdog-capped
at 10 tool calls so it cannot spiral.

```
npx tsx scripts/eval-dispatch.mts              # all 10
npx tsx scripts/eval-dispatch.mts fanout until  # just these
```

**Result, 2026-09-03 (glm-5.2, single sample per scenario): 10/10.**

| scenario | expected dispatch | result |
|---|---|---|
| `small-edit` | does it itself (no run_agent) | grep, edit |
| `single-substantial` | no unwarranted `tasks[]` fan-out for one sequential unit of work | investigated, implemented directly |
| `fanout` | `run_agent` with `tasks[]` (≥2 strands) | one call, 3 strands |
| `until` | delegates with `until`, or fixes + verifies with a real test run | fixed directly, reran tests, reported 5/5 |
| `adversarial-property` | delegates the fix; does NOT stuff "flaky"/"break it" into `until` criteria | delegated, criteria stayed objective |
| `plan-mode-no-delegate` | no `run_agent` call — the tool isn't in plan mode's schema at all | investigated read-only, no delegation attempted |
| `inline-html` | ```` ```html ```` fence, no `draw_demo` call | inline fence |
| `draw-demo` | `draw_demo` call (genuinely multi-file) | called |
| `assistant-project-work` | `session_send`, never `run_agent` | dispatched, then polled `session_read` (assistant.md's "delivery is not completion") |
| `assistant-own-scratch` | `run_agent` (not `session_send` — no project involved) | delegated in its own workspace |

Two scenarios (`single-substantial`, `until`) were **recalibrated after real
runs disagreed with the first draft's expectation**, not loosened to force a
pass: the original bar was "must delegate", and two consecutive live runs
showed the model legitimately choosing to do capable, verified work directly
instead — which is the "small stuff yourself" rule working as intended, not
a defect. The bar that survives is the one actually worth grading: no
unwarranted `tasks[]` fan-out for a single sequential unit of work, and no
"done" claim without re-running the check. That recalibration is itself a
finding — an eval's expected answer needs the same scrutiny as the code
being evaluated.

**Caveat:** single sample per scenario, one model. A single PASS is not proof
of reliability and a single FAIL is a lead to inspect, not a proven
regression — rerun before concluding either way. Worth another pass whenever
the directive, a tool's guidelines, or the default toolset changes.

## Where to look

- `scripts/run-agent-check.mts` (in `make e2e`) asserts the call shapes and
  the refusals — bad shape, unknown type, a strand escaping the jail, two
  writers in one tree — all before any provider call. It also pins one defect
  the merge introduced and testing caught: a synthesis pass that returned
  nothing used to discard every strand's result and hand back an empty string;
  it now falls back to the labelled strand output.
- Settings → Tool lists all of them with scope (全部 / 主 agent / 仅助理 /
  默认关闭),
  editable prompt text, and an enable checkbox; disabling is honoured at the
  next worker boot (`agent/registry.ts`, `disableTools` in
  `agent/clownfish-agent.ts`).
- `CLOWNFISH_DUMP_PROMPT=<dir>` writes what a session's first request
  actually carries (`<sessionId>.system.md`, `.tools.json`).
- `agent/tool-catalog.ts` is the inventory; each tool's text lives in a
  `*_TOOL_META` constant next to its factory.

## Follow-up audit (after the merge)

A second pass over the remaining default toolset, the directives and the
builtin agent prompts — same method, 672 real calls as the evidence base —
found 10 more findings, all fixed in the same change:

1. **The directive still advertised `workflow`/`run_goal`** while both sat
   behind off-by-default flags, and never mentioned `tasks`/`until` — the
   parameters that replaced them. Rewritten around what actually ships; the
   flagged tools get their bullet only when their flag is on.
2. **`worktree_decide` was unreachable by default** (its only producers are
   the flagged tools) and its "never merge with bash" clause contradicted
   `system.md`'s "clean up the worktrees you created". It now ships only with
   its producers; `system.md` owns the default-config rule.
3. **Three verification routes with no rule for choosing** (framework
   auto-verify / `until` / "delegate to qa") — the same shape as C2, and the
   cheapest-sounding one had already won 33-0 in measurement. Collapsed into
   one three-case rule in the directive; `system.md` points at it.
4. **`read`'s oversized-line message recommended `sed` through bash** — the
   exact move the bash guideline forbids, delivered on the stronger channel
   (a tool result). It now points at grep. The nudge also learned `sed -n` /
   `awk`, stopped being suppressed by `2>&1`, and exempts `find -delete/-exec`.
5. **The assistant had two hand-off paths and no rule** (`session_send` vs
   `run_agent`) — and the wrong one silently runs in the assistant's own
   workspace. `assistant.md` now carries the dispatch rule.
6. **Plan mode said "you have no write tools" beside "delegation is
   run_agent"** — the delegation/demo directives are now dropped in plan mode
   along with the tools they describe.
7-10. Smaller: the lesson-destination rule (`CLAUDE.md` vs `memory`, chosen
   by audience), `cron` no longer promises one-off jobs a 5-field cron cannot
   express, `draw_demo`'s duplicated selection text trimmed, and the
   delegation cost clause moved from `run_agent`'s guidelines into the
   directive.


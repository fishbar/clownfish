# Clownfish — common developer tasks. See CLAUDE.md for full setup (provider
# config, ports, architecture). Provider credentials + model are NOT baked in:
# they come from the environment or <dataDir>/settings.json.

NPM ?= npm

.DEFAULT_GOAL := help

.PHONY: help dev dev-tls dev-auth dev-server dev-web install typecheck e2e e2e-live build build-worker build-pty-worker clean start start-tls

help:
	@echo "Clownfish — make targets:"
	@echo "  make dev        Start API/agent server + Vite web UI (hot reload, Ctrl-C to stop)"
	@echo "  make dev-tls    Same as dev but with HTTPS (CLOWNFISH_TLS=1; auto self-signed cert)"
	@echo "  make dev-auth   Same as dev but with Google login ON (needs the OAuth env/settings)"
	@echo "  make dev-server Start only the API/agent server (port 4317)"
	@echo "  make dev-web    Start only the Vite web UI (port 5173, proxies to 4317)"
	@echo "  make install    Install dependencies"
	@echo "  make typecheck  tsc --noEmit across agent + server"
	@echo "  make e2e        Boot a throwaway server and exercise REST + WS + auth gate"
	@echo "  make e2e-live   Same, plus one real model turn (needs provider credentials)"
	@echo "  make bench      Clownfish vs Claude Code on 5 tasks (ROUND=n)"
	@echo "  make bench-polyglot  Same, on Aider's public polyglot benchmark (N=12)"
	@echo "  make build      Production build the web UI (Vite → dist/)"
	@echo "  make build-worker  Prebuild the agent worker bundle (dist/worker.mjs; npm start does this)"
	@echo "  make build-pty-worker  Prebuild the CLI-session pty worker bundle (dist/pty-worker.mjs)"
	@echo "  make clean      Remove dist/"

# Start API server (tsx watch) + web (vite) together. Ctrl-C stops both.
# Login is forced OFF here, so a settings.json with CLOWNFISH_AUTH=google set for
# a deployed host can't silently gate local dev. Use `make dev-auth` to test it.
dev:
	$(NPM) run dev

dev-auth:
	CLOWNFISH_AUTH=google $(NPM) run dev

# Same, but the server listens HTTPS with an auto-generated self-signed cert.
dev-tls:
	CLOWNFISH_TLS=1 $(NPM) run dev

dev-server:
	$(NPM) run dev:server

dev-web:
	$(NPM) run dev:web

start:
	$(NPM) start

start-tls:
	CLOWNFISH_TLS=1 $(NPM) start

install:
	$(NPM) install

typecheck:
	$(NPM) run typecheck

# Agent-vs-agent benchmark. Both sides talk to the same model backend, so what is
# measured is the harness. `make bench ROUND=2` runs the next round.
ROUND ?= 1
bench:
	node scripts/bench/run.mjs --round $(ROUND) --concurrency 3

# Seeds and verifies every task WITHOUT running an agent: each task declares the
# score an untouched seed must get, so a broken seed or a task that gives away
# points fails here instead of silently distorting a round.
# Round 0 is reserved for the dry baseline so it can never overwrite a real
# round's artifacts (it did once, which is why the round is pinned here).
bench-dry:
	node scripts/bench/run.mjs --dry --round 0 --suite phase1
	node scripts/bench/run.mjs --dry --round 0 --suite phase2
	node scripts/bench/run.mjs --dry --round 0 --suite phase3
	node scripts/bench/run.mjs --dry --round 0 --suite phase4

# Aider's public polyglot benchmark: problems we did NOT write, scored by their
# own upstream tests. Fetch once, then `make bench-polyglot ROUND=n N=12`.
bench-polyglot-fetch:
	@test -d .bench/polyglot-benchmark || git clone --depth 1 https://github.com/Aider-AI/polyglot-benchmark.git .bench/polyglot-benchmark
	@echo "polyglot checkout ready: .bench/polyglot-benchmark"

N ?= 12
bench-polyglot: bench-polyglot-fetch
	node scripts/bench/run.mjs --suite polyglot --round $(ROUND) --n $(N) --concurrency 3

bench-rescore:
	node scripts/bench/run.mjs --round $(ROUND) --rescore

e2e:
	$(NPM) run e2e

e2e-live:
	$(NPM) run e2e:live

build:
	$(NPM) run build

build-worker:
	$(NPM) run build:worker

build-pty-worker:
	$(NPM) run build:pty-worker

clean:
	rm -rf dist

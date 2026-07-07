# vectors daemon — background sync for the unified knowledge database

A single long-lived process that keeps the PostgreSQL + pgvector store (see
[`../references/unified-knowledge-db-spec.md`](../references/unified-knowledge-db-spec.md))
continuously up to date, plus launchd/systemd tooling to run it as a background
service. It is the moving part behind the spec's "automatic background digesting"
and "constantly learning memory" features. Implemented in TypeScript and run on
Bun (`src/daemon/daemon.ts`) — **no Python**.

## What it does

Three subsystems run concurrently in one process (`runDaemon`), all against the
shared store:

1. **Chat feeder** (`src/daemon/feeders/chat.ts`) — watches chat-transcript files
   (Claude Code / Claude Desktop JSONL by default, `VINDEX_CHAT_GLOBS`) and
   upserts new `session` / `message` rows past a per-file watermark in
   `daemon_state`. New rows fire the DB trigger that enqueues an `embed` job, so
   fresh chat context becomes searchable on its own.
2. **Source feeder** (`src/daemon/feeders/source.ts`) — periodically re-ingests
   every project's configured sources via `ingestProject`, which diffs by
   whole-file content hash and skips unchanged files. Changed chunks auto-enqueue
   `embed` jobs via the trigger.
3. **Digest worker** (`src/daemon/worker.ts`) — drains the `digest_job` queue:
   `embed` (Transformers.js / ONNX, no network) and the haiku-level tasks
   (`summarize`, `extract_*`) against a **local Ollama**. It claims jobs with
   `FOR UPDATE SKIP LOCKED` (safe to run several), wakes on `LISTEN/NOTIFY`
   (channel `digest`), and polls every 2s as the safety net. On error it requeues
   until `max_attempts`, then marks the job `dead`.

The searchable path (ingest → embed → search) never needs Ollama; only the
derived abstraction tasks do.

## Prerequisites

- The schema applied: `vectors setup` (or `vectors daemon run` applies it on
  startup) against a PostgreSQL 16 with **pgvector**.
- Bun ≥ 1.2 on `PATH`.
- A local **Ollama** running (`ollama serve`) with the model in
  `VINDEX_OLLAMA_MODEL` / `UKDB_OLLAMA_MODEL` pulled — only for summaries / fact
  extraction.

## Manage it with the CLI

```bash
vectors daemon start        # install + start the service (launchd on macOS, systemd --user on Linux)
vectors daemon status       # service status
vectors daemon logs         # follow the output log
vectors daemon stop         # stop + remove the service
```

`bash ../../setup.sh` offers to start it at the end of install; `vectors daemon
start` runs the platform installer below directly.

## Install directly (env-baked service)

```bash
cd skills/vector-index/daemon
cp ukdb-daemon.env.example ukdb-daemon.env   # then edit: set VINDEX_DSN at least
bash install.sh
```

This writes the platform service with the env baked in from your
`ukdb-daemon.env`, bootstraps and starts it. **macOS (launchd):**
`~/Library/LaunchAgents/com.vectors.ukdb.plist`, runs at login, kept alive, logs
to `~/Library/Logs/ukdb-daemon.{out,err}.log`. **Linux (systemd --user):** a
`--user` unit `ukdb-daemon.service` (`loginctl enable-linger "$USER"` to keep it
running while logged out). Re-run `bash install.sh` after editing the env to
apply changes; reverse with `bash uninstall.sh`.

```bash
launchctl print gui/$(id -u)/com.vectors.ukdb | head   # macOS status
tail -f ~/Library/Logs/ukdb-daemon.out.log             # watch it work
```

## Run in the foreground (debug)

```bash
vectors daemon run
# or directly:  bun src/daemon/daemon.ts
```

## Configuration

All via environment — see [`ukdb-daemon.env.example`](ukdb-daemon.env.example).
`VINDEX_*` is canonical; the legacy `UKDB_*` names are still accepted as aliases.
`VINDEX_DSN` (alias `UKDB_DSN`) is required; everything else has sane defaults.
Notable knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VINDEX_DSN` / `UKDB_DSN` | `postgres://localhost:5432/vectors` | Postgres DSN. |
| `VINDEX_EMBED_MODEL` | `all-MiniLM-L6-v2` | Embedding model. |
| `VINDEX_OLLAMA_URL` / `UKDB_OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama. |
| `VINDEX_OLLAMA_MODEL` / `UKDB_OLLAMA_MODEL` | `llama3.1:8b` | Ollama model. |
| `VINDEX_CHAT_GLOBS` / `UKDB_CHAT_GLOBS` | `~/.claude/projects/**/*.jsonl,~/.claude/history.jsonl` | Session-history globs (comma list). |
| `VINDEX_CHAT_INTERVAL` / `UKDB_CHAT_INTERVAL` | `5` (s) | Chat feeder cadence. |
| `VINDEX_SOURCE_INTERVAL` / `UKDB_SOURCE_INTERVAL` | `300` (s) | Source feeder cadence. |

## Notes & limits

- The chat parser is tolerant of transcript shape (string or typed-array
  `content`); point `VINDEX_CHAT_GLOBS` at any JSONL conversation logs. Chat
  `message.project_id` is left NULL unless you wire a mapping — global search
  still finds them.
- Per-message offsets and source-scan watermarks live in `daemon_state`, so
  restarts resume without re-ingesting.
- The embedding space (`embedding_space` row + `emb_<model>_<dim>` table + HNSW
  index) is created on first run if absent.

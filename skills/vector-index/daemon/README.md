# ukdb-daemon — background sync for the Unified Knowledge Database

A single long-lived process that keeps the PostgreSQL + pgvector store (see
[`../references/unified-knowledge-db-spec.md`](../references/unified-knowledge-db-spec.md))
continuously up to date, plus launchd/systemd tooling to run it as a background
service. It is the moving part behind the spec's "automatic background digesting"
and "constantly learning memory" features.

## What it does

Concerns handled in one event loop (the first three keep the DB current; the
fourth, optional, mirrors it off-machine):

1. **Chat feeder** — watches chat-transcript files (Claude Code / Claude Desktop
   JSONL by default, `UKDB_CHAT_GLOBS`) and upserts new `session` / `message`
   rows. New rows fire the DB trigger that enqueues an `embed` job, so fresh chat
   context becomes searchable on its own.
2. **Source feeder** — re-reads each project's existing
   `$VINDEX_HOME/<project>/config.json` and mirrors changed files (content-hash
   diffed) into `document` / `chunk`. This bridges your current vector-index
   store into the unified DB without re-declaring sources.
3. **Job worker** — drains the `digest_job` queue: `embed` (sentence-transformers,
   no network), and the haiku-level LLM tasks against a **local Ollama** —
   `extract_references`, `extract_facts`, and `summarize` (builds derived L1/L2
   `memory_node`s + `derivation` edges). It claims jobs with
   `FOR UPDATE SKIP LOCKED` (safe to run several), wakes on `LISTEN/NOTIFY`, and
   polls as the safety net.

4. **Backup (optional)** — once a day, `pg_dump`s the DB and pushes it to a
   remote provider (OneDrive / Google Drive via `folder` or `rclone`, an Obsidian
   vault, and/or a Notion manifest). See *Optional remote backup* below.

The searchable path (ingest → embed → search) never needs Ollama; only the
derived abstraction tasks do. `cluster_topics`, `extract_concepts`, `dedupe`, and
`rebuild_abstraction` are recognized and acknowledged-as-skipped for now (a later
iteration implements them) so the queue stays clean.

## Prerequisites

- The schema applied: `psql "$UKDB_DSN" -f ../references/unified-knowledge-db.sql`
  against a PostgreSQL 16 with **pgvector** installed.
- The plugin venv built: `bash ../setup.sh` (the installer adds `psycopg` to it).
- A local **Ollama** running (`ollama serve`) with the model in
  `UKDB_OLLAMA_MODEL` pulled — only needed for summaries/fact extraction.

## Install (macOS — launchd)

The top-level `bash ../setup.sh` offers to install this daemon at the end (answer
`Y`, or pass `-y` to auto-accept). You still need `ukdb-daemon.env` configured
first. To install it directly:

```bash
cd skills/vector-index/daemon
cp ukdb-daemon.env.example ukdb-daemon.env   # then edit: set UKDB_DSN at least
bash install.sh
```

This writes `~/Library/LaunchAgents/com.vectors.ukdb.plist` (env baked in from
your `ukdb-daemon.env`), then bootstraps + kickstarts it. It runs at login and is
kept alive. Logs go to `~/Library/Logs/ukdb-daemon.{out,err}.log`.

```bash
launchctl print gui/$(id -u)/com.vectors.ukdb | head   # status
tail -f ~/Library/Logs/ukdb-daemon.out.log             # watch it work
bash uninstall.sh                                       # stop + remove
```

Re-run `bash install.sh` after editing `ukdb-daemon.env` to apply changes.

## Install (Linux — systemd --user)

The same `install.sh` detects Linux and writes a `--user` unit instead:

```bash
bash install.sh
systemctl --user status ukdb-daemon.service
loginctl enable-linger "$USER"     # keep running while logged out (optional)
```

## Run in the foreground (debug)

```bash
set -a; . ukdb-daemon.env; set +a
../.venv/bin/python ukdb_daemon.py
```

## Optional remote backup (≈ once a day)

When `UKDB_BACKUP_PROVIDER` is set, the daemon runs `pg_dump -Fc` of the whole DB
and pushes it to one or more providers, self-throttled to `UKDB_BACKUP_INTERVAL`
(default 24h) and tracked in `daemon_state` so restarts don't double-back-up.
Providers are comma-separated; pick by how you want the bytes stored:

| Provider | Storage | Config |
| --- | --- | --- |
| `folder` | copy to any local dir — **point it at a OneDrive / Google Drive local sync folder** to reach those clouds with no API setup | `UKDB_BACKUP_DIR` |
| `rclone` | true cloud upload via a configured `rclone` remote (OneDrive, Google Drive, …) | `UKDB_RCLONE_REMOTE` (e.g. `onedrive:backups/ukdb`) |
| `obsidian` | copy into a vault subfolder + maintain `UKDB Backups.md`; mirror via Obsidian Sync / iCloud | `UKDB_OBSIDIAN_VAULT` |
| `notion` | a backup **manifest** page (timestamp/size/checksum/location) — the dump bytes go to a byte-storing provider above, Notion is the catalog | `UKDB_NOTION_TOKEN`, `UKDB_NOTION_PARENT` (a page id) |

`UKDB_BACKUP_RETENTION` (default 7) keeps the newest N dumps for
folder/obsidian/rclone. **OneDrive and Google Drive** are reached either via
`folder` (their desktop apps expose a local synced directory, the simplest path)
or via `rclone` (no local sync needed). Requires `pg_dump` on `PATH` (or set
`UKDB_PG_DUMP`).

Test your provider config without waiting a day:

```bash
set -a; . ukdb-daemon.env; set +a
../.venv/bin/python ukdb_daemon.py --backup-now    # one backup, prints results, exits
```

## Configuration

All via environment — see [`ukdb-daemon.env.example`](ukdb-daemon.env.example).
`UKDB_DSN` is required; everything else has sane defaults. Notable knobs:
`UKDB_OLLAMA_MODEL`, `UKDB_CHAT_GLOBS`, `UKDB_FEEDER_INTERVAL` (chat+source scan
cadence), `UKDB_POLL_INTERVAL` (queue poll), and `UKDB_DISABLE_FEEDERS=1` to run a
worker-only node.

## Notes & limits

- The chat parser is tolerant of transcript shape (string or typed-array
  `content`, `message.role` or top-level `type`); point `UKDB_CHAT_GLOBS` at any
  JSONL conversation logs. Chat `message.project_id` is left NULL unless you wire
  a mapping — global search still finds them.
- Per-message offsets and source scan watermarks live in the `daemon_state`
  table, so restarts resume without re-ingesting.
- The embedding space (`embedding_space` row + `emb_<model>_<dim>` table + HNSW
  index) is created on first run if absent.

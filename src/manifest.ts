/**
 * manifest — derive a default project name from a directory's package manifest.
 *
 * Powers bare `vectors index`: package.json → composer.json → Cargo.toml →
 * pyproject.toml → go.mod, falling back to the directory basename. Stdlib only
 * (no TOML dependency — the two TOML reads are section-scoped regexes), every
 * read tolerant: any miss or parse failure just moves to the next candidate.
 */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'


/** Last path segment of a package name (`@scope/pkg` / `vendor/pkg` → `pkg`). */
function lastSegment (name: string): string {
  const parts = name.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

async function readText (path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  }
  catch {
    return null
  }
}

/** `.name` from a JSON manifest (package.json, composer.json). */
async function jsonName (path: string): Promise<string | null> {
  const text = await readText(path)
  if (!text)
    return null
  try {
    const name = (JSON.parse(text) as Record<string, unknown>).name
    return typeof name === 'string' ? lastSegment(name) : null
  }
  catch {
    return null
  }
}

/** `name = "…"` within one `[section]` of a TOML file (no TOML dependency). */
async function tomlName (path: string, section: string): Promise<string | null> {
  const text = await readText(path)
  if (!text)
    return null

  const start = text.indexOf(`[${section}]`)
  if (start < 0)
    return null

  const body = text.slice(start + section.length + 2)
  const end  = body.search(/^\s*\[/m)
  const m    = (end < 0 ? body : body.slice(0, end)).match(/^\s*name\s*=\s*"([^"]+)"/m)
  return m ? m[1] : null
}

/** `module …` path basename from go.mod. */
async function goModName (path: string): Promise<string | null> {
  const text = await readText(path)
  const m    = text?.match(/^module\s+(\S+)/m)
  return m ? lastSegment(m[1]) : null
}

/** Derive a project name from the root's package manifest, else basename(root). */
export async function defaultProjectName (root: string): Promise<string> {
  const candidates = [
    () => jsonName(join(root, 'package.json')),
    () => jsonName(join(root, 'composer.json')),
    () => tomlName(join(root, 'Cargo.toml'), 'package'),
    () => tomlName(join(root, 'pyproject.toml'), 'project'),
    () => goModName(join(root, 'go.mod')),
  ]
  for (const candidate of candidates) {
    const name = await candidate()
    if (name)
      return name
  }
  return basename(root)
}

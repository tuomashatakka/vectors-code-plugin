/**
 * `vectors` (no args) — the interactive TUI, built on @opentui/core. It drives
 * the *same* command registry as the flag CLI (match/dispatch from ./index.ts),
 * so the two front-ends never drift. Features:
 *   - autocomplete over the command registry (type a prefix; Tab to accept)
 *   - a project switcher (Ctrl-P) backed by the project list
 *   - a query-first prompt: a bare line searches the active project
 *   - `:project <name>`, `:help`, `:q` meta-commands
 *
 * Commands print via console.log; we transiently capture that into the results
 * pane rather than rewriting every command to return strings.
 */
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  SelectRenderable,
  InputRenderableEvents,
} from '@opentui/core'
import type { KeyEvent, SelectOption } from '@opentui/core'
import { resolveProjectName, listProjects } from '../db/projects.ts'


const ACCENT = '#b48ead'
const DIM    = '#6b6b85'
const BG     = '#0b0b12'

const WELCOME = [
  'welcome to vectors — a query-first shell.',
  '',
  '  • type a command (Tab to autocomplete) or a search query',
  '  • Ctrl-P  switch project        :project <name>  switch by name',
  '  • :help   list every command    :q / Ctrl-C      quit',
].join('\n')

const META: SelectOption[] = [
  { name: ':project <name>', description: 'switch the active project', value: ':project ' },
  { name: ':help', description: 'list every command', value: ':help' },
  { name: ':q', description: 'quit the shell', value: ':q' },
]

function header (project: string): string {
  return `vectors · project: ${project}   —   Ctrl-P switch · Tab complete · :help · Ctrl-C quit`
}

/** Run the interactive shell; resolves when the user quits. */
export async function runTui (): Promise<void> {
  const { match, dispatch, helpText, COMMANDS } = await import('./index.ts')
  let project                      = await resolveProjectName()
  let mode: 'complete' | 'project' = 'complete'

  const renderer = await createCliRenderer({ exitOnCtrlC: false, backgroundColor: BG })
  const root     = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%', height: '100%', padding: 1, gap: 1 })
  renderer.root.add(root)

  const headerText = new TextRenderable(renderer, { content: header(project), fg: ACCENT })
  root.add(headerText)

  const outputBox = new BoxRenderable(renderer, { flexGrow: 1, width: '100%', border: true, borderColor: DIM, title: ' results ', padding: 1 })
  root.add(outputBox)

  const output    = new TextRenderable(renderer, { content: WELCOME })
  outputBox.add(output)

  const suggestBox = new BoxRenderable(renderer, { width: '100%', height: 7, border: true, borderColor: DIM, title: ' suggestions ', visible: false })
  root.add(suggestBox)

  const suggest    = new SelectRenderable(renderer, {
    width:                   '100%',
    height:                  5,
    options:                 [],
    showDescription:         true,
    wrapSelection:           true,
    selectedBackgroundColor: ACCENT,
  })
  suggestBox.add(suggest)

  const input = new InputRenderable(renderer, {
    width:       '100%',
    placeholder: 'command or search query — Tab completes, Enter runs',
  })
  root.add(input)
  input.focus()

  // The completion pool: every visible command, by canonical path.
  const verbs: SelectOption[] = COMMANDS
    .filter(c => !c.hidden)
    .map(c => ({ name: c.usage ?? c.path.join(' '), description: c.summary, value: c.path.join(' ') }))

  function setSuggestions (options: SelectOption[]): void {
    suggest.options    = options
    suggestBox.visible = options.length > 0
    if (options.length)
      suggest.setSelectedIndex(0)
    renderer.requestRender()
  }

  function refreshCompletions (text: string): void {
    if (mode === 'project')
      return

    const q = text.trim().toLowerCase()
    if (!q) {
      setSuggestions([])
      return
    }

    const pool = q.startsWith(':') ? META : verbs
    setSuggestions(pool
      .filter(o => String(o.value).toLowerCase()
        .startsWith(q) || o.name.toLowerCase().includes(q))
      .slice(0, 8))
  }

  function show (echo: string, body: string): void {
    output.content = `❯ ${echo}\n\n${body || '(no output)'}`
    renderer.requestRender()
  }

  /** Capture console output emitted while `fn` runs. */
  async function capture (fn: () => Promise<void>): Promise<string> {
    const lines: string[] = []
    const log             = console.log
    const err             = console.error
    console.log           = (...a: unknown[]) => {
      lines.push(a.map(String).join(' '))
    }
    console.error         = (...a: unknown[]) => {
      lines.push(a.map(String).join(' '))
    }
    try {
      await fn()
    }
    catch (e) {
      lines.push(String(e instanceof Error ? e.message : e))
    }
    finally {
      console.log   = log
      console.error = err
    }
    return lines.join('\n')
  }

  async function runLine (raw: string): Promise<void> {
    const s            = raw.trim()
    input.value        = ''
    suggestBox.visible = false
    mode               = 'complete'
    if (!s) {
      renderer.requestRender()
      return
    }
    if (s === ':q' || s === ':quit') {
      finish()
      return
    }
    if (s === ':help' || s === ':h') {
      show(s, helpText(true))
      return
    }
    if (s.startsWith(':project ')) {
      project           = s.slice(':project '.length).trim() || project
      headerText.content = header(project)
      show(s, `switched to project '${project}'`)
      return
    }

    const hit = match(s.split(/\s+/))
    if (hit?.cmd.longRunning) {
      show(s, `'${hit.cmd.path.join(' ')}' runs a long-lived process — quit (:q) and run: vectors ${s}`)
      return
    }

    const out = await capture(async () => {
      if (hit)
        await dispatch(hit.cmd, hit.rest)
      else
        await dispatch(match([ 'search' ])!.cmd, [ s, '--project', project ])
    })
    show(s, out)
  }

  async function openProjectPicker (): Promise<void> {
    const rows = await listProjects()
    if (!rows.length) {
      show('Ctrl-P', 'no projects yet — run `index <name> [path]`')
      return
    }
    mode = 'project'
    setSuggestions(rows.map(p => ({
      name:        p.name,
      description: `${p.documents} docs · ${p.chunks} chunks`,
      value:       p.name,
    })))
  }

  function acceptCompletion (): void {
    const opt = suggest.getSelectedOption()
    if (!opt)
      return
    input.value = String(opt.value)
    refreshCompletions(input.value)
  }

  function chooseProject (): void {
    const opt = suggest.getSelectedOption()
    mode               = 'complete'
    suggestBox.visible = false
    if (opt) {
      project            = String(opt.value)
      headerText.content = header(project)
      show('switch project', `switched to project '${project}'`)
    }
    else
      renderer.requestRender()
  }

  input.on(InputRenderableEvents.INPUT, () => refreshCompletions(input.value))
  input.on(InputRenderableEvents.ENTER, () => {
    void runLine(input.value)
  })

  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (key.ctrl && key.name === 'c') {
      finish(); return
    }
    if (key.ctrl && key.name === 'p') {
      key.preventDefault(); void openProjectPicker(); return
    }
    if (!suggestBox.visible)
      return
    switch (key.name) {
      case 'up': suggest.moveUp(); key.preventDefault(); renderer.requestRender(); break
      case 'down': suggest.moveDown(); key.preventDefault(); renderer.requestRender(); break
      case 'tab': if (mode === 'complete')
        acceptCompletion(); key.preventDefault(); break
      case 'return': if (mode === 'project') {
        chooseProject(); key.preventDefault()
      } break
      case 'escape': mode = 'complete'; suggestBox.visible = false; key.preventDefault(); renderer.requestRender(); break
      default: break
    }
  })

  let resolveDone: () => void
  const done = new Promise<void>(r => {
    resolveDone = r
  })
  function finish (): void {
    renderer.destroy()
    resolveDone()
  }

  renderer.start()
  await done
}

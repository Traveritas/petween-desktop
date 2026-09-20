/**
 * connectors/config-io.ts — shared hardened read-modify-write machinery for
 * USER-owned JSON config files (zcode ~/.zcode/cli/config.json, Claude Code
 * ~/.claude/settings.json). The v0.4.0 review hardening applies to both:
 * random tmp suffix (concurrent writers never share a path), one-generation
 * .petween-bak backup, atomic rename, in-module serialization of the
 * read-modify-write pair, corrupt-file refusal (user data is never
 * clobbered by a parse failure).
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** null = missing file (fresh install); throws on present-but-corrupt. */
export async function readConfigObject(path: string): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null // missing file: fresh install
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('config root is not an object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(`config is not valid JSON (${path}): ${String(error)}`)
  }
}

export async function writeConfigAtomic(path: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Random suffix: two concurrent writers must never share a tmp path (the
  // in-module chain serializes our own calls; the suffix covers anything else).
  const tmp = `${path}.petween-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
  try {
    // One-generation backup — the config is user data; a botched merge must
    // always be recoverable even if our error path misbehaved.
    await copyFile(path, `${path}.petween-bak`)
  } catch {
    // absent on fresh installs — nothing to back up
  }
  await rename(tmp, path)
}

/**
 * Serializes the read-modify-write pair against itself — a double-clicked
 * install or an install racing an uninstall must never interleave (the
 * second writer's stale read would clobber the first writer's merge).
 * One chain per config file.
 */
const writeChains = new Map<string, Promise<unknown>>()

export function serializedWrite<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(path) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  writeChains.set(path, run.catch(() => {}))
  return run
}

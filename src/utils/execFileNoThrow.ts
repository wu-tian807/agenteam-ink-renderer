import { spawn, type ChildProcess } from 'child_process'

export interface ExecResult {
  exitCode: number
  code: number   // alias for exitCode (used by osc.ts)
  stdout: string
  stderr: string
}

export interface ExecOpts {
  /** stdin data — string (utf8) or raw Buffer */
  input?: string | Buffer
  /** timeout in ms, default 5000 */
  timeout?: number
  /** unused, kept for API compat */
  useCwd?: boolean
}

type PipedChild = ChildProcess & {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
}

/**
 * Spawn a subprocess, feed it optional stdin, and resolve with the result.
 * Never throws — errors are caught and returned as exitCode=1.
 */
export async function execFileNoThrow(
  file: string,
  args: string[],
  opts?: ExecOpts,
): Promise<ExecResult> {
  return new Promise(resolve => {
    const { timeout = 5000, input } = opts ?? {}

    let child: PipedChild
    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as PipedChild
    } catch {
      return resolve({ exitCode: 1, code: 1, stdout: '', stderr: 'spawn error' })
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code, code, stdout, stderr })
    }

    const timer = setTimeout(() => {
      if (!settled) {
        try { child.kill() } catch { /* ignore */ }
        done(1)
      }
    }, timeout)

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('close', (code: number | null) => done(code ?? 1))
    child.on('error', () => done(1))

    if (input !== undefined) {
      try {
        if (Buffer.isBuffer(input)) {
          child.stdin.write(input)
        } else {
          child.stdin.write(input, 'utf8')
        }
      } catch { /* ignore */ }
    }
    try { child.stdin.end() } catch { /* ignore */ }
  })
}

/**
 * dsh-bridge/dsh-client.ts — the HTTP RPC helpers the bridge needs: probing
 * aliveness via POST /api/host.describe (docs/03 §4.2). Requests use the
 * client-request envelope with Content-Type: application/json (anything
 * else gets 415); `method` must match the URL endpoint. No Origin header —
 * Node fetch on a loopback URL passes the trust gate.
 */

export interface DshDescribe {
  version: string
  [key: string]: unknown
}

const REQUEST_TIMEOUT_MS = 2500

function randomRpcId(): string {
  return globalThis.crypto.randomUUID()
}

export async function postRpc<T>(port: number, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomRpcId(), method, payload }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const body = (await response.json()) as {
    type: string
    result?: { ok: boolean; value?: T; error?: { message?: string } }
  }
  if (body.type !== 'server-response' || body.result === undefined || !body.result.ok) {
    throw new Error(body.result?.error?.message ?? 'rpc failed')
  }
  return body.result.value as T
}

/** Liveness probe; resolves null when nothing answers like DSH on the port. */
export async function describeDsh(port: number): Promise<DshDescribe | null> {
  try {
    const value = await postRpc<DshDescribe>(port, 'host.describe', {})
    return typeof value.version === 'string' ? value : null
  } catch {
    return null
  }
}

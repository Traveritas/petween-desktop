/**
 * dsh-bridge/ws-socket.ts — the thin `ws` adapter. The bridge logic talks to
 * this minimal surface so tests can inject fakes; the real one enforces the
 * DSH downlink contract requirements: JSON text frames only, no Origin /
 * no subprotocol header, ws-level ping for keepalive (control frames are
 * safe on a downlink-only stream — sending DATA would get us closed with
 * 1008, so send() is deliberately absent).
 */
import WebSocket from 'ws'

export interface BridgeSocket {
  onOpen(handler: () => void): void
  onClose(handler: (code: number, reason: string) => void): void
  onMessage(handler: (data: string) => void): void
  onPong(handler: () => void): void
  ping(): void
  close(): void
}

export function connectDshSocket(url: string): BridgeSocket {
  const socket = new WebSocket(url) // no origin option: loopback trust gate
  const text = (data: WebSocket.RawData): string => {
    if (typeof data === 'string') return data
    return Buffer.from(data as ArrayBuffer).toString('utf8')
  }
  return {
    onOpen(handler) {
      socket.on('open', handler)
    },
    onClose(handler) {
      socket.on('close', (code, reason) => handler(code, reason.toString('utf8')))
      socket.on('error', () => handler(-1, 'error'))
    },
    onMessage(handler) {
      socket.on('message', (data, isBinary) => {
        if (isBinary) return // the streams are JSON text only
        handler(text(data))
      })
    },
    onPong(handler) {
      socket.on('pong', handler)
    },
    ping() {
      if (socket.readyState === WebSocket.OPEN) socket.ping()
    },
    close() {
      socket.removeAllListeners()
      socket.close()
    },
  }
}

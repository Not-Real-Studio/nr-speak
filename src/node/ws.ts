/**
 * Приём WebSocket на HTTP-сервере (LLM-4, `/v1/listen/stream` speak): `ws` в режиме `noServer`
 * поверх `upgrade` — маршрут и ключ решает вызывающий, соединение отдаётся простым интерфейсом
 * (текст/байты внутрь, текст наружу), без типов `ws` у клиента.
 */

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'

export interface WsConn {
  send(text: string): void
  close(code?: number, reason?: string): void
  /** Текстовый кадр — строкой, бинарный — байтами. */
  onMessage(cb: (data: string | Uint8Array) => void): void
  onClose(cb: (code: number, reason: string) => void): void
  readonly open: boolean
}

/**
 * `route(req)` — `true`: принять; число — HTTP-статус отказа (401, 404); `false` — не наш путь
 * (сокет не трогаем: другой обработчик `upgrade`). Возвращает отписку.
 */
export function acceptWebSockets(server: Pick<Server, 'on' | 'off'>, route: (req: IncomingMessage) => boolean | number, handle: (conn: WsConn, req: IncomingMessage) => void, o: { maxPayload?: number } = {}): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: o.maxPayload ?? 4 * 1024 * 1024 })
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const verdict = route(req)
    if (verdict === false) return
    if (verdict !== true) {
      const text = verdict === 401 ? 'Unauthorized' : verdict === 404 ? 'Not Found' : 'Bad Request'
      socket.end(`HTTP/1.1 ${verdict} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handle(
        {
          send: (t) => {
            if (ws.readyState === ws.OPEN) ws.send(t)
          },
          close: (code, reason) => ws.close(code ?? 1000, reason),
          onMessage: (cb) => ws.on('message', (data, isBinary) => cb(isBinary ? new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : (data as Buffer)) : String(data))),
          onClose: (cb) => ws.on('close', (code, reason) => cb(code, String(reason))),
          get open() {
            return ws.readyState === ws.OPEN
          },
        },
        req,
      )
    })
  }
  server.on('upgrade', onUpgrade)
  return () => {
    server.off('upgrade', onUpgrade)
    for (const c of wss.clients) c.terminate()
    wss.close()
  }
}

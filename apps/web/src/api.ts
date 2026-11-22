import type { RpcEvent, RpcId, RpcRequest, RpcResults, RpcServerFrame } from '@extendo/contracts';

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, options);
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? 'Could not reach the local Extendo server.');
  }
  return response.json() as Promise<T>;
}

export function json(method: 'POST' | 'PUT', data: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

type Method = keyof RpcResults;
type Params<M extends Method> = Extract<RpcRequest, { method: M }>['params'];
type Pending = {
  result(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

export class RpcSocket {
  private readonly socket: WebSocket;
  private readonly pending = new Map<RpcId, Pending>();
  private cursor = 0;
  readonly ready: Promise<void>;

  constructor(onEvent: (event: RpcEvent) => void, onClose?: () => void) {
    const url = new URL('/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('close', () => {
        const error = new Error('The local connection was interrupted.');
        reject(error);
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
          pending.reject(error);
        }
        onClose?.();
      }, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('Could not connect to the local Extendo server.')), { once: true });
    });
    this.socket.addEventListener('message', ({ data }) => {
      if (typeof data !== 'string') return;
      let frame: RpcServerFrame;
      try { frame = JSON.parse(data) as RpcServerFrame; } catch { return; }
      if ('event' in frame) { onEvent(frame); return; }
      if (frame.id === null) return;
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(frame.id);
      if ('error' in frame) pending.reject(new Error(frame.error.message));
      else pending.result(frame.result);
    });
  }

  async call<M extends Method>(method: M, params: Params<M>): Promise<RpcResults[M]> {
    await this.ready;
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('The local connection is closed.');
    const id = ++this.cursor;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Extendo did not respond. Try again after reconnecting.'));
      }, 10_000);
      this.pending.set(id, { result: (value) => resolve(value as RpcResults[M]), reject, timeout });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  close() {
    this.socket.close();
  }
}

// Worker 调度:合并抖动期内的多次请求,过期响应直接丢弃,保证拖拽流畅。
import type { ComputeRequest, ComputeResponse } from './compute.worker.ts';
import type { IllumResult } from './types.ts';

export class ComputeScheduler {
  private worker: Worker;
  private seq = 0;
  private latestSeq = -1;
  private timer: number | null = null;
  private pending: ComputeRequest | null = null;
  private onResult: (r: IllumResult) => void;
  private onBusy?: (busy: boolean) => void;

  constructor(onResult: (r: IllumResult) => void, onBusy?: (busy: boolean) => void) {
    this.onResult = onResult;
    this.onBusy = onBusy;
    this.worker = new Worker(new URL('./compute.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<ComputeResponse>) => {
      if (ev.data.seq !== this.latestSeq) return; // 过期结果
      this.onBusy?.(false);
      this.onResult(ev.data.result);
      if (this.pending) {
        const next = this.pending;
        this.pending = null;
        this.dispatch(next);
      }
    };
  }

  /** 防抖提交:拖拽时每帧最多一次计算 */
  request(req: Omit<ComputeRequest, 'seq'>, debounceMs = 60): void {
    this.pending = { ...req, seq: -1 };
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.pending) {
        const next = this.pending;
        this.pending = null;
        this.dispatch(next);
      }
    }, debounceMs);
  }

  private dispatch(req: ComputeRequest): void {
    this.seq += 1;
    this.latestSeq = this.seq;
    this.onBusy?.(true);
    this.worker.postMessage({ ...req, seq: this.seq } satisfies ComputeRequest);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.worker.terminate();
  }
}

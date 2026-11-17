// 五个功能面板共享的上下文。
import type { Store } from '../core/store.ts';
import type { SceneRenderer } from '../render/scene.ts';
import type { ComputeScheduler } from '../core/scheduler.ts';

export interface PanelContext {
  store: Store;
  renderer: SceneRenderer;
  scheduler: ComputeScheduler;
  /** 请求重新计算(防抖) */
  scheduleCompute: () => void;
  /** 重建 3D 房间网格 */
  rebuildRoom: () => void;
}

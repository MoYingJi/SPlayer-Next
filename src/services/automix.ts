import { shallowRef } from "vue";
import type { AutoMixComponentStatus } from "@shared/types/automix";

/** 只存紧凑的组件状态，不持有模型或音频数据 */
export const autoMixComponentStatus = shallowRef<AutoMixComponentStatus>({
  state: "missing",
  models: [],
});
/**
 * 仅按当前模式所需组件判断就绪，避免无关下载的进度使 PCM 预载失效
 * @param enhanced - 是否启用分轨增强
 * @returns 所需模型和运行时均已就绪时为 true
 */
export const isAutoMixReady = (enhanced = false): boolean => {
  const required = enhanced ? ["beat", "demucs", "runtime"] : ["beat", "runtime"];
  return required.every(
    (id) => autoMixComponentStatus.value.models.find((model) => model.id === id)?.state === "ready",
  );
};

/** 读取已校验的状态，设置页与预载服务共享结果，首次检查由主进程合并 */
export const refreshAutoMixComponents = async (): Promise<void> => {
  autoMixComponentStatus.value = await window.api.automix.getStatus();
};

/**
 * 在播放器生命周期内接收低频组件状态与下载进度
 * @returns 解绑函数
 */
export const connectAutoMixComponents = (): (() => void) => {
  const unsubscribe = window.api.automix.onStatus((status) => {
    autoMixComponentStatus.value = status;
  });
  void refreshAutoMixComponents().catch(console.warn);
  return unsubscribe;
};

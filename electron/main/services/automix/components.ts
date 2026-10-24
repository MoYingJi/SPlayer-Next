import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { net } from "electron";
import { automixDir } from "@main/utils/paths";
import { broadcast } from "@main/utils/broadcast";
import { playerLog } from "@main/utils/logger";
import type {
  AutoMixComponentId,
  AutoMixComponentStatus,
  AutoMixModelStatus,
} from "@shared/types/automix";
import { AUTOMIX_COMPONENTS, AUTOMIX_WORKER } from "./assets";
import { extractAutoMixPackage } from "./runtime";

const models: AutoMixModelStatus[] = (["beat", "demucs", "runtime"] as const).map((id) => ({
  id,
  state: AUTOMIX_COMPONENTS[id] ? "missing" : "unsupported",
  received: 0,
  total: 0,
}));
let checking: Promise<AutoMixComponentStatus> | undefined;
let installation: Promise<AutoMixComponentStatus> | undefined;
let controller: AbortController | undefined;
let checked = false;
let activeComponentId: AutoMixComponentId | undefined;

/** 汇总独立组件的紧凑状态，不包含模型或音频数据 */
const snapshot = (): AutoMixComponentStatus => ({
  state: models.every((model) => model.state === "ready")
    ? "ready"
    : models.some((model) => model.state === "downloading")
      ? "downloading"
      : models.some((model) => model.state === "error")
        ? "error"
        : "missing",
  models: models.map((item) => ({ ...item })),
});

/**
 * 首次选择 AutoMix 时检查所需文件，普通查询共享结果
 * @returns 组件的安装或下载状态
 */
export const getAutoMixComponentStatus = (): Promise<AutoMixComponentStatus> => {
  if (installation || checked) return Promise.resolve(snapshot());
  if (checking) return checking;
  checking = (async () => {
    for (const model of models) {
      const asset = AUTOMIX_COMPONENTS[model.id];
      if (!asset) continue;
      const files = await Promise.all(
        asset.files.map((file) => stat(path.join(automixDir, model.id, file)).catch(() => null)),
      );
      model.state = files.every((file) => file?.isFile() && file.size > 0) ? "ready" : "missing";
    }
    checked = true;
    return snapshot();
  })().finally(() => {
    checking = undefined;
  });
  return checking;
};

/**
 * 用户点击后流式下载并解压组件，完成后移动到安装目录
 * @param id - 组件标识
 * @returns 安装完成或失败后的组件状态
 */
export const installAutoMixComponents = (
  id: AutoMixComponentId,
): Promise<AutoMixComponentStatus> => {
  if (installation)
    return activeComponentId === id
      ? installation
      : Promise.reject(new Error("请等待当前组件安装完成"));
  const model = models.find((item) => item.id === id);
  const asset = AUTOMIX_COMPONENTS[id];
  if (!model || !asset) return Promise.reject(new Error("不支持的 AutoMix 组件"));
  controller = new AbortController();
  activeComponentId = id;
  const signal = controller.signal;
  installation = (async () => {
    const staging = path.join(automixDir, id + ".part");
    try {
      await getAutoMixComponentStatus();
      if (model.state === "ready") return snapshot();
      model.state = "downloading";
      model.received = 0;
      model.total = 0;
      model.error = undefined;
      broadcast("automix:componentStatus", snapshot());
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      const archive = path.join(staging, asset.file);
      const response = await net.fetch(asset.url, { signal });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      model.total = Number(response.headers.get("content-length")) || 0;
      const body = response.body;
      const startedAt = performance.now();
      let announcedAt = 0;
      const source = (async function* () {
        for await (const chunk of body) {
          model.received += chunk.byteLength;
          model.bytesPerSecond = Math.round(
            (model.received * 1000) / Math.max(1, performance.now() - startedAt),
          );
          if (performance.now() - announcedAt >= 200) {
            announcedAt = performance.now();
            broadcast("automix:componentStatus", snapshot(), true);
          }
          yield chunk;
        }
      })();
      await pipeline(source, createWriteStream(archive), { signal });
      await extractAutoMixPackage(archive, staging, signal);
      await rm(archive);
      for (const file of asset.files) {
        const info = await stat(path.join(staging, file));
        if (!info.isFile() || !info.size) throw new Error(`组件文件缺失: ${file}`);
      }
      if (id === "runtime" && process.platform !== "win32")
        await chmod(path.join(staging, AUTOMIX_WORKER), 0o755);
      signal.throwIfAborted();
      const destination = path.join(automixDir, id);
      await rm(destination, { recursive: true, force: true });
      // Windows 刚解压的运行库可能短暂被占用，只重试目录移动且允许取消
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          await rename(staging, destination);
          break;
        } catch (error) {
          if (
            process.platform !== "win32" ||
            !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") ||
            attempt === 5
          )
            throw error;
          await delay(250 * (attempt + 1), undefined, { signal });
        }
      }
      model.state = "ready";
    } catch (error) {
      model.state = signal.aborted ? "missing" : "error";
      model.error = signal.aborted
        ? undefined
        : error instanceof Error
          ? error.message
          : String(error);
      if (!signal.aborted) playerLog.warn("AutoMix 组件安装失败", error);
    } finally {
      try {
        await rm(staging, { recursive: true, force: true });
      } finally {
        installation = undefined;
        controller = undefined;
        activeComponentId = undefined;
        model.bytesPerSecond = undefined;
        broadcast("automix:componentStatus", snapshot());
      }
    }
    return snapshot();
  })();
  return installation;
};

/** 取消下载并在安装任务结束时清理临时文件 */
export const cancelAutoMixDownload = (): void => controller?.abort();

import { app, ipcMain } from "electron";
import type { AutoMixComponentId } from "@shared/types/automix";

let components: typeof import("@main/services/automix/components") | undefined;

/**
 * 用户访问组件时才载入下载与解压服务，普通启动不加载压缩库
 * @returns 当前进程复用的组件服务
 */
const getComponents = async (): Promise<typeof import("@main/services/automix/components")> =>
  (components ??= await import("@main/services/automix/components"));

/** 注册只在用户操作时下载的 AutoMix 组件管理接口 */
export const registerAutoMixIpc = (): void => {
  ipcMain.handle("automix:getStatus", async () =>
    (await getComponents()).getAutoMixComponentStatus(),
  );
  ipcMain.handle("automix:download", async (_event, id: AutoMixComponentId) =>
    (await getComponents()).installAutoMixComponents(id),
  );
  ipcMain.handle("automix:cancelDownload", () => components?.cancelAutoMixDownload());
  app.on("before-quit", () => components?.cancelAutoMixDownload());
};

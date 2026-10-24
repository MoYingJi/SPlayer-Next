import type { AutoMixComponentId } from "@shared/types/automix";
import { release } from "node:os";

/** 独立组件的下载地址与所需文件 */
interface AutoMixAsset {
  file: string;
  url: string;
  files: readonly string[];
}

export const AUTOMIX_RUNTIME_VERSION = "rust-1";
const baseUrl = "https://github.com/SPlayer-Dev/SPlayer-Next/releases/download/AutoMix";
const [osMajor, osMinor] = release().split(".").map(Number);
const supportedMac =
  process.platform !== "darwin" ||
  (process.arch === "arm64" ? osMajor >= 23 : osMajor > 22 || (osMajor === 22 && osMinor >= 5));
export const AUTOMIX_WORKER =
  process.platform === "win32" ? "automix-worker.exe" : "automix-worker";
export const AUTOMIX_RUNTIME_FILES = [
  AUTOMIX_WORKER,
  ...(process.platform === "win32"
    ? [
        "onnxruntime.dll",
        "DirectML.dll",
        "onnxruntime_providers_shared.dll",
        "msvcp140.dll",
        "msvcp140_1.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
      ]
    : process.platform === "darwin"
      ? ["libonnxruntime.dylib"]
      : ["libonnxruntime.so"]),
];

export const AUTOMIX_COMPONENTS: Record<AutoMixComponentId, AutoMixAsset | null> = {
  beat: {
    file: "automix-beat-v2.zip",
    url: `${baseUrl}/automix-beat-v2.zip`,
    files: ["beat-this.onnx", "beat-this.check.json"],
  },
  demucs: {
    file: "automix-demucs-v2.zip",
    url: `${baseUrl}/automix-demucs-v2.zip`,
    files: ["htdemucs.onnx", "htdemucs.check.json"],
  },
  runtime:
    supportedMac &&
    ["win32", "darwin", "linux"].includes(process.platform) &&
    ["x64", "arm64"].includes(process.arch)
      ? {
          file: `automix-runtime-${process.platform}-${process.arch}.zip`,
          url: `${baseUrl}/automix-runtime-${process.platform}-${process.arch}.zip`,
          files: AUTOMIX_RUNTIME_FILES,
        }
      : null,
};

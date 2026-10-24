import path from "node:path";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { getEngine } from "@main/services/engine";
import { automixCacheDir } from "@main/utils/paths";
import type { AutoMixPlan, AutoMixProfile } from "@shared/types/automix";
import type { AnalysisTrack } from "./analysisHost";
import { runAutoMixModel, runAutoMixTask } from "./inference";
import { arrangeVocalHandoff, measureVocalActivity } from "./vocals";
import type { AutoMixStructure } from "@shared/types/automix";

/** 只保留最近四对交接的磁盘窗口，不缓存 PCM 或模型张量 */
const completed = new Map<string, { plan: AutoMixPlan; directory: string }>();
let workspace: Promise<void> | undefined;

/**
 * 仅分离已选中的交接片段，再按实测人声与乐器安排包络
 * @param plan - 基础选点与速度计划
 * @param tracks - 两路实际音源
 * @param profiles - 可复用的首尾分析证据
 * @param signal - 当前预载的取消信号
 * @returns 依据实际声部活动安排人声交接的增强计划
 */
export const enhanceAutoMixPlan = (
  plan: AutoMixPlan,
  tracks: AnalysisTrack[],
  profiles: AutoMixProfile[],
  signal: AbortSignal,
): Promise<AutoMixPlan> =>
  runAutoMixTask(signal, async () => {
    const identities = await Promise.all(
      tracks.map(async (track) => {
        const info = await stat(track.source);
        return [track.source, info.size, info.mtimeMs, info.ctimeMs];
      }),
    );
    const key = JSON.stringify([identities, plan]);
    signal.throwIfAborted();
    const cached = completed.get(key);
    if (cached) return cached.plan;
    workspace ??= rm(automixCacheDir, { recursive: true, force: true })
      .then(() => mkdir(automixCacheDir, { recursive: true }))
      .then(() => undefined);
    await workspace;
    const directory = await mkdtemp(path.join(automixCacheDir, "mix-"));
    const windows = profiles.map((profile, index) => {
      const start = index === 0 ? plan.outStartMs : plan.inStartMs;
      const length = plan.durationMs * (index === 0 ? plan.outgoingRate : 1);
      return {
        input: path.join(directory, index + ".pcm"),
        output: path.join(directory, index + ".stems"),
        startMs: Math.max(profile.startMs, start - 1500),
        endMs: Math.min(profile.endMs, start + length + 1500),
      };
    });
    let retained = false;
    try {
      for (const [index, window] of windows.entries()) {
        signal.throwIfAborted();
        await getEngine().exportAutoMixWindow(
          tracks[index].source,
          window.startMs / 1000,
          window.endMs / 1000,
          false,
          window.input,
        );
      }
      signal.throwIfAborted();
      const results = await runAutoMixModel<{ structure: AutoMixStructure; frames: number }>(
        "demucs",
        windows,
        signal,
      );
      signal.throwIfAborted();
      const voices = profiles.map((profile, index) =>
        measureVocalActivity(profile, results[index].structure.vocals, windows[index].startMs),
      );
      const [outgoing, incoming] = windows.map((window, index) => ({
        path: window.output,
        startMs: window.startMs,
        frames: results[index].frames,
      }));
      const result = arrangeVocalHandoff(
        { ...plan, stems: { outgoing, incoming } },
        voices[0],
        voices[1],
        profiles[1].periodMs!,
      );
      completed.set(key, { plan: result, directory });
      retained = true;
      while (completed.size > 4) {
        const oldest = completed.keys().next().value!;
        const entry = completed.get(oldest)!;
        completed.delete(oldest);
        await rm(entry.directory, { recursive: true, force: true });
      }
      return result;
    } finally {
      if (retained) await Promise.all(windows.map((window) => rm(window.input, { force: true })));
      else await rm(directory, { recursive: true, force: true });
    }
  });

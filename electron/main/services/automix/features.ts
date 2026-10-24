import type { JsAutoMixFeatures } from "@splayer/audio-engine";
import type { AutoMixProfile } from "@shared/types/automix";
import { measureBeatPeriod, pickBeatPeaks } from "./beats";

/**
 * 将原生频谱和模型预测转换为有限的音乐档案，不保留模型输入
 * @param features - 原生窗口特征，时间单位为秒
 * @param scores - 交错排列的拍点和重拍预测
 * @param tail - 是否优先使用靠近曲尾的稳定节拍
 * @returns 使用绝对毫秒时间的选点证据
 */
export const createAutoMixProfile = (
  features: Omit<JsAutoMixFeatures, "mel">,
  scores: Float32Array,
  tail = false,
): AutoMixProfile => {
  const startMs = features.startSeconds * 1000;
  const levels = Array.from(features.levels);
  const sorted = [...levels].sort((a, b) => a - b);
  const threshold = Math.max(0.001, sorted[Math.floor(sorted.length * 0.8)] * 0.25);
  let bodyEnd = -1;
  for (let index = 0; index + 2 < levels.length; index++) {
    if (levels.slice(index, index + 3).every((level) => level >= threshold)) {
      bodyEnd = index + 3;
    }
  }
  const beats = pickBeatPeaks(scores.filter((_, index) => index % 2 === 0)).map(
    (time) => time + startMs,
  );
  const rawDownbeats = pickBeatPeaks(scores.filter((_, index) => index % 2 === 1));
  const downbeats = beats.length
    ? [
        ...new Set(
          rawDownbeats.flatMap((time) => {
            const nearest = beats.reduce((best, beat) =>
              Math.abs(beat - startMs - time) < Math.abs(best - startMs - time) ? beat : best,
            );
            return Math.abs(nearest - startMs - time) <= 80 ? [nearest] : [];
          }),
        ),
      ]
    : [];
  const chroma = Array.from(features.chroma);
  const novelty = levels.map((_, index) => {
    if (index < 12 || index + 12 >= levels.length) return 0;
    let distance = 0;
    for (let pitch = 0; pitch < 12; pitch++) {
      let before = 0;
      let after = 0;
      for (let offset = 0; offset < 12; offset++) {
        before += chroma[(index - 12 + offset) * 12 + pitch];
        after += chroma[(index + offset) * 12 + pitch];
      }
      distance += ((after - before) / 12) ** 2;
    }
    const before = levels.slice(index - 12, index).reduce((sum, value) => sum + value, 0);
    const after = levels.slice(index, index + 12).reduce((sum, value) => sum + value, 0);
    return (
      Math.sqrt(distance) + Math.min(2, Math.abs(Math.log((after + 0.01) / (before + 0.01)))) * 0.3
    );
  });
  const boundaries = novelty.flatMap((value, index) =>
    value > 0.35 && value === Math.max(...novelty.slice(Math.max(0, index - 15), index + 16))
      ? [startMs + index * 100]
      : [],
  );
  return {
    startMs,
    endMs: features.endSeconds * 1000,
    firstAudibleMs: features.firstAudibleSeconds * 1000,
    lastAudibleMs: features.lastAudibleSeconds * 1000,
    bodyEndMs:
      bodyEnd < 0
        ? features.lastAudibleSeconds * 1000
        : Math.min(features.endSeconds * 1000, startMs + bodyEnd * 100),
    levels,
    chroma,
    boundaries,
    beats,
    downbeats,
    ...measureBeatPeriod(beats, tail),
  };
};

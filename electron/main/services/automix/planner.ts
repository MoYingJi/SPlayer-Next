import type { AutoMixPlan, AutoMixProfile } from "@shared/types/automix";
import { arrangeAutoMix } from "./arrangement";

/**
 * 仅在用户使用正常速度和音调时允许 AutoMix
 * @param speed - 用户播放速度
 * @param pitch - 用户音调偏移
 * @returns 是否可以安排自动混音
 */
export const canAutoMix = (speed: number, pitch: number): boolean =>
  Math.abs(speed - 1) < 0.0001 && pitch === 0;

/**
 * 测量实际候选片段的有效电平与音级分布，避免残响和空前奏支配决策
 * @param profile - 有限分析档案
 * @param startMs - 片段绝对起点
 * @param endMs - 片段绝对终点
 * @returns 有效电平与归一化音级能量
 */
const measureMixWindow = (profile: AutoMixProfile, startMs: number, endMs: number) => {
  const first = Math.max(0, Math.floor((startMs - profile.startMs) / 100));
  const last = Math.min(profile.levels.length, Math.ceil((endMs - profile.startMs) / 100));
  const levels = profile.levels.slice(first, last).sort((a, b) => a - b);
  const level = Math.max(0.001, levels[Math.floor(levels.length * 0.65)] ?? 0);
  const chroma = Array<number>(12).fill(0);
  for (let index = first; index < last; index++) {
    if (profile.levels[index] < level * 0.25) continue;
    for (let pitch = 0; pitch < 12; pitch++) chroma[pitch] += profile.chroma[index * 12 + pitch];
  }
  const norm = Math.hypot(...chroma);
  if (norm > 0) for (let pitch = 0; pitch < 12; pitch++) chroma[pitch] /= norm;
  return { level, chroma };
};

/**
 * 选择可信小节与兼容片段，无法精确对拍时交由普通交叉过渡
 * @param outgoing - 当前曲尾部证据
 * @param incoming - 下一曲首部证据
 * @param currentEndMs - 当前曲目或 CUE 的有效终点
 * @param enhanced - 是否能在稳定拍段结束前独立退出鼓声部
 * @returns 通过节拍与有效音频验证的计划，没有可靠对拍空间时为空
 */
export const planAutoMix = (
  outgoing: AutoMixProfile,
  incoming: AutoMixProfile,
  currentEndMs: number,
  enhanced = false,
): AutoMixPlan | null => {
  const endMs = Math.min(currentEndMs, outgoing.lastAudibleMs + 200, outgoing.endMs);
  let entry = Math.max(incoming.startMs, incoming.firstAudibleMs - 100);
  const bodyEnd = Math.min(endMs, outgoing.bodyEndMs + 300);
  const outgoingLevel = measureMixWindow(outgoing, outgoing.startMs, bodyEnd).level;
  const incomingLevel = measureMixWindow(incoming, entry, incoming.endMs).level;
  let selected: Omit<AutoMixPlan, "envelopes"> | null = null;
  if (
    outgoing.periodMs &&
    incoming.periodMs &&
    outgoing.stability >= 0.85 &&
    incoming.stability >= 0.85 &&
    outgoing.gridStartMs != null &&
    outgoing.gridEndMs != null &&
    incoming.gridStartMs != null &&
    incoming.gridEndMs != null
  ) {
    const rates = [0.5, 1, 2].map((fold) => (outgoing.periodMs! / incoming.periodMs!) * fold);
    const rate = rates.sort((a, b) => Math.abs(Math.log(a)) - Math.abs(Math.log(b)))[0];
    const commonBeat = Math.max(outgoing.periodMs / rate, incoming.periodMs);
    const bar = commonBeat * 4;
    const downbeats = [outgoing, incoming].map((profile) => {
      const times = profile.downbeats.filter(
        (time) => time >= profile.gridStartMs! && time <= profile.gridEndMs!,
      );
      const barMs = profile.periodMs! * 4;
      // 相邻两个小节提供局部支持，不让远处的重拍相位变化或零散误检否定当前乐句
      return times.filter((time) => {
        const neighbors = new Set<number>();
        for (const other of times) {
          const offset = Math.round((other - time) / barMs);
          if (
            offset !== 0 &&
            Math.abs(offset) <= 2 &&
            Math.abs(other - time - offset * barMs) <= Math.max(40, profile.periodMs! * 0.06)
          )
            neighbors.add(offset);
        }
        return neighbors.size >= 2;
      });
    });
    const anchor = downbeats[1].find((time) => time >= Math.max(entry, incoming.gridStartMs!));
    // 开头能对拍时保留原有起音，否则允许从已确认的稳定小节入场
    if (anchor != null && anchor > entry + bar) entry = anchor;
    if (rate >= 0.93 && rate <= 1.07 && anchor != null) {
      let bestScore = Infinity;
      for (const bars of [8, 4, 2]) {
        const phraseLength = bars * bar;
        if (
          phraseLength > 18_000 ||
          phraseLength < 3500 ||
          entry + phraseLength > incoming.endMs - 300
        )
          continue;
        if (entry + phraseLength > incoming.gridEndMs + commonBeat) continue;
        for (const beat of downbeats[0]) {
          const start = beat - (anchor - entry) * rate;
          const length = Math.min(phraseLength, (endMs - start) / rate);
          const finish = start + length * rate;
          if (start < outgoing.startMs + 200 || beat < outgoing.gridStartMs) continue;
          if (phraseLength - length > 20 || length < 3500) continue;
          // 分轨模式可先交出鼓，再让自由速度的尾奏自然退出；普通模式仍要求全段网格
          const gridRequired = enhanced ? start + bar * rate : finish;
          if (gridRequired > outgoing.gridEndMs + outgoing.periodMs) continue;
          if (finish < bodyEnd - outgoing.periodMs * 2 || finish < currentEndMs - 16_000) continue;
          const a = measureMixWindow(outgoing, start, finish);
          const b = measureMixWindow(incoming, entry, entry + length);
          const hasTone = Math.hypot(...a.chroma) > 0 && Math.hypot(...b.chroma) > 0;
          const affinity = hasTone
            ? a.chroma.reduce((sum, value, i) => sum + value * b.chroma[i], 0)
            : 0.75;
          const preferred = affinity >= 0.7 ? 16_000 : 8000;
          const energyCost =
            Math.max(0, Math.log(outgoingLevel / a.level)) +
            Math.max(0, Math.log(incomingLevel / b.level));
          const boundaryCost = outgoing.boundaries.length
            ? Math.min(
                ...outgoing.boundaries.map((time) =>
                  Math.abs(time - (start + (length * rate) / 2)),
                ),
              ) / bar
            : 0;
          const score =
            Math.abs(length - preferred) / preferred +
            (Math.abs(finish - bodyEnd) / bar) * 0.2 +
            energyCost * 0.4 +
            Math.abs(Math.log(a.level / b.level)) * 0.1 +
            Math.min(2, boundaryCost) * 0.1 +
            ((1 - affinity) * length) / 8000;
          if (score >= bestScore) continue;
          bestScore = score;
          selected = {
            outStartMs: start,
            inStartMs: entry,
            durationMs: length,
            outgoingRate: rate,
            levelRatio: 1,
            strategy: affinity >= 0.7 ? "phrase" : "handoff",
          };
        }
      }
    }
  }
  if (!selected) return null;
  const a = measureMixWindow(
    outgoing,
    selected.outStartMs,
    selected.outStartMs + selected.durationMs * selected.outgoingRate,
  );
  const b = measureMixWindow(
    incoming,
    selected.inStartMs,
    selected.inStartMs + selected.durationMs,
  );
  selected.levelRatio = Math.max(0.5, Math.min(2, b.level / a.level));
  return arrangeAutoMix(selected, outgoing, incoming);
};

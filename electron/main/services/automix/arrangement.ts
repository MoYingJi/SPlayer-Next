import type { AutoMixEnvelope, AutoMixPlan, AutoMixProfile } from "@shared/types/automix";

/**
 * 将选点转换为按音乐时间错开的鼓、低频、人声与伴奏包络
 * @param plan - 已通过边界与小节验证的对拍计划
 * @param outgoing - 当前曲的稳定节拍证据
 * @param incoming - 下一曲的稳定节拍证据
 * @returns 只含有限区间的可执行编排，不在音频回调做选点
 */
export const arrangeAutoMix = (
  plan: Omit<AutoMixPlan, "envelopes">,
  outgoing: AutoMixProfile,
  incoming: AutoMixProfile,
): AutoMixPlan => {
  const duration = plan.durationMs;
  const beat = Math.max(outgoing.periodMs! / plan.outgoingRate, incoming.periodMs!);
  const bar = beat * 4;
  const gridEnd = (outgoing.gridEndMs! - plan.outStartMs) / plan.outgoingRate;
  const target = Math.min(Math.max(duration * 0.4, duration - bar * 2.5), gridEnd);
  const swaps = incoming.downbeats
    .map((time) => time - plan.inStartMs)
    .filter((time) => time >= beat && time <= Math.min(duration * 0.65, gridEnd));
  const drumAt = swaps.length
    ? swaps.reduce((best, time) =>
        Math.abs(time - target) < Math.abs(best - target) ? time : best,
      )
    : target;
  const bassAt = Math.min(duration * 0.8, drumAt + bar);
  const width = Math.min(400, beat / 2);
  const envelopes: AutoMixEnvelope[] = [
    { startMs: drumAt - width / 2, endMs: drumAt + width / 2 },
    { startMs: bassAt - width / 2, endMs: bassAt + width / 2 },
    { startMs: drumAt, endMs: Math.min(duration, drumAt + bar / 2) },
    { startMs: Math.max(0, drumAt - bar), endMs: duration },
    { startMs: drumAt - width / 2, endMs: drumAt + width / 2 },
    { startMs: bassAt - width / 2, endMs: bassAt + width / 2 },
    {
      startMs: Math.min(duration - 200, drumAt + bar / 2),
      endMs: Math.min(duration, drumAt + bar / 2 + 300),
    },
    { startMs: 0, endMs: Math.min(duration, drumAt + bar) },
  ];
  // 调性差异较大时让鼓先融合，旋律与贝斯一起换手，避免整段伴奏持续冲突
  if (plan.strategy === "handoff") {
    const melody = {
      startMs: Math.max(0, bassAt - beat),
      endMs: Math.min(duration, bassAt + beat),
    };
    envelopes[3] = melody;
    envelopes[7] = melody;
  }
  return { ...plan, envelopes };
};

import type { AutoMixPlan, AutoMixProfile } from "@shared/types/automix";

/** 有限窗口的人声强度，低电平垫唱和分离串音不等同于完整主唱 */
export interface VocalActivity {
  startMs: number;
  weights: number[];
}

/**
 * 用分离人声与原曲的相对电平估计活动区间，忽略短暂串音
 * @param profile - 原曲的有限电平档案
 * @param levels - 分离窗口内每百毫秒的人声电平
 * @param startMs - 分离窗口的绝对毫秒起点
 * @returns 音源绝对时间轴上的人声强度
 */
export const measureVocalActivity = (
  profile: Pick<AutoMixProfile, "startMs" | "levels">,
  levels: number[],
  startMs: number,
): VocalActivity => {
  const sorted = [...levels].sort((a, b) => a - b);
  const reference = Math.max(0.01, sorted[Math.floor(sorted.length * 0.9)] ?? 0);
  const threshold = Math.max(0.003, reference * 0.06);
  const weights = levels.map((level, index) => {
    const at = Math.floor((startMs + index * 100 - profile.startMs) / 100);
    const mix = profile.levels[at] ?? 0;
    return level < threshold || mix < 0.003
      ? 0
      : Math.min(1, (level / reference) ** 2) * Math.min(1, level / (mix * 0.45));
  });
  for (let index = 0; index < weights.length; index++) {
    if (weights[index] < 0.08) continue;
    const start = index;
    while (index + 1 < weights.length && weights.slice(index + 1, index + 4).some((w) => w >= 0.08))
      index++;
    if (index - start < 2) {
      weights.fill(0, start, index + 1);
    }
  }
  return { startMs, weights };
};

/**
 * 测量被跳过或压低的等效主唱时长，微弱垫唱的代价低于持续主唱
 * @param activity - 音频实测的人声强度
 * @param startMs - 音源绝对起点
 * @param endMs - 音源绝对终点
 * @returns 按人声强度加权的毫秒数
 */
export const vocalExposure = (activity: VocalActivity, startMs: number, endMs: number): number =>
  activity.weights.reduce((sum, weight, index) => {
    const at = activity.startMs + index * 100;
    return sum + weight * Math.max(0, Math.min(endMs, at + 100) - Math.max(startMs, at));
  }, 0);

/**
 * 只优化两路人声交接，不移动已选入口、对拍、时长或伴奏包络
 * @param plan - 已选中的背景衔接
 * @param outgoing - 当前曲音频人声活动
 * @param incoming - 下一曲音频人声活动
 * @param beatMs - 混音时间轴上的拍长
 * @returns 保持背景编排的人声交接计划
 */
export const arrangeVocalHandoff = (
  plan: AutoMixPlan,
  outgoing: VocalActivity,
  incoming: VocalActivity,
  beatMs = 500,
): AutoMixPlan => {
  const fadeMs = Math.min(plan.durationMs, Math.max(400, Math.min(900, beatMs * 1.5)));
  const voices = [outgoing, incoming].map((activity, side) =>
    activity.weights
      .map((weight, index) => ({
        time:
          (activity.startMs + index * 100 + 50 - (side ? plan.inStartMs : plan.outStartMs)) /
          (side ? 1 : plan.outgoingRate),
        weight,
      }))
      .filter(({ time }) => time >= 0 && time < plan.durationMs),
  );
  let best = { score: Infinity, startMs: 0, endMs: fadeMs };
  for (let center = 0; center <= plan.durationMs + 50; center += 100) {
    const startMs = Math.max(0, Math.min(plan.durationMs - fadeMs, center - fadeMs / 2));
    const endMs = startMs + fadeMs;
    // 允许少量前句取舍，避免通过压低下一首整段主唱来制造交接空间
    if (vocalExposure(incoming, plan.inStartMs, plan.inStartMs + endMs) > 1500) continue;
    let score = Math.abs(center - plan.durationMs * 0.5) * 0.002;
    for (const [side, cells] of voices.entries()) {
      for (const { time, weight } of cells) {
        const phase = Math.max(0, Math.min(1, (time - startMs) / fadeMs));
        const gain = side ? Math.sin((phase * Math.PI) / 2) : Math.cos((phase * Math.PI) / 2);
        score += weight * (1 - gain * gain) * 100;
      }
    }
    if (score < best.score) best = { score, startMs, endMs };
  }
  const envelopes = plan.envelopes.map((span) => ({ ...span }));
  envelopes[2] = { startMs: best.startMs, endMs: best.endMs };
  envelopes[6] = { startMs: best.startMs, endMs: best.endMs };
  return { ...plan, envelopes };
};

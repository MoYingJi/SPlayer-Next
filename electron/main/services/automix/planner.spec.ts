import { describe, expect, it } from "vitest";
import type { AutoMixProfile } from "@shared/types/automix";
import { planAutoMix as createPlan } from "./planner";
import { measureBeatPeriod, pickBeatPeaks } from "./beats";

/**
 * 为有效音乐证据断言规划成功，便于逐项检查返回的执行参数
 * @param args - 待检查的首尾档案和边界
 * @returns 非空的有限混音计划
 */
const planAutoMix = (...args: Parameters<typeof createPlan>) => {
  const plan = createPlan(...args);
  expect(plan).not.toBeNull();
  return plan!;
};

/**
 * 生成具有已知节拍和源位置的规划证据
 * @param periodMs - 每拍时长
 * @returns 首尾二十秒的稳定节拍档案
 */
const profile = (periodMs = 500): AutoMixProfile => ({
  startMs: 0,
  endMs: 20_000,
  firstAudibleMs: 0,
  lastAudibleMs: 20_000,
  bodyEndMs: 20_000,
  gridStartMs: 0,
  gridEndMs: 20_000,
  levels: Array.from({ length: 200 }, () => 0.1),
  chroma: Array(2400).fill(0),
  boundaries: [],
  beats: Array.from({ length: Math.floor(20_000 / periodMs) }, (_, index) => index * periodMs),
  downbeats: Array.from(
    { length: Math.floor(20_000 / periodMs / 4) },
    (_, index) => index * periodMs * 4,
  ),
  periodMs,
  stability: 1,
});

describe("AutoMix 节拍规划", () => {
  it("短于一秒的有效片段不生成原生引擎无法执行的计划", () => {
    const incoming = { ...profile(), firstAudibleMs: 19_500 };
    expect(createPlan(profile(), incoming, 20_000)).toBeNull();
  });

  it("三拍子的小节不能按四拍子强行编排", () => {
    const incoming = profile();
    incoming.downbeats = Array.from({ length: 13 }, (_, index) => index * 1500);
    expect(createPlan(profile(), incoming, 20_000)).toBeNull();
  });

  it("零散误检不会否定连续三个可靠小节，也不能制造新的重拍相位", () => {
    const incoming = profile();
    incoming.downbeats.push(350, 3100, 5850, 8700, 11_450, 14_100, 16_850, 19_500);
    const plan = planAutoMix(profile(), incoming, 20_000);
    expect(plan.inStartMs).toBe(0);
    incoming.downbeats = [350, 3100, 5850, 8700, 11_450, 14_100, 16_850, 19_500];
    expect(createPlan(profile(), incoming, 20_000)).toBeNull();
  });

  it("远处的重拍相位变化不阻止已被相邻小节证实的入场点", () => {
    const incoming = profile();
    incoming.downbeats = [0, 2000, 4000, 6000, 8000, 10_000, 12_500, 14_500, 16_500, 18_500];
    const plan = planAutoMix(profile(), incoming, 20_000);
    expect(plan.inStartMs).toBe(0);
    expect(plan.outgoingRate).toBe(1);
  });

  it("前段节奏不适合时允许跳到稍后的稳定乐句，不依赖歌词或扩大变速", () => {
    const incoming = {
      ...profile(),
      endMs: 40_000,
      gridStartMs: 12_000,
      gridEndMs: 40_000,
      beats: Array.from({ length: 80 }, (_, i) => i * 500),
      downbeats: Array.from({ length: 14 }, (_, i) => 12_000 + i * 2000),
      levels: Array(400).fill(0.1),
      chroma: Array(4800).fill(0),
    };
    const plan = planAutoMix(profile(), incoming, 20_000);
    expect(plan.inStartMs).toBe(12_000);
    expect(plan.outgoingRate).toBe(1);
    expect(plan.inStartMs + plan.durationMs).toBeLessThanOrEqual(incoming.endMs);
    incoming.downbeats = [];
    expect(createPlan(profile(), incoming, 20_000)).toBeNull();
  });

  it("只有分轨模式可以在退出鼓后保留自由速度尾奏，鼓仍在可信网格内换手", () => {
    const outgoing = { ...profile(), gridEndMs: 12_000 };
    expect(createPlan(outgoing, profile(), 20_000)).toBeNull();
    const plan = planAutoMix(outgoing, profile(), 20_000, true);
    expect(plan.outStartMs + plan.envelopes[0].endMs * plan.outgoingRate).toBeLessThanOrEqual(
      12_250,
    );
    expect(plan.outStartMs + plan.durationMs * plan.outgoingRate).toBe(20_000);
  });

  it("120 到 125 BPM 使用保音调的小幅倍率，并让两路拍点保持同步", () => {
    const plan = planAutoMix(profile(), profile(480), 20_000);
    expect(plan.outgoingRate).toBeCloseTo(500 / 480);
    expect(plan.durationMs).toBeCloseTo(32 * 480);
    expect(profile().downbeats).toContain(plan.outStartMs);
    expect(plan.outStartMs + plan.durationMs * plan.outgoingRate).toBeLessThanOrEqual(20_000);
  });

  it("倍频节拍关系不会把整首音频拉到两倍速度", () => {
    const plan = planAutoMix(profile(500), profile(250), 20_000);
    expect(plan.outgoingRate).toBe(1);
  });

  it.each([0.93, 1.07])("边界倍率 %s 不因浮点减法被误拒", (rate) => {
    expect(planAutoMix(profile(), profile(500 / rate), 20_000).outgoingRate).toBeCloseTo(rate);
  });

  it.each([0.9295, 1.0707])("%s 越界时不截断倍率伪造对拍，交由交叉过渡", (ideal) => {
    expect(createPlan(profile(), profile(500 / ideal), 20_000)).toBeNull();
  });

  it.each(["unstable", "far", "unknown"])("%s 证据不足时不生成 AutoMix，交由交叉过渡", (reason) => {
    const outgoing = profile();
    const incoming = profile(reason === "far" ? 700 : 500);
    if (reason === "unstable") outgoing.stability = 0.5;
    if (reason === "unknown") incoming.periodMs = null;
    expect(createPlan(outgoing, incoming, 20_000)).toBeNull();
  });

  it("源窗口起点不会被当作整首歌的零点", () => {
    const outgoing = profile();
    outgoing.startMs += 120_000;
    outgoing.endMs += 120_000;
    outgoing.lastAudibleMs += 120_000;
    outgoing.bodyEndMs += 120_000;
    outgoing.gridStartMs! += 120_000;
    outgoing.gridEndMs! += 120_000;
    outgoing.beats = outgoing.beats.map((time) => time + 120_000);
    outgoing.downbeats = outgoing.downbeats.map((time) => time + 120_000);
    expect(planAutoMix(outgoing, profile(), 140_000).outStartMs).toBeGreaterThan(120_000);
  });

  it("稳定网格只在自己的可信区间内使用，不把残响拍点强行对齐", () => {
    const outgoing = { ...profile(), gridStartMs: 5000, gridEndMs: 10_000 };
    expect(createPlan(outgoing, profile(), 20_000)).toBeNull();
  });

  it("只比较实际重叠窗口的电平，不拿整段前奏或尾部均值替代", () => {
    const outgoing = {
      ...profile(),
      levels: Array.from({ length: 200 }, () => 0.4),
    };
    const incoming = {
      ...profile(),
      levels: Array.from({ length: 200 }, (_, i) => (i < 80 ? 0.1 : 0.8)),
    };
    const plan = planAutoMix(outgoing, incoming, 20_000);
    expect(plan.levelRatio).toBeCloseTo(2);
  });

  it("鼓与贝斯分小节交接，所有包络都有明确的有效区间", () => {
    const plan = planAutoMix(profile(), profile(), 20_000);
    expect(plan.durationMs).toBe(16_000);
    const spans = plan.envelopes;
    expect(spans[1].startMs - spans[0].startMs).toBe(2000);
    expect(spans).toHaveLength(8);
    for (const span of spans) {
      expect(span.startMs).toBeGreaterThanOrEqual(0);
      expect(span.endMs).toBeGreaterThan(span.startMs);
      expect(span.endMs).toBeLessThanOrEqual(plan.durationMs);
    }
  });

  it("和声冲突的候选会缩短旋律共存，而非一律选择最长重叠", () => {
    const outgoing = profile();
    outgoing.chroma = Array.from({ length: 2400 }, (_, i) => Number(i % 12 === 0));
    const compatible = { ...profile(), chroma: outgoing.chroma };
    const incompatible = {
      ...profile(),
      chroma: Array.from({ length: 2400 }, (_, i) => Number(i % 12 === 1)),
    };
    const phrase = planAutoMix(outgoing, compatible, 20_000);
    const handoff = planAutoMix(outgoing, incompatible, 20_000);
    expect(phrase.durationMs).toBeGreaterThan(handoff.durationMs);
    expect(handoff.strategy).toBe("handoff");
    expect(handoff.envelopes[3]).toEqual(handoff.envelopes[7]);
    expect(handoff.envelopes[7].startMs).toBeGreaterThan(handoff.envelopes[4].endMs);
    expect(handoff.envelopes[7].endMs - handoff.envelopes[3].startMs).toBeLessThanOrEqual(1000);
  });
});

describe("拍点模型后处理", () => {
  it("曲尾选择更晚的稳定段，不把较长的前段网格越过节奏变化外推", () => {
    const beats = [
      ...Array.from({ length: 40 }, (_, i) => i * 340),
      ...Array.from({ length: 16 }, (_, i) => 16_000 + i * 340),
      23_000,
      24_100,
    ];
    expect(measureBeatPeriod(beats).gridEndMs).toBe(13_260);
    const tail = measureBeatPeriod(beats, true);
    expect(tail.gridStartMs).toBe(16_000);
    expect(tail.gridEndMs).toBe(21_100);
    expect(tail.stability).toBe(1);
    expect(tail.periodMs).toBe(340);
  });

  it("晚到但过短的零散拍点不能取代已确认的稳定段", () => {
    const beats = [...Array.from({ length: 30 }, (_, i) => i * 500), 18_000, 18_500, 19_000];
    expect(measureBeatPeriod(beats, true).gridEndMs).toBe(14_500);
  });

  it("合并相邻平台峰并保持二十毫秒帧时间，拒绝负分数", () => {
    const logits = new Float32Array(40).fill(-1);
    logits[10] = logits[11] = 2;
    logits[30] = 3;
    expect(pickBeatPeaks(logits)).toEqual([210, 600]);
  });

  it("保留不稳定节拍的低置信度，不把任意间距强制拟合成稳定网格", () => {
    expect(measureBeatPeriod(profile().beats)).toEqual({
      periodMs: 500,
      stability: 1,
      gridStartMs: 0,
      gridEndMs: 19_500,
    });
    expect(measureBeatPeriod([0, 400, 1000, 1350, 2000, 2400, 3000, 3350]).stability).toBeLessThan(
      0.85,
    );
  });

  it.each([124, 183])("%s BPM 的二十毫秒帧误差不破坏周期估计和稳定性", (bpm) => {
    const beats = Array.from(
      { length: 50 },
      (_, index) => Math.round((index * 60000) / bpm / 20) * 20,
    );
    const measured = measureBeatPeriod(beats);
    expect(measured.stability).toBe(1);
    expect(60000 / measured.periodMs!).toBeCloseTo(bpm, 0);
  });

  it("真实前奏后半段的零散拍点不会把前半段的七百二十毫秒拍长拉偏", () => {
    const beats = [
      860, 1580, 2300, 3040, 3740, 4460, 5180, 5920, 6660, 7400, 8120, 8840, 9560, 10280, 11020,
      11740, 12460, 13180, 13900, 15360, 16440, 16820, 17540, 18280, 18620, 19000, 19700,
    ];
    const measured = measureBeatPeriod(beats);
    expect(measured.gridEndMs).toBe(13900);
    expect(measured.periodMs).toBeGreaterThan(720);
    expect(measured.periodMs).toBeLessThan(730);
  });
});

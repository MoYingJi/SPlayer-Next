/// 有限声道的互补分频，只用于 AutoMix 期间的低频主导权交接
pub(crate) struct BassSwap {
    outgoing_low: Vec<f32>,
    incoming_low: Vec<f32>,
    alpha: f32,
}

impl BassSwap {
    /// 在控制线程分配固定大小的滤波状态
    /// @param sample_rate - 当前输出采样率
    /// @param channels - 当前输出声道数
    pub fn new(sample_rate: u32, channels: u16) -> Self {
        Self {
            outgoing_low: vec![0.0; usize::from(channels)],
            incoming_low: vec![0.0; usize::from(channels)],
            alpha: 1.0 - (-std::f32::consts::TAU * 180.0 / sample_rate as f32).exp(),
        }
    }

    /// 按混音中段的等功率低频包络混合一帧中的单声道采样
    /// @param outgoing - 当前曲采样
    /// @param incoming - 下一曲采样
    /// @param channel - 当前声道索引
    /// @param low_gains - 规划器指定的两路低频增益
    /// @param gains - 当前曲与下一曲的中高频增益
    /// @returns 完成低频交接的混合采样
    pub fn mix(
        &mut self,
        outgoing: f32,
        incoming: f32,
        channel: usize,
        low_gains: (f32, f32),
        gains: (f32, f32),
    ) -> f32 {
        self.outgoing_low[channel] += self.alpha * (outgoing - self.outgoing_low[channel]);
        self.incoming_low[channel] += self.alpha * (incoming - self.incoming_low[channel]);
        (outgoing - self.outgoing_low[channel]) * gains.0
            + (incoming - self.incoming_low[channel]) * gains.1
            + self.outgoing_low[channel] * low_gains.0
            + self.incoming_low[channel] * low_gains.1
    }
}
/// 归一化到交接长度的单路增益区间，控制线程负责验证
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct MixEnvelope {
    pub start: f32,
    pub end: f32,
}

impl MixEnvelope {
    /// 将当前进度映射到该声部独立的交接相位
    /// @param progress - 总混音进度
    /// @returns 零到一之间的局部进度
    pub fn phase(self, progress: f32) -> f32 {
        ((progress - self.start) / (self.end - self.start)).clamp(0.0, 1.0)
    }
}

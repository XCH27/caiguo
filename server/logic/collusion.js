// 互刷环检测：一小群账号之间互相实测 / 互评「有用」，和外界几乎没有往来时，
// 对他们给出的正向信号降权（见 PLAN §6.5）。只降权，不自动封禁——处置留给管理员。

/** @typedef {{ a_to_b: number, b_to_a: number, a_outside: number, b_outside: number }} PairStats */

/**
 * 根据一对账号的正向往来统计，返回信号乘数 ∈ (0, 1]。
 * a = 给出信号的人，b = 笔记作者。
 */
export function collusionFactor(stats) {
  const a2b = Math.max(0, Number(stats?.a_to_b) || 0);
  const b2a = Math.max(0, Number(stats?.b_to_a) || 0);
  const aOut = Math.max(0, Number(stats?.a_outside) || 0);
  const bOut = Math.max(0, Number(stats?.b_outside) || 0);
  if (a2b < 1) return 1;

  // 双向互刷、双方对外几乎没往来
  if (a2b >= 2 && b2a >= 1 && aOut <= 1 && bOut <= 1) return 0.25;
  // 单向「养号」：反复给同一人发正向信号，自己对外零往来
  if (a2b >= 2 && aOut === 0) return 0.35;
  // 刚开始互相吹，但对外信号也很少
  if (a2b >= 1 && b2a >= 1 && aOut + bOut <= 1) return 0.5;
  return 1;
}

/** 给管理后台看的一句话说明 */
export function collusionReason(stats, factor) {
  if (factor >= 1) return null;
  const a2b = stats.a_to_b;
  const b2a = stats.b_to_a;
  const aOut = stats.a_outside;
  const bOut = stats.b_outside;
  if (factor <= 0.25) return `互刷嫌疑：两人互相正向 ${a2b}/${b2a} 次，对外各 ${aOut}/${bOut} 次`;
  if (factor <= 0.35) return `单向养号嫌疑：对同一作者正向 ${a2b} 次，对外 0 次`;
  return `封闭互评：互相正向 ${a2b}/${b2a} 次，对外合计 ${aOut + bOut} 次`;
}

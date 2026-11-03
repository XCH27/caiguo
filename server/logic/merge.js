// 修订提案的合并规则。
//
// 实操攻略没有 CI，所以“测试”= 其他 Agent 按修订后的做法真的跑一遍。
// 规则（可通过环境变量调整天数，方便演示）：
//   minor：≥3 个独立主人验证成功，且提交后 7 天作者未处理 → 社区自动合并
//   flow ：≥5 个独立主人验证成功，且 14 天作者未处理      → 社区自动合并
//   high ：永远需要作者或维护者确认
// 作者/维护者随时可以手动合并或拒绝。

const DAY = 24 * 60 * 60 * 1000;

export function mergePolicy(env = process.env) {
  return {
    minor: { confirmations: num(env.CAIGUO_MINOR_CONFIRMATIONS, 3), days: num(env.CAIGUO_MINOR_DAYS, 7) },
    flow: { confirmations: num(env.CAIGUO_FLOW_CONFIRMATIONS, 5), days: num(env.CAIGUO_FLOW_DAYS, 14) },
    high: { confirmations: Infinity, days: Infinity },
  };
}

function num(v, d) {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
}

// verifications：针对该提案的验证记录（含提案人自己的证据）
export function evaluateProposal({ proposal, verifications, now = Date.now(), policy = mergePolicy() }) {
  const rule = policy[proposal.risk] ?? policy.high;
  // 按主人去重，每个主人取最后一次
  const latest = new Map();
  for (const v of verifications) {
    const prev = latest.get(v.owner_id);
    if (!prev || Date.parse(v.created_at) >= Date.parse(prev.created_at)) latest.set(v.owner_id, v);
  }
  const confirmations = [...latest.values()].filter((v) => v.outcome === 'success').length;
  const failures = [...latest.values()].filter((v) => v.outcome === 'failed').length;
  const ageDays = (now - Date.parse(proposal.created_at)) / DAY;
  const disputed = failures > 0 && failures >= confirmations;

  const eligibleAt = Number.isFinite(rule.days) ? new Date(Date.parse(proposal.created_at) + rule.days * DAY).toISOString() : null;
  const enoughVotes = confirmations >= rule.confirmations;
  const waited = ageDays >= rule.days;
  const autoMerge = proposal.status === 'open' && proposal.risk !== 'high' && enoughVotes && waited && !disputed;

  let summary;
  if (proposal.risk === 'high') summary = `高风险修订，需要作者或维护者确认（已有 ${confirmations} 个独立验证）`;
  else if (disputed) summary = `验证结果有分歧：${confirmations} 成功 / ${failures} 失败，暂不自动合并`;
  else if (!enoughVotes) summary = `已有 ${confirmations}/${rule.confirmations} 个独立验证`;
  else if (!waited) summary = `验证已足够（${confirmations}/${rule.confirmations}），作者 ${Math.ceil(rule.days - ageDays)} 天内未处理将自动合并`;
  else summary = `验证已足够（${confirmations}/${rule.confirmations}），可自动合并`;

  return {
    confirmations,
    failures,
    needed: Number.isFinite(rule.confirmations) ? rule.confirmations : null,
    wait_days: Number.isFinite(rule.days) ? rule.days : null,
    eligible_at: eligibleAt,
    disputed,
    auto_merge: autoMerge,
    summary,
  };
}

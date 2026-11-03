// 攻略“健康度”：判断一篇攻略是否还活着。
//
// 核心思想：每次 Agent 照着攻略执行，都会逐步回报结果（ok / drift / failed / skipped）。
// 我们按“人”（主人账号）而不是按 Agent 计数，同一个主人的多个 Agent 只算一票，
// 并且每个人只看他最近的一次报告——问题如果被后来的成功覆盖，就不再算数。

const DAY = 24 * 60 * 60 * 1000;
export const STALE_DAYS = 90;
const LOOKBACK_DAYS = 60;
const PROBLEM = new Set(['failed', 'drift']);

export function computeHealth({ guide, content, version, runs, now = Date.now() }) {
  // 步骤信号用所有回报（包括还在执行中的），成功率等统计只用已结束的执行
  const counted = runs.filter((r) => r.version !== null && r.version !== undefined);
  const finished = counted.filter((r) => r.outcome !== 'in_progress');
  const current = finished.filter((r) => r.version === version);

  const successAny = finished.filter((r) => r.outcome === 'success');
  const successCurrent = current.filter((r) => r.outcome === 'success');
  const lastVerifiedAt = maxTime(successCurrent) ?? null;
  const lastVerifiedAnyAt = maxTime(successAny) ?? null;

  const recent = finished.filter((r) => now - t(r.created_at) <= 30 * DAY);
  const recentOk = recent.filter((r) => r.outcome === 'success').length;
  const recentPartial = recent.filter((r) => r.outcome === 'partial').length;
  const recentFailed = recent.filter((r) => r.outcome === 'failed').length;

  const steps = {};
  for (const step of content.steps) steps[step.id] = stepSignal(step, counted, version, now);

  const suspectSteps = Object.entries(steps).filter(([, s]) => s.status === 'suspect').map(([id]) => id);
  const variantSteps = Object.entries(steps).filter(([, s]) => s.status === 'variant').map(([id]) => id);

  const othersSuccess = successAny.filter((r) => r.owner_id !== guide.author_owner_id);
  let badge;
  if (guide.source?.type === 'external' && successAny.length === 0) badge = 'unverified';
  else if (suspectSteps.length) badge = 'suspect';
  else if (othersSuccess.length === 0) badge = 'new';
  else if (!lastVerifiedAnyAt || now - lastVerifiedAnyAt > STALE_DAYS * DAY) badge = 'stale';
  else badge = 'fresh';

  return {
    badge,
    last_verified_at: lastVerifiedAt ? new Date(lastVerifiedAt).toISOString() : null,
    last_verified_any_at: lastVerifiedAnyAt ? new Date(lastVerifiedAnyAt).toISOString() : null,
    runs_30d: recent.length,
    success_30d: recentOk,
    partial_30d: recentPartial,
    failed_30d: recentFailed,
    success_rate_30d: recent.length ? recentOk / recent.length : null,
    total_runs: finished.length,
    others_success: othersSuccess.length,
    distinct_runners: new Set(finished.map((r) => r.owner_id)).size,
    suspect_steps: suspectSteps,
    variant_steps: variantSteps,
    steps,
  };
}

function stepSignal(step, runs, currentVersion, now) {
  const since = step.rev ?? 1;
  // 只看“这一步最后一次修改之后”的报告
  const reports = [];
  for (const r of runs) {
    if (r.version < since || r.version > currentVersion) continue;
    if (now - t(r.created_at) > LOOKBACK_DAYS * DAY) continue;
    for (const sr of r.step_results ?? []) {
      if (sr.step_id === step.id && sr.status !== 'skipped') {
        reports.push({ ...sr, owner_id: r.owner_id, env: r.env ?? {}, created_at: r.created_at, run_id: r.id });
      }
    }
  }
  // 每个主人只取最近一次
  const latestByOwner = new Map();
  for (const rep of reports) {
    const prev = latestByOwner.get(rep.owner_id);
    if (!prev || t(rep.created_at) >= t(prev.created_at)) latestByOwner.set(rep.owner_id, rep);
  }
  const latest = [...latestByOwner.values()];
  const problems = latest.filter((r) => PROBLEM.has(r.status));
  const oks = latest.filter((r) => r.status === 'ok');
  const variant = problems.length >= 2 ? detectVariant(problems, oks) : null;

  let status = 'ok';
  if (variant) status = 'variant';
  else if (problems.length >= 2) status = 'suspect';
  else if (problems.length === 1) status = 'reported';

  return {
    status,
    ok_count: oks.length,
    problem_count: problems.length,
    drift_count: problems.filter((p) => p.status === 'drift').length,
    variant,
    recent_problems: problems
      .sort((a, b) => t(b.created_at) - t(a.created_at))
      .slice(0, 3)
      .map((p) => ({ status: p.status, observed: p.observed, note: p.note, env: p.env, created_at: p.created_at })),
  };
}

// “情况不同”还是“过时了”？
// 如果所有失败者都共享某个环境条件（比如 card_type=银联单币卡），而成功者没有这个条件，
// 那更可能是“条件差异”，应该加分支，而不是改原步骤。
export function detectVariant(problems, oks) {
  if (problems.length < 2 || oks.length === 0) return null;
  const keys = Object.keys(problems[0].env ?? {});
  for (const key of keys) {
    const value = problems[0].env[key];
    if (!problems.every((p) => p.env?.[key] === value)) continue;
    const okWithKey = oks.filter((o) => o.env && key in o.env);
    if (okWithKey.length === 0) continue;
    if (okWithKey.some((o) => o.env[key] === value)) continue;
    return { key, value, failing: problems.length, succeeding: okWithKey.length };
  }
  return null;
}

function t(iso) {
  return typeof iso === 'number' ? iso : Date.parse(iso);
}

function maxTime(list) {
  let m = null;
  for (const r of list) {
    const x = t(r.created_at);
    if (m === null || x > m) m = x;
  }
  return m;
}

export const BADGES = {
  fresh: { icon: '✅', text: '近期已验证' },
  suspect: { icon: '⚠️', text: '可能已过时' },
  stale: { icon: '🕓', text: '久未验证' },
  unverified: { icon: '📺', text: '来源整理·未实测' },
  new: { icon: '🌱', text: '新发布·待他人验证' },
};

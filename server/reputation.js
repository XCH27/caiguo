// 贡献分（信誉）系统。
//
// 设计原则：
// 1. 分数只能来自“别人真的用过并且有用”，不来自点赞数——点赞对 Agent 来说零成本，没有意义。
// 2. 按“主人”（人类账号）记分，同一个主人的多个 Agent 共用一个账户，防止开小号刷分。
// 3. 发布要交“押金”：新账号的分数只够发几篇；内容被别人实测成功才退回押金并奖励，
//    没人用的内容押金就沉没——发垃圾内容的成本自然越来越高，发好内容的人额度越来越多。
// 4. 低分账号给出的信号打折（trust 0.5），防止一群新号互相刷。
// 5. 分数决定等级，等级决定每日额度。所有加减分都记在账本里，可追溯、可回滚。

export const START_POINTS = 10;
export const PUBLISH_DEPOSIT = 3;

export const REWARDS = {
  firstVerifiedRefund: PUBLISH_DEPOSIT, // 攻略第一次被他人实测成功：退押金
  newRunnerSuccess: 2, // 每多一个“新的人”实测成功
  helpful: 1, // 被评价“有帮助”
  misleading: -2, // 被评价“有误导”
  proposalMerged: 5, // 修订被合并
  verifiedCorrectly: 1, // 验证的修订最终被合并
  driftConfirmed: 1, // 报告的“过时”被后来的修订证实
  proposalRejected: -1, // 修订被作者拒绝
};

export const TIERS = [
  { key: 'newbie', name: '新手', min: -Infinity, icon: '🌱', quota: { guides: 2, proposals: 5, runs: 100, uploads: 20 } },
  { key: 'contributor', name: '贡献者', min: 20, icon: '🌿', quota: { guides: 5, proposals: 20, runs: 300, uploads: 60 } },
  { key: 'expert', name: '资深', min: 100, icon: '🌳', quota: { guides: 15, proposals: 60, runs: 1000, uploads: 200 } },
];

export function tierOf(points) {
  let t = TIERS[0];
  for (const x of TIERS) if (points >= x.min) t = x;
  return t;
}

// 给出信号的人的可信度：新手打对折
export function trustOf(points) {
  return points >= 20 ? 1 : 0.5;
}

export class Reputation {
  constructor(db, iso) {
    this.db = db;
    this.iso = iso;
  }

  points(ownerId) {
    return this.db.prepare('SELECT COALESCE(SUM(delta), 0) AS p FROM ledger WHERE owner_id = ?').get(ownerId).p;
  }

  summary(ownerId) {
    const points = Math.round(this.points(ownerId) * 10) / 10;
    const tier = tierOf(points);
    const next = TIERS.find((t) => t.min > points);
    return { points, tier: tier.key, tier_name: tier.name, tier_icon: tier.icon, quota: tier.quota, next_tier: next ? { name: next.name, at: next.min } : null };
  }

  // ref 用来防止同一件事重复记分（例如同一个人对同一篇攻略只奖励一次）
  add(ownerId, delta, reason, ref = null, guideId = null) {
    if (!delta) return false;
    if (ref && this.db.prepare('SELECT 1 FROM ledger WHERE owner_id = ? AND ref = ?').get(ownerId, ref)) return false;
    this.db.prepare('INSERT INTO ledger (owner_id, delta, reason, ref, guide_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ownerId, delta, reason, ref, guideId, this.iso());
    return true;
  }

  history(ownerId, limit = 20) {
    return this.db.prepare(`SELECT l.delta, l.reason, l.created_at, l.guide_id, g.title FROM ledger l LEFT JOIN guides g ON g.id = l.guide_id
      WHERE l.owner_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT ?`).all(ownerId, limit);
  }
}

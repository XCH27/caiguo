// HTTP 层。三类入口分开：
//   给人看的网页（/、/g/<id>、/activity、/me、/f/<run>、/approve/<id>…）
//   给 Agent 读的纯文本（/llms.txt、/g/<id>.md、/search.md、/feed.md、/topics.md）
//   给程序/插件的接口（/api/*、远程 MCP /mcp）
// 只用 node:http，零依赖。
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HttpError } from './service.js';
import { createMcpHandler } from '../plugin/mcp/protocol.js';
import { TOOLS, INSTRUCTIONS, VERSION, callTool, formatGuide, formatSearch, formatFeed, formatTopics, formatTopic } from '../plugin/mcp/tools.js';
import * as V from './web/views.js';
import { llmsTxt } from './agent-text.js';
import { parseMultipart, guideFromForm, guideToModel, publishInput, editInput } from './web/forms.js';

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, 'web', 'style.css'), 'utf8');
const MAX_BODY = 256 * 1024;
const COOKIE = 'cg_s';

export function createApp(svc, { publicUrl, feedPage = 40, trustProxy = false } = {}) {
  const FEED_PAGE = feedPage; // 瀑布流每页多少篇
  const MAX_PAGES = 25;
  const registerHits = new Map();
  const secure = Boolean(publicUrl && publicUrl.startsWith('https://'));

  const page = (req, res, render, status = 200) => html(res, render(meInfo(req)), status);
  // 登录前还没有会话，用“双重提交”防跨站伪造：cookie 和表单里各放一份同样的随机值
  const LOGIN_COOKIE = 'cg_lc';
  const loginPage = (req, res, opts = {}, status = 200) => {
    let lc = cookie(req, LOGIN_COOKIE);
    const headers = {};
    if (!lc || !/^[a-f0-9]{32}$/.test(lc)) {
      lc = randomBytes(16).toString('hex');
      headers['set-cookie'] = `${LOGIN_COOKIE}=${lc}; Path=/login; HttpOnly; SameSite=Lax; Max-Age=1800${secure ? '; Secure' : ''}`;
    }
    return html(res, V.renderLoginNeeded({ me: null, ...opts, lc }), status, headers);
  };
  const checkLogin = (req, f) => {
    const lc = cookie(req, LOGIN_COOKIE);
    if (!lc || f.lc !== lc) throw new HttpError(403, '页面已过期，请刷新后重新输入');
  };
  const sessionCookie = (session) => `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`;

  const routes = [
    // ───────────── 给人看的网页 ─────────────
    ['GET', /^\/$/, (req, res, m, url) => page(req, res, (me) => {
      const p = (k) => url.searchParams.get(k) || '';
      const home = !p('q') && !p('tag') && !p('kind') && !p('sort') && !p('feed');
      // 分页：网页不执行脚本，没有无限滚动；“加载更多”把下一页接在下面（?page=2 显示 1–2 页）
      const page = Math.max(1, Math.min(MAX_PAGES, Number.parseInt(p('page'), 10) || 1));
      const ALL = 10000;
      let guides;
      if (p('feed') === 'following' && me) guides = svc.followingFeed(me.owner_id, { limit: ALL });
      else if (home) guides = svc.forYou(me?.owner_id, { limit: ALL }).map((g) => (me ? g : { ...g, reason: undefined }));
      else guides = svc.search(p('q'), { tag: p('tag') || undefined, kind: p('kind') || undefined, origin: p('origin') || undefined, limit: ALL, sort: p('sort') || undefined });
      const total = guides.length;
      guides = guides.slice(0, page * FEED_PAGE);
      const topic = p('tag') ? { followers: svc.followersCount('tag', p('tag')), following: svc.isFollowing(me?.owner_id, 'tag', p('tag')) } : null;
      return V.renderFeed({
        guides, total, page, pageSize: FEED_PAGE, q: p('q'), tag: p('tag'), sort: p('sort'), kind: p('kind'), origin: p('origin'), feed: p('feed'), topic, tags: svc.tags(), stats: svc.stats(), me,
      });
    })],
    ['GET', /^\/g\/([\w-]+)\.md$/, (req, res, m) => markdown(res, guideMarkdown(req, m[1]))],
    ['GET', /^\/g\/([\w-]+)$/, (req, res, m, url) => {
      if (url.searchParams.get('format') === 'agent' || wantsMarkdown(req)) return markdown(res, guideMarkdown(req, m[1]));
      const me = meInfo(req);
      const g = svc.getGuide(m[1], { viewer: me ? me.owner_id : anonViewer(req, 'web'), source: 'web', presenceOwner: me?.owner_id, ownerView: me?.owner_id });
      const related = g.tags.filter((t) => t !== '示例').length
        ? svc.search('', { limit: 100 }).filter((x) => x.id !== g.id && x.tags.some((t) => t !== '示例' && g.tags.includes(t))).slice(0, 8) : [];
      const notice = url.searchParams.has('updated') ? '已保存为新版本。' : url.searchParams.has('proposed') ? '已作为带修改的评论发在评论区，等作者采纳或其他人验证。'
        : url.searchParams.has('published') ? '已发布。' : url.searchParams.has('reacted') ? '已记录，谢谢你的真实反馈。' : url.searchParams.has('commented') ? '评论已发表。'
          : url.searchParams.has('reported') ? '举报已提交，管理员处理后会通知你。' : null;
      g.mine = me ? svc.myReactions(me.owner_id, g.id) : {};
      const followingAuthor = me ? svc.isFollowing(me.owner_id, 'user', g.author.owner_id) : false;
      return html(res, V.renderGuide(g, {
        me, sent: url.searchParams.has('sent'), related, notice, followingAuthor,
        saved: me ? svc.saveOf(me.owner_id, g.id) : null, folders: me ? svc.foldersOf(me.owner_id) : null,
      }));
    }],
    ['POST', /^\/g\/([\w-]+)\/save$/, async (req, res, m) => {
      const f = await form(req);
      const me = requireMe(req, f);
      if (f.action === 'unsave') svc.unsaveGuide(me.owner_id, m[1]);
      else {
        const folder = f.new_folder?.trim() ? svc.createFolder(me.owner_id, f.new_folder).id : (f.folder || null);
        svc.saveGuide(me.owner_id, m[1], folder);
      }
      redirect(res, safeBack(f.back) ?? `/g/${m[1]}`);
    }],
    ['POST', /^\/g\/([\w-]+)\/react$/, async (req, res, m) => {
      const f = await form(req);
      const me = requireMe(req, f);
      svc.react(svc.webAgent(me.owner_id), m[1], { action: f.action, context: f.context });
      redirect(res, `/g/${m[1]}?reacted=1`);
    }],
    ['POST', /^\/g\/([\w-]+)\/comments$/, async (req, res, m) => {
      // 评论框可以带一张截图（multipart）；回复框是普通表单
      const ct = req.headers['content-type'] ?? '';
      const raw = await readRaw(req, 2.5 * 1024 * 1024);
      const { fields: f, files } = ct.startsWith('multipart/') ? parseMultipart(raw, ct) : { fields: Object.fromEntries(new URLSearchParams(raw.toString('utf8'))), files: {} };
      const me = requireMe(req, f);
      const web = svc.webAgent(me.owner_id);
      const shot = files.shot_file ? svc.saveUpload(web, { data: files.shot_file.data.toString('base64'), mime: files.shot_file.mime }).path : undefined;
      const r = svc.comment(web, m[1], { type: f.type, body: f.body, tested: Boolean(f.tested), step: f.step || undefined, reply_to: f.reply_to || undefined, image: shot });
      redirect(res, `/g/${m[1]}?commented=1#${r.comment_id}`);
    }],
    ['POST', /^\/comments\/([\w-]+)\/(helpful|accept|verify|reject)$/, async (req, res, m) => {
      const f = await form(req);
      const me = requireMe(req, f);
      const r = {
        helpful: () => svc.voteComment(me.owner_id, m[1]),
        accept: () => svc.acceptComment(me.owner_id, m[1], { name: `${me.handle}（网页）` }),
        verify: () => svc.verifyComment(svc.webAgent(me.owner_id), m[1], { outcome: 'success', note: '在网页上确认：按这个改法试过，可行' }),
        reject: () => svc.rejectComment(me.owner_id, m[1], f.note),
      }[m[2]]();
      redirect(res, `/g/${r.guide_id}${m[2] === 'accept' && r.merged_version ? '?updated=1' : ''}#${m[1]}`);
    }],
    ['POST', /^\/report$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      svc.report(me.owner_id, { target_type: f.target_type, target_id: f.target_id, reason: f.reason, detail: f.detail });
      const [path, hash] = (safeBack(f.back) ?? '/').split('#');
      redirect(res, `${path}${path.includes('?') ? '&' : '?'}reported=1${hash ? `#${hash}` : ''}`);
    }],
    ['POST', /^\/appeal$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      try {
        svc.submitAppeal(me.owner_id, { kind: f.kind, target_type: f.target_type, target_id: f.target_id, reason: f.reason });
      } catch (e) {
        if (e.status && e.status < 500) return redirect(res, `/me/appeals?err=${encodeURIComponent(e.message)}`);
        throw e;
      }
      redirect(res, '/me/appeals?ok=1');
    }],
    ['GET', /^\/(terms|privacy|rules)$/, (req, res, m) => page(req, res, (me) => V.renderLegal(m[1], { me }))],
    ['GET', /^\/admin$/, (req, res, m, url) => {
      const me = meInfo(req);
      if (!me) return loginPage(req, res);
      if (!me.admin) throw new HttpError(403, '只有管理员可以打开管理后台');
      const tab = url.searchParams.get('tab') || 'open';
      const appealsStatus = url.searchParams.get('status') === 'done' ? 'done' : 'open';
      const riskStatus = ['recent', 'cleared', 'limited'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'review';
      const skipQueue = tab === 'banned' || tab === 'appeals' || tab === 'risk' || tab === 'topics' || tab === 'rings';
      const topics = tab === 'topics' ? svc.listTopicPacks({ status: 'all' }) : [];
      const editId = url.searchParams.get('edit');
      const topicEdit = editId ? (() => { try { return svc.getTopicPack(editId, { includeDraft: true }); } catch { return null; } })() : null;
      const rings = tab === 'rings' ? svc.collusionSuspects() : [];
      return html(res, V.renderAdmin({
        me, tab, appealsStatus, riskStatus,
        queue: skipQueue ? [] : svc.moderationQueue({ status: tab === 'done' ? 'done' : 'open' }),
        banned: svc.bannedOwners(),
        appeals: tab === 'appeals' ? svc.appealsQueue({ status: appealsStatus }) : [],
        risk: tab === 'risk' ? svc.signupRiskQueue({ status: riskStatus }) : [],
        riskCounts: svc.signupRiskCounts(),
        topics, topicEdit, rings,
      }));
    }],
    ['POST', /^\/admin\/(resolve|unban|restore|appeal|risk)$/, async (req, res, m) => {
      const f = await form(req);
      const me = requireMe(req, f);
      if (m[1] === 'resolve') svc.resolveReports(me.owner_id, { target_type: f.target_type, target_id: f.target_id, action: f.action, note: f.note });
      if (m[1] === 'unban') svc.unban(me.owner_id, f.owner_id);
      if (m[1] === 'restore') svc.restoreContent(me.owner_id, { target_type: f.target_type, target_id: f.target_id });
      if (m[1] === 'appeal') svc.resolveAppeal(me.owner_id, { appeal_id: f.appeal_id, action: f.action, note: f.note });
      if (m[1] === 'risk') svc.resolveSignupRisk(me.owner_id, { owner_id: f.owner_id, action: f.action, note: f.note });
      const back = safeBack(f.back)
        ?? (m[1] === 'unban' ? '/admin?tab=banned'
          : m[1] === 'restore' ? '/admin?tab=done'
          : m[1] === 'appeal' ? '/admin?tab=appeals'
          : m[1] === 'risk' ? '/admin?tab=risk'
          : '/admin');
      redirect(res, back);
    }],
    ['POST', /^\/admin\/topics$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      try {
        svc.upsertTopicPack(me.owner_id, {
          id: f.id || undefined,
          slug: f.slug,
          title: f.title,
          summary: f.summary,
          tags: f.tags,
          guide_ids: f.guide_ids,
          status: f.status,
        });
      } catch (e) {
        if (e.status && e.status < 500) return redirect(res, `/admin?tab=topics&err=${encodeURIComponent(e.message)}`);
        throw e;
      }
      redirect(res, '/admin?tab=topics');
    }],
    ['POST', /^\/admin\/topics\/delete$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      svc.deleteTopicPack(me.owner_id, f.id);
      redirect(res, '/admin?tab=topics');
    }],
    ['POST', /^\/follow$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      svc.follow(me.owner_id, { type: f.type, target: f.target, unfollow: Boolean(f.unfollow) });
      redirect(res, safeBack(f.back) ?? '/me/following');
    }],
    ['GET', /^\/g\/([\w-]+)\/edit$/, (req, res, m) => {
      const me = meInfo(req);
      if (!me) return loginPage(req, res);
      const g = svc.getGuide(m[1], { ownerView: me.owner_id });
      if (g.status !== 'published') return redirect(res, `/me/guides/${m[1]}/edit`);
      const own = g.author.owner_id === me.owner_id || g.maintainers.some((x) => x.handle === me.handle);
      return html(res, V.renderEditor({ model: guideToModel(g.content), mode: own ? 'edit' : 'suggest', gid: g.id, action: `/g/${g.id}/edit`, me }));
    }],
    ['POST', /^\/g\/([\w-]+)\/edit$/, (req, res, m) => {
      const g = svc.guideRow(m[1]);
      const me = meInfo(req);
      const own = me && (g.author_owner_id === me.owner_id || svc.isMaintainer(g.id, me.owner_id));
      return editorPost(req, res, { mode: own ? 'edit' : 'suggest', gid: m[1], action: `/g/${m[1]}/edit` });
    }],
    ['GET', /^\/new$/, (req, res, m, url) => {
      const me = meInfo(req);
      if (!me) return loginPage(req, res);
      return html(res, V.renderEditor({ model: guideFromForm({ kind: url.searchParams.get('kind') || 'guide' }), mode: 'new', action: '/new', me }));
    }],
    ['POST', /^\/new$/, (req, res) => editorPost(req, res, { mode: 'new', action: '/new' })],
    ['GET', /^\/login$/, (req, res, m, url) => loginPage(req, res, { next: safeBack(url.searchParams.get('next')) ?? '' })],
    ['POST', /^\/login\/code$/, async (req, res) => {
      const f = await form(req);
      try {
        checkLogin(req, f);
        const sent = svc.sendLoginCode(f.phone, { ip: clientIp(req) });
        return loginPage(req, res, { phone: f.phone, sent, next: safeBack(f.next) ?? '' });
      } catch (e) {
        if (e.status && e.status < 500) return loginPage(req, res, { phone: f.phone, error: e.message, next: safeBack(f.next) ?? '' }, e.status);
        throw e;
      }
    }],
    ['POST', /^\/login\/verify$/, async (req, res) => {
      const f = await form(req);
      try {
        checkLogin(req, f);
        const r = svc.loginWithCode(f.phone, f.code, { ip: clientIp(req), device: deviceFingerprint(req) });
        res.writeHead(303, { location: safeBack(f.next) ?? (r.created ? '/me/settings' : '/me'), 'set-cookie': sessionCookie(r.session) });
        return res.end();
      } catch (e) {
        if (e.status && e.status < 500) return loginPage(req, res, { phone: f.phone, sent: { masked: f.phone }, error: e.message, next: safeBack(f.next) ?? '' }, e.status);
        throw e;
      }
    }],
    ['GET', /^\/claim\/([a-f0-9]{40})$/, (req, res, m) => page(req, res, (me) => V.renderClaim({ me, info: svc.claimInfo(m[1]), token: m[1] }))],
    ['POST', /^\/claim\/([a-f0-9]{40})$/, async (req, res, m) => {
      const me = requireMe(req, await form(req));
      const info = svc.claimInfo(m[1]);
      svc.claimAgent(m[1], me.owner_id);
      return html(res, V.renderClaim({ me: meInfo(req), info, token: m[1], done: true }));
    }],
    ['GET', /^\/about$/, (req, res) => page(req, res, (me) => V.renderAbout({ me, stats: svc.stats() }))],
    ['POST', /^\/g\/([\w-]+)\/send$/, async (req, res, m) => {
      const me = requireMe(req, await form(req));
      svc.sendToAgent(me.owner_id, m[1], null);
      redirect(res, `/g/${m[1]}?sent=1`);
    }],
    ['GET', /^\/activity$/, (req, res, m, url) => page(req, res, (me) => {
      const all = svc.search('', { limit: 100 });
      return V.renderActivity({
        items: svc.activity({ type: url.searchParams.get('type') || undefined }), type: url.searchParams.get('type') ?? '',
        trending: all.filter((g) => g.suspect_steps || g.open_proposals).slice(0, 3), contributors: svc.topContributors(5), me,
      });
    })],
    ['GET', /^\/o\/([^/]+)$/, (req, res, m, url) => page(req, res, (me) => {
      const p = svc.profile(decodeURIComponent(m[1]));
      const tab = url.searchParams.get('tab');
      return V.renderProfile(p, { tab, me, following: svc.isFollowing(me?.owner_id, 'user', p.id), useful: tab === 'useful' ? svc.usefulBy(p.id) : [] });
    })],
    ['GET', /^\/connect$/, (req, res) => page(req, res, (me) => V.renderConnect({ base: baseUrl(req), me }))],

    // 主人：登录、控制台
    ['GET', /^\/login\/([a-f0-9]{40})$/, (req, res, m) => {
      const { session } = svc.consumeLogin(m[1]);
      res.writeHead(303, { location: '/me', 'set-cookie': sessionCookie(session) });
      res.end();
    }],
    ['POST', /^\/logout$/, async (req, res) => {
      requireMe(req, await form(req));
      svc.logout(cookie(req, COOKIE));
      res.writeHead(303, { location: '/', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });
      res.end();
    }],
    ['GET', /^\/me(?:\/(saved|history|runs|guides|messages|settings|following|useful|appeals))?$/, (req, res, m, url) => {
      const me = meInfo(req);
      if (!me) return loginPage(req, res);
      const d = svc.consoleData(me.owner_id);
      const o = me.owner_id;
      // 消息和历史：“更多”把条数往上加（?page=2 显示前 2 页）
      const page = Math.max(1, Math.min(MAX_PAGES, Number.parseInt(url.searchParams.get('page'), 10) || 1));
      const upTo = (fetch, size) => { const rows = fetch(page * size + 1); return { items: rows.slice(0, page * size), more: rows.length > page * size ? page + 1 : null }; };
      switch (m[1]) {
        case 'saved': {
          const folder = url.searchParams.get('folder') || undefined;
          return html(res, V.renderSaved(d, { me, folder, folders: svc.foldersOf(o), items: svc.savedList(o, { folder }) }));
        }
        case 'history': {
          const who = url.searchParams.get('who') === 'agent' ? 'agent' : 'me';
          if (who === 'agent') return html(res, V.renderHistory(d, { me, who, sharing: d.settings.share_presence, items: svc.agentTrail(o) }));
          const h = upTo((limit) => svc.historyOf(o, { limit }), 100);
          return html(res, V.renderHistory(d, { me, who, sharing: d.settings.share_presence, items: h.items, more: h.more }));
        }
        case 'runs': return html(res, V.renderRuns(d, { me, items: svc.runsOfOwner(o) }));
        case 'guides': return redirect(res, `/me${url.search}`);
        case 'useful': return html(res, V.renderUseful(d, { me, items: svc.usefulBy(o) }));
        case 'messages': {
          const seenAt = svc.db.prepare('SELECT seen_at FROM owners WHERE id = ?').get(o).seen_at;
          const msgs = upTo((limit) => svc.messages(o, { limit }), 60);
          const pageHtml = V.renderMessages(d, { me, items: msgs.items, more: msgs.more, seenAt, tab: url.searchParams.get('tab') || '' });
          svc.markMessagesSeen(o);
          return html(res, pageHtml);
        }
        case 'settings': return html(res, V.renderSettings(d, { me }));
        case 'following': return html(res, V.renderFollowing(d, { me, following: svc.followingOf(o), stats: svc.creatorStats(o) }));
        case 'appeals': return html(res, V.renderAppeals(d, { me, actionable: svc.appealableOf(o), appeals: svc.myAppeals(o), notice: url.searchParams.get('ok') === '1' ? '申诉已提交，管理员会尽快处理' : null, error: url.searchParams.get('err') || null }));
        default: return html(res, V.renderMyGuides(d, { me, items: svc.myGuides(o), status: url.searchParams.get('status') || '' }));
      }
    }],
    ['POST', /^\/me\/pair$/, async (req, res) => {
      const me = requireMe(req, await form(req));
      const pair = svc.createPairCode(me.owner_id);
      return html(res, V.renderSettings(svc.consoleData(me.owner_id), { me: meInfo(req), pair }));
    }],
    ['POST', /^\/me\/profile$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      try {
        svc.updateProfile(me.owner_id, { handle: f.handle, ...(f.bio !== undefined ? { bio: f.bio } : {}) });
      } catch (e) {
        if (e.status && e.status < 500) return html(res, V.renderSettings(svc.consoleData(me.owner_id), { me: meInfo(req), error: e.message }), e.status);
        throw e;
      }
      return redirect(res, '/me/settings');
    }],
    ['POST', /^\/me\/settings$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      svc.updateSettings(me.owner_id, { require_publish_approval: f.require_publish_approval === 'on', share_presence: f.share_presence === 'on' });
      redirect(res, '/me/settings');
    }],
    ['POST', /^\/me\/env-profile$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      const env = {};
      for (const k of ['region', 'os', 'system']) {
        if (f[k] !== undefined) env[k] = String(f[k] ?? '').trim();
      }
      const skills = String(f.skills ?? '').split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
      svc.updateEnvProfile(me.owner_id, { env, skills });
      redirect(res, '/me/settings#env');
    }],
    ['POST', /^\/me\/delete$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      try {
        svc.deleteAccount(me.owner_id, { confirm: f.confirm });
      } catch (e) {
        if (e.status && e.status < 500) return html(res, V.renderSettings(svc.consoleData(me.owner_id), { me: meInfo(req), error: e.message }), e.status);
        throw e;
      }
      res.writeHead(303, { location: '/', 'set-cookie': 'cg_s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
      res.end();
    }],
    ['POST', /^\/me\/agents\/([\w-]+)\/revoke$/, async (req, res, m) => {
      const me = requireMe(req, await form(req));
      svc.revokeAgent(me.owner_id, m[1]);
      redirect(res, '/me/settings');
    }],
    ['POST', /^\/me\/publish\/([\w-]+)$/, async (req, res, m) => {
      const f = await form(req);
      const me = requireMe(req, f);
      svc.reviewPublish(m[1], { ownerId: me.owner_id, action: f.action });
      redirect(res, f.action === 'approve' ? `/g/${m[1]}` : '/me');
    }],
    ['POST', /^\/me\/guides\/([\w-]+)$/, async (req, res, m) => {
      const f = await form(req);
      const me = requireMe(req, f);
      const o = me.owner_id;
      const gid = m[1];
      const done = {
        publish: () => { svc.publishDraft(o, gid); return `/g/${gid}?published=1`; },
        reject: () => { svc.reviewPublish(gid, { ownerId: o, action: 'reject' }); return '/me'; },
        archive: () => { svc.archiveGuide(o, gid); return '/me?status=archived'; },
        restore: () => { svc.restoreGuide(o, gid); return `/g/${gid}`; },
        delete: () => { svc.deleteGuide(o, gid); return '/me'; },
      }[f.action];
      if (!done) throw new HttpError(400, '未知操作');
      redirect(res, done());
    }],
    ['GET', /^\/me\/guides\/([\w-]+)\/edit$/, (req, res, m) => {
      const me = meInfo(req);
      if (!me) return loginPage(req, res);
      const g = svc.ownGuide(me.owner_id, m[1]);
      if (g.status === 'published') return redirect(res, `/g/${m[1]}/edit`);
      if (g.status === 'archived') throw new HttpError(409, '已下架的攻略要先恢复公开才能编辑');
      const v = svc.versionRow(m[1], 1);
      return html(res, V.renderEditor({ model: guideToModel(v.content), mode: 'draft', gid: m[1], action: `/me/guides/${m[1]}/edit`, me }));
    }],
    ['POST', /^\/me\/guides\/([\w-]+)\/edit$/, (req, res, m) => editorPost(req, res, { mode: 'draft', gid: m[1], action: `/me/guides/${m[1]}/edit` })],
    ['POST', /^\/me\/proposals\/([\w-]+)$/, async (req, res, m) => {
      const f = await form(req);
      const me = requireMe(req, f);
      svc.reviewProposal({ owner_id: me.owner_id, name: `${me.handle}（网页）` }, m[1], { action: f.action, note: f.note });
      redirect(res, '/me/messages?tab=todo');
    }],
    ['POST', /^\/me\/folders$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      const folder = svc.createFolder(me.owner_id, f.name);
      redirect(res, `/me/saved?folder=${folder.id}`);
    }],
    ['POST', /^\/me\/folders\/([\w-]+)$/, async (req, res, m) => {
      const f = await form(req);
      const me = requireMe(req, f);
      if (f.action === 'delete') { svc.deleteFolder(me.owner_id, m[1]); return redirect(res, '/me/saved'); }
      svc.renameFolder(me.owner_id, m[1], f.name);
      redirect(res, `/me/saved?folder=${m[1]}`);
    }],
    ['POST', /^\/me\/history$/, async (req, res) => {
      const f = await form(req);
      const me = requireMe(req, f);
      svc.clearHistory(me.owner_id, f.all ? null : f.guide_id);
      redirect(res, '/me/history');
    }],

    // 发布确认链接（Agent 发给主人）
    ['GET', /^\/approve\/([\w-]+)$/, (req, res, m, url) => page(req, res, (me) => V.renderApprove(svc.pendingPreview(m[1], { key: url.searchParams.get('k'), ownerId: me?.owner_id }), { me }))],
    ['POST', /^\/approve\/([\w-]+)$/, async (req, res, m) => {
      const f = await form(req);
      const r = svc.reviewPublish(m[1], { key: f.k, action: f.action });
      if (r.status === 'published') return redirect(res, `/g/${m[1]}`);
      return page(req, res, (me) => V.renderMessage({ title: '已取消发布', text: '这篇攻略不会公开。', me }));
    }],

    // 跟做页（本人步骤）
    ['GET', /^\/f\/([\w-]+)$/, (req, res, m, url) => page(req, res, (me) => V.renderFollow(svc.followView(m[1], url.searchParams.get('k')), { key: url.searchParams.get('k'), me }))],
    ['POST', /^\/f\/([\w-]+)$/, async (req, res, m) => {
      const f = await form(req);
      svc.humanDone(m[1], f.k, f.step_id, { problem: f.action === 'problem' ? (f.problem || '用户在跟做页报告遇到问题') : null });
      redirect(res, `/f/${m[1]}?k=${encodeURIComponent(f.k)}`);
    }],

    ['GET', /^\/u\/([a-f0-9]{20})\.(png|jpg|webp|gif)$/, (req, res, m) => {
      const up = svc.getUpload(m[1]);
      send(res, 200, up.data, up.mime, { 'cache-control': 'public, max-age=31536000, immutable' });
    }],
    ['GET', /^\/static\/style\.css$/, (req, res) => send(res, 200, CSS, 'text/css; charset=utf-8', { 'cache-control': 'public, max-age=300' })],
    ['GET', /^\/healthz$/, (req, res) => json(res, { ok: true })],


    // ───────────── 专题合集 ─────────────
    ['GET', /^\/topics$/, (req, res) => {
      const packs = svc.listTopicPacks({ status: 'published' });
      html(res, V.renderTopics({ packs, me: meInfo(req) }));
    }],
    ['GET', /^\/topics\/([a-z0-9][a-z0-9-]{1,62})$/, (req, res, m) => {
      const pack = svc.getTopicPack(m[1]);
      html(res, V.renderTopicDetail({ pack, me: meInfo(req) }));
    }],
    // ───────────── 给 Agent 读的纯文本 ─────────────
    ['GET', /^\/llms\.txt$/, (req, res) => markdown(res, llmsTxt(baseUrl(req), svc.stats(), svc.tags(), svc.listTopicPacks({ status: 'published', limit: 20 })))],
    ['GET', /^\/search\.md$/, (req, res, m, url) => {
      const q = url.searchParams.get('q') ?? '';
      markdown(res, formatSearch(svc.searchPage(q, { limit: url.searchParams.get('limit') ?? 10, offset: url.searchParams.get('offset') ?? 0 }), q));
    }],
    ['GET', /^\/feed\.md$/, (req, res, m, url) => {
      const kind = url.searchParams.get('kind') ?? 'new';
      if (kind === 'mine') throw new HttpError(400, 'kind=mine 需要身份，请用 /api/feed 或 MCP');
      markdown(res, formatFeed(svc.feed({ owner_id: null }, { kind, since: url.searchParams.get('since') ?? undefined, limit: url.searchParams.get('limit') ?? 10 })));
    }],
    ['GET', /^\/topics\.md$/, (req, res) => markdown(res, formatTopics(svc.listTopicPacks({ status: 'published' }), baseUrl(req)))],
    ['GET', /^\/topics\/([a-z0-9][a-z0-9-]{1,62})\.md$/, (req, res, m) => markdown(res, formatTopic(svc.getTopicPack(m[1]), baseUrl(req)))],

    // ───────────── 接口 ─────────────
    ['GET', /^\/api\/stats$/, (req, res) => json(res, svc.stats())],
    ['GET', /^\/api\/topics$/, (req, res, m, url) => json(res, { topics: svc.listTopicPacks({ status: 'published', limit: url.searchParams.get('limit') ?? 50 }) })],
    ['GET', /^\/api\/topics\/([a-z0-9][a-z0-9-]{1,62})$/, (req, res, m) => json(res, svc.getTopicPack(m[1]))],
    ['GET', /^\/api\/guides$/, (req, res, m, url) => {
      const r = svc.searchPage(url.searchParams.get('q') ?? '', { tag: url.searchParams.get('tag') || undefined, kind: url.searchParams.get('kind') || undefined, limit: url.searchParams.get('limit') ?? 20, offset: url.searchParams.get('offset') ?? 0 });
      json(res, { guides: r.items, total: r.total, offset: r.offset });
    }],
    ['GET', /^\/api\/guides\/([\w-]+)$/, (req, res, m) => json(res, svc.getGuide(m[1], { viewer: optionalOwner(req) ?? anonViewer(req, 'api'), source: 'agent' }))],
    ['GET', /^\/api\/profiles\/([^/]+)$/, (req, res, m) => json(res, svc.profile(decodeURIComponent(m[1])))],
    ['GET', /^\/api\/proposals\/([\w-]+)$/, (req, res, m) => json(res, svc.getProposal(m[1]))],
    ['POST', /^\/api\/agents\/register$/, async (req, res) => {
      limitRegister(req);
      const b = await body(req);
      json(res, svc.registerAgent({ name: b.name, model: b.model, client: b.client, pair_code: b.pair_code }, { public: true }), 201);
    }],
    ['POST', /^\/api\/guides$/, async (req, res) => json(res, svc.publishGuide(auth(req), await body(req)), 201)],
    ['POST', /^\/api\/guides\/([\w-]+)\/runs$/, async (req, res, m) => json(res, svc.reportRun(auth(req), m[1], await body(req)), 201)],
    ['POST', /^\/api\/guides\/([\w-]+)\/proposals$/, async (req, res, m) => json(res, svc.propose(auth(req), m[1], await body(req)), 201)],
    ['POST', /^\/api\/proposals\/([\w-]+)\/verifications$/, async (req, res, m) => json(res, svc.verifyProposal(auth(req), m[1], await body(req)), 201)],
    ['POST', /^\/api\/proposals\/([\w-]+)\/review$/, async (req, res, m) => json(res, svc.reviewProposal(auth(req), m[1], await body(req)))],
    ['GET', /^\/api\/feed$/, (req, res, m, url) => json(res, svc.feed(auth(req), { kind: url.searchParams.get('kind') ?? 'mine', since: url.searchParams.get('since') ?? undefined, limit: url.searchParams.get('limit') ?? 10 }))],
    ['POST', /^\/api\/runs$/, async (req, res) => {
      const b = await body(req);
      json(res, svc.startRun(auth(req), b.guide_id, { env: b.env }), 201);
    }],
    ['GET', /^\/api\/runs\/([\w-]+)$/, (req, res, m) => {
      const a = auth(req);
      svc.runRow(m[1], a.owner_id);
      json(res, svc.runState(m[1]));
    }],
    ['POST', /^\/api\/runs\/([\w-]+)\/steps$/, async (req, res, m) => json(res, svc.stepResult(auth(req), m[1], await body(req)))],
    ['POST', /^\/api\/runs\/([\w-]+)\/finish$/, async (req, res, m) => json(res, svc.finishRun(auth(req), m[1], await body(req)))],
    // 跟做 JSON：凭 session_key（跟做链接里的 k）读写进度，给浏览器扩展 / 第三方 UI，不走 Agent Bearer
    ['GET', /^\/api\/follow\/([\w-]+)$/, (req, res, m, url) => {
      const k = url.searchParams.get('k');
      json(res, svc.followApiView(m[1], k));
    }],
    ['POST', /^\/api\/follow\/([\w-]+)$/, async (req, res, m) => {
      const b = await body(req);
      const action = b.action === 'problem' ? 'problem' : 'done';
      svc.humanDone(m[1], b.k, b.step_id, { problem: action === 'problem' ? (b.problem || '用户在扩展跟做中报告遇到问题') : null });
      json(res, svc.followApiView(m[1], b.k));
    }],
    ['POST', /^\/api\/guides\/([\w-]+)\/react$/, async (req, res, m) => json(res, svc.react(auth(req), m[1], await body(req)))],
    ['GET', /^\/api\/guides\/([\w-]+)\/comments$/, (req, res, m) => json(res, { comments: svc.commentsOf(m[1]) })],
    ['POST', /^\/api\/guides\/([\w-]+)\/comments$/, async (req, res, m) => json(res, svc.comment(auth(req), m[1], await body(req)), 201)],
    ['POST', /^\/api\/comments\/([\w-]+)\/helpful$/, (req, res, m) => json(res, svc.voteComment(auth(req).owner_id, m[1]))],
    ['POST', /^\/api\/comments\/([\w-]+)\/accept$/, (req, res, m) => { const a = auth(req); json(res, svc.acceptComment(a.owner_id, m[1], { name: a.name })); }],
    ['POST', /^\/api\/comments\/([\w-]+)\/verify$/, async (req, res, m) => json(res, svc.verifyComment(auth(req), m[1], await body(req)))],
    ['POST', /^\/api\/comments\/([\w-]+)\/reject$/, async (req, res, m) => json(res, svc.rejectComment(auth(req).owner_id, m[1], (await body(req)).note))],
    ['POST', /^\/api\/follows$/, async (req, res) => json(res, svc.follow(auth(req).owner_id, await body(req)))],
    ['POST', /^\/api\/connect$/, async (req, res) => {
      const r = svc.connectAgent(auth(req), await body(req));
      json(res, { ...r, claim_url: r.claim_path ? baseUrl(req) + r.claim_path : null });
    }],
    ['GET', /^\/api\/library$/, (req, res, m, url) => json(res, svc.library(auth(req), { view: url.searchParams.get('view') ?? 'mine', folder: url.searchParams.get('folder') || undefined }))],
    ['POST', /^\/api\/manage$/, async (req, res) => json(res, svc.manage(auth(req), await body(req)))],
    ['POST', /^\/api\/login-links$/, (req, res) => json(res, svc.createLoginLink(auth(req)), 201)],
    ['POST', /^\/api\/uploads$/, async (req, res) => {
      const up = svc.saveUpload(auth(req), await body(req, 2.2 * 1024 * 1024));
      json(res, { ...up, url: baseUrl(req) + up.path }, 201);
    }],
    ['POST', /^\/api\/usage$/, async (req, res) => json(res, svc.reportUsage(auth(req), (await body(req)).items))],

    // 远程 MCP（Streamable HTTP，无状态 JSON 响应）
    ['POST', /^\/mcp$/, async (req, res) => {
      const msg = await body(req);
      const handler = mcpHandlerFor(req);
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(handler))).filter(Boolean);
        return out.length ? json(res, out) : send(res, 202, '');
      }
      const out = await handler(msg);
      return out ? json(res, out) : send(res, 202, '');
    }],
    ['GET', /^\/mcp$/, (req, res) => send(res, 405, 'Method Not Allowed', 'text/plain', { allow: 'POST' })],
    ['DELETE', /^\/mcp$/, (req, res) => send(res, 405, 'Method Not Allowed', 'text/plain', { allow: 'POST' })],
  ];

  function baseUrl(req) {
    return publicUrl ?? `http://${req.headers.host ?? 'localhost'}`;
  }

  function guideMarkdown(req, gid) {
    const g = svc.getGuide(gid, { viewer: optionalOwner(req) ?? anonViewer(req, 'api'), source: 'agent' });
    return formatGuide(g, { webUrl: (p) => baseUrl(req) + p });
  }

  function auth(req) {
    const h = req.headers.authorization ?? '';
    return svc.authenticate(h.startsWith('Bearer ') ? h.slice(7).trim() : null);
  }

  function optionalOwner(req) {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) return null;
    try { return svc.authenticate(h.slice(7).trim()).owner_id; } catch { return null; }
  }

  function meInfo(req) {
    const me = svc.sessionOwner(cookie(req, COOKIE));
    if (!me) return null;
    const pending = svc.db.prepare("SELECT COUNT(*) AS n FROM guides WHERE author_owner_id = ? AND status = 'pending'").get(me.owner_id).n;
    return { ...me, runs: svc.activeRuns(me.owner_id), pending, counts: svc.libraryCounts(me.owner_id) };
  }

  // 攻略编辑器的提交：新写、改草稿、编辑已公开的、提修改建议共用。带图片上传（multipart）。
  async function editorPost(req, res, { mode, gid, action }) {
    const raw = await readRaw(req, 12 * 1024 * 1024);
    const ct = req.headers['content-type'] ?? '';
    const { fields: f, files } = ct.startsWith('multipart/') ? parseMultipart(raw, ct) : { fields: Object.fromEntries(new URLSearchParams(raw.toString('utf8'))), files: {} };
    const me = requireMe(req, f);
    const web = svc.webAgent(me.owner_id);
    const problems = [];
    for (const [name, file] of Object.entries(files)) {
      const mm = /^s(\d+)_shot_file$/.exec(name);
      if (!mm) continue;
      try {
        const up = svc.saveUpload(web, { data: file.data.toString('base64'), mime: file.mime });
        f[`s${mm[1]}_shot`] = up.path;
        delete f[`s${mm[1]}_shot_del`];
      } catch (e) {
        problems.push(`第 ${Number(mm[1]) + 1} 步的截图没有上传：${e.message}`);
      }
    }
    const model = guideFromForm(f);
    model.rationale = f.rationale;
    const full = meInfo(req);
    const again = (extra = {}) => html(res, V.renderEditor({ model, mode, gid, action, me: full, ...extra, notice: extra.notice ?? (problems.join('；') || null) }), extra.error ? 400 : 200);
    // 重新显示表单时保留原来的空行，再按需要多加一行
    const blanks = (k, n) => Math.max(0, (Number(f[k]) || 0) - n);
    const add = { steps: blanks('step_n', model.steps.length), sources: blanks('src_n', model.sources.length), pitfalls: blanks('pit_n', model.pitfalls.length) };
    if (f.op === 'add_step') return again({ add: { ...add, steps: add.steps + 1 } });
    if (f.op === 'add_source') return again({ add: { ...add, sources: add.sources + 1 } });
    if (f.op === 'add_pitfall') return again({ add: { ...add, pitfalls: add.pitfalls + 1 } });
    if (problems.length) return again({ error: problems.join('；'), add });
    try {
      if (mode === 'new') {
        const r = svc.publishGuide(web, { ...publishInput(model), draft: f.op === 'draft' }, { direct: true });
        return redirect(res, r.status === 'draft' ? '/me?status=draft' : `/g/${r.guide_id}?published=1`);
      }
      if (mode === 'draft') {
        svc.updateDraft(me.owner_id, gid, publishInput(model));
        if (f.op === 'publish') { svc.publishDraft(me.owner_id, gid); return redirect(res, `/g/${gid}?published=1`); }
        return redirect(res, '/me');
      }
      const r = svc.editGuide(web, gid, editInput(model), { rationale: f.rationale, tested: Boolean(f.tested) });
      return redirect(res, r.status === 'merged' ? `/g/${gid}?updated=1` : `/g/${gid}?proposed=1#${r.comment_id ?? 'comments'}`);
    } catch (e) {
      if (e.status && e.status < 500) return again({ error: e.message, add });
      throw e;
    }
  }

  function requireMe(req, f) {
    const me = svc.sessionOwner(cookie(req, COOKIE));
    if (!me) throw new HttpError(401, '请先登录：让你的 Agent 调用 caiguo_console_link 生成登录链接');
    if (!f || f.csrf !== me.csrf) throw new HttpError(403, '页面已过期，请刷新后再试');
    return me;
  }

  // 访问者 IP。放在反向代理（Caddy / Nginx）后面时，socket 地址都是 127.0.0.1，
  // 要打开 trustProxy（CAIGUO_TRUST_PROXY=1）取 X-Forwarded-For 最右边那个（由我们自己的代理追加，客户端伪造不了）
  function clientIp(req) {
    if (trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress ?? '?';
  }

  function anonViewer(req, kind) {
    const raw = `${clientIp(req)}|${req.headers['user-agent'] ?? ''}`;
    return `${kind}:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  }

  // 设备指纹：User-Agent + Accept-Language（不含 IP，和 IP 限流分开）。只用于注册计数，不存原文。
  function deviceFingerprint(req) {
    const ua = String(req.headers['user-agent'] ?? '');
    const lang = String(req.headers['accept-language'] ?? '');
    return createHash('sha256').update(`ua:${ua}|lang:${lang}`).digest('hex').slice(0, 32);
  }

  function limitRegister(req) {
    const ip = clientIp(req);
    const now = Date.now();
    const hits = (registerHits.get(ip) ?? []).filter((t) => now - t < 3600e3);
    if (hits.length >= 30) throw new HttpError(429, '注册太频繁，请稍后再试');
    hits.push(now);
    registerHits.set(ip, hits);
  }

  function mcpHandlerFor(req) {
    const base = baseUrl(req);
    const agent = () => auth(req);
    const viewer = () => { try { return agent().owner_id; } catch { return anonViewer(req, 'api'); } };
    const client = {
      webUrl: (p) => base + p,
      search: async ({ q, tag, kind, limit, offset }) => svc.searchPage(q, { tag, kind, limit, offset }),
      getGuide: async (id) => svc.getGuide(id, { viewer: viewer(), source: 'agent' }),
      start: async (gid, env) => svc.startRun(agent(), gid, { env }),
      next: async (rid, b) => svc.stepResult(agent(), rid, b),
      runState: async (rid) => { svc.runRow(rid, agent().owner_id); return svc.runState(rid); },
      finish: async (rid, b) => svc.finishRun(agent(), rid, b),
      publish: async (c) => svc.publishGuide(agent(), c),
      upload: async ({ data, mime }) => { const up = svc.saveUpload(agent(), { data, mime }); return { ...up, url: base + up.path }; },
      reportRun: async (id, b) => svc.reportRun(agent(), id, b),
      propose: async (id, b) => svc.propose(agent(), id, b),
      verify: async (pid, b) => svc.verifyProposal(agent(), pid, b),
      review: async (pid, b) => svc.reviewProposal(agent(), pid, b),
      feed: async (o) => svc.feed(agent(), o),
      consoleLink: async () => svc.createLoginLink(agent()),
      library: async (o) => svc.library(agent(), o),
      connect: async (b) => { const r = svc.connectAgent(agent(), b); return { ...r, claim_url: r.claim_path ? base + r.claim_path : null }; },
      react: async ({ guide_id, ...b }) => svc.react(agent(), guide_id, b),
      comment: async ({ action = 'post', guide_id, comment_id, ...b }) => ({
        post: () => svc.comment(agent(), guide_id, b),
        helpful: () => svc.voteComment(agent().owner_id, comment_id),
        accept: () => svc.acceptComment(agent().owner_id, comment_id, { name: agent().name }),
        verify: () => svc.verifyComment(agent(), comment_id, { outcome: b.outcome ?? 'success', env: b.env, note: b.body }),
        reject: () => svc.rejectComment(agent().owner_id, comment_id, b.body),
      }[action] ?? (() => { throw new Error('action 只能是 post / helpful / verify / accept / reject'); }))(),
      follow: async (b) => svc.follow(agent().owner_id, b),
      manage: async (b) => svc.manage(agent(), b),
      listTopics: async (o = {}) => svc.listTopicPacks({ status: 'published', limit: o.limit }),
      getTopic: async (slug) => svc.getTopicPack(slug),
    };
    return createMcpHandler({ name: 'caiguo', version: VERSION, instructions: INSTRUCTIONS, tools: TOOLS, call: (n, a) => callTool(client, n, a) });
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      for (const [method, re, fn] of routes) {
        if (req.method !== method) continue;
        const m = url.pathname.match(re);
        if (m) return await fn(req, res, m, url);
      }
      throw new HttpError(404, '页面不存在');
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) console.error(e);
      const msg = status >= 500 ? '服务器内部错误' : e.message;
      if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return json(res, { error: msg }, status);
      if (/\.(md|txt)$/.test(url.pathname)) return markdown(res, `错误：${msg}`, status);
      return html(res, V.renderMessage({ title: status === 404 ? '找不到' : '出错了', text: msg, me: null }), status);
    }
  };
}

function wantsMarkdown(req) {
  const a = req.headers.accept ?? '';
  return a.includes('text/markdown') && !a.includes('text/html');
}

function cookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function send(res, status, payload, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', ...headers });
  res.end(payload);
}

function json(res, data, status = 200) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

function markdown(res, text, status = 200) {
  send(res, status, text, 'text/markdown; charset=utf-8');
}

function html(res, pageHtml, status = 200, extra = {}) {
  send(res, status, pageHtml, 'text/html; charset=utf-8', {
    ...extra,
    'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'none'; form-action 'self'; frame-ancestors 'self'",
    'referrer-policy': 'same-origin',
  });
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function safeBack(p) {
  return typeof p === 'string' && /^\/[\w/?=&%-]*$/.test(p) && !p.startsWith('//') ? p : null;
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, '内容太大（图片每张最多 1.5MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, '请求太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function body(req, max = MAX_BODY) {
  const text = await readBody(req, max);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON');
  }
}

async function form(req) {
  const text = await readBody(req, 64 * 1024);
  return Object.fromEntries(new URLSearchParams(text));
}

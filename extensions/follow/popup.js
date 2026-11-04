const $ = (id) => document.getElementById(id);

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function guideIdFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/g\/([\w-]+)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function parseFollowInput(raw, baseUrl) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const u = new URL(text, baseUrl || 'http://127.0.0.1');
    const m = u.pathname.match(/^\/f\/([\w-]+)/);
    if (m) return { runId: m[1], key: u.searchParams.get('k') || '' };
  } catch { /* fall through */ }
  if (/^[\w-]+$/.test(text)) return { runId: text, key: '' };
  return null;
}

function applyLiveView(baseUrl, key, view) {
  const done = {};
  for (const st of view.steps) {
    if (st.result) done[st.id] = true;
  }
  const stepIndex = view.next_step_index != null
    ? view.next_step_index
    : Math.max(0, view.steps.length - 1);
  return {
    mode: 'run',
    baseUrl,
    runId: view.run_id,
    sessionKey: key,
    guideId: view.guide_id,
    title: view.title,
    agent: view.agent || '',
    status: view.status,
    steps: view.steps.map((s) => ({
      id: s.id,
      n: s.n,
      action: s.action,
      expect: s.expect || '',
      notes: s.notes || '',
      actor: s.actor || 'agent',
      target: s.target || null,
    })),
    stepIndex,
    done,
    nextStepId: view.next_step_id,
  };
}

async function init() {
  const st = await chrome.storage.local.get(['baseUrl', 'guideId', 'title', 'runId', 'sessionKey', 'mode']);
  $('base').value = st.baseUrl || 'http://127.0.0.1:8787';
  const tab = await currentTab();
  const fromFollow = tab?.url ? parseFollowInput(tab.url, st.baseUrl) : null;
  if (fromFollow) {
    $('follow').value = tab.url;
    if (fromFollow.key) $('key').value = fromFollow.key;
  } else if (st.runId) {
    $('follow').value = st.runId;
    if (st.sessionKey) $('key').value = st.sessionKey;
  }
  const fromTab = tab?.url ? guideIdFromUrl(tab.url) : '';
  $('gid').value = fromTab || st.guideId || '';
  if (st.title) {
    $('msg').textContent = st.mode === 'run'
      ? `同步中：${st.title}${st.runId ? `（${st.runId}）` : ''}`
      : `当前：${st.title}`;
  }
}

$('load').onclick = async () => {
  const baseUrl = $('base').value.trim().replace(/\/$/, '');
  $('msg').textContent = '';
  $('msg').className = 'muted';
  if (!baseUrl) {
    $('msg').textContent = '请填写站点';
    $('msg').className = 'err';
    return;
  }
  const parsed = parseFollowInput($('follow').value, baseUrl);
  const key = ($('key').value.trim() || parsed?.key || '').trim();
  try {
    if (parsed?.runId) {
      if (!key) throw new Error('跟做模式需要 session key（链接里的 k=）');
      const r = await fetch(`${baseUrl}/api/follow/${encodeURIComponent(parsed.runId)}?k=${encodeURIComponent(key)}`);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `同步失败 HTTP ${r.status}`);
      }
      const view = await r.json();
      if (!view.steps?.length) throw new Error('这次执行没有步骤');
      await chrome.storage.local.set(applyLiveView(baseUrl, key, view));
      $('msg').textContent = view.status === 'finished'
        ? `已结束：《${view.title}》`
        : `已同步《${view.title}》· Agent「${view.agent || '?'}」· ${view.done_count}/${view.total_steps} 步`;
      $('msg').className = 'ok';
    } else {
      const guideId = $('gid').value.trim();
      if (!guideId) throw new Error('请填写跟做链接，或笔记编号');
      const r = await fetch(`${baseUrl}/api/guides/${encodeURIComponent(guideId)}`);
      if (!r.ok) throw new Error(`读取失败 HTTP ${r.status}`);
      const g = await r.json();
      const steps = (g.content?.steps ?? []).map((s, i) => ({
        id: s.id,
        n: i + 1,
        action: s.action,
        expect: s.expect || '',
        notes: s.notes || '',
        actor: s.actor || 'agent',
        target: s.target || null,
      }));
      if (!steps.length) throw new Error('这篇没有步骤（可能不是攻略）');
      await chrome.storage.local.set({
        mode: 'guide',
        baseUrl,
        runId: null,
        sessionKey: null,
        guideId: g.id,
        title: g.title,
        agent: '',
        status: 'guide',
        steps,
        stepIndex: 0,
        done: {},
        nextStepId: steps[0]?.id ?? null,
      });
      $('msg').textContent = `离线跟做《${g.title}》共 ${steps.length} 步（不同步 Agent）`;
      $('msg').className = 'ok';
    }
    const tab = await currentTab();
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'caiguo-follow-refresh' }).catch(() => {});
  } catch (e) {
    $('msg').textContent = e.message || String(e);
    $('msg').className = 'err';
  }
};

$('clear').onclick = async () => {
  await chrome.storage.local.remove([
    'guideId', 'title', 'steps', 'stepIndex', 'done', 'mode',
    'runId', 'sessionKey', 'agent', 'status', 'nextStepId', 'collapsed',
  ]);
  $('msg').textContent = '已清除';
  const tab = await currentTab();
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'caiguo-follow-refresh' }).catch(() => {});
};

init();

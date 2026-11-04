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

async function init() {
  const st = await chrome.storage.local.get(['baseUrl', 'guideId', 'title']);
  $('base').value = st.baseUrl || 'http://127.0.0.1:8787';
  const tab = await currentTab();
  const fromTab = tab?.url ? guideIdFromUrl(tab.url) : '';
  $('gid').value = fromTab || st.guideId || '';
  if (st.title) $('msg').textContent = `当前：${st.title}`;
}

$('load').onclick = async () => {
  const baseUrl = $('base').value.trim().replace(/\/$/, '');
  const guideId = $('gid').value.trim();
  $('msg').textContent = '';
  $('msg').className = 'muted';
  if (!baseUrl || !guideId) {
    $('msg').textContent = '请填写站点和笔记编号';
    $('msg').className = 'err';
    return;
  }
  try {
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
      baseUrl,
      guideId: g.id,
      title: g.title,
      steps,
      stepIndex: 0,
      done: {},
    });
    $('msg').textContent = `已加载《${g.title}》共 ${steps.length} 步；刷新当前页即可看到浮层。`;
    const tab = await currentTab();
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'caiguo-follow-refresh' }).catch(() => {});
  } catch (e) {
    $('msg').textContent = e.message || String(e);
    $('msg').className = 'err';
  }
};

$('clear').onclick = async () => {
  await chrome.storage.local.remove(['guideId', 'title', 'steps', 'stepIndex', 'done']);
  $('msg').textContent = '已清除';
  const tab = await currentTab();
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'caiguo-follow-refresh' }).catch(() => {});
};

init();

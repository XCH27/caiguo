(() => {
  const ROOT_ID = 'caiguo-follow-root';

  async function state() {
    return chrome.storage.local.get(['baseUrl', 'guideId', 'title', 'steps', 'stepIndex', 'done', 'collapsed']);
  }

  function ensureRoot() {
    let el = document.getElementById(ROOT_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = ROOT_ID;
    document.documentElement.appendChild(el);
    return el;
  }

  function render(st) {
    const existing = document.getElementById(ROOT_ID);
    if (!st.guideId || !st.steps?.length) {
      existing?.remove();
      return;
    }
    const el = ensureRoot();
    el.classList.toggle('collapsed', Boolean(st.collapsed));
    const i = Math.min(Math.max(0, st.stepIndex || 0), st.steps.length - 1);
    const step = st.steps[i];
    const done = st.done || {};
    const open = st.baseUrl && st.guideId ? `${st.baseUrl}/g/${st.guideId}` : '#';
    el.innerHTML = `
      <div class="hd">
        <b>${escapeHtml(st.title || st.guideId)}</b>
        <button type="button" data-act="toggle">${st.collapsed ? '展开' : '收起'}</button>
        <button type="button" data-act="close">关闭</button>
      </div>
      <div class="bd">
        <div class="n">第 ${step.n} / ${st.steps.length} 步${done[step.id] ? ' · 已勾完' : ''}</div>
        ${step.actor === 'human' ? '<span class="pill">需要你本人</span>' : '<span class="pill">Agent / 任意</span>'}
        <h2>${escapeHtml(step.action)}</h2>
        ${step.expect ? `<div class="expect"><b>做完应该看到</b><br>${escapeHtml(step.expect)}</div>` : ''}
        ${step.notes ? `<div class="notes">${escapeHtml(step.notes)}</div>` : ''}
        <div class="nav">
          <button type="button" class="ghost" data-act="prev" ${i === 0 ? 'disabled' : ''}>上一步</button>
          <button type="button" data-act="done">${done[step.id] ? '已完成' : '本步完成'}</button>
          <button type="button" class="ghost" data-act="next" ${i >= st.steps.length - 1 ? 'disabled' : ''}>下一步</button>
        </div>
      </div>
      <div class="foot"><a href="${escapeHtml(open)}" target="_blank" rel="noopener">打开原笔记</a> · 踩过跟做 MVP</div>
    `;
    el.onclick = async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      const cur = await state();
      if (act === 'close') {
        await chrome.storage.local.remove(['guideId', 'title', 'steps', 'stepIndex', 'done', 'collapsed']);
        el.remove();
        return;
      }
      if (act === 'toggle') {
        await chrome.storage.local.set({ collapsed: !cur.collapsed });
        render(await state());
        return;
      }
      let idx = cur.stepIndex || 0;
      const d = { ...(cur.done || {}) };
      if (act === 'prev') idx = Math.max(0, idx - 1);
      if (act === 'next') idx = Math.min(cur.steps.length - 1, idx + 1);
      if (act === 'done') {
        const sid = cur.steps[idx].id;
        d[sid] = true;
        if (idx < cur.steps.length - 1) idx += 1;
      }
      await chrome.storage.local.set({ stepIndex: idx, done: d });
      render(await state());
    };
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'caiguo-follow-refresh') state().then(render);
  });
  chrome.storage.onChanged.addListener(() => state().then(render));
  state().then(render);
})();

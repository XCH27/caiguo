(() => {
  const ROOT_ID = 'caiguo-follow-root';
  let pollTimer = null;

  async function state() {
    return chrome.storage.local.get([
      'mode', 'baseUrl', 'guideId', 'title', 'steps', 'stepIndex', 'done', 'collapsed',
      'runId', 'sessionKey', 'agent', 'status', 'nextStepId',
    ]);
  }

  function ensureRoot() {
    let el = document.getElementById(ROOT_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = ROOT_ID;
    document.documentElement.appendChild(el);
    return el;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function syncFromServer() {
    const st = await state();
    if (st.mode !== 'run' || !st.baseUrl || !st.runId || !st.sessionKey) return;
    try {
      const r = await fetch(`${st.baseUrl}/api/follow/${encodeURIComponent(st.runId)}?k=${encodeURIComponent(st.sessionKey)}`);
      if (!r.ok) return;
      const view = await r.json();
      const done = {};
      for (const step of view.steps) if (step.result) done[step.id] = true;
      const stepIndex = view.next_step_index != null ? view.next_step_index : Math.max(0, view.steps.length - 1);
      await chrome.storage.local.set({
        title: view.title,
        agent: view.agent || '',
        status: view.status,
        steps: view.steps.map((s) => ({
          id: s.id, n: s.n, action: s.action, expect: s.expect || '', notes: s.notes || '',
          actor: s.actor || 'agent', target: s.target || null,
        })),
        stepIndex,
        done,
        nextStepId: view.next_step_id,
        guideId: view.guide_id,
      });
    } catch {
      // ignore network blips
    }
  }

  async function postHuman(action) {
    const st = await state();
    if (st.mode !== 'run' || !st.baseUrl || !st.runId || !st.sessionKey) return null;
    const step = st.steps[st.stepIndex];
    if (!step) return null;
    const r = await fetch(`${st.baseUrl}/api/follow/${encodeURIComponent(st.runId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        k: st.sessionKey,
        step_id: step.id,
        action: action === 'problem' ? 'problem' : 'done',
        problem: action === 'problem' ? '扩展跟做：本步遇到问题' : undefined,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    return r.json();
  }

  function schedulePoll(st) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (st.mode === 'run' && st.status === 'in_progress') {
      pollTimer = setInterval(() => { syncFromServer().then(() => state().then(render)); }, 4000);
    }
  }

  function render(st) {
    const existing = document.getElementById(ROOT_ID);
    if (!st.steps?.length || (!st.guideId && !st.runId)) {
      existing?.remove();
      if (pollTimer) clearInterval(pollTimer);
      return;
    }
    schedulePoll(st);
    const el = ensureRoot();
    el.classList.toggle('collapsed', Boolean(st.collapsed));
    const i = Math.min(Math.max(0, st.stepIndex || 0), st.steps.length - 1);
    const step = st.steps[i];
    const done = st.done || {};
    const live = st.mode === 'run';
    const open = st.baseUrl && (live && st.runId && st.sessionKey
      ? `${st.baseUrl}/f/${st.runId}?k=${encodeURIComponent(st.sessionKey)}`
      : st.guideId ? `${st.baseUrl}/g/${st.guideId}` : '#');
    const canConfirm = !live || step.actor === 'human';
    el.innerHTML = `
      <div class="hd">
        <b>${escapeHtml(st.title || st.guideId || st.runId)}</b>
        <button type="button" data-act="toggle">${st.collapsed ? '展开' : '收起'}</button>
        <button type="button" data-act="close">关闭</button>
      </div>
      <div class="bd">
        <div class="n">${live ? `同步 · ${escapeHtml(st.agent || 'Agent')} · ${st.status === 'finished' ? '已结束' : '进行中'}` : '离线跟做'}
          · 第 ${step.n} / ${st.steps.length} 步${done[step.id] ? ' · 已完成' : ''}</div>
        ${step.actor === 'human' ? '<span class="pill">需要你本人</span>' : '<span class="pill">Agent 步骤</span>'}
        <h2>${escapeHtml(step.action)}</h2>
        ${step.expect ? `<div class="expect"><b>做完应该看到</b><br>${escapeHtml(step.expect)}</div>` : ''}
        ${step.notes ? `<div class="notes">${escapeHtml(step.notes)}</div>` : ''}
        ${live && step.actor !== 'human' && !done[step.id] ? '<p class="notes">等 Agent 回报这一步；浮层约 4 秒自动刷新。</p>' : ''}
        <div class="nav">
          <button type="button" class="ghost" data-act="prev" ${i === 0 ? 'disabled' : ''}>上一步</button>
          <button type="button" data-act="done" ${!canConfirm || done[step.id] || st.status === 'finished' ? 'disabled' : ''}>${done[step.id] ? '已完成' : (live ? '我做完了' : '本步完成')}</button>
          <button type="button" class="ghost" data-act="next" ${i >= st.steps.length - 1 ? 'disabled' : ''}>下一步</button>
        </div>
      </div>
      <div class="foot"><a href="${escapeHtml(open)}" target="_blank" rel="noopener">${live ? '打开跟做页' : '打开原笔记'}</a> · 踩过跟做</div>
    `;
    el.onclick = async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.getAttribute('data-act');
      const cur = await state();
      if (act === 'close') {
        await chrome.storage.local.remove([
          'guideId', 'title', 'steps', 'stepIndex', 'done', 'collapsed',
          'mode', 'runId', 'sessionKey', 'agent', 'status', 'nextStepId',
        ]);
        el.remove();
        if (pollTimer) clearInterval(pollTimer);
        return;
      }
      if (act === 'toggle') {
        await chrome.storage.local.set({ collapsed: !cur.collapsed });
        render(await state());
        return;
      }
      let idx = cur.stepIndex || 0;
      if (act === 'prev') {
        await chrome.storage.local.set({ stepIndex: Math.max(0, idx - 1) });
        render(await state());
        return;
      }
      if (act === 'next') {
        await chrome.storage.local.set({ stepIndex: Math.min(cur.steps.length - 1, idx + 1) });
        render(await state());
        return;
      }
      if (act === 'done') {
        try {
          if (cur.mode === 'run') {
            await postHuman('done');
            await syncFromServer();
          } else {
            const d = { ...(cur.done || {}) };
            d[cur.steps[idx].id] = true;
            if (idx < cur.steps.length - 1) idx += 1;
            await chrome.storage.local.set({ stepIndex: idx, done: d });
          }
        } catch (e) {
          alert(e.message || String(e));
        }
        render(await state());
      }
    };
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'caiguo-follow-refresh') {
      syncFromServer().finally(() => state().then(render));
    }
  });
  chrome.storage.onChanged.addListener(() => state().then(render));
  syncFromServer().finally(() => state().then(render));
})();

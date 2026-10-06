(() => {
  const KB = window.KB || {};
  const TW = window.TWEAKS || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, a, b, c) => { const m = Math.abs(n) % 100, d = m % 10; return m > 10 && m < 20 ? c : d === 1 ? a : d >= 2 && d <= 4 ? b : c; };
  const ic = (name, size = 18) => `<svg class="i" width="${size}" height="${size}"><use href="#i-${name}"/></svg>`;
  const nSvc = (n) => `${n} ${plural(n, 'служба', 'службы', 'служб')}`;
  const nTw = (n) => `${n} ${plural(n, 'настройка', 'настройки', 'настроек')}`;
  const nSt = (n) => `${n} ${plural(n, 'программа автозагрузки', 'программы автозагрузки', 'программ автозагрузки')}`;

  // ───── backend bridge (with a mock so the UI can be previewed in a plain browser) ─────
  const tauri = window.__TAURI__;
  const invoke = tauri ? tauri.core.invoke : mockInvoke;

  const state = {
    services: [], admin: false, selected: null, view: 'dashboard',
    pending: new Map(),          // service name -> target start
    pendingTweaks: new Set(),    // tweak ids
    tweakApplied: new Map(),     // tweak id -> bool
    filter: 'all', query: '', expert: false, snapshots: [], sys: null, app: null,
    icons: new Map(),            // 'startup:<id>' | 'service:<name>' -> PNG data URL (extracted from the exe)
    iconAsked: new Set(),        // keys we already requested, so each icon is fetched once
    startup: [],                 // autostart entries from the backend
    pendingStartup: new Map(),   // startup id -> target enabled (bool)
  };

  const LABEL = { auto: 'Авто', delayed: 'Авто (отложенный)', manual: 'Вручную', disabled: 'Отключена', other: 'Система' };
  const RANK = { auto: 3, delayed: 3, manual: 2, disabled: 1, other: 4 };
  const RISK = { safe: 'Безопасно', caution: 'Зависит от вас', critical: 'Не трогать' };
  const REC = { disabled: 'Можно отключить', manual: 'Можно вручную', keep: 'Оставить' };

  const kb = (s) => KB[s.name.toLowerCase()];
  const curKey = (s) => (s.start === 2 ? (s.delayed ? 'delayed' : 'auto') : s.start === 3 ? 'manual' : s.start === 4 ? 'disabled' : 'other');
  const risk = (s) => (s.blocked ? 'critical' : kb(s)?.r || 'unknown');
  const canEdit = (s) => {
    if (s.blocked || curKey(s) === 'other') return false;
    const k = kb(s);
    return k ? k.r !== 'critical' : state.expert;
  };
  const wantsChange = (s) => {
    const k = kb(s);
    return !!k && k.rec !== 'keep' && !s.blocked && RANK[curKey(s)] > RANK[k.rec];
  };
  // ── autostart helpers ──
  const skb = (e) => { const hay = (e.name + ' ' + e.command).toLowerCase(); return (window.STARTUP_KB || []).find((k) => k.m.some((t) => hay.includes(t))); };
  const startupWants = (e) => { const k = skb(e); return !!k && k.rec === 'disable' && k.r !== 'critical' && e.enabled; };
  const startupLocked = (e) => skb(e)?.r === 'critical';
  const exeOf = (cmd) => { const m = /([^\\/"]+\.(?:exe|lnk|bat|cmd))/i.exec(cmd || ''); return m ? m[1] : ''; };
  const startupTitle = (e) => skb(e)?.t || e.name.replace(/^(MicrosoftEdgeAutoLaunch|GoogleChromeAutoLaunch)_[0-9A-F]+$/i, '$1');
  const startupTarget = (e) => (state.pendingStartup.has(e.id) ? state.pendingStartup.get(e.id) : e.enabled);

  const startKeyOf = (start, delayed) => (start === 2 ? (delayed ? 'delayed' : 'auto') : start === 3 ? 'manual' : start === 4 ? 'disabled' : 'other');

  // ───── loading ─────
  async function load() {
    try {
      state.admin = await invoke('is_admin');
      state.services = await invoke('scan_services');
      state.snapshots = await invoke('list_snapshots');
      state.tweakApplied = new Map((await invoke('list_tweaks')).map((t) => [t.id, t.applied]));
      state.sys = await invoke('system_info');
      state.startup = await invoke('scan_startup');
      state.app = await invoke('app_info');
    } catch (e) {
      toast('Ошибка сканирования: ' + e, true);
    }
    $('adminText').textContent = state.admin ? 'Администратор' : 'Без прав администратора';
    $('adminBadge').classList.toggle('no', !state.admin);
    $('adminBanner').hidden = state.admin;
    renderAll();
    ensureIcons('startup', state.startup.map((e) => e.id));
  }

  // Program icons come from the exe files themselves; they arrive after the first paint.
  async function ensureIcons(kind, ids) {
    const need = ids.filter((id) => !state.iconAsked.has(kind + ':' + id));
    if (!need.length) return;
    need.forEach((id) => state.iconAsked.add(kind + ':' + id));
    try {
      const got = await invoke('entry_icons', { kind, ids: need });
      Object.entries(got).forEach(([id, url]) => state.icons.set(kind + ':' + id, url));
      if (Object.keys(got).length) { if (kind === 'startup') renderStartup(); else renderDetail(); }
    } catch { /* icons are cosmetic: ignore failures */ }
  }

  // ───── presets ─────
  function allSafePreset() {
    return {
      id: 'all', icon: 'sparkles', risk: 'safe', riskLabel: 'Безопасно', title: 'Все безопасные',
      desc: 'Только изменения с низким риском: ненужные фоновые службы, реклама и часть телеметрии. Хороший старт для новой системы.',
      services: state.services.map((s) => s.name), tweaks: Object.keys(TW).filter((id) => TW[id].r === 'safe'), startup: true,
    };
  }
  const allPresets = () => [allSafePreset(), ...(window.PRESETS || [])];
  function presetServices(p) {
    const names = new Set(p.services.map((n) => n.toLowerCase()));
    return state.services.filter((s) => names.has(s.name.toLowerCase())).map((s) => {
      const k = kb(s);
      if (!k || !canEdit(s) || k.rec === 'keep' || RANK[curKey(s)] <= RANK[k.rec]) return null;
      if (k.r !== 'safe' && !p.cautious) return null;
      return { s, to: k.rec };
    }).filter(Boolean);
  }
  const presetTweaks = (p) => p.tweaks.filter((id) => TW[id] && !state.tweakApplied.get(id));
  // autostart entries a preset would turn off (safe ones only, unless the preset is marked cautious)
  const presetStartup = (p) => (p.startup ? state.startup.filter((e) => startupWants(e) && (skb(e).r === 'safe' || p.cautious)) : []);
  const presetSelected = (svc, tw, st) => (svc.length + tw.length + st.length) > 0 && svc.every(({ s, to }) => state.pending.get(s.name) === to) && tw.every((id) => state.pendingTweaks.has(id)) && st.every((e) => state.pendingStartup.get(e.id) === false);
  const presetCounts = (p) => { const svc = presetServices(p), tw = presetTweaks(p), st = presetStartup(p); return { svc, tw, st, total: svc.length + tw.length + st.length, sel: presetSelected(svc, tw, st) }; };
  const metaText = (c) => [c.svc.length ? nSvc(c.svc.length) : '', c.tw.length ? nTw(c.tw.length) : '', c.st.length ? nSt(c.st.length) : ''].filter(Boolean).join(' · ');

  function togglePreset(id) {
    const p = allPresets().find((x) => x.id === id);
    if (!p) return;
    const c = presetCounts(p);
    if (!c.total) return;
    if (c.sel) {
      c.svc.forEach(({ s }) => state.pending.delete(s.name));
      c.tw.forEach((t) => state.pendingTweaks.delete(t));
      c.st.forEach((e) => state.pendingStartup.delete(e.id));
    } else {
      c.svc.forEach(({ s, to }) => state.pending.set(s.name, to));
      c.tw.forEach((t) => state.pendingTweaks.add(t));
      c.st.forEach((e) => state.pendingStartup.set(e.id, false));
    }
    renderAll();
  }

  // ───── dashboard ─────
  function metrics() {
    const svcTodo = state.services.filter(wantsChange);
    const twTodo = Object.keys(TW).filter((id) => !state.tweakApplied.get(id));
    const safeTodo = svcTodo.filter((s) => kb(s).r === 'safe').length + twTodo.filter((id) => TW[id].r === 'safe').length;
    const doneSvc = state.services.filter((s) => { const k = kb(s); return k && k.r === 'safe' && k.rec !== 'keep' && !s.blocked && !wantsChange(s); }).length;
    const doneTw = Object.keys(TW).filter((id) => TW[id].r === 'safe' && state.tweakApplied.get(id)).length;
    const stTodo = state.startup.filter(startupWants);
    const doneSt = state.startup.filter((e) => { const k = skb(e); return k && k.r === 'safe' && k.rec === 'disable' && !e.enabled; }).length;
    const done = doneSvc + doneTw + doneSt;
    const safeAll = safeTodo + stTodo.filter((e) => skb(e).r === 'safe').length;
    const score = done + safeAll ? Math.round((100 * done) / (done + safeAll)) : 100;
    const attention = svcTodo.filter((s) => kb(s).r === 'caution').length + stTodo.filter((e) => skb(e).r === 'caution').length;
    let applied = 0;
    state.snapshots.filter((sn) => !sn.restored).forEach((sn) => {
      applied += sn.items.filter((i) => i.ok).length + tweakGroups(sn.tweaks || []).filter((t) => t.ok).length + (sn.startup || []).filter((t) => t.ok).length;
    });
    return { todo: svcTodo.length + twTodo.length + stTodo.length, score, attention, applied };
  }

  function renderDashboard() {
    const m = metrics();
    const running = state.services.filter((s) => s.state === 4).length;
    const cards = allPresets().filter((p) => p.id !== 'all').map((p) => ({ p, c: presetCounts(p) })).filter((x) => x.c.total)
      .sort((a, b) => (a.p.risk === 'safe' ? 0 : 1) - (b.p.risk === 'safe' ? 0 : 1)).slice(0, 3);
    const tint = { eye: 'ico', ads: 'ico teal', network: 'ico indigo' };
    const hist = state.snapshots.slice(0, 5).map((sn) => {
      const okS = sn.items.filter((i) => i.ok).length, okT = tweakGroups(sn.tweaks || []).filter((t) => t.ok).length, okA = (sn.startup || []).filter((t) => t.ok).length;
      const parts = [okS ? nSvc(okS) : '', okT ? nTw(okT) : '', okA ? nSt(okA) : ''].filter(Boolean).join(', ') || 'Ничего не изменено';
      return `<tr><td>${esc(parts)}</td><td>${sn.restorePoint ? 'Со снимком Windows' : 'Копия WinLite'}</td><td>${esc(new Date(sn.created * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</td><td class="r"><span class="status ${sn.restored ? 'neutral' : 'safe'}">${sn.restored ? 'Откачено' : 'Можно откатить'}</span></td></tr>`;
    }).join('');
    const verdict = m.score >= 80 ? 'Отличный результат' : m.score >= 40 ? 'Есть что улучшить' : 'Требуется внимание';
    $('dashboard').innerHTML = `
      <div class="dash">
        <div class="grid-2-1">
          <div class="card hero">
            <div>
              <span class="eyebrow">Состояние системы</span>
              <h2>${m.todo ? 'Windows можно сделать легче' : 'Система уже оптимизирована'}</h2>
              <p>${m.todo ? `WinLite нашёл <strong>${m.todo} ${plural(m.todo, 'потенциальное улучшение', 'потенциальных улучшения', 'потенциальных улучшений')}</strong>. Все изменения можно проверить перед применением и откатить в любой момент.` : 'Все рекомендованные улучшения уже применены. Если что-то изменится, WinLite подскажет.'}</p>
            </div>
            <div class="hero-foot">
              <div class="hero-actions">
                <button class="btn primary" data-goto="quick">Перейти к чистке</button>
                <button class="btn" data-goto="services">Открыть службы</button>
              </div>
              <div class="hero-note">${ic('cog', 14)} Служб запущено: ${running} из ${state.services.length}</div>
            </div>
          </div>
          <div class="card score" title="Доля применённых безопасных улучшений от всех найденных">
            <div class="ring">
              <svg viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15.9155" fill="none" stroke-width="3.4"/><circle class="fg" cx="18" cy="18" r="15.9155" fill="none" stroke-width="3.4" stroke-linecap="round" stroke-dasharray="${Math.max(m.score, 1)} 100"/></svg>
              <div class="num"><strong>${m.score}</strong><span>ИЗ 100</span></div>
            </div>
            <b>Индекс оптимизации</b><small>${verdict}</small>
          </div>
        </div>

        <div class="grid-3">
          <div class="metric"><div><small>Можно оптимизировать</small><strong>${m.todo}<em>${plural(m.todo, 'элемент', 'элемента', 'элементов')}</em></strong></div><div class="ico">${ic('sliders', 20)}</div></div>
          <div class="metric"><div><small>Изменений применено</small><strong>${m.applied}<em>${plural(m.applied, 'элемент', 'элемента', 'элементов')}</em></strong></div><div class="ico blue">${ic('check', 20)}</div></div>
          <div class="metric"><div><small>Зависят от сценария</small><strong>${m.attention}<em>${plural(m.attention, 'элемент', 'элемента', 'элементов')}</em></strong></div><div class="ico amber">${ic('alert', 20)}</div></div>
        </div>

        <div>
          <div class="sec-head"><div><span class="eyebrow">Рекомендовано</span><h3>Что можно улучшить прямо сейчас</h3></div><button class="link-btn" data-goto="quick">Все сценарии ${ic('chevron', 12)}</button></div>
          <div class="grid-3">${cards.length ? cards.map(({ p, c }, i) => `
            <article class="card action-card ${c.sel ? 'on' : ''}" data-p="${p.id}">
              <div><div class="top"><div class="${['ico', 'ico teal', 'ico indigo'][i % 3]}">${ic(p.icon, 20)}</div><span class="status ${p.risk}">${esc(p.riskLabel)}</span></div>
              <h4>${esc(p.title)}</h4><p>${esc(metaText(c))}</p></div>
              <div class="foot"><span>${c.sel ? 'Отмечено' : 'Отметить'}</span>${ic(c.sel ? 'check' : 'chevron', 13)}</div></article>`).join('') : '<div class="card hist-empty" style="grid-column:1/-1">Рекомендованных сценариев не осталось.</div>'}</div>
        </div>

        <div>
          <div class="sec-head"><div><span class="eyebrow">История</span><h3>Последние действия</h3></div>${state.snapshots.length ? `<button class="link-btn" data-goto="backups">Все копии ${ic('chevron', 12)}</button>` : ''}</div>
          <div class="card hist">${hist ? `<table><thead><tr><th>Действие</th><th>Тип копии</th><th>Время</th><th class="r">Статус</th></tr></thead><tbody>${hist}</tbody></table>` : '<div class="hist-empty">Пока ничего не применялось. Здесь появятся ваши изменения.</div>'}</div>
        </div>
      </div>`;
  }

  // ───── sidebar: badges, system card, collapse ─────
  function renderSide() {
    const rec = state.services.filter(wantsChange).length;
    const twTodo = Object.keys(TW).filter((id) => !state.tweakApplied.get(id)).length;
    $('badgeServices').textContent = rec || '';
    $('badgePrivacy').textContent = twTodo || '';
    $('badgeStartup').textContent = state.startup.filter(startupWants).length || '';
    $('backupCount').textContent = state.snapshots.length || '';
    const s = state.sys;
    if (s) {
      $('sysOs').textContent = (s.os || 'Windows').replace(/^Windows /, 'Win ') + (s.version ? ' ' + s.version : '');
      $('sysOs').title = (s.os || '') + (s.version ? ' ' + s.version : '');
      $('sysRam').textContent = s.ramTotal ? `${Math.round(s.ramTotal / 2 ** 30)} ГБ · ${s.ramUsedPct}%` : '—';
      $('sysBar').style.width = (s.ramUsedPct || 0) + '%';
    }
    if (state.app) $('verText').textContent = `v${state.app.version} · сборка ${state.app.build}`;
    const run = state.services.filter((x) => x.state === 4).length;
    $('sysSvc').textContent = state.services.length ? `${run} из ${state.services.length}` : '—';
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  function setCollapsed(c, remember) {
    document.body.classList.toggle('collapsed', c);
    $('collapseBtn').title = c ? 'Развернуть панель' : 'Свернуть панель';
    if (remember) store.set('winlite.collapsed', c ? '1' : '0');
  }


  // ───── quick cleanup ─────
  function renderScenarios() {
    $('scenarioGrid').innerHTML = allPresets().map((p) => {
      const c = presetCounts(p);
      return `<article class="scenario-card card ${c.sel ? 'selected' : ''} ${c.total ? '' : 'done'}" data-p="${p.id}">
        <div class="scenario-top"><div class="ico">${ic(p.icon, 20)}</div><div class="check">${ic('check', 14)}</div></div>
        <h3>${esc(p.title)}</h3><p>${esc(p.desc)}</p>
        ${p.warn ? `<div class="warn-line">${ic('alert', 14)}<span>${esc(p.warn)}</span></div>` : ''}
        <div class="scenario-meta"><span>${c.total ? esc(metaText(c)) : 'Уже применено'}</span><span class="risk ${p.risk}">${esc(p.riskLabel)}</span></div></article>`;
    }).join('');
  }

  function renderTweaks() {
    const groups = window.TWEAK_GROUPS || {};
    $('tweakList').innerHTML = Object.keys(groups).map((g) => {
      const items = Object.entries(TW).filter(([, t]) => t.g === g);
      return `<div class="tw-group">${ic(groups[g].icon, 16)} ${esc(groups[g].t)}</div>` + items.map(([id, t]) => {
        const applied = !!state.tweakApplied.get(id);
        const on = state.pendingTweaks.has(id);
        return `<label class="tw card ${on ? 'on' : ''} ${applied ? 'applied' : ''}" data-id="${id}">
          <input type="checkbox" ${on ? 'checked' : ''} ${applied ? 'disabled' : ''}>
          <div><div class="tt">${esc(t.t)} ${applied ? '<span class="status safe">Уже применено</span>' : t.r === 'caution' ? '<span class="status warn">Меняет поведение</span>' : ''}</div>
          <div class="dd">${esc(t.d)}</div><div class="off"><b>Последствия:</b> ${esc(t.off)}</div></div></label>`;
      }).join('');
    }).join('');
  }

  // ───── services ─────
  function visible() {
    const q = state.query.trim().toLowerCase();
    return state.services.filter((s) => {
      if (state.filter === 'known' && !kb(s)) return false;
      if (state.filter === 'rec' && !wantsChange(s)) return false;
      if (state.filter === 'running' && s.state !== 4) return false;
      if (state.filter === 'mine' && !state.pending.has(s.name)) return false;
      if (!q) return true;
      const k = kb(s);
      return (s.display + ' ' + s.name + ' ' + s.description + ' ' + (k ? k.t + ' ' + k.d : '')).toLowerCase().includes(q);
    });
  }

  function renderStats() {
    const total = state.services.length;
    const running = state.services.filter((s) => s.state === 4).length;
    const known = state.services.filter((s) => kb(s)).length;
    const rec = state.services.filter(wantsChange).length;
    $('stats').innerHTML =
      `<div class="stat-chip"><strong>${total}</strong><span>служб</span></div>` +
      `<div class="stat-chip"><strong>${running}</strong><span>работают</span></div>` +
      `<div class="stat-chip"><strong>${known}</strong><span>с описанием</span></div>` +
      `<div class="stat-chip accent"><strong>${rec}</strong><span>можно оптимизировать</span></div>`;
  }

  const optionsFor = (s, pend) => '<option value="">Не менять</option>' + ['auto', 'delayed', 'manual', 'disabled'].filter((o) => o !== curKey(s))
    .map((o) => `<option value="${o}" ${pend === o ? 'selected' : ''}>${LABEL[o]}</option>`).join('');

  function rowHtml(s) {
    const k = kb(s);
    const r = risk(s);
    const pend = state.pending.get(s.name) || '';
    const editable = canEdit(s);
    const rec = k ? (k.rec !== 'keep' ? `<span class="recommend ${r === 'safe' ? 'safe' : 'warn'}">${REC[k.rec]}</span>` : '<span class="recommend keep">Оставить</span>') : '<span class="recommend none">Нет данных</span>';
    const tip = editable ? '' : s.blocked ? 'Системная служба: WinLite её не меняет' : 'Нет данных о службе. Включите расширенный режим внизу.';
    return `<div class="service-row ${state.selected === s.name ? 'active' : ''} ${pend ? 'chg' : ''}" data-n="${esc(s.name)}">
      <div class="service-title"><span class="sdot ${r}" title="${esc(RISK[r] || 'Нет данных')}"></span><div class="service-name"><strong>${esc(k ? k.t : s.display)}</strong><small>${esc(s.name)}</small></div></div>
      <div class="state ${s.state === 4 ? 'running' : ''}">${s.state === 4 ? 'Работает' : 'Остановлена'}</div>
      <div class="start-type">${LABEL[curKey(s)]}</div>
      <div>${rec}</div>
      <select class="select-control" ${editable ? '' : 'disabled'} title="${esc(tip)}">${optionsFor(s, pend)}</select>
    </div>`;
  }

  function renderRows() {
    const list = visible();
    $('rows').innerHTML = list.map(rowHtml).join('');
    $('empty').hidden = list.length > 0;
  }

  function renderDetail() {
    const s = state.services.find((x) => x.name === state.selected);
    const el = $('detail');
    if (!s) { el.innerHTML = `<div class="empty-inspector"><div class="empty-icon">${ic('info', 24)}</div><h3>Выберите службу</h3><p>Здесь появится описание, рекомендация и последствия изменения.</p></div>`; return; }
    const k = kb(s);
    const r = risk(s);
    const pend = state.pending.get(s.name) || '';
    const active = s.dependents.filter((d) => { const x = state.services.find((y) => y.name === d); return x && x.start !== 4; });
    let rec;
    if (s.blocked) rec = `<div class="recommend-box lock"><strong>${ic('lock', 14)} Системная служба</strong>WinLite её не изменяет: отключение может нарушить загрузку, сеть или безопасность Windows.</div>`;
    else if (k) rec = `<div class="recommend-box ${k.r === 'safe' ? 'safe' : k.rec === 'keep' ? 'neutral' : ''}"><strong>${esc(k.rec === 'keep' ? 'Оставить как есть' : REC[k.rec])} · ${esc(RISK[k.r])}</strong>${esc(k.off || '')}${k.who ? '<br><span class="sub">' + esc(k.who) + '</span>' : ''}</div>`;
    else rec = `<div class="recommend-box"><strong>${ic('alert', 14)} Нет данных</strong>Этой службы нет в базе WinLite, описание взято из Windows. Без понимания, что она делает, менять её не стоит.<br><button class="btn sm" id="webSearch" style="margin-top:10px">${ic('search', 14)} Найти в интернете</button></div>`;
    el.innerHTML = `
      <span class="eyebrow">СЛУЖБА</span>
      <div class="insp-head">${state.icons.has('service:' + s.name) ? `<img src="${state.icons.get('service:' + s.name)}" alt="" width="36" height="36">` : ''}<div><h2>${esc(k ? k.t : s.display)}</h2><div class="service-key">${esc(s.name)}</div></div></div>
      <div class="inspector-section first"><span class="inspector-label">ЧТО ЭТО</span><p>${esc(k ? k.d : s.description || 'Описание отсутствует.')}</p>
        ${k && s.description && k.d !== s.description ? `<p class="sub" style="margin-top:8px">Описание Windows: ${esc(s.description)}</p>` : ''}</div>
      <div class="inspector-section"><span class="inspector-label">СОСТОЯНИЕ</span>
        <div class="fact-row"><span>Сейчас</span><strong>${s.state === 4 ? 'Работает' + (s.pid ? ' · PID ' + s.pid : '') : 'Остановлена'}</strong></div>
        <div class="fact-row"><span>Тип запуска</span><strong>${LABEL[curKey(s)]}</strong></div>
        <div class="fact-row"><span>Риск</span><strong>${esc(RISK[r] || 'Нет данных')}</strong></div></div>
      <div class="inspector-section"><span class="inspector-label">РЕКОМЕНДАЦИЯ WINLITE</span>${rec}</div>
      ${s.dependents.length || s.dependsOn.length ? `<div class="inspector-section"><span class="inspector-label">ЗАВИСИМОСТИ</span>
        ${s.dependents.length ? `<div class="deps"><b>Зависят от неё:</b> ${s.dependents.map(esc).join(', ')}</div>${active.length ? `<div class="recommend-box" style="margin-top:8px">Отключение может затронуть перечисленные службы.</div>` : ''}` : ''}
        ${s.dependsOn.length ? `<div class="deps" style="margin-top:8px"><b>Сама зависит от:</b> ${s.dependsOn.map(esc).join(', ')}</div>` : ''}</div>` : ''}
      <div class="inspector-section"><span class="inspector-label">ИЗМЕНИТЬ ТИП ЗАПУСКА</span>
        <select class="select-control ${pend ? 'chg' : ''}" id="inspSel" ${canEdit(s) ? '' : 'disabled'}>${optionsFor(s, pend)}</select></div>
      ${s.imagePath ? `<div class="inspector-section"><span class="inspector-label">ФАЙЛ</span><div class="code">${esc(s.imagePath)}</div></div>` : ''}`;
  }

  // ───── web search for services missing from the knowledge base ─────
  function searchQuery(s) {
    const m = /([^\\/"]+\.exe)/i.exec(s.imagePath || '');
    const exe = m && !/^svchost\.exe$/i.test(m[1]) ? m[1] : '';
    return [s.display, s.display.toLowerCase() === s.name.toLowerCase() ? '' : s.name, exe, 'служба Windows что это'].filter(Boolean).join(' ');
  }
  async function openSearch(query) {
    const url = 'https://www.google.com/search?q=' + encodeURIComponent(query).replace(/%20/g, '+');
    try { if (tauri) await invoke('open_url', { url }); else window.open(url, '_blank'); } catch (e) { toast(String(e), true); }
  }
  function webSearch() {
    const s = state.services.find((x) => x.name === state.selected);
    if (s) openSearch(searchQuery(s));
  }

  // ───── autostart ─────
  function renderStartup() {
    const list = state.startup;
    const on = list.filter((e) => e.enabled).length;
    const rec = list.filter(startupWants).length;
    $('startupStats').innerHTML =
      `<div class="stat-chip"><strong>${list.length}</strong><span>в автозагрузке</span></div>` +
      `<div class="stat-chip"><strong>${on}</strong><span>включено</span></div>` +
      `<div class="stat-chip accent"><strong>${rec}</strong><span>можно отключить</span></div>`;
    if (!list.length) { $('startupList').innerHTML = '<div class="empty-b">Элементов автозагрузки не найдено.</div>'; return; }
    const sorted = [...list].sort((a, b) => (b.enabled - a.enabled) || a.name.localeCompare(b.name));
    $('startupList').innerHTML = sorted.map((e) => {
      const k = skb(e), target = startupTarget(e), changed = state.pendingStartup.has(e.id), locked = startupLocked(e);
      const r = k ? k.r : 'unknown';
      const rec = k ? (k.rec === 'disable' && k.r !== 'critical' ? `<span class="status ${k.r === 'safe' ? 'safe' : 'warn'}">${k.r === 'safe' ? 'Можно отключить' : 'Зависит от вас'}</span>` : '<span class="status neutral">Оставить</span>') : '<span class="status neutral">Нет данных</span>';
      return `<div class="st-row card ${changed ? 'changed' : ''} ${target ? '' : 'off'}" data-id="${esc(e.id)}">
        ${state.icons.has('startup:' + e.id)
          ? `<div class="ico has-img"><img src="${state.icons.get('startup:' + e.id)}" alt="" width="30" height="30"></div>`
          : `<div class="ico ${r === 'safe' ? '' : r === 'caution' ? 'amber' : r === 'critical' ? 'blue' : ''}">${ic(locked ? 'lock' : 'power', 20)}</div>`}
        <div class="st-main">
          <div class="st-title">${esc(startupTitle(e))} ${rec}${changed ? '<span class="status safe">Будет ' + (target ? 'включена' : 'отключена') + '</span>' : ''}</div>
          <div class="st-desc">${esc(k ? k.d : 'Этой программы нет в базе WinLite. Если не уверены, что это, найдите её в интернете.')}</div>
          ${k && k.off ? `<div class="st-off"><b>Если отключить:</b> ${esc(k.off)}</div>` : ''}
          <div class="st-cmd"><span class="tag">${esc(e.location)}</span><code title="${esc(e.command)}">${esc(e.command)}</code></div>
        </div>
        <div class="st-side">
          ${k ? '' : `<button class="btn sm" data-search="${esc(e.id)}">${ic('search', 14)} Найти</button>`}
          <label class="switch" title="${locked ? 'Системный элемент: WinLite его не меняет' : target ? 'Включена: нажмите, чтобы отключить' : 'Отключена: нажмите, чтобы включить'}"><input type="checkbox" ${target ? 'checked' : ''} ${locked ? 'disabled' : ''}><i></i></label>
        </div></div>`;
    }).join('');
  }

  // ───── bar / backups ─────
  function renderBar() {
    const sv = state.pending.size, tw = state.pendingTweaks.size, st = state.pendingStartup.size, n = sv + tw + st;
    $('selectedCount').textContent = n;
    $('selectedTweaks').textContent = tw;
    $('selectedStartup').textContent = st;
    $('bar').classList.toggle('show', n > 0 && state.view !== 'backups');
    $('barCount').textContent = n;
    $('barTitle').textContent = [sv ? nSvc(sv) : '', tw ? nTw(tw) : '', st ? nSt(st) : ''].filter(Boolean).join(' · ') || 'Ничего не выбрано';
  }

  function tweakGroups(items) {
    const m = new Map();
    items.forEach((t) => { const g = m.get(t.id) || { id: t.id, ok: true, n: 0, err: null }; g.n++; if (!t.ok) { g.ok = false; g.err = g.err || t.error; } m.set(t.id, g); });
    return [...m.values()];
  }

  function renderBackups() {
    $('backupCount').textContent = state.snapshots.length || '';
    if (!state.snapshots.length) { $('backupList').innerHTML = '<div class="empty-b">Копий пока нет. Они появятся после первого применения изменений.</div>'; return; }
    $('backupList').innerHTML = state.snapshots.map((sn) => {
      const tws = tweakGroups(sn.tweaks || []);
      const okSvc = sn.items.filter((i) => i.ok).length;
      const okTw = tws.filter((t) => t.ok).length;
      const sts = sn.startup || [];
      const okSt = sts.filter((t) => t.ok).length;
      const date = new Date(sn.created * 1000).toLocaleString('ru-RU');
      const items = sn.items.map((i) =>
        `<li class="${i.ok ? '' : 'bad'}">${esc(KB[i.name.toLowerCase()]?.t || i.display)}: ${i.ok ? esc(LABEL[startKeyOf(i.beforeStart, i.beforeDelayed)]) + ' → ' + esc(LABEL[i.after]) : 'не изменено (' + esc(i.error || '?') + ')'}</li>`).join('') +
        tws.map((t) => `<li class="${t.ok ? '' : 'bad'}">Настройка «${esc(TW[t.id]?.t || t.id)}»: ${t.ok ? 'применена' : 'не применена (' + esc(t.err || '?') + ')'}</li>`).join('') +
        sts.map((t) => `<li class="${t.ok ? '' : 'bad'}">Автозагрузка «${esc(t.name || t.id)}»: ${t.ok ? (t.beforeEnabled ? 'Включена' : 'Отключена') + ' → ' + (t.afterEnabled ? 'Включена' : 'Отключена') : 'не изменено (' + esc(t.error || '?') + ')'}</li>`).join('');
      return `<div class="snap card" data-id="${sn.id}">
        <div class="row"><span class="when">${esc(date)}</span>
          <span class="status neutral">${[okSvc ? nSvc(okSvc) : '', okTw ? nTw(okTw) : '', okSt ? nSt(okSt) : ''].filter(Boolean).join(' · ') || 'без изменений'}</span>
          ${sn.restorePoint ? '<span class="status safe">Точка восстановления Windows</span>' : sn.restoreStatus === 'skipped' ? '<span class="status warn" title="Windows создаёт не больше одной точки в сутки">Точка Windows пропущена</span>' : sn.restoreStatus === 'failed' ? '<span class="status warn">Точка Windows не создана</span>' : ''}
          ${sn.restored ? `<span class="status safe">Откачено ${esc(new Date(sn.restored * 1000).toLocaleString('ru-RU'))}</span>` : ''}
          <div class="grow"></div>
          <button class="btn sm" data-a="restore" ${state.admin ? '' : 'disabled'}>Откатить</button>
          <button class="btn sm danger" data-a="delete">Удалить</button></div>
        <ul>${items}</ul></div>`;
    }).join('');
  }

  function renderAll() { renderSide(); renderDashboard(); renderScenarios(); renderTweaks(); renderStartup(); renderStats(); renderRows(); renderDetail(); renderBar(); renderBackups(); }

  // ───── apply flow ─────
  const pendingList = () => [...state.pending.entries()].map(([name, to]) => ({ s: state.services.find((x) => x.name === name), to })).filter((x) => x.s);
  const dotCls = (r) => (r === 'safe' ? 'safe' : r === 'caution' ? 'caution' : r === 'critical' ? 'critical' : '');

  function openReview() {
    const list = pendingList();
    const tws = [...state.pendingTweaks].filter((id) => TW[id]);
    const sts = [...state.pendingStartup.entries()].map(([id, to]) => ({ e: state.startup.find((x) => x.id === id), to })).filter((x) => x.e);
    if (!list.length && !tws.length && !sts.length) return;
    const disabling = new Set(list.filter((x) => x.to === 'disabled').map((x) => x.s.name.toLowerCase()));
    const warns = [];
    list.filter((x) => x.to === 'disabled').forEach(({ s }) => {
      const affected = s.dependents.filter((d) => { const x = state.services.find((y) => y.name === d); return x && x.start !== 4 && !disabling.has(d.toLowerCase()); });
      if (affected.length) warns.push(`<b>${esc(kb(s)?.t || s.display)}</b>: от неё зависят ${esc(affected.join(', '))}`);
    });
    tws.filter((id) => TW[id].r === 'caution').forEach((id) => warns.push(`<b>${esc(TW[id].t)}</b>: ${esc(TW[id].off)}`));
    const unknown = list.filter((x) => !kb(x.s)).length;
    $('mTitle').textContent = 'Проверьте изменения';
    $('mBody').innerHTML =
      '<p class="sub">Перед изменениями WinLite сохранит текущее состояние. Отменить можно на вкладке «Резервные копии».</p>' +
      (unknown ? `<div class="mwarn">Среди выбранных ${nSvc(unknown)} без описания в базе. Вы меняете их на свой риск.</div>` : '') +
      (warns.length ? `<div class="mwarn">Обратите внимание:<ul>${warns.map((w) => `<li>${w}</li>`).join('')}</ul></div>` : '') +
      '<ul class="chg-list">' +
      (list.length ? '<li class="sec">Службы</li>' + list.map(({ s, to }) =>
        `<li><span class="sdot ${dotCls(risk(s))}"></span><div><div class="nm">${esc(kb(s)?.t || s.display)}</div><div class="sub">${esc(s.name)}</div></div><div class="grow"></div><span>${LABEL[curKey(s)]} <span class="arrow">→</span> <b>${LABEL[to]}</b></span></li>`).join('') : '') +
      (tws.length ? '<li class="sec">Настройки Windows</li>' + tws.map((id) =>
        `<li><span class="sdot ${dotCls(TW[id].r)}"></span><div><div class="nm">${esc(TW[id].t)}</div><div class="sub">${esc(TW[id].d)}</div></div></li>`).join('') : '') +
      (sts.length ? '<li class="sec">Автозагрузка</li>' + sts.map(({ e, to }) =>
        `<li><span class="sdot ${dotCls(skb(e)?.r)}"></span><div><div class="nm">${esc(startupTitle(e))}</div><div class="sub">${esc(e.location)}</div></div><div class="grow"></div><span>${e.enabled ? 'Включена' : 'Отключена'} <span class="arrow">→</span> <b>${to ? 'Включена' : 'Отключена'}</b></span></li>`).join('') : '') +
      '</ul>';
    $('mOk').textContent = 'Применить';
    $('mOk').disabled = !state.admin;
    $('mOk').onclick = doApply;
    $('mRpWrap').hidden = false;
    $('mCancel').hidden = false;
    $('modal').hidden = false;
  }

  async function doApply() {
    const changes = pendingList().map(({ s, to }) => ({ name: s.name, start: to }));
    const tweaks = [...state.pendingTweaks].filter((id) => TW[id]);
    const startup = [...state.pendingStartup.entries()].map(([id, enabled]) => ({ id, enabled }));
    $('mOk').disabled = true;
    $('mOk').textContent = 'Применяю…';
    try {
      const res = await invoke('apply_changes', { changes, tweaks, startup, restorePoint: $('mRp').checked });
      const bad = res.items.filter((i) => !i.ok);
      const tg = tweakGroups(res.tweaks || []);
      const stBad = (res.startup || []).filter((t) => !t.ok);
      $('mTitle').textContent = 'Готово: ' + [
        res.items.length ? `${res.items.length - bad.length} из ${res.items.length} служб` : '',
        tg.length ? `${tg.filter((t) => t.ok).length} из ${tg.length} настроек` : '',
        (res.startup || []).length ? `${res.startup.length - stBad.length} из ${res.startup.length} в автозагрузке` : '',
      ].filter(Boolean).join(', ');
      $('mBody').innerHTML =
        '<p class="res-ok">Изменения сохранены в копию.</p>' +
        ({
          created: '<p class="res-ok">Точка восстановления Windows создана.</p>',
          skipped: '<div class="mwarn">Точка восстановления Windows <b>не создана</b>: Windows создаёт не больше одной точки в сутки, а свежая уже есть. Откат через копию WinLite доступен на вкладке «Резервные копии».</div>',
          failed: '<div class="mwarn">Точку восстановления Windows <b>создать не удалось</b> (возможно, отключена защита системы). Откат через копию WinLite доступен на вкладке «Резервные копии».</div>',
        }[res.restoreStatus] || '') +
        (bad.length || tg.some((t) => !t.ok) || stBad.length ? '<p class="res-bad">Не удалось применить:</p><ul class="chg-list">' +
          bad.map((i) => `<li><b>${esc(i.display)}</b><span class="sub">${esc(i.error)}</span></li>`).join('') +
          tg.filter((t) => !t.ok).map((t) => `<li><b>${esc(TW[t.id]?.t || t.id)}</b><span class="sub">${esc(t.err)}</span></li>`).join('') +
          stBad.map((t) => `<li><b>${esc(t.name || t.id)}</b><span class="sub">${esc(t.error)}</span></li>`).join('') + '</ul>' : '') +
        '<p class="sub">Отключённые службы остановятся сразу. Часть настроек (например, реклама в «Пуске») подхватится после перезапуска проводника или перезагрузки. Программы автозагрузки перестанут стартовать со следующего входа в систему.</p>';
      $('mRpWrap').hidden = true;
      $('mOk').textContent = 'Закрыть';
      $('mOk').disabled = false;
      $('mOk').onclick = closeModal;
      $('mCancel').hidden = true;
      res.items.filter((i) => i.ok).forEach((i) => state.pending.delete(i.name));
      tg.filter((t) => t.ok).forEach((t) => state.pendingTweaks.delete(t.id));
      (res.startup || []).filter((t) => t.ok).forEach((t) => state.pendingStartup.delete(t.id));
      await load();
    } catch (e) {
      $('mOk').disabled = false;
      $('mOk').textContent = 'Применить';
      toast(String(e), true);
    }
  }
  function closeModal() { $('modal').hidden = true; $('mCancel').hidden = false; }

  // ───── about / diagnostics (copied by the user, never sent anywhere) ─────
  function diagnostics() {
    const a = state.app || {}, s = state.sys || {};
    const run = state.services.filter((x) => x.state === 4).length;
    return [
      `WinLite ${a.version || '?'} (сборка ${a.build || '?'})`,
      `ОС: ${s.os || '?'} ${s.version || ''}`.trim() + `, ОЗУ ${s.ramTotal ? Math.round(s.ramTotal / 2 ** 30) + ' ГБ' : '?'}`,
      `Права администратора: ${state.admin ? 'да' : 'нет'}`,
      `Служб: ${state.services.length} (запущено ${run}), автозагрузка: ${state.startup.length}, копий: ${state.snapshots.length}`,
    ].join('\n');
  }
  function openAbout() {
    const a = state.app || {}, s = state.sys || {};
    $('mTitle').textContent = 'О программе';
    $('mBody').innerHTML = `
      <div class="about-head"><img src="logo.png" alt=""><div><b>WinLite</b><span>Оптимизатор Windows · бета-версия</span></div></div>
      <div class="about-facts">
        <div class="fact"><span>Версия</span><b>${esc(a.version || '—')}</b></div>
        <div class="fact"><span>Номер сборки</span><b>${esc(a.build || '—')}</b></div>
        <div class="fact"><span>Система</span><b>${esc((s.os || '—') + (s.version ? ' ' + s.version : ''))}</b></div>
        <div class="fact"><span>Права</span><b>${state.admin ? 'Администратор' : 'Только просмотр'}</b></div>
      </div>
      <p class="about-note">WinLite не отправляет никаких данных: ни телеметрии, ни отчётов. Если нужна помощь, нажмите «Скопировать сведения» и приложите текст к сообщению об ошибке. Копии изменений лежат в <code>%APPDATA%\\WinLite\\snapshots</code>.</p>`;
    $('mRpWrap').hidden = true;
    $('mCancel').hidden = false; $('mCancel').textContent = 'Закрыть';
    $('mOk').disabled = false; $('mOk').textContent = 'Скопировать сведения';
    $('mOk').onclick = async () => {
      try { await navigator.clipboard.writeText(diagnostics()); toast('Сведения скопированы в буфер обмена'); } catch { toast('Не удалось скопировать. Выделите текст вручную.', true); }
    };
    $('modal').hidden = false;
  }

  async function restore(id) {
    if (!confirm('Вернуть службы и настройки из этой копии к прежним значениям?')) return;
    try {
      const r = await invoke('restore_snapshot', { id });
      toast(`Восстановлено: ${r.restored}` + (r.failed.length ? `. Не удалось: ${r.failed.join('; ')}` : ''), r.failed.length > 0);
      await load();
    } catch (e) { toast(String(e), true); }
  }
  async function removeSnap(id) {
    if (!confirm('Удалить эту копию? Откатиться к ней потом будет нельзя.')) return;
    try { await invoke('delete_snapshot', { id }); await load(); } catch (e) { toast(String(e), true); }
  }

  // ───── misc ─────
  let toastTimer;
  function toast(msg, err) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), err ? 8000 : 4000);
  }

  function setView(v) {
    state.view = v;
    document.querySelectorAll('.view').forEach((x) => x.classList.toggle('active', x.id === 'view-' + v));
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    renderBar();
  }

  // ───── events ─────
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('.nav-item'); if (b) setView(b.dataset.view); });
  $('dashboard').addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]'); if (g) { setView(g.dataset.goto); return; }
    const c = e.target.closest('.action-card'); if (c) togglePreset(c.dataset.p);
  });
  $('collapseBtn').addEventListener('click', () => setCollapsed(!document.body.classList.contains('collapsed'), true));
  const narrow = window.matchMedia('(max-width: 1280px)');
  setCollapsed(store.get('winlite.collapsed') === null ? narrow.matches : store.get('winlite.collapsed') === '1', false);
  narrow.addEventListener('change', (e) => { if (store.get('winlite.collapsed') === null) setCollapsed(e.matches, false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('modal').hidden) closeModal();
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && $('modal').hidden) { e.preventDefault(); setView('services'); $('search').focus(); }
  });
  $('scenarioGrid').addEventListener('click', (e) => { const c = e.target.closest('.scenario-card'); if (c) togglePreset(c.dataset.p); });
  $('tweakList').addEventListener('change', (e) => {
    const lab = e.target.closest('.tw'); if (!lab) return;
    if (e.target.checked) state.pendingTweaks.add(lab.dataset.id); else state.pendingTweaks.delete(lab.dataset.id);
    lab.classList.toggle('on', e.target.checked);
    renderBar(); renderScenarios(); renderDashboard();
  });
  $('startupList').addEventListener('change', (e) => {
    const row = e.target.closest('.st-row'); if (!row) return;
    const ent = state.startup.find((x) => x.id === row.dataset.id); if (!ent) return;
    if (e.target.checked === ent.enabled) state.pendingStartup.delete(ent.id); else state.pendingStartup.set(ent.id, e.target.checked);
    renderStartup(); renderBar(); renderScenarios(); renderDashboard();
  });
  $('startupList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-search]'); if (!b) return;
    const ent = state.startup.find((x) => x.id === b.dataset.search);
    if (ent) openSearch([ent.name, exeOf(ent.command), 'автозагрузка что это'].filter(Boolean).join(' '));
  });
  $('search').addEventListener('input', (e) => { state.query = e.target.value; renderRows(); });
  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.filter = b.dataset.f;
    document.querySelectorAll('#filters button').forEach((x) => x.classList.toggle('active', x === b));
    renderRows();
  });
  $('expert').addEventListener('change', (e) => {
    state.expert = e.target.checked;
    if (!state.expert) state.services.filter((s) => !kb(s)).forEach((s) => state.pending.delete(s.name));
    renderAll();
  });
  $('rows').addEventListener('click', (e) => {
    const row = e.target.closest('.service-row'); if (!row || e.target.closest('select')) return;
    state.selected = row.dataset.n;
    document.querySelectorAll('#rows .service-row.active').forEach((x) => x.classList.remove('active'));
    row.classList.add('active');
    renderDetail();
    ensureIcons('service', [state.selected]);
  });
  const setPending = (name, val) => { if (val) state.pending.set(name, val); else state.pending.delete(name); };
  $('rows').addEventListener('change', (e) => {
    const sel = e.target.closest('select'); if (!sel) return;
    const row = sel.closest('.service-row');
    setPending(row.dataset.n, sel.value);
    row.classList.toggle('chg', !!sel.value);
    if (state.selected === row.dataset.n) renderDetail();
    renderBar(); renderScenarios(); renderDashboard();
  });
  $('detail').addEventListener('click', (e) => { if (e.target.closest('#webSearch')) webSearch(); });
  $('detail').addEventListener('change', (e) => {
    if (e.target.id !== 'inspSel' || !state.selected) return;
    setPending(state.selected, e.target.value);
    e.target.classList.toggle('chg', !!e.target.value);
    renderRows(); renderBar(); renderScenarios(); renderDashboard();
  });
  $('clearPending').addEventListener('click', () => { state.pending.clear(); state.pendingTweaks.clear(); state.pendingStartup.clear(); renderAll(); });
  $('review').addEventListener('click', openReview);
  $('mCancel').addEventListener('click', closeModal);
  $('verBtn').addEventListener('click', openAbout);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  $('rescan').addEventListener('click', async () => { $('rescan').classList.add('spin'); await load(); setTimeout(() => $('rescan').classList.remove('spin'), 500); });
  $('backupList').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const id = b.closest('.snap').dataset.id;
    if (b.dataset.a === 'restore') restore(id); else if (b.dataset.a === 'delete') removeSnap(id);
  });

  // ───── mock backend (browser preview only) ─────
  function mockInvoke(cmd, args) {
    const M = (window.__mock = window.__mock || {
      admin: true,
      snaps: [],
      tw: Object.fromEntries(Object.keys(TW).map((id) => [id, id === 'tel_input'])),
      startup: [
        ['hkcu_run|Steam', 'Steam', '"G:\\steam\\steam.exe" -silent', 'Реестр · текущий пользователь', true],
        ['hkcu_run|Docker Desktop', 'Docker Desktop', 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', 'Реестр · текущий пользователь', true],
        ['hkcu_run|Spotify', 'Spotify', 'C:\\Users\\me\\AppData\\Roaming\\Spotify\\Spotify.exe --autostart', 'Реестр · текущий пользователь', true],
        ['hkcu_run|MyApp Updater', 'MyApp Updater', 'C:\\Users\\me\\AppData\\Roaming\\MyApp\\updater.exe', 'Реестр · текущий пользователь', true],
        ['hklm_run|SecurityHealth', 'SecurityHealth', '%windir%\\system32\\SecurityHealthSystray.exe', 'Реестр · все пользователи', true],
        ['hklm_run32|SunJavaUpdateSched', 'SunJavaUpdateSched', '"C:\\Program Files (x86)\\Common Files\\Java\\Java Update\\jusched.exe"', 'Реестр · 32-бит, все пользователи', false],
      ].map(([id, name, command, location, enabled]) => ({ id, name, command, location, enabled, machine: location.includes('все') })),
      svcs: [
        ['DiagTrack', 'Функциональность для подключённых пользователей и телеметрия', 2, 4, 'Служба DiagTrack.'],
        ['dmwappushservice', 'dmwappushsvc', 3, 1, ''],
        ['WerSvc', 'Служба регистрации ошибок Windows', 3, 1, ''],
        ['SysMain', 'SysMain', 2, 4, 'Поддерживает и улучшает производительность системы.'],
        ['WSearch', 'Windows Search', 2, 4, 'Индексирование контента.'],
        ['Spooler', 'Диспетчер печати', 2, 4, 'Эта служба ставит задания печати в очередь.'],
        ['XblAuthManager', 'Диспетчер проверки подлинности Xbox Live', 3, 1, ''],
        ['Fax', 'Факс', 3, 1, ''],
        ['MapsBroker', 'Диспетчер скачанных карт', 2, 1, ''],
        ['TermService', 'Службы удалённых рабочих столов', 3, 4, ''],
        ['Dnscache', 'DNS-клиент', 2, 4, 'Кэширует имена DNS.'],
        ['RpcSs', 'Удалённый вызов процедур (RPC)', 2, 4, ''],
        ['SomeVendorUpdater', 'Some Vendor Updater', 2, 4, 'Обновляет продукт вендора.'],
      ].map(([name, display, start, st, description]) => ({ name, display, description, start, delayed: false, state: st, pid: st === 4 ? 1000 + name.length : 0, imagePath: 'C:\\Windows\\system32\\svchost.exe -k netsvcs', dependsOn: name === 'TermService' ? ['RpcSs'] : [], dependents: name === 'RpcSs' ? ['TermService'] : [], blocked: ['Dnscache', 'RpcSs'].includes(name) })),
    });
    switch (cmd) {
      case 'is_admin': return Promise.resolve(M.admin);
      case 'entry_icons': {
        // neutral letter tiles stand in for real exe icons in the browser preview
        const tile = (id) => {
          const name = id.split('|').pop(), hue = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="hsl(${hue} 42% 42%)"/><text x="16" y="22.5" font-size="17" font-family="Segoe UI,Arial,sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${name[0].toUpperCase()}</text></svg>`;
          return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
        };
        return Promise.resolve(Object.fromEntries(args.ids.filter((id) => !/MyApp|SecurityHealth/.test(id)).map((id) => [id, tile(id)])));
      }
      case 'app_info': return Promise.resolve({ version: '0.2.0', build: '20261006' });
      case 'system_info': return Promise.resolve({ os: 'Windows 11 Pro', version: '24H2', ramTotal: 17179869184, ramUsedPct: 42 });
      case 'scan_services': return Promise.resolve(JSON.parse(JSON.stringify(M.svcs)));
      case 'list_snapshots': return Promise.resolve(JSON.parse(JSON.stringify(M.snaps)));
      case 'scan_startup': return Promise.resolve(JSON.parse(JSON.stringify(M.startup)));
      case 'list_tweaks': return Promise.resolve(Object.entries(M.tw).map(([id, applied]) => ({ id, applied })));
      case 'apply_changes': {
        const items = args.changes.map((c) => {
          const s = M.svcs.find((x) => x.name === c.name);
          const it = { name: c.name, display: s.display, beforeStart: s.start, beforeDelayed: s.delayed, beforeRunning: s.state === 4, after: c.start, ok: !s.blocked, error: s.blocked ? 'Служба входит в защищённый список' : null };
          if (!s.blocked) { s.start = c.start === 'auto' || c.start === 'delayed' ? 2 : c.start === 'manual' ? 3 : 4; s.delayed = c.start === 'delayed'; if (c.start === 'disabled') s.state = 1; }
          return it;
        });
        const tweaks = args.tweaks.map((id) => { M.tw[id] = true; return { id, hive: 'HKCU', path: 'x', name: 'v', before: null, after: 0, ok: true, error: null }; });
        const startup = (args.startup || []).map((c) => {
          const e = M.startup.find((x) => x.id === c.id);
          const it = { id: c.id, name: e.name, beforeEnabled: e.enabled, afterEnabled: c.enabled, ok: true, error: null };
          e.enabled = c.enabled;
          return it;
        });
        const id = String(Date.now());
        // mock mimics Windows: only the first restore point of the "day" is really created
        const restoreStatus = !args.restorePoint ? 'off' : M.rpMade ? 'skipped' : 'created';
        if (restoreStatus === 'created') M.rpMade = true;
        const restorePoint = restoreStatus === 'created';
        M.snaps.unshift({ id, created: Math.floor(Date.now() / 1000), restorePoint, restoreStatus, restored: null, items, tweaks, startup });
        return new Promise((r) => setTimeout(() => r({ snapshotId: id, restorePoint, restoreStatus, items, tweaks, startup }), 400));
      }
      case 'restore_snapshot': {
        const sn = M.snaps.find((x) => x.id === args.id);
        sn.items.forEach((i) => { const s = M.svcs.find((x) => x.name === i.name); s.start = i.beforeStart; s.delayed = i.beforeDelayed; });
        (sn.tweaks || []).forEach((t) => { M.tw[t.id] = false; });
        sn.restored = Math.floor(Date.now() / 1000);
        (sn.startup || []).forEach((t) => { const e = M.startup.find((x) => x.id === t.id); if (e) e.enabled = t.beforeEnabled; });
        return Promise.resolve({ restored: sn.items.length + (sn.tweaks || []).length + (sn.startup || []).length, failed: [] });
      }
      case 'delete_snapshot': M.snaps = M.snaps.filter((x) => x.id !== args.id); return Promise.resolve();
      default: return Promise.reject('unknown command ' + cmd);
    }
  }

  load().then(() => {
    // browser-preview only (used to render website screenshots): ?view=startup&sel=DiagTrack
    if (tauri) return;
    const q = new URLSearchParams(location.search);
    if (q.get('view')) { document.body.classList.add('shot'); setView(q.get('view')); }
    if (q.get('sel') && state.services.some((s) => s.name === q.get('sel'))) { state.selected = q.get('sel'); renderRows(); renderDetail(); }
  });
})();

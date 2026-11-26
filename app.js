/* Meu Treino — app pessoal que lê a ficha da planilha da treinadora. */
(function () {
  'use strict';
  const P = window.TreinoParser;

  // ---------- utilidades ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (sec) => { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
  const fmtDate = (iso) => { const d = new Date(iso); return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }); };
  const fmtDateFull = (iso) => { const d = new Date(iso); return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' }); };
  const fmtRest = (s) => (s >= 60 && s % 60 === 0 ? s / 60 + ' min' : s >= 60 ? fmtTime(s) : s + ' s');
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const store = {
    get(k, d) { try { const v = localStorage.getItem('mt.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('mt.' + k, JSON.stringify(v)); } catch (e) { toast('Não foi possível salvar no aparelho'); } },
  };

  // ---------- estado ----------
  let settings = Object.assign({ url: '', restDefault: 30, sound: true, vibrate: true, notify: true }, store.get('settings', {}));
  let cache = store.get('cache', null);
  let data = cache ? P.parse(cache.values, cache.merges) : { meta: {}, fichas: [] };
  let overrides = store.get('overrides', {});
  let sessions = store.get('sessions', []);
  let aliases = store.get('aliases', {});
  let active = store.get('active', null);

  const saveSessions = () => store.set('sessions', sessions);
  const saveActive = () => store.set('active', active);

  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

  // ---------- modelo ----------
  const currentFicha = () => data.fichas[data.fichas.length - 1] || null;
  const fichaById = (id) => data.fichas.find((f) => f.id === id) || null;
  function canon(key) {
    let k = key, guard = 0;
    while (aliases[k] && guard++ < 10) k = aliases[k];
    return k;
  }
  const ovKey = (ficha, ti, ex) => ficha.id + '|' + ti + '|' + ex.key;

  function effEx(ficha, ti, ex) {
    const o = overrides[ovKey(ficha, ti, ex)];
    if (!o) return Object.assign({ edited: false, orig: ex }, ex);
    const name = o.name != null ? o.name : ex.name;
    const series = o.series != null ? o.series : ex.series;
    const rest = o.rest != null ? o.rest : ex.rest;
    const load = o.load != null ? o.load : ex.load;
    const s = P.parseSeries(series);
    return {
      name, key: ex.key, series, rest, load,
      sets: s.sets, reps: s.reps, unilateral: s.unilateral, durationSec: s.durationSec,
      restSec: P.parseRest(rest), loadKg: P.parseLoadKg(load),
      block: ex.block || null, edited: true, orig: ex,
    };
  }

  const blockKind = (n) => (n === 2 ? 'bi-set' : n === 3 ? 'tri-set' : 'circuito');
  function blockMembers(steps, id) {
    const out = [];
    steps.forEach((s, k) => { if (s.type === 'ex' && s.ex.block && s.ex.block.id === id) out.push(k); });
    return out;
  }

  function stepsFor(ficha, ti) {
    const t = ficha.treinos[ti];
    const steps = t.warmup.map((w) => ({ type: 'warm', w }));
    t.exercises.forEach((ex) => steps.push({ type: 'ex', ex }));
    return steps;
  }

  function lastUsed(key, excludeSessionId) {
    const k = canon(key);
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i];
      if (s.id === excludeSessionId) continue;
      for (let j = s.sets.length - 1; j >= 0; j--) {
        const st = s.sets[j];
        if (canon(st.key) === k && st.load) return { load: st.load, at: st.at };
      }
    }
    return null;
  }

  function suggestedTi(ficha) {
    if (!ficha || !ficha.treinos.length) return 0;
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i];
      if (s.fichaId === ficha.id && s.sets.length) return (s.ti + 1) % ficha.treinos.length;
    }
    return 0;
  }

  // ---------- navegação ----------
  let stack = [{ name: 'home' }];
  const view = $('#view');
  function go(name, params, replace) {
    const entry = Object.assign({ name }, params || {});
    if (replace) stack[stack.length - 1] = entry; else stack.push(entry);
    render();
    window.scrollTo(0, 0);
  }
  function tab(name) { stack = [{ name }]; render(); window.scrollTo(0, 0); }
  function back() { if (stack.length > 1) { stack.pop(); render(); } }
  $('#backBtn').onclick = back;
  document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
  $('#syncBtn').onclick = () => sync(true);

  function setTitle(t) { $('#title').textContent = t; }

  function render() {
    const cur = stack[stack.length - 1];
    $('#backBtn').hidden = stack.length <= 1 && cur.name !== 'workout';
    document.body.classList.toggle('in-workout', cur.name === 'workout');
    const root = stack[0].name;
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === root));
    const fn = views[cur.name] || views.home;
    fn(cur);
    if (cur.name === 'workout') requestWakeLock(); else releaseWakeLock();
  }

  // ---------- componentes ----------
  function exLine(ex) {
    const bits = [];
    if (ex.series) bits.push(ex.series);
    if (ex.load) bits.push(ex.load);
    return bits.join(' · ');
  }

  function treinoPreview(ficha, ti, open) {
    const t = ficha.treinos[ti];
    let rows = '';
    t.exercises.forEach((ex, k) => {
      const e = effEx(ficha, ti, ex);
      const b = ex.block;
      if (b && b.pos === 0) {
        const rest = e.restSec != null ? ' · descanso ' + fmtRest(e.restSec) + ' após a rodada' : '';
        rows += `<div class="block-group"><div class="block-tag">Bloco ${esc(b.label)} · ${blockKind(b.size)}${rest}</div>`;
      }
      rows += `<div class="ex-preview"><span class="n">${esc(e.name)}${e.edited ? ' <span class="pill edited">editado</span>' : ''}</span><span class="d">${esc(exLine(e))}</span></div>`;
      if (b && b.pos === b.size - 1) rows += '</div>';
    });
    const warm = t.warmup.map((w) => `${w.title}${w.text ? ': ' + w.text : ''}`).join(' · ');
    return `<details ${open ? 'open' : ''}><summary class="sub">${t.exercises.length} exercícios${warm ? ' · ' + esc(warm) : ''}</summary>${rows}</details>`;
  }

  function treinoTitle(t) { return esc(t.name) + (t.label ? ' <span class="pill">' + esc(t.label) + '</span>' : ''); }

  // ---------- telas ----------
  const views = {};

  views.home = function () {
    setTitle('Meu Treino');
    const f = currentFicha();
    if (!f) {
      view.innerHTML = `<div class="empty"><div class="big">🏋️</div><p>Nenhuma ficha carregada ainda.</p>
        <p class="muted">Cole o endereço do seu Apps Script em Ajustes para o app ler a planilha.</p>
        <button class="btn primary" id="toSettings">Abrir Ajustes</button></div>`;
      $('#toSettings').onclick = () => tab('settings');
      return;
    }
    let html = '';
    if (active) {
      const af = fichaById(active.fichaId);
      if (af && af.treinos[active.ti]) {
        html += `<div class="card"><div class="row"><div class="grow"><div class="muted">Treino em andamento</div><h3>${treinoTitle(af.treinos[active.ti])}</h3></div>
          <button class="btn primary small" id="resume">Continuar</button></div></div>`;
      } else { active = null; saveActive(); }
    }
    const sti = suggestedTi(f);
    const st = f.treinos[sti];
    html += `<div class="section-title">Ficha atual · ${esc(f.period)}</div>
      <div class="card"><div class="muted">Hoje</div><h2>${treinoTitle(st)}</h2>
      ${treinoPreview(f, sti, false)}
      <button class="btn primary big-action" id="startSug" style="margin-top:14px">Começar ${esc(st.name)}</button></div>`;
    const others = f.treinos.map((t, i) => i).filter((i) => i !== sti);
    if (others.length) {
      html += `<div class="section-title">Outros treinos</div>`;
      others.forEach((i) => {
        html += `<div class="card"><div class="row"><h3 class="grow">${treinoTitle(f.treinos[i])}</h3>
          <button class="btn small" data-start="${i}">Começar</button></div>${treinoPreview(f, i, false)}</div>`;
      });
    }
    if (cache) html += `<p class="muted" style="text-align:center">Planilha lida em ${new Date(cache.fetchedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</p>`;
    view.innerHTML = html;
    if ($('#resume')) $('#resume').onclick = () => go('workout');
    $('#startSug').onclick = () => startWorkout(f, sti);
    view.querySelectorAll('[data-start]').forEach((b) => (b.onclick = () => startWorkout(f, +b.dataset.start)));
  };

  views.fichas = function () {
    setTitle('Fichas');
    if (!data.fichas.length) { view.innerHTML = '<div class="empty">Nenhuma ficha carregada.</div>'; return; }
    const items = data.fichas.slice().reverse().map((f) => {
      const isCur = f === currentFicha();
      return `<button class="list-item" data-id="${esc(f.id)}"><div class="grow"><div>${esc(f.period)} ${isCur ? '<span class="pill accent">atual</span>' : ''}</div>
        <div class="muted">${f.treinos.map((t) => esc(t.name)).join(' · ')}</div></div><span class="chev">›</span></button>`;
    }).join('');
    view.innerHTML = `<p class="muted">${data.fichas.length} fichas na planilha, da mais nova para a mais antiga.</p><div class="list">${items}</div>`;
    view.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => go('ficha', { id: b.dataset.id })));
  };

  views.ficha = function (p) {
    const f = fichaById(p.id);
    if (!f) return tab('fichas');
    setTitle(f.period);
    view.innerHTML = f.treinos.map((t, i) => `<div class="card"><div class="row"><h3 class="grow">${treinoTitle(t)}</h3>
      <button class="btn small" data-start="${i}">Fazer</button></div>${treinoPreview(f, i, true)}</div>`).join('');
    view.querySelectorAll('[data-start]').forEach((b) => (b.onclick = () => startWorkout(f, +b.dataset.start)));
  };

  // ----- execução do treino -----
  function startWorkout(ficha, ti) {
    const begin = () => {
      const session = { id: uid(), fichaId: ficha.id, period: ficha.period, ti, treinoName: ficha.treinos[ti].name, startedAt: new Date().toISOString(), finishedAt: null, sets: [] };
      sessions.push(session); saveSessions();
      active = { sessionId: session.id, fichaId: ficha.id, ti, step: 0, done: {}, used: {} };
      saveActive();
      unlockAudio();
      askNotifyPermission();
      go('workout');
    };
    if (active) {
      const af = fichaById(active.fichaId);
      const name = af && af.treinos[active.ti] ? af.treinos[active.ti].name : 'anterior';
      return confirmSheet(`Há um treino em andamento (${esc(name)}).`, 'Encerrar e começar novo', () => { finishActive(true); begin(); });
    }
    begin();
  }

  function finishActive(silent) {
    if (!active) return;
    swPost({ type: 'clear' });
    const s = sessions.find((x) => x.id === active.sessionId);
    if (s) {
      if (!s.sets.length) sessions = sessions.filter((x) => x !== s);
      else s.finishedAt = new Date().toISOString();
      saveSessions();
    }
    active = null; saveActive();
    if (!silent) toast('Treino salvo 💪');
  }

  views.workout = function () {
    if (!active) return tab('home');
    const f = fichaById(active.fichaId);
    if (!f || !f.treinos[active.ti]) { active = null; saveActive(); return tab('home'); }
    const t = f.treinos[active.ti];
    const steps = stepsFor(f, active.ti);
    const i = Math.min(active.step, steps.length - 1);
    const st = steps[i];
    setTitle(t.name + (t.label ? ' · ' + t.label : ''));

    const exCount = t.exercises.length;
    const progress = steps.map((s, k) => {
      const isDone = s.type === 'warm' ? active.done[k] >= 1 : (active.done[k] || 0) >= (effEx(f, active.ti, s.ex).sets || 1);
      return `<i class="${k === i ? 'cur' : isDone ? 'done' : ''}"></i>`;
    }).join('');

    let html = `<div class="progress">${progress}</div>`;
    const isLast = i === steps.length - 1;

    if (st.type === 'warm') {
      const w = st.w;
      const done = active.done[i] >= 1;
      html += `<div class="ex-card"><div class="ex-step"><span>Antes de começar</span></div>
        <div class="ex-name">${esc(w.title)}</div>
        <div class="warm-text">${esc(w.text || (w.kind === 'mobilidade' ? 'Mobilidade geral' : ''))}</div>
        ${w.durationSec ? `<button class="btn ghost block" id="warmTimer" style="margin-bottom:10px">⏱ Cronometrar ${fmtTime(w.durationSec)}</button>` : ''}
        <button class="btn ${done ? '' : 'primary'} big-action" id="warmDone">${done ? 'Feito ✓ — seguir' : 'Feito →'}</button></div>`;
    } else {
      const ex = effEx(f, active.ti, st.ex);
      const nSets = ex.sets || 1;
      const doneSets = active.done[i] || 0;
      const exIdx = i - (steps.length - exCount) + 1;
      const lu = lastUsed(ex.key, active.sessionId);
      const usedVal = active.used[i] != null ? active.used[i] : lu ? lu.load : ex.load;
      const blk = ex.block;
      const members = blk ? blockMembers(steps, blk.id) : [];
      const restTxt = ex.restSec != null ? fmtRest(ex.restSec) : fmtRest(settings.restDefault) + ' <small>(padrão)</small>';
      let blockHtml = '';
      let setSuffix = '';
      if (blk) {
        const names = members.map((k) => `<span class="${k === i ? 'cur' : ''}">${esc(effEx(f, active.ti, steps[k].ex).name)}</span>`).join(' → ');
        blockHtml = `<div class="block-box"><div class="block-tag">Bloco ${esc(blk.label)} · ${blockKind(blk.size)} · ${blk.pos + 1} de ${blk.size}</div>
          <div class="block-names">${names}</div><div class="muted">Faça uma série de cada, em sequência; descanse só ao fim da rodada.</div></div>`;
        const nx = nextInBlock(f, i, steps, members, 1);
        if (nx && !nx.wrapped) setSuffix = '<span class="btn-sub">em seguida: ' + esc(effEx(f, active.ti, steps[nx.k].ex).name) + '</span>';
      }
      const seriesTxt = ex.sets ? `${ex.sets} <small>×</small> ${esc(ex.reps || '—')}` : esc(ex.series || '—');
      const allDone = doneSets >= nSets;

      html += `<div class="ex-card">
        <div class="ex-step"><span>Exercício ${exIdx} de ${exCount}${ex.edited ? ' · <span class="pill edited">editado</span>' : ''}</span>
          <button class="btn small ghost" id="editEx">✎ Editar</button></div>
        <div class="ex-name">${esc(ex.name)}</div>
        ${blockHtml}
        <div class="facts">
          <div class="fact"><div class="k">Séries</div><div class="v">${seriesTxt}</div>${ex.unilateral ? '<div class="h">cada lado</div>' : ''}</div>
          <div class="fact"><div class="k">Descanso</div><div class="v">${restTxt}</div>${blk ? '<div class="h">após a rodada</div>' : ''}</div>
          <div class="fact wide"><div class="k">Carga da ficha</div><div class="v">${esc(ex.load || '—')}</div>
            ${lu ? `<div class="h">Você usou <b>${esc(lu.load)}</b> em ${fmtDate(lu.at)}</div>` : ''}</div>
        </div>
        <div class="sets">${Array.from({ length: nSets }, (_, k) => `<button class="set-dot ${k < doneSets ? 'done' : k === doneSets ? 'cur' : ''}" data-set="${k}" aria-label="Série ${k + 1}">${k + 1}</button>`).join('')}</div>
        <div class="used"><label for="usedIn">Carga usada</label><input id="usedIn" value="${esc(usedVal || '')}" placeholder="ex.: 12 kg" autocomplete="off"></div>
        ${allDone
          ? `<button class="btn ${isLast ? 'good' : 'primary'} big-action" id="nextBtn">${isLast ? 'Finalizar treino ✓' : 'Próximo exercício →'}</button>`
          : ex.durationSec
            ? `<button class="btn primary big-action" id="workBtn">▶ Série ${doneSets + 1} · ${fmtRest(ex.durationSec)}</button>`
            : `<button class="btn primary big-action" id="setBtn">✓ Série ${doneSets + 1} de ${nSets} feita${setSuffix}</button>`}
      </div>`;
    }

    html += `<div class="nav-row"><button class="btn ghost" id="prevBtn" ${i === 0 ? 'disabled' : ''}>‹ Anterior</button>
      ${isLast ? `<button class="btn ghost" id="endBtn">Encerrar</button>` : `<button class="btn ghost" id="skipBtn">Pular ›</button>`}</div>`;
    view.innerHTML = html;

    const goStep = (k) => { active.step = k; saveActive(); render(); window.scrollTo(0, 0); };
    $('#prevBtn').onclick = () => goStep(i - 1);
    if ($('#skipBtn')) $('#skipBtn').onclick = () => goStep(i + 1);
    if ($('#endBtn')) $('#endBtn').onclick = () => confirmSheet('Encerrar o treino agora?', 'Encerrar e salvar', () => { finishActive(); tab('home'); });

    if (st.type === 'warm') {
      publishEx({ title: st.w.title, body: st.w.text || 'Antes de começar', actionTitle: '✓ Feito', restAfterSet: 0, restLabel: '' });
      if ($('#warmTimer')) $('#warmTimer').onclick = () => { unlockAudio(); startTimer(st.w.durationSec, 'work', st.w.title, null); };
      $('#warmDone').onclick = () => { active.done[i] = 1; goStep(Math.min(i + 1, steps.length - 1)); };
      return;
    }

    const ex = effEx(f, active.ti, st.ex);
    const nSets = ex.sets || 1;
    publishEx(exNotif(f, i, ex, steps));
    $('#usedIn').oninput = (e) => { active.used[i] = e.target.value; saveActive(); };
    $('#editEx').onclick = () => editSheet(f, active.ti, st.ex);
    view.querySelectorAll('[data-set]').forEach((b) => (b.onclick = () => {
      const k = +b.dataset.set;
      const doneSets = active.done[i] || 0;
      if (k < doneSets) { // desmarcar a partir desta
        active.done[i] = k; removeSets(i, doneSets - k);
      } else if (k === doneSets) { markSet(f, i, ex, steps); return; }
      saveActive(); render();
    }));
    if ($('#setBtn')) $('#setBtn').onclick = () => markSet(f, i, ex, steps);
    if ($('#workBtn')) $('#workBtn').onclick = () => {
      unlockAudio();
      const doneSets = active.done[i] || 0;
      startTimer(ex.durationSec, 'work', `${ex.name} · série ${doneSets + 1} de ${nSets}`, () => markSet(f, i, ex, steps));
    };
    if ($('#nextBtn')) $('#nextBtn').onclick = () => {
      if (i === steps.length - 1) { finishActive(); tab('home'); } else goStep(i + 1);
    };
  };

  function removeSets(stepIdx, n) {
    const s = sessions.find((x) => x.id === active.sessionId);
    if (!s) return;
    for (let k = s.sets.length - 1; k >= 0 && n > 0; k--) if (s.sets[k].step === stepIdx) { s.sets.splice(k, 1); n--; }
    saveSessions();
  }

  function markSet(f, i, ex, steps, fromAt) {
    unlockAudio();
    const s = sessions.find((x) => x.id === active.sessionId);
    const usedIn = $('#usedIn');
    const used = usedIn ? usedIn.value.trim() : (active.used[i] || ex.load || '');
    active.used[i] = used;
    const doneSets = (active.done[i] || 0) + 1;
    active.done[i] = doneSets;
    if (s) {
      s.sets.push({ step: i, key: canon(ex.key), name: ex.name, load: used, loadKg: P.parseLoadKg(used), reps: ex.reps, at: new Date(fromAt || Date.now()).toISOString() });
      saveSessions();
    }
    const nSets = ex.sets || 1;
    const rest0 = ex.restSec != null ? ex.restSec : settings.restDefault;
    const rest = fromAt ? Math.round(rest0 - (Date.now() - fromAt) / 1000) : rest0; // série marcada pelo relógio: desconta o tempo já passado
    const isLast = i === steps.length - 1;
    if (ex.block) {
      const members = blockMembers(steps, ex.block.id);
      const nx = nextInBlock(f, i, steps, members, 0);
      const name = (k) => effEx(f, active.ti, steps[k].ex).name;
      if (nx && !nx.wrapped) {           // segue direto para o próximo do bloco
        active.step = nx.k; saveActive(); render(); window.scrollTo(0, 0);
        toast('Agora: ' + name(nx.k) + ' (sem descanso)');
      } else if (nx) {                   // rodada completa: descanso e volta ao primeiro
        active.step = nx.k; saveActive(); render(); window.scrollTo(0, 0);
        const round = (active.done[nx.k] || 0) + 1;
        if (rest > 1) startTimer(rest, 'rest', `Rodada ${round} do bloco ${ex.block.label} · começa com ${name(nx.k)}`, null);
      } else {                           // bloco terminado
        const after = members[members.length - 1] + 1;
        if (after >= steps.length) { active.step = members[members.length - 1]; saveActive(); render(); return; }
        active.step = after; saveActive(); render(); window.scrollTo(0, 0);
        const st = steps[after];
        if (rest > 1) startTimer(rest, 'rest', 'Próximo: ' + (st.type === 'ex' ? effEx(f, active.ti, st.ex).name : st.w.title), null);
      }
      return;
    }
    if (doneSets >= nSets) {
      if (isLast) { saveActive(); render(); return; }
      active.step = i + 1; saveActive(); render(); window.scrollTo(0, 0);
      const nx = steps[i + 1];
      const nxName = nx.type === 'ex' ? effEx(f, active.ti, nx.ex).name : nx.w.title;
      if (rest > 1) startTimer(rest, 'rest', 'Próximo: ' + nxName, null);
    } else {
      saveActive(); render();
      if (rest > 1) startTimer(rest, 'rest', `Próxima: série ${doneSets + 1} de ${nSets}`, null);
    }
  }

  // Próximo exercício do bloco que ainda tem séries. extra=1 simula a série atual já marcada.
  function nextInBlock(f, i, steps, members, extra) {
    const remaining = (k) => (effEx(f, active.ti, steps[k].ex).sets || 1) - (active.done[k] || 0) - (k === i ? extra : 0);
    const pos = members.indexOf(i);
    for (let d = 1; d <= members.length; d++) {
      const k = members[(pos + d) % members.length];
      if (remaining(k) > 0) return { k, wrapped: pos + d >= members.length };
    }
    return null;
  }

  // Estado do exercício atual para a notificação (que aparece no relógio)
  function exNotif(f, i, ex, steps) {
    const nSets = ex.sets || 1;
    const doneSets = active.done[i] || 0;
    const rest = ex.restSec != null ? ex.restSec : settings.restDefault;
    const nameOf = (k) => (steps[k].type === 'ex' ? effEx(f, active.ti, steps[k].ex).name : steps[k].w.title);
    const isLast = i === steps.length - 1;
    const used = active.used[i] != null ? active.used[i] : (lastUsed(ex.key, active.sessionId) || {}).load || ex.load;
    if (doneSets >= nSets) {
      return { title: ex.name + ' · concluído', body: isLast ? 'Último exercício: encerre o treino no celular.' : 'Próximo: ' + nameOf(i + 1), actionTitle: isLast ? '' : '→ Próximo', restAfterSet: 0, restLabel: '' };
    }
    const bits = [ex.sets ? ex.sets + '×' + (ex.reps || '') : ex.series];
    if (used) bits.push(used);
    let restAfterSet = rest, restLabel;
    if (doneSets + 1 < nSets) restLabel = `Próxima: série ${doneSets + 2} de ${nSets}`;
    else restLabel = isLast ? '' : 'Próximo: ' + nameOf(i + 1);
    if (ex.block) {
      const members = blockMembers(steps, ex.block.id);
      const nx = nextInBlock(f, i, steps, members, 1);
      if (nx && !nx.wrapped) { restAfterSet = 0; bits.push('em seguida: ' + nameOf(nx.k)); }
      else if (nx) restLabel = `Rodada ${(active.done[nx.k] || 0) + 1} do bloco ${ex.block.label} · ${nameOf(nx.k)}`;
      else { const after = members[members.length - 1] + 1; restLabel = after < steps.length ? 'Próximo: ' + nameOf(after) : ''; if (after >= steps.length) restAfterSet = 0; }
    } else bits.push('descanso ' + fmtRest(rest));
    if (isLast && doneSets + 1 >= nSets && !ex.block) restAfterSet = 0;
    return { title: `${ex.name} · série ${doneSets + 1} de ${nSets}`, body: bits.filter(Boolean).join(' · '), actionTitle: '✓ Série feita', restAfterSet, restLabel };
  }

  // Ação vinda do relógio/notificação: marca a série atual (ou avança)
  function watchAction(at) {
    if (!active) return;
    const f = fichaById(active.fichaId);
    if (!f || !f.treinos[active.ti]) return;
    const steps = stepsFor(f, active.ti);
    const i = Math.min(active.step, steps.length - 1);
    const st = steps[i];
    if (stack[stack.length - 1].name !== 'workout') { stack = [{ name: 'home' }, { name: 'workout' }]; render(); }
    if (timer) stopTimer(false);
    if (st.type === 'warm') { active.done[i] = 1; active.step = Math.min(i + 1, steps.length - 1); saveActive(); render(); return; }
    const ex = effEx(f, active.ti, st.ex);
    if ((active.done[i] || 0) >= (ex.sets || 1)) { if (i < steps.length - 1) { active.step = i + 1; saveActive(); render(); } return; }
    markSet(f, i, ex, steps, at);
  }

  // ----- edição -----
  function editSheet(f, ti, baseEx) {
    const e = effEx(f, ti, baseEx);
    const o = baseEx;
    const field = (id, label, val, orig) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${esc(val)}" autocomplete="off">
      <div class="orig">Na planilha: ${esc(orig || '—')}</div></div>`;
    openSheet(`<h2>Editar exercício</h2>
      ${field('eName', 'Nome', e.name, o.name)}
      ${field('eSeries', 'Séries × repetições', e.series, o.series)}
      ${field('eRest', 'Descanso', e.rest, o.rest)}
      ${field('eLoad', 'Carga', e.load, o.load)}
      <p class="muted">A edição vale só no app (a planilha não é alterada). Exemplos: <b>4x10</b>, <b>3x10/10</b>, <b>3x30"</b>; descanso <b>45"</b>, <b>1'</b>, <b>60</b>.</p>
      <div class="nav-row"><button class="btn ghost" id="eReset" ${e.edited ? '' : 'disabled'}>Restaurar</button><button class="btn primary" id="eSave">Salvar</button></div>`);
    $('#eSave').onclick = () => {
      const vals = { name: $('#eName').value.trim(), series: $('#eSeries').value.trim(), rest: $('#eRest').value.trim(), load: $('#eLoad').value.trim() };
      const ov = {};
      for (const k of Object.keys(vals)) if (vals[k] !== (o[k] || '')) ov[k] = vals[k];
      const key = ovKey(f, ti, baseEx);
      if (Object.keys(ov).length) overrides[key] = ov; else delete overrides[key];
      store.set('overrides', overrides);
      closeSheet(); render(); toast('Exercício atualizado');
    };
    $('#eReset').onclick = () => { delete overrides[ovKey(f, ti, baseEx)]; store.set('overrides', overrides); closeSheet(); render(); toast('Valores da planilha restaurados'); };
  }

  // ----- histórico -----
  function allExercises() {
    const map = new Map(); // canonKey -> {key, name, lastAt, order}
    data.fichas.forEach((f, fi) => f.treinos.forEach((t) => t.exercises.forEach((ex) => {
      const k = canon(ex.key);
      const cur = map.get(k) || { key: k, name: ex.name, lastAt: '', order: -1 };
      if (fi >= cur.order) { cur.name = ex.name; cur.order = fi; }
      map.set(k, cur);
    })));
    sessions.forEach((s) => s.sets.forEach((st) => {
      const k = canon(st.key);
      const cur = map.get(k) || { key: k, name: st.name, lastAt: '', order: -1 };
      if (st.at > cur.lastAt) cur.lastAt = st.at;
      map.set(k, cur);
    }));
    return [...map.values()].sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '') || b.order - a.order || a.name.localeCompare(b.name));
  }

  views.history = function (p) {
    setTitle('Histórico');
    const done = sessions.filter((s) => s.sets.length).slice().reverse();
    const sesHtml = done.length
      ? `<div class="list">${done.slice(0, p.all ? 999 : 8).map((s) => `<button class="list-item" data-ses="${s.id}"><div class="grow"><div>${esc(s.treinoName)} <span class="muted">· ${esc(s.period)}</span></div>
          <div class="muted">${fmtDateFull(s.startedAt)} · ${plural(new Set(s.sets.map((x) => x.step)).size, 'exercício', 'exercícios')} · ${plural(s.sets.length, 'série', 'séries')}</div></div><span class="chev">›</span></button>`).join('')}</div>
          ${done.length > 8 && !p.all ? '<button class="btn small ghost" id="allSes">Ver todos</button>' : ''}`
      : '<p class="muted">Nenhum treino registrado ainda. Os treinos aparecem aqui quando você marca séries.</p>';
    view.innerHTML = `<div class="section-title">Treinos feitos</div>${sesHtml}
      <div class="section-title">Exercícios</div>
      <input class="search" id="q" placeholder="Buscar exercício…" value="${esc(p.q || '')}" autocomplete="off">
      <div class="list" id="exList"></div>`;
    const list = $('#exList');
    const all = allExercises();
    const draw = () => {
      const q = P.normKey($('#q').value);
      const items = all.filter((x) => !q || x.key.includes(q)).slice(0, 80);
      list.innerHTML = items.map((x) => `<button class="list-item" data-key="${esc(x.key)}"><div class="grow">${esc(x.name)}
        <div class="muted">${x.lastAt ? 'feito em ' + fmtDate(x.lastAt) : 'só na ficha'}</div></div><span class="chev">›</span></button>`).join('') || '<div class="list-item muted">Nada encontrado.</div>';
      list.querySelectorAll('[data-key]').forEach((b) => (b.onclick = () => { stack[stack.length - 1].q = $('#q').value; go('exercise', { key: b.dataset.key }); }));
    };
    $('#q').oninput = draw; draw();
    view.querySelectorAll('[data-ses]').forEach((b) => (b.onclick = () => go('session', { id: b.dataset.ses })));
    if ($('#allSes')) $('#allSes').onclick = () => { stack[stack.length - 1].all = true; render(); };
  };

  views.session = function (p) {
    const s = sessions.find((x) => x.id === p.id);
    if (!s) return back();
    setTitle(s.treinoName + ' · ' + fmtDate(s.startedAt));
    const groups = [];
    s.sets.forEach((st) => {
      let g = groups.find((x) => x.step === st.step);
      if (!g) { g = { step: st.step, name: st.name, sets: [] }; groups.push(g); }
      g.sets.push(st);
    });
    view.innerHTML = `<p class="sub">${fmtDateFull(s.startedAt)} · ficha ${esc(s.period)}</p>
      <div class="card"><table class="data"><tr><th>Exercício</th><th>Séries</th><th>Carga usada</th></tr>
      ${groups.map((g) => `<tr><td>${esc(g.name)}</td><td>${g.sets.length}</td><td>${esc([...new Set(g.sets.map((x) => x.load || '—'))].join(', '))}</td></tr>`).join('')}</table></div>
      <button class="btn ghost block" id="delSes">Apagar este registro</button>`;
    $('#delSes').onclick = () => confirmSheet('Apagar este treino do histórico?', 'Apagar', () => {
      sessions = sessions.filter((x) => x.id !== s.id); saveSessions(); if (active && active.sessionId === s.id) { active = null; saveActive(); } back();
    });
  };

  views.exercise = function (p) {
    const key = canon(p.key);
    const info = allExercises().find((x) => x.key === key);
    setTitle(info ? info.name : 'Exercício');
    // prescrições por ficha
    const presc = [];
    data.fichas.forEach((f) => f.treinos.forEach((t, ti) => t.exercises.forEach((ex) => {
      if (canon(ex.key) !== key) return;
      const e = effEx(f, ti, ex);
      presc.push({ ficha: f, t, e });
    })));
    // cargas usadas por sessão (maior carga numérica do dia)
    const used = [];
    sessions.forEach((s) => {
      const sets = s.sets.filter((st) => canon(st.key) === key);
      if (!sets.length) return;
      const kg = sets.map((x) => x.loadKg).filter((x) => x != null);
      used.push({ at: s.startedAt, kg: kg.length ? Math.max(...kg) : null, txt: [...new Set(sets.map((x) => x.load || '—'))].join(', '), n: sets.length });
    });

    const prescPts = presc.filter((x) => x.e.loadKg != null).map((x) => ({ label: x.ficha.period, y: x.e.loadKg, tip: `${x.ficha.period}: ${x.e.load}` }));
    const usedPts = used.filter((x) => x.kg != null).map((x) => ({ label: fmtDate(x.at), y: x.kg, tip: `${fmtDate(x.at)}: ${x.txt}` }));

    const otherOpts = allExercises().filter((x) => x.key !== key).map((x) => `<option value="${esc(x.key)}">${esc(x.name)}</option>`).join('');
    const mergedFrom = Object.keys(aliases).filter((k) => canon(k) === key && k !== key);

    view.innerHTML = `
      <div class="card"><h3>Carga usada por treino</h3>
        ${usedPts.length ? chartHtml(usedPts, 'var(--used)', 'kg') : '<p class="muted">Sem registros com carga numérica ainda.</p>'}</div>
      <div class="card"><h3>Carga prescrita por ficha</h3>
        ${prescPts.length ? chartHtml(prescPts, 'var(--accent)', 'kg') : '<p class="muted">A ficha não traz carga numérica para este exercício.</p>'}
        <table class="data" style="margin-top:8px"><tr><th>Ficha</th><th>Séries</th><th>Carga</th></tr>
        ${presc.slice().reverse().map((x) => `<tr><td>${esc(x.ficha.period)}<div class="muted">${esc(x.t.name)}</div></td><td>${esc(x.e.series || '—')}</td><td>${esc(x.e.load || '—')}</td></tr>`).join('')}</table></div>
      ${used.length ? `<div class="card"><h3>Registros</h3><table class="data"><tr><th>Data</th><th>Séries</th><th>Carga</th></tr>
        ${used.slice().reverse().map((u) => `<tr><td>${fmtDateFull(u.at)}</td><td>${u.n}</td><td>${esc(u.txt)}</td></tr>`).join('')}</table></div>` : ''}
      <div class="card"><h3>Mesmo exercício com outro nome?</h3>
        <p class="muted">Junte as variações de nome (ex.: "Tríceps polia barra reta" e "Tríceps barra reta polia") para somar o histórico.</p>
        ${mergedFrom.length ? `<p class="sub">Já juntado com: ${mergedFrom.map(esc).join(', ')} <button class="btn small ghost" id="unmerge">Separar</button></p>` : ''}
        <div class="row"><select id="mergeSel" class="grow"><option value="">Escolher exercício…</option>${otherOpts}</select>
        <button class="btn small" id="mergeBtn">Juntar</button></div></div>`;
    wireCharts();
    $('#mergeBtn').onclick = () => {
      const other = $('#mergeSel').value;
      if (!other) return;
      aliases[other] = key; store.set('aliases', aliases); toast('Exercícios juntados'); render();
    };
    if ($('#unmerge')) $('#unmerge').onclick = () => { mergedFrom.forEach((k) => delete aliases[k]); store.set('aliases', aliases); render(); };
  };

  // ----- gráfico de linha simples (uma série, com dica ao tocar) -----
  function chartHtml(pts, color, unit) {
    const W = 340, H = 170, L = 34, R = 12, T = 12, B = 26;
    const max = Math.max(...pts.map((p) => p.y)) * 1.15 || 1;
    const nice = niceMax(max);
    const x = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1));
    const y = (v) => T + (1 - v / nice) * (H - T - B);
    const ticks = [0, nice / 2, nice];
    const grid = ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`).join('');
    const ylab = ticks.map((v) => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${+v.toFixed(1)}</text>`).join('');
    const step = Math.ceil(pts.length / 5);
    const xlab = pts.map((p, i) => (i % step === 0 || i === pts.length - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(shortLabel(p.label))}</text>` : '')).join('');
    const path = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p.y).toFixed(1)).join(' ');
    const dots = pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.y)}" r="4.5" fill="${color}" stroke="var(--card)" stroke-width="2"/>`).join('');
    const hits = pts.map((p, i) => `<rect x="${x(i) - 16}" y="${T}" width="32" height="${H - T - B}" fill="transparent" data-tip="${esc(p.tip)}" data-x="${x(i) / W}" data-y="${y(p.y) / H}"/>`).join('');
    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de carga em ${unit}">
      <g class="grid">${grid}</g><g class="axis">${ylab}${xlab}</g>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>${dots}${hits}</svg><div class="tip" hidden></div></div>`;
  }
  function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
  function shortLabel(s) { s = String(s).replace(/^até:?\s*/i, ''); return s.length > 9 ? s.slice(0, 8) + '…' : s; }
  function wireCharts() {
    view.querySelectorAll('.chart').forEach((c) => {
      const tip = $('.tip', c);
      c.querySelectorAll('[data-tip]').forEach((r) => {
        const show = () => { tip.hidden = false; tip.textContent = r.dataset.tip; tip.style.left = r.dataset.x * 100 + '%'; tip.style.top = r.dataset.y * 100 + '%'; };
        r.addEventListener('pointerenter', show); r.addEventListener('pointerdown', show);
      });
      c.addEventListener('pointerleave', () => (tip.hidden = true));
    });
  }

  // ----- ajustes -----
  views.settings = function () {
    setTitle('Ajustes');
    view.innerHTML = `
      <div class="card"><h3>Planilha</h3>
        <div class="field"><label for="sUrl">Endereço do Apps Script (com ?key=…)</label>
        <input id="sUrl" value="${esc(settings.url)}" placeholder="https://script.google.com/macros/s/…/exec?key=…" autocomplete="off" spellcheck="false"></div>
        <button class="btn primary block" id="sTest">Salvar e ler a planilha</button>
        <p class="muted" id="sStatus">${cache ? `${data.fichas.length} fichas carregadas · lida em ${new Date(cache.fetchedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Ainda não lida.'}</p></div>
      <div class="card"><h3>Treino</h3>
        <div class="field"><label for="sRest">Descanso padrão quando a ficha não diz (segundos)</label><input id="sRest" type="number" inputmode="numeric" min="0" step="5" value="${settings.restDefault}"></div>
        <label class="row" style="margin:10px 0"><input type="checkbox" id="sSound" style="width:auto" ${settings.sound ? 'checked' : ''}> <span>Bipe no fim do descanso</span></label>
        <label class="row"><input type="checkbox" id="sVib" style="width:auto" ${settings.vibrate ? 'checked' : ''}> <span>Vibrar no fim do descanso</span></label></div>
      <div class="card"><h3>Relógio (notificações)</h3>
        <p class="muted">Durante o treino, o exercício atual aparece numa notificação, que o Galaxy Watch espelha, com o botão <b>Série feita</b>. No fim do descanso, a notificação vibra no relógio.</p>
        <label class="row" style="margin:10px 0"><input type="checkbox" id="sNotify" style="width:auto" ${settings.notify !== false ? 'checked' : ''}> <span>Mostrar o treino nas notificações</span></label>
        <p class="sub" id="nStatus">${notifStatusText()}</p>
        <button class="btn small block" id="sNotifyTest">Testar: notificação em 5 s</button></div>
      <div class="card"><h3>Seus dados</h3>
        <p class="muted">Registros, edições e histórico ficam guardados só neste celular. Faça um backup de vez em quando.</p>
        <div class="nav-row"><button class="btn small" id="sExport">Exportar backup</button>
        <label class="btn small" style="text-align:center">Importar backup<input type="file" id="sImport" accept="application/json" hidden></label></div></div>
      <p class="muted" style="text-align:center">Meu Treino · v3</p>`;
    const saveS = () => store.set('settings', settings);
    $('#sTest').onclick = async () => { settings.url = $('#sUrl').value.trim(); saveS(); $('#sStatus').textContent = 'Lendo…'; await sync(true); render(); };
    $('#sRest').onchange = (e) => { settings.restDefault = Math.max(0, parseInt(e.target.value, 10) || 0); saveS(); };
    $('#sSound').onchange = (e) => { settings.sound = e.target.checked; saveS(); };
    $('#sVib').onchange = (e) => { settings.vibrate = e.target.checked; saveS(); };
    $('#sNotify').onchange = async (e) => { settings.notify = e.target.checked; saveS(); if (settings.notify) await askNotifyPermission(); $('#nStatus').textContent = notifStatusText(); };
    $('#sNotifyTest').onclick = async () => {
      settings.notify = true; saveS(); $('#sNotify').checked = true;
      await askNotifyPermission();
      $('#nStatus').textContent = notifStatusText();
      if (!notifAllowed()) return;
      swPost({ type: 'test' });
      toast('Bloqueie o celular e olhe o relógio');
    };
    $('#sExport').onclick = () => {
      const blob = new Blob([JSON.stringify({ app: 'meu-treino', v: 1, exportedAt: new Date().toISOString(), settings: Object.assign({}, settings, { url: '' }), overrides, sessions, aliases }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'meu-treino-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    };
    $('#sImport').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const j = JSON.parse(await file.text());
        if (j.app !== 'meu-treino') throw new Error();
        confirmSheet(`Substituir os dados atuais pelo backup de ${fmtDateFull(j.exportedAt)} (${(j.sessions || []).length} treinos)?`, 'Importar', () => {
          overrides = j.overrides || {}; sessions = j.sessions || []; aliases = j.aliases || {};
          store.set('overrides', overrides); saveSessions(); store.set('aliases', aliases); toast('Backup importado'); render();
        });
      } catch (err) { toast('Arquivo de backup inválido'); }
    };
  };

  // ---------- sincronização ----------
  let syncing = false;
  async function sync(manual) {
    if (syncing) return;
    if (!settings.url) { if (manual) tab('settings'); return; }
    syncing = true; $('#syncBtn').classList.add('spin');
    try {
      const u = new URL(settings.url);
      u.searchParams.set('t', Date.now());
      const r = await fetch(u.toString(), { cache: 'no-store', redirect: 'follow' });
      const j = await r.json();
      if (j.error) throw new Error(j.error === 'unauthorized' ? 'chave inválida no endereço' : j.error);
      const parsed = P.parse(j.values || [], j.merges || []);
      if (!parsed.fichas.length) throw new Error('nenhuma ficha encontrada na planilha');
      const prev = currentFicha();
      const prevSig = prev ? JSON.stringify(prev.treinos) : null;
      cache = { fetchedAt: j.fetchedAt || new Date().toISOString(), values: j.values, merges: j.merges || [] };
      store.set('cache', cache);
      data = parsed;
      const cur = currentFicha();
      const seen = store.get('seenFicha', null);
      if (seen && seen !== cur.id) showBanner(`🆕 Nova ficha: <b>${esc(cur.period)}</b>. Os treinos já estão atualizados.`);
      else if (prev && prev.id === cur.id && prevSig !== JSON.stringify(cur.treinos)) showBanner('✏️ A treinadora alterou a ficha atual. Os treinos já estão atualizados.');
      else hideBanner();
      store.set('seenFicha', cur.id);
      if (manual) toast('Ficha atualizada');
      const top = stack[stack.length - 1].name;
      if (top !== 'workout' && $('#sheet').hidden) render();
    } catch (e) {
      const msg = e && e.message && !/fetch|json|network|Unexpected/i.test(e.message) ? e.message : 'sem conexão ou endereço incorreto';
      if (cache) showBanner(`Não consegui ler a planilha (${esc(msg)}). Mostrando a última ficha salva.`, true);
      else showBanner(`Não consegui ler a planilha (${esc(msg)}). Confira o endereço em Ajustes.`, true);
    } finally {
      syncing = false; $('#syncBtn').classList.remove('spin');
    }
  }

  function showBanner(html, warn) { const b = $('#banner'); b.innerHTML = html; b.className = 'banner' + (warn ? ' warn' : ''); b.hidden = false; b.onclick = hideBanner; }
  function hideBanner() { $('#banner').hidden = true; }

  // ---------- diálogos ----------
  function openSheet(html) { $('#sheetBody').innerHTML = html; $('#sheet').hidden = false; }
  function closeSheet() { $('#sheet').hidden = true; }
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  function confirmSheet(text, okLabel, onOk) {
    openSheet(`<h2>${text}</h2><div class="nav-row"><button class="btn ghost" id="cNo">Cancelar</button><button class="btn primary" id="cYes">${esc(okLabel)}</button></div>`);
    $('#cNo').onclick = closeSheet;
    $('#cYes').onclick = () => { closeSheet(); onOk(); };
  }
  let toastT;
  function toast(msg) {
    let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2200);
  }

  // ---------- timer ----------
  const timerEl = $('#timer'), ringFg = $('#ringFg'), CIRC = 2 * Math.PI * 88;
  ringFg.style.strokeDasharray = CIRC;
  let timer = null;
  function startTimer(sec, kind, nextText, onEnd) {
    stopTimer(false);
    timer = { end: Date.now() + sec * 1000, total: sec, kind, onEnd, ended: false, nextText };
    if (kind === 'rest') swPost({ type: 'rest', sec, label: nextText || '', after: lastExNotif });
    $('#timerKind').textContent = kind === 'work' ? 'Execução' : 'Descanso';
    $('#timerNext').textContent = nextText || '';
    timerEl.className = 'timer' + (kind === 'work' ? ' work' : '');
    timerEl.hidden = false;
    timer.iv = setInterval(tick, 200); tick();
  }
  function tick() {
    if (!timer) return;
    const rem = (timer.end - Date.now()) / 1000;
    const shown = Math.max(0, Math.ceil(rem));
    $('#timerNum').textContent = fmtTime(shown);
    ringFg.style.strokeDashoffset = CIRC * (1 - Math.max(0, rem) / Math.max(1, timer.total));
    if (rem <= 3 && rem > 0 && timer.kind === 'rest' && timer.lastBeep !== shown) { timer.lastBeep = shown; beep(660, 0.08); }
    if (rem <= 0 && !timer.ended) {
      timer.ended = true;
      timerEl.classList.add('ended');
      alertEnd();
      setTimeout(() => stopTimer(true), timer.kind === 'work' ? 400 : 1200);
    }
  }
  function stopTimer(fire) {
    if (!timer) return;
    clearInterval(timer.iv);
    const t = timer; timer = null;
    timerEl.hidden = true;
    if (fire && t.onEnd) t.onEnd();
  }
  const syncRest = () => { if (timer && timer.kind === 'rest') swPost({ type: 'rest', sec: Math.max(0, (timer.end - Date.now()) / 1000), label: timer.nextText || '', after: lastExNotif }); };
  $('#tSkip').onclick = () => { if (timer) { const t = timer; timer.ended = true; if (t.kind === 'rest') swPost({ type: 'cancelRest' }); stopTimer(t.kind === 'work'); } };
  $('#tPlus').onclick = () => { if (timer && !timer.ended) { timer.end += 15000; timer.total += 15; tick(); syncRest(); } };
  $('#tMinus').onclick = () => { if (timer && !timer.ended) { timer.end -= 15000; tick(); syncRest(); } };

  // ---------- notificações (o Galaxy Watch espelha as notificações do celular) ----------
  let lastExNotif = null;
  const notifAllowed = () => settings.notify !== false && 'Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator;
  function notifStatusText() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'Este navegador não permite notificações.';
    if (settings.notify === false) return 'Desligado.';
    if (Notification.permission === 'granted') return '✓ Notificações permitidas.';
    if (Notification.permission === 'denied') return '✗ Notificações bloqueadas: libere em Configurações do Android › Apps › Meu Treino (ou Chrome) › Notificações.';
    return 'Ainda não permitido: toque em "Testar" para autorizar.';
  }
  async function askNotifyPermission() {
    try { if (settings.notify !== false && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch (e) {}
  }
  async function swPost(msg) {
    if (!notifAllowed()) return;
    try { const reg = await navigator.serviceWorker.ready; if (reg.active) reg.active.postMessage(msg); } catch (e) {}
  }
  function publishEx(n) {
    lastExNotif = n;
    if (!timer || timer.kind !== 'rest') swPost({ type: 'show', n });
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'watchSet') watchAction(m.at);
      else if (m.type === 'watchSkip' && timer && timer.kind === 'rest') { timer.ended = true; stopTimer(false); }
    });
  }

  let audioCtx = null;
  function unlockAudio() {
    try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
  }
  function beep(freq, dur, when) {
    if (!settings.sound || !audioCtx) return;
    try {
      const t0 = audioCtx.currentTime + (when || 0);
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + dur + 0.05);
    } catch (e) {}
  }
  function alertEnd() {
    beep(880, 0.18, 0); beep(880, 0.18, 0.25); beep(1175, 0.35, 0.5);
    if (settings.vibrate && navigator.vibrate) try { navigator.vibrate([300, 120, 300]); } catch (e) {}
  }

  // ---------- tela ligada durante o treino ----------
  let wakeLock = null;
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => (wakeLock = null)); } } catch (e) {}
  }
  function releaseWakeLock() { try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {} }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (stack[stack.length - 1].name === 'workout') requestWakeLock();
      if (timer) tick();
    }
  });

  // ---------- início ----------
  if (active) stack = [{ name: 'home' }, { name: 'workout' }];
  render();
  sync(false);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

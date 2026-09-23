/* Hugoland na nuvem: painel que lê tudo do servidor */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const local = {
  get(k, d){ try{ const v = localStorage.getItem('hugoland-' + k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem('hugoland-' + k, JSON.stringify(v)); }catch(e){} }
};

let S = null;               // último resumo do servidor
let prev = null;            // resumo anterior (para detectar zerou/alerta)
let sort = local.get('sort', 'manual');
let flashIds = new Set();

async function api(path, opts = {}){
  const r = await fetch(path, {credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, ...opts});
  if(r.status === 401){ location.href = '/login'; throw new Error('login'); }
  const d = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

/* ---------- auxiliares ---------- */
const seg = id => S && S.segments.find(s => s.id === id);
const segLabel = id => (seg(id) || {label: '?'}).label;
const isSmall = l => String(l).length > 3;
const chip = id => { const s = seg(id); return s ? `<span class="chip" style="background:${s.color}">${esc(s.label)}</span>` : ''; };
const ball = (id, cls = '') => { const s = seg(id) || {label: '?', color: '#888'}; return `<span class="ball ${isSmall(s.label) ? 'sm' : ''} ${cls}" style="background:${s.color}" title="${esc(s.label)}">${esc(s.label)}</span>`; };
function fmtDur(ms){ const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60, p = n => String(n).padStart(2, '0'); return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`; }
const fmtDate = t => new Date(t).toLocaleDateString('pt-BR');
const fmtTime = t => new Date(t).toLocaleTimeString('pt-BR');
const ruleTxt = m => m.mode === 'seq' ? 'Zera quando sai a sequência' : m.mode === 'rep' ? `Zera quando o mesmo resultado repete ${m.rep}x seguidas` : 'Zera quando sai qualquer um';
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2600); }
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_DEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';

/* ---------- atualização ---------- */
let lastN = null, busy = false;
async function refresh(){
  if(busy) return; busy = true;
  try{
    const d = await api('/api/summary');
    prev = S; S = d;
    detect();
    renderTop(); renderGrid(); renderSide(); renderStatus();
    if(!segEditing) renderSegs();
    if($('#v-hist').classList.contains('on') && lastN !== null && d.n !== lastN) loadHist(true);
    lastN = d.n;
  }catch(e){ if(e.message !== 'login') setPill('err', 'Sem servidor', e.message); }
  finally{ busy = false; }
}
function detect(){
  if(!prev) return;
  const alerts = [];
  S.monitors.forEach(m => {
    const p = prev.monitors.find(x => x.id === m.id); if(!p) return;
    if(m.st.hits > p.st.hits) flashIds.add(m.id);
    if(m.alert > 0 && p.st.current < m.alert && m.st.current >= m.alert) alerts.push(m.name);
  });
  if(alerts.length){ try{ navigator.vibrate && navigator.vibrate([250, 120, 250]); }catch(e){} toast('Alerta: ' + alerts.join(', ')); }
}
function setPill(cls, txt, title = ''){ const p = $('#livePill'); p.classList.toggle('on', cls === 'on'); p.classList.toggle('err', cls === 'err'); $('#liveTxt').textContent = txt; p.title = title; }

/* ---------- topo ---------- */
let stripN = 0;
function renderTop(){
  $('#roundCount').textContent = S.n.toLocaleString('pt-BR');
  const added = stripN ? Math.max(0, S.n - stripN) : 0;
  $('#strip').innerHTML = S.last.length ? S.last.map((r, i) => ball(r.seg, i < Math.min(added, 5) ? 'new' : '')).join('') : '<span class="muted" style="font-size:.85rem">Aguardando rodadas…</span>';
  stripN = S.n;
  const c = S.collector;
  if(c.ok && c.last_ok && S.now - c.last_ok * 1000 < 90000) setPill('on', 'Ao vivo', 'Coletor gravando no servidor');
  else if(c.ok === false) setPill('err', 'Fonte fora', c.error || '');
  else if(c.error) setPill('err', 'Coletor parado', c.error);
  else setPill('', 'Conectando…');
}

/* ---------- combinações ---------- */
function renderGrid(){
  const now = Date.now();
  let list = [...S.monitors];
  if(sort === 'current') list.sort((a, b) => b.st.current - a.st.current);
  if(sort === 'record') list.sort((a, b) => (b.st.record ? b.st.current / b.st.record : 0) - (a.st.record ? a.st.current / a.st.record : 0));
  $('#comboCount').textContent = list.length ? `(${list.length})` : '';
  document.querySelectorAll('#sortCtl button').forEach(b => b.classList.toggle('on', b.dataset.sort === sort));
  $('#grid').innerHTML = list.map(m => {
    const st = m.st, hot = m.alert > 0 && st.current >= m.alert;
    const pct = st.record ? Math.min(100, st.current / st.record * 100) : 0;
    const ref = st.lastT || st.firstT, plus = st.lastT ? '' : '+';
    const sep = m.mode === 'seq' ? '<span class="muted">→</span>' : '';
    const chips = m.mode === 'rep' ? m.values.map(v => Array.from({length: m.rep}, () => chip(v)).join('')).join('<span class="muted">ou</span>') : m.values.map(chip).join(sep);
    const s4 = m.mode === 'rep'
      ? `<div>Falhou<b class="num" title="Vezes que a repetição começou e parou antes de completar">${(st.fails ?? 0).toLocaleString('pt-BR')}</b></div><div>Emendados<b class="num" title="Iguais seguidos neste momento">${st.run ?? 0}</b></div>`
      : `<div>Saiu<b class="num">${st.hits.toLocaleString('pt-BR')}x</b></div><div>Média<b class="num">${st.avg == null ? '—' : st.avg.toFixed(1)}</b></div>`;
    return `<article class="combo ${hot ? 'hot' : ''} ${flashIds.has(m.id) ? 'flash' : ''}">
      <div class="c-head">
        <div><div class="c-name">${esc(m.name)}</div><div class="c-rule">${ruleTxt(m)}${m.alert ? ` · alerta em ${m.alert}` : ''}</div></div>
        <div class="c-act"><button class="icon" data-edit="${m.id}" aria-label="Editar ${esc(m.name)}">${ICON_EDIT}</button><button class="icon" data-del="${m.id}" aria-label="Excluir ${esc(m.name)}">${ICON_DEL}</button></div>
      </div>
      <div class="chips">${chips}</div>
      <div class="c-main"><div class="count num">${st.current.toLocaleString('pt-BR')}</div><div class="count-lbl">rodadas<br>sem sair</div></div>
      <div class="prog"><i style="width:${pct}%"></i></div>
      <div class="stats">
        <div>Recorde<b class="num">${st.record.toLocaleString('pt-BR')}</b></div>
        <div>Tempo<b class="num" data-tm="${ref || ''}" data-plus="${plus}">${ref ? fmtDur(now - ref) + plus : '—'}</b></div>
        ${s4}
      </div>
    </article>`;
  }).join('') + '<button class="add" data-new><span>+</span>Nova combinação</button>';
  flashIds.clear();
}
setInterval(() => { const now = Date.now(); document.querySelectorAll('[data-tm]').forEach(el => { if(el.dataset.tm) el.textContent = fmtDur(now - +el.dataset.tm) + el.dataset.plus; }); }, 1000);

/* ---------- lateral ---------- */
function renderSide(){
  const n = S.n || 0;
  $('#dist').innerHTML = S.dist.map(d => { const s = seg(d.seg); if(!s) return '';
    return `<div class="drow"><span class="nm" title="${esc(s.label)}">${esc(s.label)}</span>
      <span class="tr" title="${d.count} vezes (${n ? (d.count / n * 100).toFixed(1) : 0}%)"><i style="width:${n ? d.count / n * 100 : 0}%;background:${s.color}"></i></span>
      <span class="vl num"><b>${d.since == null ? '—' : d.since}</b></span></div>`; }).join('');
  const keys = S.segments.map(s => s.id + s.label + s.color).join();
  if($('#pad').dataset.k !== keys){
    $('#pad').innerHTML = S.segments.map(s => `<button class="key ${isSmall(s.label) ? 'sm' : ''}" style="background:${s.color}" data-key="${s.id}" aria-label="Registrar ${esc(s.label)}">${esc(s.label)}</button>`).join('');
    $('#pad').dataset.k = keys;
  }
}

/* ---------- status do coletor ---------- */
function renderStatus(){
  const c = S.collector, now = S.now;
  const ago = t => t ? fmtDur(now - t * 1000) + ' atrás' : '—';
  $('#colStatus').textContent =
    (c.ok ? '✓ Coletando normalmente' : c.ok === false ? '✗ Falha ao buscar na fonte' : c.running ? '… Iniciando' : '✗ Coletor parado') + '\n' +
    `Última consulta com sucesso: ${ago(c.last_ok)}\n` +
    `Última rodada gravada: ${c.last_round ? fmtDate(c.last_round * 1000) + ' ' + fmtTime(c.last_round * 1000) : '—'}\n` +
    `Rodadas no banco: ${S.n.toLocaleString('pt-BR')}\n` +
    `Atraso até gravar: ${c.delay_last == null ? '—' : c.delay_last.toFixed(1) + ' s'} (média ${c.delay_avg == null ? '—' : c.delay_avg.toFixed(1) + ' s'})\n` +
    `Consulta: a cada ${c.poll_fast}s perto do fim do giro, ${c.poll_slow}s logo depois` +
    (c.error ? `\nMensagem: ${c.error}` : '') + (c.fails ? `\nFalhas seguidas: ${c.fails}` : '');
}

/* ---------- histórico ---------- */
let histOffset = 0, histRows = [], histMons = [];
async function loadHist(reset){
  if(reset){ histOffset = 0; histRows = []; }
  try{
    const d = await api(`/api/history?offset=${histOffset}&limit=150`);
    histMons = d.monitors; histRows = histRows.concat(d.rows); histOffset += d.rows.length;
    $('#histInfo').textContent = `(${d.total.toLocaleString('pt-BR')} rodadas)`;
    $('#histNote').textContent = d.total > histOffset ? `Mostrando ${histOffset.toLocaleString('pt-BR')} de ${d.total.toLocaleString('pt-BR')}. O Excel e o JSON trazem o período escolhido completo.` : '';
    $('#more').style.display = d.total > histOffset ? '' : 'none';
    $('#histHead').innerHTML = `<tr><th>Nº</th><th>Data</th><th>Hora</th><th>Resultado</th>${histMons.map(m => `<th title="${esc(m.name)}">${esc(m.name)}</th>`).join('')}<th></th></tr>`;
    $('#histBody').innerHTML = histRows.length ? histRows.map(r => `<tr><td class="muted num">${r.n ?? ''}</td><td class="num">${fmtDate(r.t)}</td><td class="num">${fmtTime(r.t)}</td><td>${chip(r.seg)}${r.manual ? ' <span class="muted" style="font-size:.75rem">manual</span>' : ''}</td>${r.seqs.map(v => `<td class="num ${v === 0 ? 'hit' : ''}">${v === 0 ? '0 ✓' : (v ?? '')}</td>`).join('')}<td><button class="icon" data-rdel="${esc(r.id)}" aria-label="Apagar rodada">${ICON_DEL}</button></td></tr>`).join('')
      : `<tr><td colspan="${5 + histMons.length}" class="muted" style="text-align:center;padding:30px">Nenhuma rodada ainda.</td></tr>`;
  }catch(e){ if(e.message !== 'login') toast('Erro ao carregar o histórico: ' + e.message); }
}
$('#more').addEventListener('click', () => loadHist(false));

/* ---------- editor de combinação ---------- */
let editing = null, pick = [];
function openModal(id){
  editing = id || null;
  const m = id ? S.monitors.find(x => x.id === id) : null;
  pick = m ? [...m.values] : [];
  $('#mTitle').textContent = m ? 'Editar combinação' : 'Nova combinação';
  $('#mName').value = m ? m.name : '';
  $('#mAlert').value = m ? m.alert : 0;
  $('#mRep').value = m && m.rep ? m.rep : 2;
  document.querySelector(`input[name=mode][value=${m && (m.mode === 'seq' || m.mode === 'rep') ? m.mode : 'any'}]`).checked = true;
  renderPick(); $('#modal').classList.add('on');
}
const closeModal = () => $('#modal').classList.remove('on');
function currentMode(){ return document.querySelector('input[name=mode]:checked').value; }
function renderPick(){
  const seqMode = currentMode() === 'seq';
  $('#repBox').style.display = currentMode() === 'rep' ? '' : 'none';
  $('#mPick').innerHTML = S.segments.map(s => { const i = pick.indexOf(s.id);
    return `<button class="${i > -1 ? 'on' : ''} ${isSmall(s.label) ? 'sm' : ''}" style="background:${s.color}" data-pick="${s.id}" aria-pressed="${i > -1}">${esc(s.label)}${i > -1 && seqMode ? `<span class="ord">${i + 1}</span>` : ''}</button>`; }).join('');
}
$('#mPick').addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if(!b) return; const id = b.dataset.pick; pick = pick.includes(id) ? pick.filter(x => x !== id) : [...pick, id]; renderPick(); });
document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', renderPick));
$('#mCancel').addEventListener('click', closeModal);
$('#modal').addEventListener('click', e => { if(e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if(e.key === 'Escape') closeModal(); });
$('#mSave').addEventListener('click', async () => {
  if(!pick.length) return toast('Escolha pelo menos um resultado');
  const mode = currentMode(), repN = Math.min(20, Math.max(2, parseInt($('#mRep').value) || 2));
  const auto = mode === 'seq' ? pick.map(segLabel).join(' → ')
    : mode === 'rep' ? pick.map(l => Array.from({length: repN}, () => segLabel(l)).join(' ')).join(' ou ')
    : pick.map(segLabel).join(pick.length > 2 ? ', ' : ' e ');
  const name = $('#mName').value.trim() || auto;
  try{
    await api('/api/monitors', {method: 'POST', body: JSON.stringify({id: editing, name, values: pick, mode, rep: repN, alert: parseInt($('#mAlert').value) || 0})});
    closeModal(); toast(editing ? 'Combinação atualizada' : 'Combinação criada'); await refresh();
    if($('#v-hist').classList.contains('on')) loadHist(true);
  }catch(e){ toast('Não salvou: ' + e.message); }
});

/* ---------- cliques gerais ---------- */
document.addEventListener('click', async e => {
  if(e.target.closest('[data-new]')) return openModal();
  const ed = e.target.closest('[data-edit]'); if(ed) return openModal(ed.dataset.edit);
  const del = e.target.closest('[data-del]');
  if(del){ const m = S.monitors.find(x => x.id === del.dataset.del);
    if(m && confirm(`Excluir a combinação "${m.name}"? Ela some para todos os aparelhos.`)){ await api('/api/monitors/' + m.id, {method: 'DELETE'}); refresh(); } return; }
  const k = e.target.closest('[data-key]');
  if(k){ try{ await api('/api/rounds', {method: 'POST', body: JSON.stringify({seg: k.dataset.key})}); refresh(); }catch(err){ toast(err.message); } return; }
  const rd = e.target.closest('[data-rdel]');
  if(rd){ if(confirm('Apagar esta rodada do histórico?')){ await api('/api/rounds/' + encodeURIComponent(rd.dataset.rdel), {method: 'DELETE'}); await refresh(); loadHist(true); } return; }
  const so = e.target.closest('[data-sort]'); if(so){ sort = so.dataset.sort; local.set('sort', sort); renderGrid(); }
});
$('#undo').addEventListener('click', async () => { const d = await api('/api/rounds/last-manual', {method: 'DELETE'}); toast(d.ok ? 'Último registro manual desfeito' : 'Não há registro manual para desfazer'); refresh(); });

/* ---------- exportação e importação ---------- */
$('#expXlsx').addEventListener('click', () => { location.href = '/api/export.xlsx?days=' + $('#period').value; toast('Gerando Excel…'); });
$('#expJson').addEventListener('click', () => { location.href = '/api/export.json?days=' + $('#period').value; toast('Gerando JSON…'); });
$('#impJson').addEventListener('click', () => $('#fileIn').click());
$('#fileIn').addEventListener('change', async e => {
  const f = e.target.files[0]; if(!f) return;
  toast('Importando…');
  try{
    const r = await fetch('/api/import', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: await f.text()});
    const d = await r.json();
    if(!r.ok) throw new Error(d.error || 'falhou');
    toast(`Importado: ${d.rodadas} rodadas novas e ${d.combinacoes} combinações`); await refresh(); loadHist(true);
  }catch(err){ toast('Não importou: ' + err.message); }
  e.target.value = '';
});
$('#clearHist').addEventListener('click', async () => {
  const t = prompt('Isto apaga TODAS as rodadas do servidor, para todos os aparelhos. Exporte antes. Para confirmar, digite APAGAR');
  if(t !== 'APAGAR') return;
  await api('/api/rounds', {method: 'DELETE', body: JSON.stringify({confirm: 'APAGAR'})});
  toast('Histórico apagado'); refresh(); loadHist(true);
});

/* ---------- resultados (botões) ---------- */
let segEditing = false, segTimer = null;
function renderSegs(){
  $('#segList').innerHTML = S.segments.map(s => `<div class="segrow">
    <input type="color" value="${s.color}" data-color="${s.id}" aria-label="Cor de ${esc(s.label)}">
    <input type="text" value="${esc(s.label)}" data-label="${s.id}" aria-label="Nome">
    <input type="text" value="${esc(s.aliases || '')}" data-alias="${s.id}" aria-label="Código na fonte" placeholder="código na fonte">
    <button class="icon" data-sdel="${s.id}" aria-label="Remover ${esc(s.label)}">${ICON_DEL}</button></div>`).join('');
}
function pushSegs(){
  clearTimeout(segTimer);
  segTimer = setTimeout(async () => { try{ await api('/api/segments', {method: 'PUT', body: JSON.stringify(S.segments)}); segEditing = false; refresh(); }catch(e){ toast('Não salvou: ' + e.message); } }, 600);
}
$('#segList').addEventListener('input', e => {
  const t = e.target, s = seg(t.dataset.color || t.dataset.label || t.dataset.alias); if(!s) return;
  segEditing = true;
  if(t.dataset.color) s.color = t.value; else if(t.dataset.label) s.label = t.value || '?'; else s.aliases = t.value;
  pushSegs();
});
$('#segList').addEventListener('click', e => {
  const b = e.target.closest('[data-sdel]'); if(!b) return;
  if(!confirm('Remover este resultado? As rodadas continuam gravadas.')) return;
  S.segments = S.segments.filter(s => s.id !== b.dataset.sdel); renderSegs(); pushSegs();
});
$('#addSeg').addEventListener('click', () => { S.segments.push({id: 'c' + Math.random().toString(36).slice(2, 9), label: 'Novo', color: '#8FA8FF', aliases: ''}); renderSegs(); pushSegs(); });
$('#resetSeg').addEventListener('click', () => {
  if(!confirm('Voltar os nomes e cores dos resultados ao padrão?')) return;
  const defs = [['s1','1','#F5C542','ABW_1'],['s2','2','#5AA9F0','ABW_2'],['s5','5','#D07BE8','ABW_5'],['s10','10','#35D69B','ABW_10'],['b2w','2 Wonder Spins','#FF9F43','ABW_WONDERSPINS_2'],['b5w','5 Wonder Spins','#FF6B81','ABW_WONDERSPINS_5'],['bwolter','Wolter Spins','#9B7BFF','ABW_WOLTERSPINS'],['bdice','Magic Dice','#4FD1C5','ABW_MAGIC_DICE'],['bcard','Card Soldiers','#C9C3DE','ABW_CARD_SOLDIERS']].map(([id,label,color,aliases]) => ({id,label,color,aliases}));
  const ids = new Set(defs.map(d => d.id));
  S.segments = [...defs, ...S.segments.filter(s => !ids.has(s.id))]; renderSegs(); pushSegs();
});

/* ---------- navegação e tela ligada ---------- */
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + b.dataset.v));
  if(b.dataset.v === 'hist') loadHist(true);
  window.scrollTo({top: 0});
}));
let wake = null, wakeOn = local.get('wake', true);
async function applyWake(){
  try{
    if(wakeOn && !document.hidden && 'wakeLock' in navigator){ if(!wake){ wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => wake = null); } }
    else if(!wakeOn && wake){ await wake.release(); wake = null; }
  }catch(e){ wake = null; }
}
$('#wakeOn').checked = wakeOn;
$('#wakeOn').addEventListener('change', e => { wakeOn = e.target.checked; local.set('wake', wakeOn); applyWake(); });
document.addEventListener('visibilitychange', () => { applyWake(); if(!document.hidden) refresh(); });

/* ---------- tempo real: o servidor avisa quando grava ---------- */
let es = null, lastEvent = 0;
function connectStream(){
  try{
    es = new EventSource('/api/stream');
    es.addEventListener('change', () => { lastEvent = Date.now(); refresh(); });
    es.onopen = () => { lastEvent = Date.now(); };
    es.onerror = () => { /* o navegador reconecta sozinho */ };
  }catch(e){ es = null; }
}
refresh(); applyWake(); connectStream();
// segurança: se o canal cair, continua atualizando por consulta
setInterval(() => { if(!es || es.readyState !== 1 || Date.now() - lastEvent > 45000) refresh(); }, 5000);
setInterval(refresh, 30000);

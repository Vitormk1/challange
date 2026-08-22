/* ==========================================================================
   Praça de Recarga — painel do lojista

   Portado do painel BMS de referência. Mantém a arquitetura de lá:
   `createXModule(deps)` recebendo estado por referência, estado de interface
   em localStorage, e o tour como módulo isolado que só conhece `setSection`,
   `canAccessSection` e o colapso da barra lateral.

   Dados de demonstração com semente fixa — o Pages serve arquivo estático e
   não executa servidor. Quando a API entrar, só `carregarDados()` muda.
   ========================================================================== */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const brl = v => v.toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
const num = (v, d = 0) => v.toLocaleString('pt-BR', {minimumFractionDigits:d, maximumFractionDigits:d});
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const clamp = (v, min, max) => Math.max(min, Math.min(v, Math.max(min, max)));
const delay = ms => new Promise(r => setTimeout(r, ms));
/* Espera dois quadros — mas com prazo. Em aba em segundo plano o
   requestAnimationFrame nao dispara, e sem esse limite o tour trava no passo
   em que estiver, com o balao escondido e o botao "Proximo" travado. */
const waitForNextPaint = () => new Promise(resolve => {
  let pronto = false;
  const encerrar = () => { if (!pronto) { pronto = true; resolve(); } };
  requestAnimationFrame(() => requestAnimationFrame(encerrar));
  setTimeout(encerrar, 120);
});
const isCompactViewport = () => window.matchMedia('(max-width: 1180px)').matches;

const LS = {
  tema:      'pr.tema',
  colapso:   'pr.sidebarColapsada',
  grupos:    'pr.gruposFechados',
  cards:     'pr.cardsDoPainel',
  perfil:    'pr.perfil',
};
const ler    = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } };
const gravar = (k, v)  => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/* ==========================================================================
   regras de negócio — as mesmas de ai/break_even.py
   ========================================================================== */
const SEGMENTOS = {
  pet:         {nome:'Pet shop e clínica veterinária', margem:20,  ticket:150},
  restaurante: {nome:'Restaurante',                    margem:10,  ticket:120},
  academia:    {nome:'Academia',                       margem:15,  ticket:130},
  farmacia:    {nome:'Farmácia',                       margem:5.5, ticket:45},
  mercado:     {nome:'Supermercado',                   margem:2.9, ticket:60},
};
const COMPRAM = 0.90, UPLIFT = 0.12, NOVOS = 0.20, KM_KWH = 10.4, AMORT = 1.11;

function tetoCortesia(margemPct, ticket, tarifa){
  const receita = COMPRAM * (NOVOS * ticket + (1 - NOVOS) * UPLIFT * ticket);
  const lucro   = receita * (margemPct / 100);
  const sobra   = lucro - AMORT;
  return {lucro, sobra, kwh: Math.max(0, sobra / tarifa)};
}

/* ==========================================================================
   estado
   ========================================================================== */
const state = {
  section: 'painel',
  loja: 'Pet & Cia — Vila Mariana',
  segmento: 'pet',
  tarifa: 0.789,
  usuario: 'Vitor Nascimento',
  pontos: [], sessoes: [], dias: [],
};

const LOJAS = [
  {nome:'Pet & Cia — Vila Mariana',    segmento:'pet'},
  {nome:'Cantina do Léo — Pinheiros',  segmento:'restaurante'},
  {nome:'Farmácia Bem Estar — Moema',  segmento:'farmacia'},
];

let seed = 20260821;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function carregarDados(){
  const seg = SEGMENTOS[state.segmento];
  seed = 20260821;

  state.pontos = [
    {id:'vaga-1', nome:'Vaga 1 — entrada',   kw:7.4,  modo:'cortesia', estado:'carregando', soc:0.62, cliente:'Fiat 500e'},
    {id:'vaga-2', nome:'Vaga 2 — entrada',   kw:7.4,  modo:'cortesia', estado:'livre'},
    {id:'vaga-3', nome:'Vaga 3 — estacion.', kw:22.0, modo:'pago',     estado:'carregando', soc:0.34, cliente:'Volvo EX30'},
    {id:'vaga-4', nome:'Vaga 4 — fundos',    kw:7.4,  modo:'pago',     estado:'falha'},
  ];

  state.dias = [];
  for (let d = 0; d < 30; d++){
    const fds = d % 7 === 5 || d % 7 === 6;
    const sessoes = Math.round((fds ? 5.5 : 3.2) * (0.65 + rnd() * 0.8));
    const kwh = sessoes * (3.5 + rnd() * 3);
    state.dias.push({
      dia: d + 1, sessoes, kwh,
      custo: kwh * state.tarifa + sessoes * AMORT,
      lucro: sessoes * tetoCortesia(seg.margem, seg.ticket, state.tarifa).lucro * (0.8 + rnd() * 0.5),
    });
  }

  const horas = [9,10,11,11,12,13,14,15,16,17,17,18,18,19,19,20];
  state.sessoes = [];
  for (let i = 0; i < 24; i++){
    const p = state.pontos[Math.floor(rnd() * 4)];
    const kwh = 2 + rnd() * 9;
    state.sessoes.push({
      dia: 30 - Math.floor(i / 3), hora: horas[Math.floor(rnd() * horas.length)],
      minuto: Math.floor(rnd() * 60), ponto: p.nome, modo: p.modo, kwh,
      compra: rnd() < 0.62 ? 40 + rnd() * 180 : 0,
      cobrado: p.modo === 'pago' ? kwh * 0.95 : 0,
    });
  }
  state.sessoes.sort((a,b) => b.dia - a.dia || b.hora - a.hora);
}

const totais = () => state.dias.reduce(
  (a,d) => ({l:a.l+d.lucro, c:a.c+d.custo, k:a.k+d.kwh, s:a.s+d.sessoes}), {l:0,c:0,k:0,s:0});

/* ==========================================================================
   toast, modal, drawer
   ========================================================================== */
function toast(msg){
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}
const abrirModal  = id => { $(id).hidden = false; };
const fecharModal = id => { $(id).hidden = true; };

function abrirDrawer(ponto){
  const teto = tetoCortesia(+$('#inMargem').value, +$('#inTicket').value, state.tarifa);
  $('#drawerTitle').textContent = ponto.nome;
  $('#drawerBody').innerHTML = `
    <div class="field"><label>Modelo de cobrança</label>
      <div class="mode-toggle" data-ponto="${ponto.id}">
        <button data-mode="cortesia" aria-pressed="${ponto.modo==='cortesia'}">Cortesia</button>
        <button data-mode="pago" aria-pressed="${ponto.modo==='pago'}">Por kWh</button>
      </div>
      <small>${ponto.modo === 'cortesia'
        ? `Teto sugerido para esta loja: <b>${num(teto.kwh,1)} kWh</b> — cerca de ${Math.round(teto.kwh*KM_KWH)} km.`
        : 'O cliente paga por quilowatt-hora entregue.'}</small>
    </div>
    <div class="field"><label>Potência</label><input type="text" value="${num(ponto.kw,1)} kW" readonly></div>
    <div class="field"><label>Situação</label>
      <p class="kpi-meta">${{carregando:'Carregando agora', livre:'Livre', falha:'Sem comunicação há 2 h'}[ponto.estado]}
      ${ponto.cliente ? ` · ${ponto.cliente} em ${Math.round(ponto.soc*100)}%` : ''}</p></div>
    <a class="primary-button" style="text-align:center" target="_blank" rel="noopener"
       href="../vaga/?vaga=${encodeURIComponent(ponto.nome)}&loja=${encodeURIComponent(state.loja)}&modo=${ponto.modo}&full=1">
      Abrir a telinha desta vaga
    </a>`;
  $('#drawerBackdrop').hidden = false;
  $('#pointDrawer').hidden = false;
}
function fecharDrawer(){ $('#drawerBackdrop').hidden = true; $('#pointDrawer').hidden = true; }

/* ==========================================================================
   barra lateral: colapso, tooltip e grupos
   ========================================================================== */
function createSidebarModule(){
  let tooltip = null;

  function ensureTooltip(){
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.className = 'collapsed-sidebar-tooltip';
    tooltip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tooltip);
    return tooltip;
  }
  function showTooltip(target){
    const label = target.dataset.tooltip;
    if (!label || !document.body.classList.contains('sidebar-collapsed') || isCompactViewport()) return;
    const node = ensureTooltip();
    node.textContent = label;
    const r = target.getBoundingClientRect();
    node.style.left = `${r.right + 12}px`;
    node.style.top  = `${r.top + r.height / 2}px`;
    node.classList.add('is-visible');
  }
  const hideTooltip = () => tooltip?.classList.remove('is-visible');

  function setCollapsed(collapsed, persist = true){
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    $('#sidebarToggleDesktop').setAttribute('aria-label', collapsed ? 'Expandir menu' : 'Recolher menu');
    $('#cfgCollapsed').checked = collapsed;
    if (!collapsed) hideTooltip();
    if (persist) gravar(LS.colapso, collapsed);
  }
  const isCollapsed = () => document.body.classList.contains('sidebar-collapsed');

  function syncGroupToggle(group){
    const t = $('.nav-group-toggle', group);
    t?.setAttribute('aria-expanded', String(!group.classList.contains('is-collapsed')));
  }
  function persistGroups(){
    gravar(LS.grupos, $$('.nav-group.is-collapsed').map(g => g.dataset.navGroup));
  }

  function init(){
    setCollapsed(ler(LS.colapso, false), false);
    ler(LS.grupos, []).forEach(key => {
      const g = $(`[data-nav-group="${key}"]`);
      if (g) { g.classList.add('is-collapsed'); syncGroupToggle(g); }
    });
    $$('.nav-group').forEach(syncGroupToggle);

    $('#sidebarToggleDesktop').onclick = () => setCollapsed(!isCollapsed());
    $('#menuBtn').onclick = () => document.body.classList.toggle('sidebar-open');

    $$('.nav-group-toggle').forEach(btn => btn.onclick = () => {
      // Colapsada, os grupos ficam sempre abertos (só ícones) — recolher ali
      // esconderia itens sem dar pista nenhuma de que existem.
      if (isCollapsed() && !isCompactViewport()) return;
      const g = btn.closest('.nav-group');
      g.classList.toggle('is-collapsed');
      syncGroupToggle(g); persistGroups();
    });

    $$('[data-tooltip]').forEach(el => {
      el.addEventListener('mouseenter', () => showTooltip(el));
      el.addEventListener('mouseleave', hideTooltip);
      el.addEventListener('focus', () => showTooltip(el));
      el.addEventListener('blur', hideTooltip);
    });
    window.addEventListener('scroll', hideTooltip, true);
  }

  return {init, setCollapsed, isCollapsed, syncGroupToggle};
}

/* ==========================================================================
   navegação entre seções
   ========================================================================== */
const TITULOS = {
  painel:       ['Painel', 'Agosto de 2026 · dados de demonstração'],
  carregadores: ['Carregadores', 'Modelo de cobrança de cada ponto'],
  sessoes:      ['Sessões', 'O que aconteceu em cada recarga'],
  clientes:     ['Clientes', 'Quem carrega, quanto gasta e se volta'],
  financeiro:   ['Financeiro', 'Se a cortesia se paga, e até onde'],
  alertas:      ['Alertas', 'O que precisa de atenção'],
};
const canAccessSection = s => Boolean(TITULOS[s]);

function setSection(secao){
  if (!canAccessSection(secao)) return;
  state.section = secao;
  $$('.page').forEach(p => p.classList.toggle('is-active', p.dataset.page === secao));
  $$('.nav-item[data-section]').forEach(b => b.classList.toggle('active', b.dataset.section === secao));
  $('#pageTitle').textContent = TITULOS[secao][0];
  $('#pageSubtitle').textContent = TITULOS[secao][1];
  $('#dashboardEditToggle').hidden = secao !== 'painel';
  document.body.classList.remove('sidebar-open');
}

/* ==========================================================================
   gerenciador de cards do painel
   ========================================================================== */
const CARDS = {
  lucro:      {nome:'Lucro atribuído',  desc:'Quanto o carregador devolveu em caixa', span:3},
  sessoes:    {nome:'Sessões no mês',   desc:'Volume de recargas',                    span:3},
  clientes:   {nome:'Clientes únicos',  desc:'Quantas pessoas diferentes',            span:3},
  energia:    {nome:'Energia entregue', desc:'Consumo e custo',                       span:3},
  retorno:    {nome:'Lucro × custo',    desc:'A linha verde precisa ficar acima',     span:8},
  horas:      {nome:'Sessões por hora', desc:'Onde está o pico do dia',               span:4},
  pontos:     {nome:'Carregadores ao vivo', desc:'Quem está usando agora',            span:12},
  ocupacao:   {nome:'Ocupação da semana', desc:'Quais dias enchem',                   span:6},
  ticket:     {nome:'Ticket comparado', desc:'Quem carrega gasta mais?',              span:6},
};
const CARDS_PADRAO = ['lucro','sessoes','clientes','energia','retorno','horas','pontos'];

function createDashboardManager(){
  let editando = false;
  let arrastando = null;

  const ativos = () => ler(LS.cards, CARDS_PADRAO).filter(id => CARDS[id]);
  const salvar = ids => gravar(LS.cards, ids);

  function corpo(id){
    const t = totais(), seg = SEGMENTOS[state.segmento];
    switch (id){
      case 'lucro': return kpi('Retorno','Lucro atribuído', brl(t.l), '<span class="delta up">+18%</span> vs mês anterior', 'good',
        '<path d="M3 17l6-6 4 4 8-8"/><path d="M21 7v5h-5"/>');
      case 'sessoes': return kpi('Operação','Sessões no mês', num(t.s), `${num(t.s/30,1)} por dia, em média`, 'amber',
        '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z"/>');
      case 'clientes': return kpi('Público','Clientes únicos', num(Math.round(t.s*0.62)), '62% voltaram ao menos uma vez', '',
        '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/>');
      case 'energia': return kpi('Custo','Energia entregue', `${num(t.k)} kWh`, `${brl(t.k*state.tarifa)} de energia`, 'warn',
        '<path d="M12 3v18"/><path d="M16.5 7.5A3.5 3.5 0 0 0 13 5h-2a3 3 0 0 0 0 6h2a3 3 0 0 1 0 6h-2a3.5 3.5 0 0 1-3.5-2.5"/>');
      case 'retorno': return `<div class="section-head"><div><p class="eyebrow">Retorno</p><h2>Lucro atribuído × custo de energia</h2></div></div>
        <div class="chart"><svg id="chartRetorno" viewBox="0 0 720 250" role="img" aria-label="Lucro atribuído contra custo de energia"></svg></div>
        <div class="legend"><span><i style="background:var(--success)"></i>lucro atribuído</span><span><i style="background:var(--amber)"></i>custo de energia</span></div>`;
      case 'horas': return `<div><p class="eyebrow">Movimento</p><h2>Sessões por hora</h2></div>
        <div class="chart"><svg id="chartHoras" viewBox="0 0 340 250" role="img" aria-label="Sessões por hora do dia"></svg></div>
        <p class="kpi-meta" id="horaPico"></p>`;
      case 'pontos': return `<div class="section-head"><div><p class="eyebrow">Agora</p><h2>Situação dos carregadores</h2></div>
        <span class="spacer"></span><button class="ghost-button" data-goto="carregadores">Configurar</button></div>
        <div class="rows" id="pointsLive"></div>`;
      case 'ocupacao': return `<div><p class="eyebrow">Semana</p><h2>Ocupação por dia</h2></div>
        <div class="chart"><svg id="chartSemana" viewBox="0 0 360 200" role="img" aria-label="Sessões por dia da semana"></svg></div>`;
      case 'ticket': return `<div><p class="eyebrow">Comparação</p><h2>Ticket de quem carrega</h2></div>
        <div class="chart"><svg id="chartTicket" viewBox="0 0 360 200" role="img" aria-label="Ticket comparado"></svg></div>
        <p class="kpi-meta">Base: ticket médio de ${brl(seg.ticket)} da loja.</p>`;
      default: return '';
    }
  }
  const kpi = (eyebrow, titulo, valor, meta, tom, icone) => `
    <div class="kpi-icon"><svg viewBox="0 0 24 24">${icone}</svg></div>
    <p class="eyebrow">${eyebrow}</p><h3>${titulo}</h3>
    <strong class="kpi-value">${valor}</strong><p class="kpi-meta">${meta}</p>`;

  function render(){
    const grid = $('#dashboardGrid');
    grid.innerHTML = ativos().map(id => `
      <article class="card span-${CARDS[id].span}" data-card="${id}" data-tone="${
        {lucro:'good', sessoes:'amber', energia:'warn'}[id] || ''}" draggable="false">
        <div class="card-tools">
          <button class="card-tool handle" type="button" aria-label="Mover ${CARDS[id].nome}" data-drag>
            <svg viewBox="0 0 24 24"><path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"/></svg></button>
          <button class="card-tool" type="button" aria-label="Remover ${CARDS[id].nome}" data-remove="${id}">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
        ${corpo(id)}
      </article>`).join('');
    aplicarEdicao();
    desenharGraficos();
    renderPontosAoVivo();
  }

  function renderBiblioteca(){
    const usados = ativos();
    $('#cardLibrary').innerHTML = Object.entries(CARDS).map(([id, c]) => `
      <button type="button" data-add="${id}" ${usados.includes(id) ? 'disabled' : ''}>
        <b>${c.nome}</b><small>${usados.includes(id) ? 'já está no painel' : c.desc}</small>
      </button>`).join('');
  }

  function aplicarEdicao(){
    document.body.classList.toggle('dashboard-editing', editando);
    $('#cardLibraryWrap').hidden = !editando;
    $('#dashboardEditToggle').textContent = editando ? 'Concluir edição' : 'Editar painel';
    $$('#dashboardGrid .card').forEach(c => c.draggable = editando);
  }

  function toggleEdicao(){
    editando = !editando;
    if (editando) renderBiblioteca();
    aplicarEdicao();
    toast(editando ? 'Arraste os cards para reordenar, ou remova no X.' : 'Painel salvo.');
  }

  function init(){
    render();
    $('#dashboardEditToggle').onclick = toggleEdicao;
    $('#dashboardReset').onclick = () => { salvar(CARDS_PADRAO); render(); renderBiblioteca(); toast('Painel restaurado.'); };

    $('#dashboardGrid').addEventListener('click', e => {
      const rm = e.target.closest('[data-remove]');
      if (rm){ salvar(ativos().filter(id => id !== rm.dataset.remove)); render(); renderBiblioteca(); toast('Card removido.'); return; }
      const goto = e.target.closest('[data-goto]');
      if (goto) setSection(goto.dataset.goto);
    });
    $('#cardLibrary').addEventListener('click', e => {
      const add = e.target.closest('[data-add]');
      if (!add || add.disabled) return;
      salvar([...ativos(), add.dataset.add]); render(); renderBiblioteca(); toast('Card adicionado.');
    });

    // arrastar para reordenar
    const grid = $('#dashboardGrid');
    grid.addEventListener('dragstart', e => {
      const card = e.target.closest('.card[data-card]');
      if (!editando || !card) return;
      arrastando = card; card.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    grid.addEventListener('dragend', () => {
      arrastando?.classList.remove('is-dragging'); arrastando = null;
      salvar($$('#dashboardGrid .card').map(c => c.dataset.card));
      desenharGraficos(); renderPontosAoVivo();
    });
    grid.addEventListener('dragover', e => {
      if (!arrastando) return;
      e.preventDefault();
      const alvo = e.target.closest('.card[data-card]');
      if (!alvo || alvo === arrastando) return;
      const r = alvo.getBoundingClientRect();
      alvo.parentNode.insertBefore(arrastando, (e.clientY - r.top) / r.height > 0.5 ? alvo.nextSibling : alvo);
    });
  }

  return {init, render, renderBiblioteca};
}

/* ==========================================================================
   gráficos — SVG desenhado à mão
   ========================================================================== */
function desenharGraficos(){
  const t = totais();

  if ($('#chartRetorno')){
    const W=720,H=250,L=48,R=14,T=16,B=30, d=state.dias;
    const max = Math.max(...d.map(x => Math.max(x.lucro, x.custo))) * 1.15 || 1;
    const x = i => L + i*(W-L-R)/(d.length-1), y = v => H-B - v*(H-T-B)/max;
    let g = '';
    for (let k=0;k<=4;k++){
      const v = max*k/4;
      g += `<line x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}" stroke="${css('--chart-grid')}"/>
            <text x="${L-8}" y="${y(v)+4}" text-anchor="end" font-size="10" font-family="JetBrains Mono,monospace" fill="${css('--text-muted')}">${num(v)}</text>`;
    }
    const path = key => d.map((p,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
    g += `<path d="${path('lucro')} L${x(d.length-1)},${y(0)} L${L},${y(0)} Z" fill="${css('--success')}" opacity=".10"/>`;
    g += `<path d="${path('lucro')}" fill="none" stroke="${css('--success')}" stroke-width="2.2" stroke-linejoin="round"/>`;
    g += `<path d="${path('custo')}" fill="none" stroke="${css('--amber')}" stroke-width="1.8" stroke-linejoin="round"/>`;
    for (let i=0;i<d.length;i+=6)
      g += `<text x="${x(i)}" y="${H-B+15}" text-anchor="middle" font-size="10" font-family="JetBrains Mono,monospace" fill="${css('--text-muted')}">${d[i].dia}</text>`;
    $('#chartRetorno').innerHTML = g;
  }

  if ($('#chartHoras')){
    const W=340,H=250,L=30,R=10,T=12,B=28;
    const b = new Array(24).fill(0); state.sessoes.forEach(s => b[s.hora]++);
    const faixa = b.slice(7,22), max = Math.max(...faixa) || 1;
    const slot=(W-L-R)/faixa.length, bw=slot*0.62;
    let g='';
    for (let k=0;k<=3;k++){
      const v=max*k/3, yy=H-B-v*(H-T-B)/max;
      g += `<line x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}" stroke="${css('--chart-grid')}"/>
            <text x="${L-6}" y="${yy+4}" text-anchor="end" font-size="9" font-family="JetBrains Mono,monospace" fill="${css('--text-muted')}">${Math.round(v)}</text>`;
    }
    faixa.forEach((v,i)=>{
      const h=v*(H-T-B)/max;
      g += `<rect x="${L+slot*i+(slot-bw)/2}" y="${H-B-h}" width="${bw}" height="${h}" rx="2" fill="${css('--primary')}" opacity="${v===max?1:.6}"/>`;
      if (i%3===0) g += `<text x="${L+slot*i+slot/2}" y="${H-B+14}" text-anchor="middle" font-size="9" font-family="JetBrains Mono,monospace" fill="${css('--text-muted')}">${i+7}h</text>`;
    });
    $('#chartHoras').innerHTML = g;
    const pico = faixa.indexOf(Math.max(...faixa)) + 7;
    if ($('#horaPico')) $('#horaPico').textContent = `Pico às ${pico}h. É onde vale abrir mais uma vaga.`;
  }

  if ($('#chartSemana')){
    const W=360,H=200,L=30,R=10,T=12,B=28;
    const dias=['dom','seg','ter','qua','qui','sex','sáb'], soma=new Array(7).fill(0);
    state.dias.forEach((d,i) => soma[i%7] += d.sessoes);
    const max=Math.max(...soma)||1, slot=(W-L-R)/7, bw=slot*0.55;
    let g='';
    soma.forEach((v,i)=>{
      const h=v*(H-T-B)/max;
      g += `<rect x="${L+slot*i+(slot-bw)/2}" y="${H-B-h}" width="${bw}" height="${h}" rx="3" fill="${css('--primary')}" opacity="${v===max?1:.55}"/>
            <text x="${L+slot*i+slot/2}" y="${H-B+14}" text-anchor="middle" font-size="9.5" fill="${css('--text-muted')}">${dias[i]}</text>`;
    });
    $('#chartSemana').innerHTML = g;
  }

  if ($('#chartTicket')){
    const seg=SEGMENTOS[state.segmento], W=360,H=200;
    const vals=[{k:'não carregou',v:seg.ticket,c:css('--text-muted')},{k:'carregou',v:seg.ticket*1.12,c:css('--success')}];
    const max=Math.max(...vals.map(v=>v.v))*1.2;
    let g='';
    vals.forEach((d,i)=>{
      const h=d.v*(H-60)/max, x=70+i*140;
      g += `<rect x="${x}" y="${H-34-h}" width="80" height="${h}" rx="4" fill="${d.c}" opacity=".9"/>
            <text x="${x+40}" y="${H-40-h}" text-anchor="middle" font-size="12" font-weight="700" font-family="JetBrains Mono,monospace" fill="${css('--text-primary')}">${brl(d.v)}</text>
            <text x="${x+40}" y="${H-14}" text-anchor="middle" font-size="10.5" fill="${css('--text-muted')}">${d.k}</text>`;
    });
    $('#chartTicket').innerHTML = g;
  }

  if ($('#chartRecorrencia')){
    const W=720,H=200,L=42,R=14,T=14,B=30;
    const dist=[{k:'1 visita',v:38},{k:'2',v:21},{k:'3',v:14},{k:'4 a 6',v:17},{k:'7+',v:10}];
    const max=Math.max(...dist.map(d=>d.v)), slot=(W-L-R)/dist.length, bw=Math.min(84,slot*0.55);
    let g='';
    dist.forEach((d,i)=>{
      const h=d.v*(H-T-B)/max, cx=L+slot*i+slot/2;
      g += `<rect x="${cx-bw/2}" y="${H-B-h}" width="${bw}" height="${h}" rx="3" fill="${i?css('--primary'):css('--text-muted')}" opacity="${i?1:.5}"/>
            <text x="${cx}" y="${H-B-h-7}" text-anchor="middle" font-size="11" font-weight="600" font-family="JetBrains Mono,monospace" fill="${css('--text-primary')}">${d.v}%</text>
            <text x="${cx}" y="${H-B+16}" text-anchor="middle" font-size="10" fill="${css('--text-muted')}">${d.k}</text>`;
    });
    $('#chartRecorrencia').innerHTML = g;
  }

  if ($('#chartFinanceiro')){
    const W=360,H=240,cx=W/2,cy=104,r=72, saldo=t.l-t.c;
    const partes=[{rot:'lucro atribuído',v:t.l,cor:css('--success')},
                  {rot:'energia',v:t.k*state.tarifa,cor:css('--amber')},
                  {rot:'equipamento',v:Math.max(0,t.c-t.k*state.tarifa),cor:css('--text-muted')}];
    const total=partes.reduce((a,p)=>a+p.v,0)||1;
    let ang=-Math.PI/2, g='';
    partes.forEach(p=>{
      const a2=ang+2*Math.PI*p.v/total, big=a2-ang>Math.PI?1:0;
      g += `<path d="M${cx},${cy} L${cx+r*Math.cos(ang)},${cy+r*Math.sin(ang)} A${r},${r} 0 ${big},1 ${cx+r*Math.cos(a2)},${cy+r*Math.sin(a2)} Z" fill="${p.cor}" opacity=".9"/>`;
      ang=a2;
    });
    g += `<circle cx="${cx}" cy="${cy}" r="45" fill="${css('--bg-surface')}"/>
          <text x="${cx}" y="${cy-1}" text-anchor="middle" font-size="16" font-weight="700" font-family="JetBrains Mono,monospace" fill="${saldo>0?css('--success'):css('--danger')}">${brl(saldo)}</text>
          <text x="${cx}" y="${cy+16}" text-anchor="middle" font-size="10" fill="${css('--text-muted')}">saldo do mês</text>`;
    partes.forEach((p,i)=>{
      const yy=196+i*14;
      g += `<rect x="30" y="${yy-8}" width="9" height="9" rx="2" fill="${p.cor}"/>
            <text x="46" y="${yy}" font-size="10.5" fill="${css('--text-secondary')}">${p.rot}</text>
            <text x="${W-22}" y="${yy}" text-anchor="end" font-size="10.5" font-family="JetBrains Mono,monospace" fill="${css('--text-primary')}">${brl(p.v)}</text>`;
    });
    $('#chartFinanceiro').innerHTML = g;
  }
}

/* ==========================================================================
   listas
   ========================================================================== */
const ROTULO = {carregando:'Carregando', livre:'Livre', falha:'Fora do ar'};

function linhaPonto(p, comToggle){
  const detalhe = p.estado === 'carregando' ? `${p.cliente} · ${Math.round(p.soc*100)}%`
                : p.estado === 'falha' ? 'Sem comunicação há 2 h' : 'Pronta para uso';
  const lado = comToggle
    ? `<div class="mode-toggle" data-ponto="${p.id}">
         <button data-mode="cortesia" aria-pressed="${p.modo==='cortesia'}">Cortesia</button>
         <button data-mode="pago" aria-pressed="${p.modo==='pago'}">Por kWh</button>
       </div>
       <button class="ghost-button" data-drawer="${p.id}">Detalhes</button>`
    : `<span class="pill ${p.modo}">${p.modo==='cortesia'?'Cortesia':'Por kWh'}</span>`;
  return `<div class="row-item"><span class="dot ${p.estado}"></span>
    <div class="row-copy"><b>${p.nome}</b><span>${num(p.kw,1)} kW · ${ROTULO[p.estado]} · ${detalhe}</span></div>
    <div class="row-side">${lado}</div></div>`;
}
function renderPontosAoVivo(){
  if ($('#pointsLive')) $('#pointsLive').innerHTML = state.pontos.map(p => linhaPonto(p, false)).join('');
}
function renderConfigPontos(){
  $('#pointsConfig').innerHTML = state.pontos.map(p => linhaPonto(p, true)).join('');
}
function renderSessoes(){
  const f = $('#filtroModo').value;
  const lista = state.sessoes.filter(s => f === 'todos' || s.modo === f);
  const max = Math.max(...state.sessoes.map(s => s.kwh));
  $('#sessionList').innerHTML = lista.map(s => `
    <div class="session" data-mode="${s.modo}">
      <span class="when">${String(s.dia).padStart(2,'0')}/08 ${String(s.hora).padStart(2,'0')}:${String(s.minuto).padStart(2,'0')}</span>
      <div><div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:5px">
        <span>${s.ponto}</span><span class="pill ${s.modo}">${s.modo==='cortesia'?'Cortesia':'Por kWh'}</span></div>
        <div class="bar"><i style="width:${100*s.kwh/max}%"></i></div></div>
      <span class="val">${num(s.kwh,1)} kWh · ${Math.round(s.kwh*KM_KWH)} km</span>
      <span class="val">${s.compra ? brl(s.compra) : (s.cobrado ? brl(s.cobrado) : '—')}</span>
    </div>`).join('') || '<p class="kpi-meta">Nenhuma sessão neste filtro.</p>';
}
function renderClientes(){
  const seg = SEGMENTOS[state.segmento];
  $('#kpiRecorrencia').textContent = '62%';
  $('#kpiTicketEV').textContent = brl(seg.ticket * 1.12);
  $('#kpiTicketDelta').innerHTML = '<span class="delta up">+12%</span> sobre o ticket da loja';
  $('#kpiCupom').textContent = '58%';
}
function renderAlertas(){
  $('#alertList').innerHTML = `
    <div class="row-item"><span class="dot falha"></span>
      <div class="row-copy"><b>Vaga 4 — fundos sem comunicação</b><span>Última leitura há 2 horas. Ninguém consegue usar.</span></div>
      <div class="row-side"><span class="pill alert">aberto</span></div></div>
    <div class="row-item"><span class="dot livre"></span>
      <div class="row-copy"><b>Demanda contratada em 71%</b><span>Pico de 53 kW num limite de 75 kW. Sem risco por enquanto.</span></div>
      <div class="row-side"><span class="pill ok">ok</span></div></div>`;
}

function calcular(){
  const m=+$('#inMargem').value, tk=+$('#inTicket').value, tf=+$('#inTarifa').value;
  $('#outMargem').textContent = `${num(m,1)}%`;
  $('#outTicket').textContent = brl(tk);
  $('#outTarifa').textContent = `${brl(tf)}/kWh`;
  const r = tetoCortesia(m, tk, tf);
  $('#tetoResultado').innerHTML = r.kwh > 0.4
    ? `Cada sessão gera <b>${brl(r.lucro)}</b> de lucro. Descontado o equipamento, sobram <b>${brl(r.sobra)}</b>.<br>
       <b style="font-size:1.15rem">Teto recomendado: ${num(r.kwh,1)} kWh</b> — cerca de <b>${Math.round(r.kwh*KM_KWH)} km</b> de cortesia.`
    : `Cada sessão gera <b>${brl(r.lucro)}</b> de lucro, menos que o custo do equipamento por sessão.
       <b>Neste cenário a cortesia não se paga</b> — o caminho é cobrar por kWh.`;
}

function renderTudo(){
  $('#clientName').textContent = state.loja;
  $('#profileName').textContent = state.usuario;
  $('#profileInitials').textContent = state.usuario.split(' ').map(p=>p[0]).slice(0,2).join('').toUpperCase();
  dashboard.render();
  renderConfigPontos(); renderSessoes(); renderClientes(); renderAlertas();
  desenharGraficos();
}

/* ==========================================================================
   tema
   ========================================================================== */
function aplicarTema(t, persist = true){
  document.documentElement.dataset.theme = t;
  $('#cfgTheme').checked = t === 'dark';
  $('#themeIcon').innerHTML = t === 'dark'
    ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>'
    : '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>';
  if (persist) gravar(LS.tema, t);
  if (state.dias.length) desenharGraficos();
}

/* ==========================================================================
   tour guiado — spotlight de 4 bandas, anel e balão com seta
   ========================================================================== */
const TOUR_STEPS = [
  {id:'welcome', section:null, target:null, placement:'center',
   title:'Bem-vindo ao painel', body:'Um tour rápido pelas áreas principais. São poucos passos, e você pode parar quando quiser.'},
  {id:'client', section:null, target:'#clientSwitcher', placement:'right',
   title:'Seu estabelecimento', body:'Tudo aqui é desta loja. Quem tem mais de uma troca por este seletor.'},
  {id:'kpis', section:'painel', target:'[data-card="lucro"]', placement:'bottom',
   title:'A resposta primeiro', body:'O número que interessa é o lucro atribuído a quem carregou — não quantos quilowatt-hora saíram.'},
  {id:'grafico', section:'painel', target:'[data-card="retorno"]', placement:'top',
   title:'Lucro contra custo', body:'A linha verde precisa ficar acima da âmbar. Quando encostam, a cortesia está grande demais.'},
  {id:'editar', section:'painel', target:'#dashboardEditToggle', placement:'bottom',
   title:'Monte o seu painel', body:'Em "Editar painel" você adiciona, remove e arrasta os cards. Fica salvo neste navegador.'},
  {id:'carregadores', section:'carregadores', target:'#chargerHint', placement:'bottom',
   forceExpandGroup:'operacao',
   title:'Cortesia ou cobrança', body:'Cada carregador pode ter um modelo diferente. A vaga da frente atrai cliente; a dos fundos pode cobrar.'},
  {id:'calculadora', section:'financeiro', target:'#calcHint', placement:'bottom',
   forceExpandGroup:'negocio',
   title:'Quanto você pode dar', body:'Com a sua margem e o seu ticket, o painel calcula o teto de cortesia que não dá prejuízo.'},
  {id:'menu', section:null, target:'#sidebarToggleDesktop', placement:'right',
   title:'Menu recolhido', body:'Esta setinha recolhe o menu para só os ícones, e passar o mouse mostra o nome de cada seção.',
   skipIf: () => isCompactViewport()},
  {id:'tema', section:null, target:'#themeBtn', placement:'bottom',
   title:'Claro ou escuro', body:'A escolha fica salva neste navegador. Pronto — é só isso.'},
];

function createTourModule({state, setSection, canAccessSection, isCompactViewport, setSidebarCollapsed, syncSidebarGroupToggle, waitForNextPaint}){
  const el = {};
  let steps = [], stepIndex = 0, transitioning = false, resizeTicking = false;
  const restore = {sidebarWasCollapsed:false, forcedGroups:new Set()};

  function ensureDom(){
    if (el.overlay) return;
    const overlay = document.createElement('div');
    overlay.className = 'tour-overlay';
    overlay.id = 'tourOverlay';
    overlay.innerHTML = `
      <div class="tour-scrim tour-scrim-top"></div>
      <div class="tour-scrim tour-scrim-bottom"></div>
      <div class="tour-scrim tour-scrim-left"></div>
      <div class="tour-scrim tour-scrim-right"></div>
      <div class="tour-spot-ring" id="tourSpotRing"></div>
      <div class="tour-loading-spinner" id="tourLoadingSpinner" aria-hidden="true"></div>
      <div class="tour-balloon" id="tourBalloon" role="dialog" aria-modal="true" aria-live="polite" aria-labelledby="tourBalloonTitle">
        <p class="tour-balloon-step" id="tourBalloonStep"></p>
        <h3 id="tourBalloonTitle"></h3>
        <p id="tourBalloonBody"></p>
        <div class="tour-balloon-actions">
          <button class="ghost-button" id="tourStop" type="button">Parar</button>
          <div class="tour-balloon-nav">
            <button class="ghost-button" id="tourPrev" type="button">Voltar</button>
            <button class="primary-button" id="tourNext" type="button">Próximo</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    Object.assign(el, {
      overlay,
      scrimTop:    $('.tour-scrim-top', overlay),
      scrimBottom: $('.tour-scrim-bottom', overlay),
      scrimLeft:   $('.tour-scrim-left', overlay),
      scrimRight:  $('.tour-scrim-right', overlay),
      ring:        $('#tourSpotRing', overlay),
      spinner:     $('#tourLoadingSpinner', overlay),
      balloon:     $('#tourBalloon', overlay),
      stepLabel:   $('#tourBalloonStep', overlay),
      title:       $('#tourBalloonTitle', overlay),
      body:        $('#tourBalloonBody', overlay),
    });
    $('#tourStop', overlay).onclick = close;
    $('#tourPrev', overlay).onclick = prev;
    $('#tourNext', overlay).onclick = next;
  }

  const isOpen = () => Boolean(el.overlay?.classList.contains('is-open'));

  // Alvos que colapsam para quase 0x0 quando vazios não destacam nada útil:
  // sobe até 3 ancestrais procurando um retângulo com tamanho real.
  function effectiveRect(node, minSize = 24){
    let cur = node, rect = cur.getBoundingClientRect(), guard = 0;
    while ((rect.width < minSize || rect.height < minSize) && cur.parentElement && guard < 3){
      cur = cur.parentElement; rect = cur.getBoundingClientRect(); guard++;
    }
    return rect;
  }

  function forceExpandGroup(key){
    const g = $(`[data-nav-group="${key}"]`);
    if (!g || !g.classList.contains('is-collapsed')) return;
    g.classList.remove('is-collapsed');
    syncSidebarGroupToggle?.(g);
    restore.forcedGroups.add(key);
  }

  const targetLivesInSidebar = sel =>
    sel.startsWith('[data-nav-group') || sel.startsWith('[data-section') ||
    sel === '#clientSwitcher' || sel === '#profileShortcut' || sel === '#sidebarToggleDesktop';

  async function resolveTarget(step){
    if (!step.target) return null;
    if (step.section && step.section !== state.section){ setSection(step.section); await waitForNextPaint(); }
    if (step.forceExpandGroup) forceExpandGroup(step.forceExpandGroup);
    if (isCompactViewport() && targetLivesInSidebar(step.target)) document.body.classList.add('sidebar-open');
    await waitForNextPaint();
    const node = $(step.target);
    if (step.skipIf?.(node) || !node) return 'SKIP';
    node.scrollIntoView({block:'nearest', behavior:'instant'});
    await waitForNextPaint();
    return node;
  }

  function positionSpotlight(rect, padding = 8){
    const vw = innerWidth, vh = innerHeight;
    const top = Math.max(rect.top - padding, 0), bottom = Math.min(rect.bottom + padding, vh);
    const left = Math.max(rect.left - padding, 0), right = Math.min(rect.right + padding, vw);
    el.scrimTop.style.height = `${top}px`;
    el.scrimBottom.style.height = `${Math.max(vh - bottom, 0)}px`;
    Object.assign(el.scrimLeft.style,  {top:`${top}px`, height:`${Math.max(bottom-top,0)}px`, width:`${left}px`});
    Object.assign(el.scrimRight.style, {top:`${top}px`, height:`${Math.max(bottom-top,0)}px`, width:`${Math.max(vw-right,0)}px`});
    Object.assign(el.ring.style, {top:`${top}px`, left:`${left}px`,
      width:`${Math.max(right-left,0)}px`, height:`${Math.max(bottom-top,0)}px`});
  }
  function collapseSpotlightToCenter(){
    el.scrimTop.style.height = `${innerHeight}px`;
    el.scrimBottom.style.height = '0px';
    el.scrimLeft.style.width = el.scrimLeft.style.height = '0px';
    el.scrimRight.style.width = el.scrimRight.style.height = '0px';
    el.ring.classList.remove('is-visible');
  }

  function positionBalloon(step, rect){
    const b = el.balloon;
    if (!rect){
      b.dataset.placement = 'center';
      b.style.top = b.style.left = '';
      b.style.removeProperty('--tour-arrow-offset');
      return;
    }
    const margin = 16, gap = 16;
    const br = b.getBoundingClientRect(), bw = br.width || 330, bh = br.height || 150;
    let placement = step.placement || 'bottom';
    if (placement === 'bottom' && rect.bottom + gap + bh > innerHeight - margin) placement = 'top';
    else if (placement === 'top' && rect.top - gap - bh < margin) placement = 'bottom';
    else if (placement === 'right' && rect.right + gap + bw > innerWidth - margin) placement = 'left';
    else if (placement === 'left' && rect.left - gap - bw < margin) placement = 'right';

    let top, left;
    if (placement === 'bottom'){ top = Math.min(rect.bottom + gap, innerHeight - bh - margin); left = clamp(rect.left, margin, innerWidth - bw - margin); }
    else if (placement === 'top'){ top = Math.max(rect.top - bh - gap, margin); left = clamp(rect.left, margin, innerWidth - bw - margin); }
    else if (placement === 'right'){ left = Math.min(rect.right + gap, innerWidth - bw - margin); top = clamp(rect.top, margin, innerHeight - bh - margin); }
    else { left = Math.max(rect.left - bw - gap, margin); top = clamp(rect.top, margin, innerHeight - bh - margin); }

    b.dataset.placement = placement;
    b.style.top = `${top}px`;
    b.style.left = `${left}px`;

    // A seta aponta pro centro REAL do alvo, mesmo quando o balão foi
    // empurrado pra caber na tela — offset fixo erraria perto das bordas.
    const arrowSize = 14, arrowMargin = 18;
    if (placement === 'bottom' || placement === 'top'){
      const off = clamp(rect.left + rect.width/2 - left, arrowMargin, bw - arrowMargin - arrowSize);
      b.style.setProperty('--tour-arrow-offset', `${Math.round(off)}px`);
    } else {
      const off = clamp(rect.top + rect.height/2 - top, arrowMargin, bh - arrowMargin - arrowSize);
      b.style.setProperty('--tour-arrow-offset', `${Math.round(off)}px`);
    }
  }

  const setBalloonVisible = v => el.balloon.classList.toggle('is-visible', v);
  const showSpinner = () => el.spinner.classList.add('is-visible');
  const hideSpinner = () => el.spinner.classList.remove('is-visible');

  async function goToStep(index, direction = 1){
    if (!isOpen() || index < 0) return;
    if (index >= steps.length){ hideSpinner(); close(); return; }
    const step = steps[index];
    const crossSection = Boolean(step.section) && step.section !== state.section;
    if (crossSection){
      setBalloonVisible(false);
      el.ring.classList.remove('is-visible');
      showSpinner();
      await delay(180);
    }
    const target = await resolveTarget(step);
    if (target === 'SKIP'){
      steps.splice(index, 1);
      await goToStep(direction >= 0 ? index : Math.max(0, index - 1), direction);
      return;
    }
    hideSpinner();
    stepIndex = index;
    el.stepLabel.textContent = `Passo ${index + 1} de ${steps.length}`;
    el.title.textContent = step.title;
    el.body.textContent = step.body;
    $('#tourNext').textContent = index === steps.length - 1 ? 'Concluir' : 'Próximo';
    if (target){
      const rect = effectiveRect(target);
      positionSpotlight(rect);
      el.ring.classList.add('is-visible');
      positionBalloon(step, rect);
    } else {
      collapseSpotlightToCenter();
      positionBalloon(step, null);
    }
    setBalloonVisible(true);
  }

  // Trava contra clique duplo em "Próximo" durante a troca de seção — sem
  // ela, duas transições se sobrepõem e o texto dessincroniza da tela.
  async function runTransition(index, direction){
    if (transitioning) return;
    transitioning = true;
    $('#tourNext').disabled = true;
    $('#tourPrev').disabled = true;
    try { await goToStep(index, direction); }
    finally {
      transitioning = false;
      $('#tourNext').disabled = false;
      $('#tourPrev').disabled = stepIndex <= 0;
    }
  }
  function next(){ runTransition(stepIndex + 1, 1); }
  function prev(){ runTransition(stepIndex - 1, -1); }

  async function open(){
    ensureDom();
    steps = TOUR_STEPS.filter(s => !s.section || canAccessSection(s.section));
    if (!steps.length) return;
    restore.sidebarWasCollapsed = document.body.classList.contains('sidebar-collapsed');
    restore.forcedGroups.clear();
    stepIndex = -1;
    el.overlay.classList.add('is-open');
    await runTransition(0, 1);
  }

  function close(){
    if (!el.overlay) return;
    el.overlay.classList.remove('is-open');
    setBalloonVisible(false);
    el.ring.classList.remove('is-visible');
    hideSpinner();
    const activeGroup = $('.nav-item.active')?.closest('[data-nav-group]')?.dataset.navGroup || null;
    restore.forcedGroups.forEach(key => {
      if (key === activeGroup) return;
      const g = $(`[data-nav-group="${key}"]`);
      if (g){ g.classList.add('is-collapsed'); syncSidebarGroupToggle?.(g); }
    });
    restore.forcedGroups.clear();
    if (restore.sidebarWasCollapsed) setSidebarCollapsed(true, false);
  }

  addEventListener('resize', () => {
    if (!isOpen() || resizeTicking) return;
    resizeTicking = true;
    requestAnimationFrame(() => { resizeTicking = false; goToStep(stepIndex, 0); });
  });
  addEventListener('keydown', e => {
    if (!isOpen()) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') next();
    if (e.key === 'ArrowLeft') prev();
  });

  return {open, close, isOpen};
}

/* ==========================================================================
   arranque
   ========================================================================== */
const sidebar = createSidebarModule();
const dashboard = createDashboardManager();
const tour = createTourModule({
  state, setSection, canAccessSection, isCompactViewport,
  setSidebarCollapsed: sidebar.setCollapsed,
  syncSidebarGroupToggle: sidebar.syncGroupToggle,
  waitForNextPaint,
});

function trocarLoja(l){
  state.loja = l.nome; state.segmento = l.segmento;
  const seg = SEGMENTOS[l.segmento];
  $('#inMargem').value = seg.margem; $('#inTicket').value = seg.ticket;
  $('#cfgStore').value = l.nome; $('#cfgSegmento').value = l.segmento;
  carregarDados(); renderTudo(); calcular();
  fecharModal('#modalLoja');
  toast(`Agora vendo ${l.nome}.`);
}

function iniciar(){
  const perfil = ler(LS.perfil, {});
  state.usuario = perfil.usuario || state.usuario;

  aplicarTema(ler(LS.tema, matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), false);
  sidebar.init();

  const seg = SEGMENTOS[state.segmento];
  $('#inMargem').value = seg.margem;
  $('#inTicket').value = seg.ticket;
  $('#inTarifa').value = state.tarifa;
  $('#cfgStore').value = state.loja;
  $('#cfgName').value = state.usuario;
  $('#cfgSegmento').value = state.segmento;

  carregarDados();
  dashboard.init();
  renderTudo();
  calcular();
  setSection('painel');

  $$('.nav-item[data-section]').forEach(b => b.onclick = () => setSection(b.dataset.section));
  $('#themeBtn').onclick = () => aplicarTema(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('#settingsBtn').onclick = () => abrirModal('#modalConfig');
  $('#profileShortcut').onclick = () => abrirModal('#modalConfig');
  $('#filtroModo').onchange = renderSessoes;
  ['#inMargem','#inTicket','#inTarifa'].forEach(s => $(s).oninput = calcular);

  $('#clientSwitcher').onclick = () => {
    $('#storeList').innerHTML = LOJAS.map(l => `
      <div class="row-item" data-loja="${l.nome}" style="cursor:pointer">
        <span class="dot ${l.nome === state.loja ? 'livre' : ''}"></span>
        <div class="row-copy"><b>${l.nome}</b><span>${SEGMENTOS[l.segmento].nome}</span></div>
        <div class="row-side">${l.nome === state.loja ? '<span class="pill ok">atual</span>' : ''}</div>
      </div>`).join('');
    $$('#storeList .row-item').forEach(n => n.onclick = () => trocarLoja(LOJAS.find(x => x.nome === n.dataset.loja)));
    abrirModal('#modalLoja');
  };

  $$('[data-close-modal]').forEach(b => b.onclick = () => b.closest('.modal-backdrop').hidden = true);
  $$('.modal-backdrop').forEach(m => m.onclick = e => { if (e.target === m) m.hidden = true; });
  $('#drawerClose').onclick = fecharDrawer;
  $('#drawerBackdrop').onclick = fecharDrawer;

  $('#cfgTheme').onchange = e => aplicarTema(e.target.checked ? 'dark' : 'light');
  $('#cfgCollapsed').onchange = e => sidebar.setCollapsed(e.target.checked);
  $('#cfgSegmento').onchange = e => {
    state.segmento = e.target.value;
    $('#inMargem').value = SEGMENTOS[e.target.value].margem;
    $('#inTicket').value = SEGMENTOS[e.target.value].ticket;
    carregarDados(); renderTudo(); calcular();
  };
  $('#cfgSave').onclick = () => {
    state.loja = $('#cfgStore').value.trim() || state.loja;
    state.usuario = $('#cfgName').value.trim() || state.usuario;
    gravar(LS.perfil, {usuario: state.usuario});
    renderTudo(); fecharModal('#modalConfig'); toast('Configurações salvas.');
  };

  // troca de modo e gaveta, em qualquer lista
  document.addEventListener('click', e => {
    const btn = e.target.closest('.mode-toggle button');
    if (btn){
      const p = state.pontos.find(x => x.id === btn.closest('.mode-toggle').dataset.ponto);
      if (p && p.modo !== btn.dataset.mode){
        p.modo = btn.dataset.mode;
        renderTudo();
        if (!$('#pointDrawer').hidden) abrirDrawer(p);
        toast(`${p.nome} agora está em ${p.modo === 'cortesia' ? 'cortesia' : 'cobrança por kWh'}.`);
      }
      return;
    }
    const det = e.target.closest('[data-drawer]');
    if (det) abrirDrawer(state.pontos.find(x => x.id === det.dataset.drawer));
  });

  // O tour só abre no botão "?" — nunca sozinho.
  $('#tourLaunchButton').onclick = () => tour.open();
}

iniciar();

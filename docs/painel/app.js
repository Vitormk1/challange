/* ==========================================================================
   Praça de Recarga — painel do lojista

   Dados de demonstração, gerados com semente fixa: o painel roda no GitHub
   Pages, que serve arquivo estático e não executa servidor. Quando a API
   entrar, só a função `carregar()` muda — o resto do arquivo não sabe de onde
   os dados vêm.
   ========================================================================== */

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const brl = v => v.toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
const num = (v, d=0) => v.toLocaleString('pt-BR', {minimumFractionDigits:d, maximumFractionDigits:d});
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* --------------------------------------------------------------------------
   parâmetros do negócio — os mesmos de ai/break_even.py
-------------------------------------------------------------------------- */
const SEGMENTOS = {
  pet:         {nome:'Pet shop e clínica veterinária', margem:20,  ticket:150},
  restaurante: {nome:'Restaurante',                    margem:10,  ticket:120},
  academia:    {nome:'Academia',                       margem:15,  ticket:130},
  farmacia:    {nome:'Farmácia',                       margem:5.5, ticket:45},
  mercado:     {nome:'Supermercado',                   margem:2.9, ticket:60},
};
const COMPRAM = 0.90;   // ~90% dos motoristas compram algo enquanto carregam
const UPLIFT  = 0.12;   // +12% de gasto médio de quem carrega durante a compra
const NOVOS   = 0.20;   // fração que veio por causa do carregador — premissa
const KM_KWH  = 10.4;   // BYD Dolphin Mini, líder de vendas em 2026
const AMORT   = 1.11;   // R$ 6.000 em 5 anos, a 3 sessões/dia

/* Lucro incremental de uma sessão, e o teto de cortesia que cabe nele. */
function tetoCortesia(margemPct, ticket, tarifa){
  const margem  = margemPct / 100;
  const receita = COMPRAM * (NOVOS * ticket + (1 - NOVOS) * UPLIFT * ticket);
  const lucro   = receita * margem;
  const sobra   = lucro - AMORT;
  return {lucro, sobra, kwh: Math.max(0, sobra / tarifa)};
}

/* --------------------------------------------------------------------------
   estado
-------------------------------------------------------------------------- */
const estado = {
  loja: 'Pet & Cia — Vila Mariana',
  segmento: 'pet',
  tarifa: 0.789,
  pontos: [],
  sessoes: [],
  dias: [],
};

const LOJAS = [
  {nome:'Pet & Cia — Vila Mariana', segmento:'pet'},
  {nome:'Cantina do Léo — Pinheiros', segmento:'restaurante'},
  {nome:'Farmácia Bem Estar — Moema', segmento:'farmacia'},
];

/* gerador com semente: o mesmo painel em toda visita */
let seed = 20260821;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function carregar(){
  const seg = SEGMENTOS[estado.segmento];

  estado.pontos = [
    {id:'vaga-1', nome:'Vaga 1 — entrada',  kw:7.4,  modo:'cortesia', estado:'carregando', soc:0.62, cliente:'Fiat 500e'},
    {id:'vaga-2', nome:'Vaga 2 — entrada',  kw:7.4,  modo:'cortesia', estado:'livre'},
    {id:'vaga-3', nome:'Vaga 3 — estacion.', kw:22.0, modo:'pago',     estado:'carregando', soc:0.34, cliente:'Volvo EX30'},
    {id:'vaga-4', nome:'Vaga 4 — fundos',   kw:7.4,  modo:'pago',     estado:'falha'},
  ];

  // 30 dias
  estado.dias = [];
  for (let d = 0; d < 30; d++){
    const fim = d % 7 === 5 || d % 7 === 6;
    const sessoes = Math.round((fim ? 5.5 : 3.2) * (0.65 + rnd() * 0.8));
    const kwh = sessoes * (3.5 + rnd() * 3);
    estado.dias.push({
      dia: d + 1,
      sessoes,
      kwh,
      custo: kwh * estado.tarifa + sessoes * AMORT,
      lucro: sessoes * tetoCortesia(seg.margem, seg.ticket, estado.tarifa).lucro * (0.8 + rnd() * 0.5),
    });
  }

  // sessões recentes
  const horas = [9,10,11,11,12,13,14,15,16,17,17,18,18,19,19,20];
  estado.sessoes = [];
  for (let i = 0; i < 22; i++){
    const p = estado.pontos[Math.floor(rnd() * 4)];
    const kwh = 2 + rnd() * 9;
    const h = horas[Math.floor(rnd() * horas.length)];
    estado.sessoes.push({
      dia: 30 - Math.floor(i / 3),
      hora: h,
      minuto: Math.floor(rnd() * 60),
      ponto: p.nome,
      modo: p.modo,
      kwh,
      compra: rnd() < 0.62 ? 40 + rnd() * 180 : 0,
      cobrado: p.modo === 'pago' ? kwh * 0.95 : 0,
    });
  }
  estado.sessoes.sort((a,b) => b.dia - a.dia || b.hora - a.hora);
}

/* --------------------------------------------------------------------------
   gráficos — SVG desenhado à mão, sem biblioteca
-------------------------------------------------------------------------- */
function eixo(g, x1, x2, y, label, cor){
  return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${cor}"/>` +
         `<text x="${x1-8}" y="${y+4}" text-anchor="end" font-size="10" font-family="JetBrains Mono,monospace" fill="${css('--text-muted')}">${label}</text>`;
}

function chartRetorno(){
  const W=720,H=260,L=48,R=14,T=18,B=32, d=estado.dias;
  const max = Math.max(...d.map(x => Math.max(x.lucro, x.custo))) * 1.15 || 1;
  const x = i => L + i * (W-L-R) / (d.length - 1);
  const y = v => H-B - v * (H-T-B) / max;
  let g = '';
  for (let k=0;k<=4;k++) g += eixo(g, L, W-R, y(max*k/4), brl(max*k/4).replace('R$ ',''), css('--grid'));
  const linha = (key, cor, w) =>
    `<path d="${d.map((p,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ')}" fill="none" stroke="${cor}" stroke-width="${w}" stroke-linejoin="round"/>`;
  const area = `<path d="${d.map((p,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(p.lucro).toFixed(1)}`).join(' ')} L${x(d.length-1)},${y(0)} L${L},${y(0)} Z" fill="${css('--success')}" opacity=".10"/>`;
  g += area + linha('lucro', css('--success'), 2.2) + linha('custo', css('--amber'), 1.8);
  for (let i=0;i<d.length;i+=6)
    g += `<text x="${x(i)}" y="${H-B+16}" text-anchor="middle" font-size="10" font-family="JetBrains Mono,monospace" fill="${css('--text-muted')}">${d[i].dia}</text>`;
  $('#chartRetorno').innerHTML = g;
}

function chartHoras(){
  const W=340,H=260,L=32,R=10,T=14,B=30;
  const buckets = new Array(24).fill(0);
  estado.sessoes.forEach(s => buckets[s.hora]++);
  const faixa = buckets.slice(7, 22);
  const max = Math.max(...faixa) || 1;
  const slot = (W-L-R)/faixa.length, bw = slot*0.62;
  let g = '';
  for (let k=0;k<=3;k++){
    const v = max*k/3, yy = H-B - v*(H-T-B)/max;
    g += `<line x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}" stroke="${css('--grid')}"/>`;
    g += `<text x="${L-6}" y="${yy+4}" text-anchor="end" font-size="9" font-family="JetBrains Mono,monospace" fill="${css('--text-muted')}">${Math.round(v)}</text>`;
  }
  faixa.forEach((v,i) => {
    const h = v*(H-T-B)/max;
    g += `<rect x="${L+slot*i+(slot-bw)/2}" y="${H-B-h}" width="${bw}" height="${h}" rx="2" fill="${css('--primary')}" opacity="${v===max?1:.62}"/>`;
    if (i%3===0) g += `<text x="${L+slot*i+slot/2}" y="${H-B+15}" text-anchor="middle" font-size="9" font-family="JetBrains Mono,monospace" fill="${css('--text-muted')}">${i+7}h</text>`;
  });
  $('#chartHoras').innerHTML = g;
  const pico = faixa.indexOf(Math.max(...faixa)) + 7;
  $('#horaPico').textContent = `Pico às ${pico}h. É onde vale abrir mais uma vaga.`;
}

function chartRecorrencia(){
  const W=720,H=200,L=42,R=14,T=14,B=30;
  const dist = [{k:'1 visita',v:38},{k:'2',v:21},{k:'3',v:14},{k:'4 a 6',v:17},{k:'7+',v:10}];
  const max = Math.max(...dist.map(d=>d.v));
  const slot=(W-L-R)/dist.length, bw=Math.min(84, slot*0.55);
  let g='';
  dist.forEach((d,i)=>{
    const h=d.v*(H-T-B)/max, cx=L+slot*i+slot/2;
    g += `<rect x="${cx-bw/2}" y="${H-B-h}" width="${bw}" height="${h}" rx="3" fill="${i?css('--primary'):css('--text-muted')}" opacity="${i?1:.5}"/>`;
    g += `<text x="${cx}" y="${H-B-h-7}" text-anchor="middle" font-size="11" font-weight="600" font-family="JetBrains Mono,monospace" fill="${css('--text-primary')}">${d.v}%</text>`;
    g += `<text x="${cx}" y="${H-B+16}" text-anchor="middle" font-size="10" fill="${css('--text-muted')}">${d.k}</text>`;
  });
  $('#chartRecorrencia').innerHTML = g;
}

function chartFinanceiro(){
  const seg = SEGMENTOS[estado.segmento];
  const t = estado.dias.reduce((a,d)=>({l:a.l+d.lucro, c:a.c+d.custo, k:a.k+d.kwh}), {l:0,c:0,k:0});
  const W=360,H=240,cx=W/2,cy=105,r=74;
  const saldo = t.l - t.c;
  const partes = [
    {rot:'lucro atribuído', v:t.l, cor:css('--success')},
    {rot:'energia',         v:t.k*estado.tarifa, cor:css('--amber')},
    {rot:'equipamento',     v:t.c - t.k*estado.tarifa, cor:css('--text-muted')},
  ];
  const total = partes.reduce((a,p)=>a+p.v,0);
  let ang = -Math.PI/2, g='';
  partes.forEach(p=>{
    const a2 = ang + 2*Math.PI*p.v/total;
    const big = a2-ang > Math.PI ? 1 : 0;
    g += `<path d="M${cx},${cy} L${cx+r*Math.cos(ang)},${cy+r*Math.sin(ang)} A${r},${r} 0 ${big},1 ${cx+r*Math.cos(a2)},${cy+r*Math.sin(a2)} Z" fill="${p.cor}" opacity=".9"/>`;
    ang = a2;
  });
  g += `<circle cx="${cx}" cy="${cy}" r="46" fill="${css('--bg-surface')}"/>`;
  g += `<text x="${cx}" y="${cy-2}" text-anchor="middle" font-size="17" font-weight="700" font-family="JetBrains Mono,monospace" fill="${saldo>0?css('--success'):css('--danger')}">${brl(saldo)}</text>`;
  g += `<text x="${cx}" y="${cy+16}" text-anchor="middle" font-size="10" fill="${css('--text-muted')}">saldo do mês</text>`;
  partes.forEach((p,i)=>{
    const yy = 200 + i*14;
    g += `<rect x="34" y="${yy-8}" width="9" height="9" rx="2" fill="${p.cor}"/>`;
    g += `<text x="50" y="${yy}" font-size="10.5" fill="${css('--text-secondary')}">${p.rot}</text>`;
    g += `<text x="${W-24}" y="${yy}" text-anchor="end" font-size="10.5" font-family="JetBrains Mono,monospace" fill="${css('--text-primary')}">${brl(p.v)}</text>`;
  });
  $('#chartFinanceiro').innerHTML = g;

  $('#finBreakdown').innerHTML = `
    <div class="point"><span class="point-dot livre"></span>
      <div class="point-info"><b>${num(t.k,0)} kWh entregues</b><span>${estado.dias.reduce((a,d)=>a+d.sessoes,0)} sessões no mês</span></div>
      <div class="point-side"><span class="pill ${saldo>0?'ok':'alert'}">${saldo>0?'no azul':'no vermelho'}</span></div>
    </div>`;
}

/* --------------------------------------------------------------------------
   renderização
-------------------------------------------------------------------------- */
function pontoHTML(p, comToggle){
  const rotulo = {carregando:'Carregando', livre:'Livre', falha:'Fora do ar'}[p.estado];
  const detalhe = p.estado === 'carregando'
    ? `${p.cliente} · ${Math.round(p.soc*100)}%`
    : p.estado === 'falha' ? 'Sem comunicação há 2 h' : 'Pronta para uso';
  const toggle = comToggle ? `
    <div class="mode-toggle" data-ponto="${p.id}">
      <button data-mode="cortesia" aria-pressed="${p.modo==='cortesia'}">Cortesia</button>
      <button data-mode="pago" aria-pressed="${p.modo==='pago'}">Por kWh</button>
    </div>` : `<span class="pill ${p.modo}">${p.modo==='cortesia'?'Cortesia':'Por kWh'}</span>`;
  return `<div class="point">
    <span class="point-dot ${p.estado}"></span>
    <div class="point-info"><b>${p.nome}</b><span>${num(p.kw,1)} kW · ${rotulo} · ${detalhe}</span></div>
    <div class="point-side">${toggle}
      <a class="ghost-button" href="../vaga/?vaga=${encodeURIComponent(p.nome)}&loja=${encodeURIComponent(estado.loja)}&modo=${p.modo}&full=1" target="_blank" rel="noopener">Ver telinha</a>
    </div>
  </div>`;
}

function render(){
  const seg = SEGMENTOS[estado.segmento];
  const t = estado.dias.reduce((a,d)=>({l:a.l+d.lucro, c:a.c+d.custo, k:a.k+d.kwh, s:a.s+d.sessoes}), {l:0,c:0,k:0,s:0});

  $('#storeName').textContent = estado.loja;
  $('#kpiLucro').textContent = brl(t.l);
  $('#kpiLucroDelta').textContent = '+18%';
  $('#kpiSessoes').textContent = num(t.s);
  $('#kpiSessoesMeta').textContent = `${num(t.s/30,1)} por dia, em média`;
  $('#kpiClientes').textContent = num(Math.round(t.s*0.62));
  $('#kpiClientesMeta').textContent = '62% voltaram ao menos uma vez';
  $('#kpiEnergia').textContent = `${num(t.k)} kWh`;
  $('#kpiEnergiaMeta').textContent = `${brl(t.k*estado.tarifa)} de energia`;

  $('#pointsLive').innerHTML   = estado.pontos.map(p => pontoHTML(p, false)).join('');
  $('#pointsConfig').innerHTML = estado.pontos.map(p => pontoHTML(p, true)).join('');

  $('#kpiRecorrencia').textContent = '62%';
  $('#kpiTicketEV').textContent = brl(seg.ticket * 1.12);
  $('#kpiTicketDelta').innerHTML = `<span class="delta up">+12%</span> sobre o ticket da loja`;
  $('#kpiCupom').textContent = '58%';

  $('#alertList').innerHTML = `
    <div class="point"><span class="point-dot falha"></span>
      <div class="point-info"><b>Vaga 4 — fundos sem comunicação</b><span>Última leitura há 2 horas. Ninguém consegue usar.</span></div>
      <div class="point-side"><span class="pill alert">aberto</span></div>
    </div>
    <div class="point"><span class="point-dot livre"></span>
      <div class="point-info"><b>Demanda contratada em 71%</b><span>Pico de 53 kW num limite de 75 kW. Sem risco por enquanto.</span></div>
      <div class="point-side"><span class="pill ok">ok</span></div>
    </div>`;

  renderSessoes();
  chartRetorno(); chartHoras(); chartRecorrencia(); chartFinanceiro();
}

function renderSessoes(){
  const filtro = $('#filtroModo').value;
  const lista = estado.sessoes.filter(s => filtro === 'todos' || s.modo === filtro);
  const maxKwh = Math.max(...estado.sessoes.map(s => s.kwh));
  $('#sessionList').innerHTML = lista.map(s => `
    <div class="session" data-mode="${s.modo}">
      <span class="when">${String(s.dia).padStart(2,'0')}/08 ${String(s.hora).padStart(2,'0')}:${String(s.minuto).padStart(2,'0')}</span>
      <div>
        <div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:5px">
          <span>${s.ponto}</span>
          <span class="pill ${s.modo}">${s.modo === 'cortesia' ? 'Cortesia' : 'Por kWh'}</span>
        </div>
        <div class="bar"><i style="width:${100*s.kwh/maxKwh}%"></i></div>
      </div>
      <span class="val">${num(s.kwh,1)} kWh · ${Math.round(s.kwh*KM_KWH)} km</span>
      <span class="val">${s.compra ? brl(s.compra) : (s.cobrado ? brl(s.cobrado) : '—')}</span>
    </div>`).join('') || '<p class="kpi-meta">Nenhuma sessão neste filtro.</p>';
}

/* --------------------------------------------------------------------------
   calculadora do teto de cortesia
-------------------------------------------------------------------------- */
function calcular(){
  const m = +$('#inMargem').value, tk = +$('#inTicket').value, tf = +$('#inTarifa').value;
  $('#outMargem').textContent = `${num(m,1)}%`;
  $('#outTicket').textContent = brl(tk);
  $('#outTarifa').textContent = `${brl(tf)}/kWh`;
  const r = tetoCortesia(m, tk, tf);
  const km = r.kwh * KM_KWH;
  $('#tetoResultado').innerHTML = r.kwh > 0.4
    ? `Cada sessão gera <b>${brl(r.lucro)}</b> de lucro. Descontado o equipamento, sobram <b>${brl(r.sobra)}</b>.<br>
       <b style="font-size:1.15rem">Teto recomendado: ${num(r.kwh,1)} kWh</b> — cerca de <b>${Math.round(km)} km</b> de cortesia.`
    : `Cada sessão gera <b>${brl(r.lucro)}</b> de lucro, menos que o custo do equipamento por sessão.
       <b>Neste cenário a cortesia não se paga</b> — o caminho é cobrar por kWh.`;
}

/* --------------------------------------------------------------------------
   tema, navegação, modais, toast
-------------------------------------------------------------------------- */
function aplicarTema(t){
  document.documentElement.dataset.theme = t;
  localStorage.setItem('pr-tema', t);
  $('#cfgTheme').checked = t === 'dark';
  $('#themeIcon').innerHTML = t === 'dark'
    ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>'
    : '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>';
  if (estado.dias.length) { chartRetorno(); chartHoras(); chartRecorrencia(); chartFinanceiro(); }
}

function irPara(pagina){
  $$('.page').forEach(p => p.classList.toggle('is-active', p.dataset.page === pagina));
  $$('.nav-item[data-page]').forEach(b => b.setAttribute('aria-current', b.dataset.page === pagina ? 'page' : 'false'));
  const titulos = {
    painel:['Painel','Agosto de 2026 · dados de demonstração'],
    carregadores:['Carregadores','Modelo de cobrança de cada ponto'],
    sessoes:['Sessões','O que aconteceu em cada recarga'],
    clientes:['Clientes','Quem carrega, quanto gasta e se volta'],
    financeiro:['Financeiro','Se a cortesia se paga, e até onde'],
    alertas:['Alertas','O que precisa de atenção'],
  }[pagina];
  $('#pageTitle').textContent = titulos[0];
  $('#pageSubtitle').textContent = titulos[1];
  $('#sidebar').classList.remove('is-open');
  window.scrollTo({top:0, behavior:'smooth'});
}

function toast(msg){
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}

/* --------------------------------------------------------------------------
   tour guiado
-------------------------------------------------------------------------- */
const PASSOS = [
  {alvo:'[data-tour="loja"]', pagina:'painel', titulo:'Seu estabelecimento',
   texto:'Tudo no painel é desta loja. Quem tem mais de uma troca por aqui.'},
  {alvo:'[data-tour="kpis"]', pagina:'painel', titulo:'A resposta primeiro',
   texto:'O número que interessa é o lucro atribuído a quem carregou — não quantos quilowatt-hora saíram.'},
  {alvo:'[data-tour="grafico"]', pagina:'painel', titulo:'Lucro contra custo',
   texto:'A linha verde precisa ficar acima da âmbar. Quando encostam, a cortesia está grande demais.'},
  {alvo:'[data-tour="pontos"]', pagina:'painel', titulo:'O que está acontecendo agora',
   texto:'Quem está carregando, quem está livre e quem parou de responder.'},
  {alvo:'[data-tour="modo"]', pagina:'carregadores', titulo:'Cortesia ou cobrança',
   texto:'Cada carregador pode ter um modelo diferente. A vaga da frente atrai cliente; a dos fundos pode cobrar.'},
  {alvo:'[data-tour="calculadora"]', pagina:'financeiro', titulo:'Quanto você pode dar',
   texto:'Com a sua margem e o seu ticket, o painel calcula o teto de cortesia que não dá prejuízo.'},
  {alvo:'[data-tour="tema"]', pagina:'painel', titulo:'Claro ou escuro',
   texto:'A escolha fica salva neste navegador. Pronto — é só isso.'},
];
let passo = 0;

function mostrarPasso(){
  const p = PASSOS[passo];
  if (p.pagina) irPara(p.pagina);
  const alvo = $(p.alvo);
  if (!alvo) return fecharTour();
  alvo.scrollIntoView({block:'center', behavior:'smooth'});

  // O texto troca na hora; só a posição espera a rolagem terminar.
  $('#tourStep').textContent  = `PASSO ${passo+1} DE ${PASSOS.length}`;
  $('#tourTitle').textContent = p.titulo;
  $('#tourText').textContent  = p.texto;
  $('#tourPrev').disabled = passo === 0;
  $('#tourNext').textContent = passo === PASSOS.length - 1 ? 'Concluir' : 'Próximo';

  setTimeout(() => {
    const r = alvo.getBoundingClientRect(), pad = 6;
    const ring = $('#tourRing');
    Object.assign(ring.style, {
      left:`${r.left-pad}px`, top:`${r.top-pad}px`,
      width:`${r.width+pad*2}px`, height:`${r.height+pad*2}px`,
    });
    const s = (n,st) => Object.assign($(`[data-scrim="${n}"]`).style, st);
    s('top',    {left:0, top:0, width:'100%', height:`${Math.max(0,r.top-pad)}px`});
    s('bottom', {left:0, top:`${r.bottom+pad}px`, width:'100%', bottom:0});
    s('left',   {left:0, top:`${r.top-pad}px`, width:`${Math.max(0,r.left-pad)}px`, height:`${r.height+pad*2}px`});
    s('right',  {left:`${r.right+pad}px`, top:`${r.top-pad}px`, right:0, height:`${r.height+pad*2}px`});

    const b = $('#tourBalloon');
    const abaixo = r.bottom + 190 < window.innerHeight;
    b.style.top  = `${abaixo ? r.bottom + 14 : Math.max(14, r.top - 200)}px`;
    b.style.left = `${Math.min(Math.max(14, r.left), window.innerWidth - 350)}px`;
  }, 320);
}
const abrirTour  = () => { passo = 0; $('#tourOverlay').hidden = false; mostrarPasso(); };
const fecharTour = () => { $('#tourOverlay').hidden = true; localStorage.setItem('pr-tour', '1'); };

/* --------------------------------------------------------------------------
   ligação dos eventos
-------------------------------------------------------------------------- */
function iniciar(){
  aplicarTema(localStorage.getItem('pr-tema') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  const seg = SEGMENTOS[estado.segmento];
  $('#inMargem').value = seg.margem;
  $('#inTicket').value = seg.ticket;
  $('#inTarifa').value = estado.tarifa;
  $('#cfgStore').value = estado.loja;
  $('#cfgSegmento').value = estado.segmento;

  carregar(); render(); calcular();

  $$('.nav-item[data-page]').forEach(b => b.onclick = () => irPara(b.dataset.page));
  $$('[data-page-link]').forEach(b => b.onclick = () => irPara(b.dataset.pageLink));
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('is-open');
  $('#themeBtn').onclick = () => aplicarTema(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('#filtroModo').onchange = renderSessoes;
  ['#inMargem','#inTicket','#inTarifa'].forEach(s => $(s).oninput = calcular);

  // troca de modo de cada carregador
  document.addEventListener('click', e => {
    const btn = e.target.closest('.mode-toggle button');
    if (!btn) return;
    const id = btn.closest('.mode-toggle').dataset.ponto;
    const p = estado.pontos.find(x => x.id === id);
    if (!p || p.modo === btn.dataset.mode) return;
    p.modo = btn.dataset.mode;
    render();
    toast(`${p.nome} agora está em ${p.modo === 'cortesia' ? 'cortesia' : 'cobrança por kWh'}.`);
  });

  // modais
  $$('[data-open-modal]').forEach(b => b.onclick = () => {
    const alvo = b.dataset.openModal === 'config' ? '#modalConfig' : '#modalLoja';
    if (alvo === '#modalLoja') {
      $('#storeList').innerHTML = LOJAS.map(l => `
        <div class="point" data-loja="${l.nome}" style="cursor:pointer">
          <span class="point-dot ${l.nome === estado.loja ? 'livre' : ''}"></span>
          <div class="point-info"><b>${l.nome}</b><span>${SEGMENTOS[l.segmento].nome}</span></div>
          <div class="point-side">${l.nome === estado.loja ? '<span class="pill ok">atual</span>' : ''}</div>
        </div>`).join('');
      $$('#storeList .point').forEach(el => el.onclick = () => {
        const l = LOJAS.find(x => x.nome === el.dataset.loja);
        estado.loja = l.nome; estado.segmento = l.segmento;
        $('#inMargem').value = SEGMENTOS[l.segmento].margem;
        $('#inTicket').value = SEGMENTOS[l.segmento].ticket;
        $('#cfgStore').value = l.nome; $('#cfgSegmento').value = l.segmento;
        seed = 20260821; carregar(); render(); calcular();
        $('#modalLoja').hidden = true;
        toast(`Agora vendo ${l.nome}.`);
      });
    }
    $(alvo).hidden = false;
  });
  $$('[data-close-modal]').forEach(b => b.onclick = () => b.closest('.modal-backdrop').hidden = true);
  $$('.modal-backdrop').forEach(m => m.onclick = e => { if (e.target === m) m.hidden = true; });

  $('#cfgTheme').onchange = e => aplicarTema(e.target.checked ? 'dark' : 'light');
  $('#cfgSegmento').onchange = e => {
    estado.segmento = e.target.value;
    $('#inMargem').value = SEGMENTOS[e.target.value].margem;
    $('#inTicket').value = SEGMENTOS[e.target.value].ticket;
    seed = 20260821; carregar(); render(); calcular();
  };
  $('#cfgSave').onclick = () => {
    estado.loja = $('#cfgStore').value.trim() || estado.loja;
    render(); $('#modalConfig').hidden = true; toast('Configurações salvas.');
  };

  // tour
  $('#tourBtn').onclick = abrirTour;
  $('#tourSkip').onclick = fecharTour;
  $('#tourNext').onclick = () => (passo === PASSOS.length - 1) ? fecharTour() : (passo++, mostrarPasso());
  $('#tourPrev').onclick = () => { if (passo > 0) { passo--; mostrarPasso(); } };
  addEventListener('keydown', e => {
    if ($('#tourOverlay').hidden) return;
    if (e.key === 'Escape') fecharTour();
    if (e.key === 'ArrowRight') $('#tourNext').click();
    if (e.key === 'ArrowLeft') $('#tourPrev').click();
  });
  addEventListener('resize', () => { if (!$('#tourOverlay').hidden) mostrarPasso(); });

  if (!localStorage.getItem('pr-tour')) setTimeout(abrirTour, 900);
}

iniciar();

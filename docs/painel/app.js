/* ==========================================================================
   Smart Charge — painel do lojista

   O CSS, o tour e a esfera de IA vêm do painel de referência sem alteração;
   o que é nosso é o conteúdo e as regras.

   Três ideias organizam este arquivo:

   1. Papel manda no que aparece. `state.permissoes` vem do servidor, e a
      tela só reflete. O servidor confere de novo em toda escrita — esconder
      botão é conforto, não tranca.
   2. O que a pessoa arruma fica no banco. Layout dos cards com tamanho,
      tema, barra lateral, seção aberta, busca de cada tabela. Entrar em
      outro computador tem que devolver a mesma tela.
   3. O servidor é obrigatório. Sem ele não há login, dado nem assistente —
      a tela de login diz isso, e é só o que ela faz.
   ========================================================================== */

import "./static/js/aiEntity.js?v=20260904g";
import { createTourModule } from "./static/js/tour.js?v=20260904g";
import { api, BASE, ErroApi } from "./api.js?v=20260904g";

/* -------------------------------------------------------------------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const brl = v => Number(v || 0).toLocaleString("pt-BR", {style:"currency", currency:"BRL"});
const num = (v, d = 0) => Number(v || 0).toLocaleString("pt-BR", {minimumFractionDigits:d, maximumFractionDigits:d});
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(v, b));
const isCompactViewport = () => matchMedia("(max-width: 1180px)").matches;
const waitForNextPaint = () => new Promise(res => {
  let feito = false;
  const fim = () => { if (!feito) { feito = true; res(); } };
  requestAnimationFrame(() => requestAnimationFrame(fim));
  setTimeout(fim, 120);   // aba em segundo plano não dispara rAF
});
const dataHora = v => v ? new Date(v).toLocaleString("pt-BR", {day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) : "—";
const iniciais = nome => String(nome || "").trim().split(/\s+/).slice(0,2).map(p=>p[0]||"").join("").toUpperCase() || "··";

const ler    = (k, fb) => { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } };
const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/* regras de negócio — as mesmas de ai/break_even.py e de api/main.py */
const COMPRAM = 0.90, UPLIFT = 0.12, NOVOS = 0.20, KM_KWH = 10.4, AMORT = 1.11;
function tetoCortesia(margemPct, ticket, tarifa){
  const lucro = COMPRAM * (NOVOS * ticket + (1 - NOVOS) * UPLIFT * ticket) * (margemPct / 100);
  const sobra = lucro - AMORT;
  return { lucro, sobra, kwh: Math.max(0, sobra / (tarifa || 0.789)) };
}

/* limites da grade: 20 colunas, linhas de 76px */
const COLUNAS = 20, MIN_COLS = 4, MIN_ROWS = 2, MAX_ROWS = 8;

/* ==========================================================================
   estado
   ========================================================================== */
const state = {
  section: "painel",
  estabelecimentoId: null,
  usuario: null,
  permissoes: {},
  secoesBloqueadas: new Set(),
  dados: { estabelecimentos:[], carregadores:[], clientes:[], sessoes:[], vendas:[],
           cupons:[], leituras:[], paineis:[], usuarios_da_loja:[] },
  paineis: { ativo:null, editando:false, menuAberto:false, criando:false, bibliotecaAberta:false },
  tabela: {},          // por seção: { busca, ordem:{col,dir}, selecionados:Set }
  prefs: {},           // espelho do usuarios.preferencias
  conversa: [],        // histórico do assistente, para dar contexto ao modelo
};

const loja = () => state.dados.estabelecimentos.find(e => e.id === state.estabelecimentoId) || {};
const daLoja = (lista, campo = "estabelecimento_id") => lista.filter(r => r[campo] === state.estabelecimentoId);
const carregadoresDaLoja = () => daLoja(state.dados.carregadores);
const sessoesDaLoja = () => {
  const ids = new Set(carregadoresDaLoja().map(c => c.id));
  return state.dados.sessoes.filter(s => ids.has(s.carregador_id));
};
const ui = secao => (state.tabela[secao] ||= { busca:"", ordem:null, selecionados:new Set() });

const pode = acao => Boolean(state.permissoes[acao]);
const podeVer = secao => !state.secoesBloqueadas.has(secao);
const somenteLeitura = () => !pode("editar_dados");

/* ==========================================================================
   catálogo de seções — uma por tabela do banco
   ========================================================================== */
const SECOES = {
  painel:      { eyebrow:"Visão do lojista", titulo:"Painel" },
  carregadores:{ eyebrow:"Operação", titulo:"Carregadores", tabela:"carregadores" },
  sessoes:     { eyebrow:"Operação", titulo:"Sessões", tabela:"sessoes" },
  leituras:    { eyebrow:"Operação", titulo:"Leituras", tabela:"leituras" },
  clientes:    { eyebrow:"Negócio", titulo:"Clientes", tabela:"clientes" },
  vendas:      { eyebrow:"Negócio", titulo:"Vendas atribuídas", tabela:"vendas" },
  cupons:      { eyebrow:"Negócio", titulo:"Cupons", tabela:"cupons" },
  financeiro:  { eyebrow:"Negócio", titulo:"Financeiro" },
  estabelecimentos:{ eyebrow:"Cadastros", titulo:"Estabelecimentos", tabela:"estabelecimentos" },
  paineis:     { eyebrow:"Cadastros", titulo:"Painéis salvos", tabela:"paineis" },
  perfil:      { eyebrow:"Sua conta", titulo:"Perfil e configurações" },
};

const chip = (texto, tom) => `<span class="machine-monitor-badge is-${tom}">${esc(texto)}</span>`;
const nomeCarregador = id => esc(state.dados.carregadores.find(c => c.id === id)?.nome || "—");
const nomeUsuario = id => esc(state.dados.usuarios_da_loja.find(u => u.id === id)?.nome || "—");

/* colunas visíveis e campos editáveis de cada tabela */
const TABELAS = {
  carregadores: {
    novo: "Adicionar carregador", vazio: "Nenhum carregador cadastrado nesta loja.",
    linhas: () => carregadoresDaLoja(),
    colunas: [
      {r:"Nome", k:"nome", v:l => esc(l.nome)},
      {r:"Potência", k:"potencia_kw", v:l => `${num(l.potencia_kw,1)} kW`},
      {r:"Modelo", k:"modo", v:l => chip(l.modo === "cortesia" ? "Cortesia" : "Por kWh", l.modo === "cortesia" ? "warning" : "info")},
      {r:"Teto", k:"teto_cortesia_kwh", v:l => l.modo === "cortesia" ? `${num(l.teto_cortesia_kwh,1)} kWh · ${Math.round(l.teto_cortesia_kwh*KM_KWH)} km` : `<span class="table-cell-muted">—</span>`},
      {r:"Preço", k:"preco_kwh_brl", v:l => l.modo === "pago" ? `${brl(l.preco_kwh_brl)}/kWh` : `<span class="table-cell-muted">—</span>`},
      {r:"Conector", k:"conector", v:l => esc(l.conector)},
      {r:"Ativo", k:"ativo", v:l => l.ativo ? "sim" : "não"},
    ],
    campos: [
      {k:"nome", r:"Nome da vaga", t:"text", obrigatorio:true},
      {k:"numero_serie", r:"Número de série", t:"text"},
      {k:"potencia_kw", r:"Potência (kW)", t:"number", passo:"0.1"},
      {k:"conector", r:"Conector", t:"select", opcoes:[["Tipo 2","Tipo 2"],["CCS2","CCS2"],["GB/T","GB/T"]]},
      {k:"modo", r:"Modelo de cobrança", t:"select", opcoes:[["cortesia","Cortesia"],["pago","Por kWh"]],
       ajuda:"Cortesia atrai cliente para a loja. Por kWh cobra de quem só quer a tomada."},
      {k:"teto_cortesia_kwh", r:"Teto de cortesia (kWh)", t:"number", passo:"0.5",
       ajuda:"Quanta energia sai de graça por visita. O Financeiro calcula o teto que se paga."},
      {k:"kwh_por_real", r:"kWh por R$ 1 de compra", t:"number", passo:"0.001",
       ajuda:"Quem gasta mais na loja leva mais energia, proporcionalmente."},
      {k:"preco_kwh_brl", r:"Preço por kWh (modo pago)", t:"number", passo:"0.01"},
      {k:"carencia_min", r:"Carência depois de cheio (min)", t:"number"},
      {k:"taxa_ociosidade_min", r:"Taxa de vaga ocupada (R$/min)", t:"number", passo:"0.01",
       ajuda:"Cobra a vaga, nunca a energia — a recarga não para."},
      {k:"ativo", r:"Ativo", t:"select", opcoes:[[true,"Sim"],[false,"Não"]]},
    ],
  },
  sessoes: {
    vazio: "Nenhuma recarga registrada ainda.",
    ordemPadrao: {col:0, dir:-1},
    linhas: () => sessoesDaLoja(),
    colunas: [
      {r:"Início", k:"inicio", v:l => dataHora(l.inicio)},
      {r:"Carregador", k:"carregador_id", v:l => nomeCarregador(l.carregador_id)},
      {r:"Modelo", k:"modo", v:l => chip(l.modo === "cortesia" ? "Cortesia" : "Por kWh", l.modo === "cortesia" ? "warning" : "info")},
      {r:"Energia", k:"energia_kwh", v:l => `${num(l.energia_kwh,1)} kWh`},
      {r:"Autonomia", k:"energia_kwh", v:l => `${Math.round(l.energia_kwh*KM_KWH)} km`},
      {r:"Custo", k:"custo_energia_brl", v:l => brl(l.custo_energia_brl)},
      {r:"Cobrado", k:"valor_cobrado_brl", v:l => Number(l.valor_cobrado_brl) ? brl(l.valor_cobrado_brl) : `<span class="table-cell-muted">—</span>`},
      {r:"Erro da previsão", k:"erro_previsao", ord: l => erroPrevisao(l) ?? -1,
       v:l => { const m = erroPrevisao(l); return m == null ? `<span class="table-cell-muted">—</span>` : `${m} min`; }},
      {r:"Situação", k:"situacao", v:l => esc(l.situacao)},
    ],
  },
  leituras: {
    vazio: "Sem leituras do medidor no período.",
    ordemPadrao: {col:0, dir:-1},
    linhas: () => { const ids = new Set(carregadoresDaLoja().map(c => c.id));
                    return state.dados.leituras.filter(l => ids.has(l.carregador_id)); },
    colunas: [
      {r:"Momento", k:"momento", v:l => dataHora(l.momento)},
      {r:"Carregador", k:"carregador_id", v:l => nomeCarregador(l.carregador_id)},
      {r:"Potência", k:"potencia_kw", v:l => `${num(l.potencia_kw,2)} kW`},
      {r:"Carga", k:"soc", v:l => l.soc == null ? `<span class="table-cell-muted">—</span>` : `${Math.round(l.soc*100)}%`},
    ],
  },
  clientes: {
    novo: "Cadastrar cliente", vazio: "Nenhum cliente identificado ainda.",
    linhas: () => daLoja(state.dados.clientes),
    colunas: [
      {r:"Cliente", k:"apelido", v:l => esc(l.apelido || "—")},
      {r:"Veículo", k:"modelo_veiculo", v:l => esc(l.modelo_veiculo || "—")},
      {r:"Bateria", k:"bateria_kwh", v:l => l.bateria_kwh ? `${num(l.bateria_kwh,0)} kWh` : `<span class="table-cell-muted">—</span>`},
      {r:"Visitas", k:"visitas", v:l => num(l.visitas)},
      {r:"Última visita", k:"ultima_visita", v:l => dataHora(l.ultima_visita)},
      {r:"Consentimento", k:"consentimento_lgpd", v:l => l.consentimento_lgpd ? chip("dado","ok") : chip("pendente","warning")},
    ],
    campos: [
      {k:"apelido", r:"Como chamar", t:"text",
       ajuda:"Sem nome completo nem CPF: o banco guarda só o apelido e um identificador embaralhado."},
      {k:"modelo_veiculo", r:"Modelo do veículo", t:"text"},
      {k:"bateria_kwh", r:"Bateria (kWh)", t:"number", passo:"0.5"},
      {k:"consentimento_lgpd", r:"Consentimento LGPD", t:"select", opcoes:[[true,"Sim"],[false,"Não"]]},
    ],
  },
  vendas: {
    novo: "Lançar venda", vazio: "Nenhuma venda atribuída a uma recarga.",
    ordemPadrao: {col:0, dir:-1},
    linhas: () => daLoja(state.dados.vendas),
    colunas: [
      {r:"Momento", k:"momento", v:l => dataHora(l.momento)},
      {r:"Valor", k:"valor_brl", v:l => brl(l.valor_brl)},
      {r:"Cupom", k:"cupom_id", v:l => { const c = state.dados.cupons.find(x => x.id === l.cupom_id);
                           return c ? `<code>${esc(c.codigo)}</code>` : `<span class="table-cell-muted">sem cupom</span>`; }},
      {r:"Lucro estimado", k:"valor_brl", so:"ver_financeiro",
       v:l => brl(Number(l.valor_brl||0) * Number(loja().margem_liquida_pct||0)/100)},
      {r:"Sessão", k:"sessao_id", v:l => l.sessao_id ? `#${l.sessao_id}` : `<span class="table-cell-muted">—</span>`},
    ],
    campos: [
      {k:"valor_brl", r:"Valor da venda (R$)", t:"number", passo:"0.01", obrigatorio:true},
      {k:"cupom_id", r:"Cupom apresentado", t:"select",
       opcoes:() => [["", "sem cupom"], ...state.dados.cupons.slice(0,200).map(c => [c.id, c.codigo])],
       ajuda:"É o cupom digitado no caixa que liga esta venda a uma recarga."},
    ],
  },
  cupons: {
    vazio: "Nenhum cupom emitido.",
    ordemPadrao: {col:2, dir:-1},
    linhas: () => state.dados.cupons,
    colunas: [
      {r:"Código", k:"codigo", v:l => `<code>${esc(l.codigo)}</code>`},
      {r:"Desconto", k:"desconto_brl", v:l => brl(l.desconto_brl)},
      {r:"Emitido", k:"emitido_em", v:l => dataHora(l.emitido_em)},
      {r:"Usado", k:"usado_em", v:l => l.usado_em ? dataHora(l.usado_em) : `<span class="table-cell-muted">não usado</span>`},
      {r:"Sessão", k:"sessao_id", v:l => `#${l.sessao_id}`},
    ],
  },
  estabelecimentos: {
    novo: "Novo estabelecimento", vazio: "Nenhum estabelecimento cadastrado.",
    soMain: true,
    linhas: () => state.dados.estabelecimentos,
    colunas: [
      {r:"Nome", k:"nome", v:l => esc(l.nome)},
      {r:"Segmento", k:"segmento", v:l => esc(l.segmento)},
      {r:"Margem", k:"margem_liquida_pct", v:l => `${num(l.margem_liquida_pct,1)}%`},
      {r:"Ticket médio", k:"ticket_medio_brl", v:l => brl(l.ticket_medio_brl)},
      {r:"Tarifa", k:"tarifa_kwh_brl", v:l => `${brl(l.tarifa_kwh_brl)}/kWh`},
      {r:"Demanda", k:"demanda_contratada_kw", v:l => l.demanda_contratada_kw ? `${num(l.demanda_contratada_kw,0)} kW` : `<span class="table-cell-muted">—</span>`},
      {r:"Teto que se paga", k:"teto", ord: l => tetoCortesia(l.margem_liquida_pct, l.ticket_medio_brl, l.tarifa_kwh_brl).kwh,
       v:l => { const r = tetoCortesia(l.margem_liquida_pct, l.ticket_medio_brl, l.tarifa_kwh_brl);
                return r.kwh > 0.4 ? `${num(r.kwh,1)} kWh` : chip("não se paga","critical"); }},
    ],
    campos: [
      {k:"nome", r:"Nome", t:"text", obrigatorio:true},
      {k:"segmento", r:"Segmento", t:"select", opcoes:[["pet","Pet shop e clínica"],["restaurante","Restaurante"],["academia","Academia"],["farmacia","Farmácia"],["mercado","Supermercado"],["cafe","Cafeteria"],["outro","Outro"]]},
      {k:"margem_liquida_pct", r:"Margem líquida (%)", t:"number", passo:"0.1",
       ajuda:"É daqui que sai o teto de cortesia. Margem baixa não sustenta energia de graça."},
      {k:"ticket_medio_brl", r:"Ticket médio (R$)", t:"number", passo:"1"},
      {k:"tarifa_kwh_brl", r:"Tarifa de energia (R$/kWh)", t:"number", passo:"0.0001"},
      {k:"demanda_contratada_kw", r:"Demanda contratada (kW)", t:"number", passo:"1",
       ajuda:"O carregador não pode empurrar a loja acima disso — a multa de ultrapassagem come o ganho."},
    ],
  },
  paineis: {
    vazio: "Nenhum painel salvo.",
    linhas: () => state.dados.paineis,
    colunas: [
      {r:"Nome", k:"nome", v:l => esc(l.nome)},
      {r:"Dono", k:"usuario_id", v:l => l.usuario_id === state.usuario?.id ? "você" : nomeUsuario(l.usuario_id)},
      {r:"Visibilidade", k:"compartilhado", v:l => l.compartilhado ? chip("compartilhado","info") : chip("particular","offline")},
      {r:"Padrão", k:"padrao", v:l => l.padrao ? "sim" : `<span class="table-cell-muted">—</span>`},
      {r:"Cards", k:"cards", ord: l => (l.cards||[]).length, v:l => `${(l.cards||[]).length} cards`},
      {r:"Atualizado", k:"atualizado_em", v:l => dataHora(l.atualizado_em)},
    ],
  },
};

/* quanto a previsão errou, em minutos */
function erroPrevisao(s){
  if (!s.previsao_fim || !s.fim) return null;
  return Math.round(Math.abs(new Date(s.fim) - new Date(s.previsao_fim)) / 60000);
}

/* ==========================================================================
   biblioteca de cards
   ========================================================================== */
/* `min` é o menor tamanho em que o card ainda diz alguma coisa. Um gráfico de
   linha espremido em 4 colunas vira um risco; um KPI de duas linhas de texto
   aguenta bem menos espaço. Sem esse piso por card, redimensionar quebra
   justamente os cards que mais importam. */
const CARDS = {
  retorno:  {t:"Lucro atribuído × custo", g:"Retorno",  tam:"large", cols:11, rows:4, min:{cols:7, rows:3}, financeiro:true},
  teto:     {t:"Teto de cortesia",        g:"Retorno",  tam:"large", cols:9,  rows:4, min:{cols:5, rows:3}, financeiro:true},
  horas:    {t:"Sessões por hora",        g:"Operação", tam:"large", cols:11, rows:4, min:{cols:7, rows:3}},
  pontos:   {t:"Carregadores",            g:"Operação", tam:"large", cols:9,  rows:4, min:{cols:5, rows:3}},
  previsao: {t:"Erro da previsão",        g:"Operação", tam:"large", cols:9,  rows:4, min:{cols:7, rows:3}},
  curva:    {t:"Curva de recarga",        g:"Operação", tam:"large", cols:20, rows:5, min:{cols:9, rows:4}},
  lucro:    {t:"Lucro atribuído",         g:"Retorno",  tam:"small", cols:5,  rows:2, min:{cols:4, rows:2}, financeiro:true},
  vendas:   {t:"Vendas atribuídas",       g:"Retorno",  tam:"small", cols:5,  rows:2, min:{cols:4, rows:2}, financeiro:true},
  sessoes:  {t:"Sessões no período",      g:"Operação", tam:"small", cols:5,  rows:2, min:{cols:4, rows:2}},
  clientes: {t:"Clientes únicos",         g:"Público",  tam:"small", cols:5,  rows:2, min:{cols:4, rows:2}},
  energia:  {t:"Energia entregue",        g:"Operação", tam:"small", cols:5,  rows:2, min:{cols:4, rows:2}},
  ticket:   {t:"Ticket de quem carrega",  g:"Público",  tam:"small", cols:5,  rows:2, min:{cols:4, rows:2}, financeiro:true},
  cupons:   {t:"Cupons usados",           g:"Público",  tam:"small", cols:5,  rows:2, min:{cols:4, rows:2}},
};
const minimoDoCard = id => CARDS[id]?.min || {cols: MIN_COLS, rows: MIN_ROWS};
const cardVisivel = id => CARDS[id] && (!CARDS[id].financeiro || pode("ver_financeiro"));

const layoutPadrao = () => (pode("ver_financeiro")
  ? ["retorno","teto","lucro","sessoes","clientes","energia"]
  : ["horas","pontos","sessoes","clientes","energia","cupons"]
).map(id => ({id, grupo:CARDS[id].tam, cols:CARDS[id].cols, rows:CARDS[id].rows, config:{}}));

/* Aceita tanto o formato novo (objeto com tamanho) quanto o antigo (só o id),
   para um painel salvo antes não sumir da tela. */
function normalizarCards(cards){
  return (Array.isArray(cards) ? cards : [])
    .map(c => (typeof c === "string" ? {id:c} : c))
    .filter(c => c && cardVisivel(c.id))
    .map(c => ({
      id: c.id,
      grupo: c.grupo || CARDS[c.id].tam,
      cols: clamp(Number(c.cols) || CARDS[c.id].cols, minimoDoCard(c.id).cols, COLUNAS),
      rows: clamp(Number(c.rows) || CARDS[c.id].rows, minimoDoCard(c.id).rows, MAX_ROWS),
      config: c.config && typeof c.config === "object" ? c.config : {},
    }));
}

/* ==========================================================================
   preferências — o que faz a tela atravessar de um computador para outro
   ========================================================================== */
let prefsPendentes = null;
function salvarPrefs(){
  state.prefs = {
    tema: state.prefs.tema ?? "system",
    sidebarColapsada: document.body.classList.contains("sidebar-collapsed"),
    gruposFechados: $$(".nav-group.is-collapsed").map(g => g.dataset.navGroup),
    secao: state.section,
    painelAtivo: {...(state.prefs.painelAtivo || {}),
                  [state.estabelecimentoId]: state.paineis.ativo},
    estabelecimento: state.estabelecimentoId,
    tabelas: Object.fromEntries(Object.entries(state.tabela)
      .map(([k, v]) => [k, {busca: v.busca, ordem: v.ordem}])),
    foto: state.prefs.foto,
    autoRefresh: Boolean(state.prefs.autoRefresh),
    autoRefreshMs: Number(state.prefs.autoRefreshMs) || 300000,
  };
  // uma escrita por rajada: arrastar card dispara muitas mudanças seguidas
  clearTimeout(prefsPendentes);
  prefsPendentes = setTimeout(() => api.preferencias(state.prefs).catch(erro => {
    // preferência é estado de tela: falhar não impede de trabalhar, mas
    // sumir na próxima vez sem nunca ter avisado é pior
    if (erro instanceof ErroApi && erro.semSessao) return;
    aviso("Não consegui guardar suas preferências", "atencao",
          {detalhe: "Tema, seção e buscas podem não voltar no próximo acesso."});
  }), 600);
}
function aplicarPrefs(p){
  state.prefs = p && typeof p === "object" ? p : {};
  aplicarTema(state.prefs.tema || "system", false);
  setSidebarCollapsed(Boolean(state.prefs.sidebarColapsada), false);
  const fechados = Array.isArray(state.prefs.gruposFechados) ? state.prefs.gruposFechados : ["cadastros"];
  $$(".nav-group").forEach(g => {
    g.classList.toggle("is-collapsed", fechados.includes(g.dataset.navGroup));
    syncSidebarGroupToggle(g);
  });
  for (const [secao, t] of Object.entries(state.prefs.tabelas || {})){
    if (!SECOES[secao]) continue;
    const u = ui(secao);
    u.busca = t?.busca || "";
    u.ordem = t?.ordem || null;
  }
}

/* ==========================================================================
   toast
   ========================================================================== */
/* ==========================================================================
   Avisos

   Toda ação que toca o banco termina em um aviso. Não é enfeite: sem ele a
   pessoa clica em "salvar", nada visível muda, e ela não sabe se gravou, se
   falhou, ou se o clique nem chegou. E como a rede aqui leva segundos, o
   silêncio é o estado mais comum — daí o aviso "salvando" que vira o
   resultado no mesmo lugar, em vez de dois avisos empilhados.
   ========================================================================== */
const ICONES = {
  ok:       '<svg viewBox="0 0 24 24"><path d="M20 6.5 9.5 17 4 11.5"/></svg>',
  erro:     '<svg viewBox="0 0 24 24"><path d="M12 7.5v6"/><path d="M12 16.8h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  atencao:  '<svg viewBox="0 0 24 24"><path d="M12 3.5 21 19H3L12 3.5Z"/><path d="M12 10v4"/><path d="M12 16.6h.01"/></svg>',
  info:     '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6h.01"/></svg>',
  andando:  '<svg viewBox="0 0 24 24" class="aviso-girando"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
};

let sequenciaAviso = 0;

/* Devolve um controle: `.ok()`, `.erro()`, `.fecha()`. Serve tanto para um
   aviso simples quanto para "salvando..." que depois vira o resultado. */
function aviso(texto, tipo = "ok", {detalhe = "", vida} = {}){
  const pilha = $("#toastStack");
  if (!pilha) return { ok(){}, erro(){}, fecha(){} };

  const el = document.createElement("div");
  el.className = `aviso is-${tipo}`;
  el.id = `aviso-${++sequenciaAviso}`;
  el.setAttribute("role", tipo === "erro" ? "alert" : "status");

  const pintar = (t, texto, detalhe) => {
    el.className = `aviso is-${t}`;
    el.innerHTML = `
      <span class="aviso-icone" aria-hidden="true">${ICONES[t] || ICONES.info}</span>
      <span class="aviso-copy">
        <strong>${esc(texto)}</strong>
        ${detalhe ? `<small>${esc(detalhe)}</small>` : ""}
      </span>
      ${t === "andando" ? "" : '<button class="aviso-fechar" type="button" aria-label="Fechar aviso">×</button>'}`;
    const fechar = $(".aviso-fechar", el);
    if (fechar) fechar.onclick = () => sair();
  };

  let relogio = null;
  const sair = () => {
    clearTimeout(relogio);
    el.classList.add("is-saindo");
    setTimeout(() => el.remove(), 260);
  };
  const agendar = ms => { clearTimeout(relogio); if (ms) relogio = setTimeout(sair, ms); };

  pintar(tipo, texto, detalhe);
  pilha.append(el);
  requestAnimationFrame(() => el.classList.add("is-visivel"));
  // erro fica mais tempo: costuma ser uma frase que explica o que fazer
  agendar(vida ?? (tipo === "andando" ? 0 : tipo === "erro" ? 9000 : 4000));

  return {
    ok(t, d){ pintar("ok", t, d); agendar(4000); },
    erro(t, d){ pintar("erro", t, d); el.setAttribute("role", "alert"); agendar(9000); },
    info(t, d){ pintar("info", t, d); agendar(5000); },
    fecha: sair,
  };
}

/* Embrulha uma operação de banco: mostra "andando", depois o resultado. É por
   onde passa toda escrita, para nenhuma ficar sem resposta na tela. */
async function comAviso(rotulo, tarefa, {sucesso, detalhe} = {}){
  const a = aviso(rotulo, "andando");
  try {
    const r = await tarefa();
    a.ok(typeof sucesso === "function" ? sucesso(r) : (sucesso || "Pronto."), detalhe);
    return r;
  } catch (erro){
    if (erro instanceof ErroApi && erro.semSessao){
      a.fecha();
      mostrarLogin("Sua sessão expirou. Entre de novo.");
      throw erro;
    }
    a.erro("Não deu certo", erro instanceof ErroApi ? erro.message : String(erro?.message || erro));
    console.error(rotulo, erro);
    throw erro;
  }
}

/* compatibilidade com as chamadas antigas */
function toast(msg, tipo = "success"){
  aviso(msg, tipo === "error" ? "erro" : tipo === "warning" ? "atencao" : "ok");
}
/* Erro do servidor vira frase, e sessão caída volta para o login em vez de
   deixar a pessoa clicando em algo que não vai funcionar. */
function avisarErro(erro, oQue){
  if (erro instanceof ErroApi && erro.semSessao){ mostrarLogin("Sua sessão expirou. Entre de novo.", "erro"); return; }
  aviso(`Não consegui ${oQue}`,
        "erro",
        {detalhe: erro instanceof ErroApi ? erro.message : "Erro inesperado. Veja o console."});
  console.error(oQue, erro);
}

/* ==========================================================================
   login e logout
   ========================================================================== */
function statusLogin(texto, tipo = ""){
  const st = $("#loginStatus");
  st.textContent = texto;
  st.classList.toggle("is-erro", tipo === "erro");
  st.classList.toggle("is-ok", tipo === "ok");
}
function mostrarLogin(mensagem = "", tipo = "erro"){
  state.usuario = null;
  document.body.classList.add("sem-sessao");
  document.body.classList.remove("primary-loading");
  esconderCarregando();
  $("#loginGate").hidden = false;
  statusLogin(mensagem, mensagem ? tipo : "");
  $("#loginEmail").focus();
}
/* A mensagem tem que dizer o que fazer, não só que deu errado. */
function explicarFalha(erro){
  if (!(erro instanceof ErroApi)) return "Não consegui entrar. Tente de novo.";
  if (erro.semRede){
    // O navegador não distingue "servidor fora do ar" de "CORS recusou": nos
    // dois casos o fetch falha sem status. Então a mensagem cobre os dois, em
    // vez de acusar o errado — foi o que aconteceu ao testar 127.0.0.1 contra
    // a API publicada, que só libera a origem do GitHub Pages.
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    return `Não consegui falar com ${BASE}. Ou o servidor está fora do ar, `
      + (local
         ? "ou ele não libera esta origem: confira ORIGENS_PERMITIDAS."
         : "ou ele está acordando — o plano gratuito hiberna. Tente de novo em um minuto.");
  }
  if (erro.status === 401) return "E-mail ou senha incorretos.";
  if (erro.status >= 500) return "O servidor respondeu com erro. Veja o terminal onde a API está rodando.";
  return erro.message || "Não consegui entrar.";
}
function initLogin(){
  const form = $("#loginForm"), botao = $("#loginButton");
  const email = $("#loginEmail"), senha = $("#loginSenha");

  const olho = $("#loginSenhaToggle");
  olho.onclick = () => {
    const vendo = senha.type === "text";
    senha.type = vendo ? "password" : "text";
    olho.setAttribute("aria-pressed", String(!vendo));
    olho.setAttribute("aria-label", vendo ? "Mostrar senha" : "Ocultar senha");
    senha.focus();
  };

  form.onsubmit = async ev => {
    ev.preventDefault();
    const usuario = email.value.trim(), chave = senha.value;
    if (!usuario || !chave){
      statusLogin("Preencha o e-mail e a senha.", "erro");
      (usuario ? senha : email).focus();
      return;
    }

    botao.disabled = true;
    botao.classList.add("is-carregando");
    statusLogin("");
    try {
      const sessao = await api.entrar(usuario, chave);
      // A porta só fecha depois que o painel montou. Fechá-la antes deixava
      // a pessoa numa tela vazia quando o /dados falhava — a mensagem de erro
      // ia para um elemento já escondido, e parecia que "não carregou nada".
      statusLogin("Carregando seus dados...", "ok");
      await entrarNoPainel(sessao);
      senha.value = "";
      statusLogin("");
      $("#loginGate").hidden = true;
    } catch (erro){
      statusLogin(explicarFalha(erro), "erro");
      senha.select();
      console.error("login:", erro);
    } finally {
      botao.disabled = false;
      botao.classList.remove("is-carregando");
    }
  };
}
function initLogout(){
  const modal = $("#logoutModal");
  const abrir = ab => {
    modal.classList.toggle("is-open", ab);
    modal.setAttribute("aria-hidden", String(!ab));
  };
  $("#collapsedProfileMenuLogout").onclick = () => {
    $("#collapsedProfileMenu").classList.remove("is-open");
    abrir(true);
  };
  $("#logoutFechar").onclick = () => abrir(false);
  $("#logoutCancelar").onclick = () => abrir(false);
  modal.onclick = ev => { if (ev.target === modal) abrir(false); };
  $("#logoutConfirmar").onclick = async () => {
    abrir(false);
    try { await api.sair(); } catch {}
    // some tudo do que era da pessoa antes de a próxima aparecer
    state.dados = { estabelecimentos:[], carregadores:[], clientes:[], sessoes:[], vendas:[],
                    cupons:[], leituras:[], paineis:[], usuarios_da_loja:[] };
    state.tabela = {}; state.conversa = [];
    state.paineis = { ativo:null, editando:false, menuAberto:false, criando:false, bibliotecaAberta:false };
    $("#globalAiChatMessages").innerHTML = "";
    mostrarLogin("Sessão encerrada.", "ok");
  };
}

/* ==========================================================================
   barra lateral
   ========================================================================== */
function setSidebarCollapsed(colapsada, persistir = true){
  document.body.classList.toggle("sidebar-collapsed", Boolean(colapsada));
  $("#sidebarToggleDesktop")?.setAttribute("aria-expanded", String(!colapsada));
  if (persistir) salvarPrefs();
}
function syncSidebarGroupToggle(grupo){
  if (!grupo) return;
  const aberto = !grupo.classList.contains("is-collapsed");
  $("[data-nav-group-toggle]", grupo)?.setAttribute("aria-expanded", String(aberto));
}
function initSidebar(){
  $("#sidebarToggleDesktop").onclick = () =>
    setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));

  $$("[data-nav-group-toggle]").forEach(b => b.onclick = () => {
    const g = b.closest(".nav-group");
    g.classList.toggle("is-collapsed");
    syncSidebarGroupToggle(g);
    salvarPrefs();
  });

  $$(".nav-item[data-section]").forEach(b => b.onclick = () => setSection(b.dataset.section));
  $("#brandReloadButton").onclick = () => location.reload();

  const menu = $("#collapsedProfileMenu"), atalho = $("#profileShortcut");
  const abrirMenu = ab => {
    menu.classList.toggle("is-open", ab);
    menu.setAttribute("aria-hidden", String(!ab));
    atalho.setAttribute("aria-expanded", String(ab));
  };
  atalho.onclick = e => { e.stopPropagation(); abrirMenu(!menu.classList.contains("is-open")); };
  menu.addEventListener("click", e => e.stopPropagation());
  $("#collapsedProfileMenuProfile").onclick = () => { abrirMenu(false); setSection("perfil"); };
  document.addEventListener("click", e => { if (!atalho.contains(e.target)) abrirMenu(false); });

  const trigger = $("#clientDropdownTrigger"), lista = $("#clientDropdownMenu");
  trigger.onclick = e => {
    e.stopPropagation();
    if (!pode("trocar_estabelecimento")) return;
    const ab = lista.hidden;
    lista.hidden = !ab;
    lista.classList.toggle("is-open", ab);
    trigger.setAttribute("aria-expanded", String(ab));
  };
  lista.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", () => {
    lista.hidden = true; lista.classList.remove("is-open"); trigger.setAttribute("aria-expanded","false");
  });
}
function renderEstabelecimentos(){
  const sel = $("#clientSelect"), menu = $("#clientDropdownMenu");
  const lojas = state.dados.estabelecimentos;
  sel.innerHTML = lojas.map(e =>
    `<option value="${e.id}" ${e.id===state.estabelecimentoId?"selected":""}>${esc(e.nome)}</option>`).join("");
  menu.innerHTML = lojas.map(e => `
    <button class="client-dropdown-option ${e.id===state.estabelecimentoId?"is-active":""}" type="button" role="option"
            aria-selected="${e.id===state.estabelecimentoId}" data-estab="${e.id}">
      <span class="client-dropdown-option-name">${esc(e.nome)}</span>
      <span class="client-dropdown-option-meta">${esc(e.segmento || "")}</span>
    </button>`).join("");
  $("#clientDropdownLabel").textContent = loja().nome || "Estabelecimento";
  document.body.classList.toggle("loja-unica", !pode("trocar_estabelecimento") || lojas.length < 2);
  $$("[data-estab]", menu).forEach(b => b.onclick = () => {
    menu.hidden = true; menu.classList.remove("is-open");
    trocarEstabelecimento(Number(b.dataset.estab));
  });
  sel.onchange = () => trocarEstabelecimento(Number(sel.value));
}
async function trocarEstabelecimento(id){
  if (id === state.estabelecimentoId) return;
  if (!pode("trocar_estabelecimento")) { toast("Seu papel não troca de loja."); return; }
  state.estabelecimentoId = id;
  state.paineis.ativo = state.prefs.painelAtivo?.[id] ?? null;
  state.paineis.editando = false;
  Object.values(state.tabela).forEach(u => u.selecionados.clear());
  fecharEditor();
  try {
    await comAviso("Trocando de estabelecimento...", () => carregarDados(),
      {sucesso: () => `Agora vendo ${loja().nome}`,
       detalhe: "Painéis, tabelas e financeiro passaram a ser desta loja."});
  } catch { return; }
  renderEstabelecimentos();
  renderTudo();
  salvarPrefs();
}

/* ==========================================================================
   tema
   ========================================================================== */
function aplicarTema(escolha, persistir = true){
  const efetivo = escolha === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : escolha;
  document.documentElement.dataset.theme = efetivo;
  document.body.dataset.theme = efetivo;
  $$("[data-theme-choice]").forEach(b => {
    const ativo = b.dataset.themeChoice === escolha;
    b.setAttribute("aria-checked", String(ativo));
    b.classList.toggle("is-selected", ativo);
  });
  state.prefs.tema = escolha;
  if (persistir) salvarPrefs();
  if (state.dados.sessoes.length) desenharGraficos();
}
function initTema(){
  aplicarTema(ler("pr.tema", "system"), false);   // antes do login, o do aparelho
  $$("[data-theme-choice]").forEach(b => b.onclick = () => {
    gravar("pr.tema", b.dataset.themeChoice);     // para a tela de login lembrar
    aplicarTema(b.dataset.themeChoice);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((state.prefs.tema || "system") === "system") aplicarTema("system", false);
  });
}

/* ==========================================================================
   navegação
   ========================================================================== */
function aplicarPapel(){
  const u = state.usuario;
  $("#profileName").textContent = u?.nome || "";
  pintarAvatar($("#profileAvatar"), u);
  const rotulo = {main:"Desenvolvedor", gerente:"Gerente", operador:"Operador"}[u?.papel] || "";
  $("#floatingRefreshText").innerHTML = `<span class="perfil-papel">${esc(rotulo)}</span>`;

  document.body.classList.toggle("somente-leitura", somenteLeitura());
  // seção bloqueada some do menu inteira, não fica clicável para falhar depois
  $$(".nav-item[data-section]").forEach(b => {
    b.hidden = !podeVer(b.dataset.section)
            || (TABELAS[b.dataset.section]?.soMain && u?.papel !== "main");
  });
  $$(".nav-group").forEach(g => {
    const vazio = $$(".nav-item[data-section]", g).every(b => b.hidden);
    g.hidden = vazio;
  });
  if (!podeVer(state.section)) state.section = "painel";
}

function setSection(secao){
  if (!SECOES[secao] || !podeVer(secao)) return;
  state.section = secao;
  $$(".panel-section").forEach(s => s.classList.toggle("is-active", s.id === `section-${secao}`));
  $$(".nav-item[data-section]").forEach(b => b.classList.toggle("active", b.dataset.section === secao));
  $("#activeSectionEyebrow").textContent = SECOES[secao].eyebrow;
  $("#activeSectionTitle").textContent = SECOES[secao].titulo;
  $("#dashboardManagerToggle").hidden = secao !== "painel";

  const cfg = TABELAS[secao];
  const podeCriar = cfg?.novo && pode("editar_dados")
                 && (!cfg.soMain || state.usuario?.papel === "main");
  $("#topbarActions").innerHTML = podeCriar
    ? `<button class="primary-button" type="button" data-criar="${secao}">${esc(cfg.novo)}</button>` : "";
  const btn = $("[data-criar]");
  if (btn) btn.onclick = () => abrirEditorNovo(secao);

  if (secao !== "painel"){ fecharBiblioteca(); fecharMenuPaineis(); sairDaEdicao(); }
  fecharEditor();
  renderSecaoAtual();
  salvarPrefs();
  document.body.classList.remove("sidebar-open");
}
const canAccessSection = s => Boolean(SECOES[s]) && podeVer(s);

function renderSecaoAtual(){
  const s = state.section;
  if (s === "painel") renderPainel();
  else if (s === "financeiro") renderFinanceiro();
  else if (s === "perfil") renderPerfil();
  else if (TABELAS[s]) renderTabela(s);
}

/* ==========================================================================
   tabelas
   ========================================================================== */
function ordenar(linhas, cfg, ordem){
  if (!ordem) return linhas;
  const col = cfg.colunas[ordem.col];
  if (!col) return linhas;
  const valor = col.ord || (l => l[col.k]);
  return [...linhas].sort((a, b) => {
    const va = valor(a), vb = valor(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === "number" && typeof vb === "number"
      ? va - vb
      : String(va).localeCompare(String(vb), "pt-BR", {numeric:true});
    return cmp * ordem.dir;
  });
}

function renderTabela(secao){
  const cfg0 = TABELAS[secao], u = ui(secao);
  const rotuloSecao = SECOES[secao].titulo.toLowerCase();
  // coluna marcada com `so` só existe para quem tem aquela permissão
  const cfg = {...cfg0, colunas: cfg0.colunas.filter(c => !c.so || pode(c.so))};
  const alvo = $(`#screen-${secao}`);
  if (!alvo) return;
  const todas = cfg.linhas();
  const termo = u.busca.trim().toLowerCase();
  const filtradas = termo ? todas.filter(l => JSON.stringify(l).toLowerCase().includes(termo)) : todas;
  const linhas = ordenar(filtradas, cfg, u.ordem ?? cfg.ordemPadrao ?? null);
  const marcadas = linhas.filter(l => u.selecionados.has(l.id)).length;
  const editavel = Boolean(cfg.campos) && pode("editar_dados")
                && (!cfg.soMain || state.usuario?.papel === "main");
  const ordem = u.ordem ?? cfg.ordemPadrao ?? null;

  const corpo = linhas.length ? linhas.map(l => `
    <tr class="${u.selecionados.has(l.id) ? "is-selected" : ""}">
      <td><input class="row-check" type="checkbox" data-linha="${l.id}" ${u.selecionados.has(l.id) ? "checked" : ""}
                 aria-label="Selecionar registro" ${editavel ? "" : "disabled"}></td>
      ${cfg.colunas.map(c => `<td>${c.v(l)}</td>`).join("")}
    </tr>`).join("")
    : `<tr><td colspan="${cfg.colunas.length + 1}">
         <div class="empty-state">${esc(termo ? "Nada encontrado para esta busca." : cfg.vazio)}</div></td></tr>`;

  const aviso = !editavel && cfg.campos ? `
    <div class="aviso-somente-leitura">
      <span aria-hidden="true">🔒</span>
      <span>Seu papel vê estes registros, mas não altera. Quem edita é o gerente.</span>
    </div>` : "";

  alvo.innerHTML = `${aviso}
    <article class="table-card">
      <div class="table-toolbar">
        <div class="toolbar-left">
          <span class="table-filter-summary">${esc(loja().nome || "")}</span>
          <label class="table-search">
            <input type="search" placeholder="Buscar em ${esc(SECOES[secao].titulo.toLowerCase())}"
                   value="${esc(u.busca)}" data-busca="${secao}">
          </label>
        </div>
        <div class="toolbar-right">
          ${marcadas ? `<span class="table-meta">${marcadas} selecionado(s)</span>` : ""}
          <span class="table-meta">Exibindo ${linhas.length} de ${todas.length} registro(s)</span>
          <button class="icon-button" type="button" data-recarregar aria-label="Atualizar ${esc(SECOES[secao].titulo)}" title="Atualizar"><span aria-hidden="true">⟳</span></button>
        </div>
      </div>
      <div class="table-shell table-container">
        <div class="table-wrapper">
          <div class="table-scroll" tabindex="0">
            <table>
              <thead><tr>
                <th><input class="head-check" type="checkbox" data-marcar-todas
                           ${linhas.length && marcadas === linhas.length ? "checked" : ""}
                           ${marcadas && marcadas < linhas.length ? 'data-indeterminate="true"' : ""}
                           ${editavel ? "" : "disabled"} aria-label="Selecionar todos"></th>
                ${cfg.colunas.map((c, i) => {
                  const dir = ordem?.col === i ? ordem.dir : 0;
                  return `<th><button class="sort-button" type="button" data-ordenar="${i}"
                              data-sort-dir="${dir === 1 ? "asc" : dir === -1 ? "desc" : "none"}">
                            <span>${esc(c.r)}</span>
                            <span class="sort-icon">${dir === 1 ? "↑" : dir === -1 ? "↓" : "↕"}</span>
                          </button></th>`;
                }).join("")}
              </tr></thead>
              <tbody>${corpo}</tbody>
            </table>
          </div>
        </div>
      </div>
    </article>`;

  const meio = $("[data-indeterminate='true']", alvo);
  if (meio) meio.indeterminate = true;

  const busca = $(`[data-busca="${secao}"]`, alvo);
  busca.oninput = () => {
    u.busca = busca.value;
    renderTabela(secao);
    const campo = $(`[data-busca="${secao}"]`, $(`#screen-${secao}`));
    campo.focus(); campo.setSelectionRange(campo.value.length, campo.value.length);
    salvarPrefs();
  };
  $$("[data-ordenar]", alvo).forEach(b => b.onclick = () => {
    const i = Number(b.dataset.ordenar);
    const atual = u.ordem ?? cfg.ordemPadrao ?? null;
    // asc -> desc -> sem ordenação, e volta
    u.ordem = atual?.col !== i ? {col:i, dir:1}
            : atual.dir === 1 ? {col:i, dir:-1}
            : null;
    renderTabela(secao); salvarPrefs();
  });
  $("[data-recarregar]", alvo).onclick = async () => {
    try {
      await comAviso("Buscando dados...", () => carregarDados(),
        {sucesso: "Dados atualizados", detalhe: `${cfg.linhas().length} registro(s) em ${rotuloSecao}.`});
      renderTudo();
    } catch { /* comAviso já mostrou */ }
  };
  const todasCb = $("[data-marcar-todas]", alvo);
  if (todasCb) todasCb.onchange = ev => {
    linhas.forEach(l => ev.target.checked ? u.selecionados.add(l.id) : u.selecionados.delete(l.id));
    renderTabela(secao); abrirEditorSelecao(secao);
  };
  $$("[data-linha]", alvo).forEach(cb => cb.onchange = () => {
    const id = Number(cb.dataset.linha);
    cb.checked ? u.selecionados.add(id) : u.selecionados.delete(id);
    renderTabela(secao); abrirEditorSelecao(secao);
  });
}

/* ==========================================================================
   gaveta de edição — cadastro, alteração e exclusão
   ========================================================================== */
let editorCtx = null;   // { secao, ids:[] }  ids vazio = criando

function campoHtml(c, valor){
  const id = `ed_${c.k}`;
  const ajuda = c.ajuda ? `<p class="editor-help">${esc(c.ajuda)}</p>` : "";
  if (c.t === "select"){
    const ops = typeof c.opcoes === "function" ? c.opcoes() : c.opcoes;
    return `<div class="editor-field" data-field-wrapper="${c.k}">
      <label for="${id}">${esc(c.r)}</label>
      <select id="${id}" class="editor-input" data-campo="${c.k}" data-tipo="select">
        ${ops.map(([v,r]) => `<option value="${esc(v)}" ${String(v)===String(valor??"")?"selected":""}>${esc(r)}</option>`).join("")}
      </select>${ajuda}</div>`;
  }
  return `<div class="editor-field" data-field-wrapper="${c.k}">
    <label for="${id}">${esc(c.r)}</label>
    <input id="${id}" class="editor-input" type="${c.t}" ${c.passo?`step="${c.passo}"`:""}
           value="${esc(valor ?? "")}" data-campo="${c.k}" data-tipo="${c.t}">${ajuda}</div>`;
}
function abrirEditor({secao, ids}){
  const cfg = TABELAS[secao];
  if (!cfg?.campos || !pode("editar_dados")) return fecharEditor();
  editorCtx = {secao, ids};
  const criando = ids.length === 0;
  const registros = cfg.linhas().filter(l => ids.includes(l.id));
  const base = registros[0] || {};

  $("#editorEyebrow").textContent = SECOES[secao].titulo;
  $("#editorTitle").textContent = criando ? "Novo registro"
                                : ids.length > 1 ? `${ids.length} registros selecionados`
                                : (base.nome || base.apelido || base.codigo || `Registro #${base.id}`);
  $("#editorBody").innerHTML = cfg.campos.map(c => {
    const misto = registros.length > 1 && registros.some(r => r[c.k] !== base[c.k]);
    return campoHtml(c, misto ? "" : base[c.k]);
  }).join("");
  $("#editorStatus").textContent = criando ? "Preencha e salve para criar."
    : ids.length > 1 ? `${ids.length} registros — o que você mudar vale para todos.`
    : "1 registro selecionado.";
  $("#editorDelete").hidden = criando;
  $("#editorSave").textContent = criando ? "Criar registro" : "Salvar alterações";
  $("#editorDrawer").classList.add("is-open");
  $("#editorDrawer").setAttribute("aria-hidden","false");
  document.body.classList.add("editor-open");
}
function abrirEditorSelecao(secao){
  const ids = [...ui(secao).selecionados];
  ids.length ? abrirEditor({secao, ids}) : fecharEditor();
}
function abrirEditorNovo(secao){
  ui(secao).selecionados.clear();
  renderTabela(secao);
  abrirEditor({secao, ids: []});
}
function fecharEditor(){
  editorCtx = null;
  $("#editorDrawer")?.classList.remove("is-open");
  $("#editorDrawer")?.setAttribute("aria-hidden","true");
  document.body.classList.remove("editor-open");
}
function lerCampos(){
  const dados = {};
  $$("#editorBody [data-campo]").forEach(el => {
    let v = el.value;
    if (el.dataset.tipo === "number") v = v === "" ? null : Number(v);
    if (v === "true") v = true; else if (v === "false") v = false;
    dados[el.dataset.campo] = v;
  });
  return dados;
}
async function salvarEditor(ev){
  ev?.preventDefault();
  if (!editorCtx) return;
  const {secao, ids} = editorCtx, cfg = TABELAS[secao], tabela = SECOES[secao].tabela;
  const campos = lerCampos();
  const faltando = cfg.campos.find(c => c.obrigatorio && (campos[c.k] === "" || campos[c.k] == null));
  if (faltando){ toast(`${faltando.r} é obrigatório.`, "error"); return; }

  const botao = $("#editorSave");
  const rotulo = SECOES[secao].titulo.toLowerCase();
  botao.disabled = true;
  try {
    if (!ids.length){
      const criado = await comAviso(`Criando em ${rotulo}...`,
        () => api.criar(tabela, {...campos, estabelecimento_id: state.estabelecimentoId}),
        {sucesso: "Registro criado", detalhe: `Salvo em ${rotulo}.`});
      await carregarDados();
      ui(secao).selecionados.clear();
      ui(secao).selecionados.add(criado.id);
      renderTudo();
      abrirEditorSelecao(secao);
    } else {
      await comAviso(ids.length > 1 ? `Salvando ${ids.length} registros...` : "Salvando...",
        async () => { for (const id of ids) await api.alterar(tabela, id, campos); },
        {sucesso: ids.length > 1 ? `${ids.length} registros salvos` : "Alterações salvas",
         detalhe: `${Object.keys(campos).length} campo(s) em ${rotulo}.`});
      await carregarDados();
      renderTudo();
      abrirEditorSelecao(secao);
    }
  } catch { /* comAviso já mostrou */ }
  finally { botao.disabled = false; }
}
async function excluirEditor(){
  if (!editorCtx?.ids.length) return;
  const {secao, ids} = editorCtx, tabela = SECOES[secao].tabela;
  const botao = $("#editorDelete");
  botao.disabled = true;
  try {
    // 409 aqui é a guarda de histórico: a frase do servidor diz o que fazer,
    // então ela vale mais que qualquer mensagem genérica nossa
    await comAviso(ids.length > 1 ? `Excluindo ${ids.length} registros...` : "Excluindo...",
      async () => { for (const id of ids) await api.excluir(tabela, id); },
      {sucesso: ids.length > 1 ? `${ids.length} registros excluídos` : "Registro excluído",
       detalhe: `Removido de ${SECOES[secao].titulo.toLowerCase()}.`});
    ui(secao).selecionados.clear();
    fecharEditor();
    await carregarDados();
    renderTudo();
  } catch { /* comAviso já mostrou */ }
  finally { botao.disabled = false; }
}

/* ==========================================================================
   painel: painéis salvos, edição, arrasto e redimensionamento
   ========================================================================== */
const meusPaineis = () => state.dados.paineis;
/* Ordem de escolha: o que a pessoa abriu por último, depois o particular
   dela (é a área de trabalho dela), depois o padrão da loja. O particular
   vem antes do compartilhado porque um painel montado para o gerente perde
   metade dos cards quando o operador o abre — melhor cair no dele. */
function painelAtual(){
  const lista = meusPaineis();
  const meu = lista.find(x => !x.compartilhado && x.usuario_id === state.usuario?.id);
  const p = lista.find(x => x.id === state.paineis.ativo)
         || meu
         || lista.find(x => x.padrao)
         || lista[0];
  if (p) state.paineis.ativo = p.id;
  return p;
}
/* O compartilhado é da loja: operador vê, mas não mexe. O particular é dele. */
function podeEditarPainel(p){
  if (!p) return false;
  return p.compartilhado ? pode("editar_painel_compartilhado") : p.usuario_id === state.usuario?.id;
}

function renderPainel(){
  const p = painelAtual();
  const editando = state.paineis.editando && podeEditarPainel(p);
  state.paineis.editando = editando;
  $("#dashboardManagerShell").classList.toggle("is-editing", editando);
  document.body.classList.toggle("editando-painel", editando);
  $("#dashboardLibraryFab").hidden = !editando;
  const titulo = $("#dashboardManagerEditbarTitleInput");
  titulo.disabled = !editando;
  if (document.activeElement !== titulo) titulo.value = p?.nome || "";

  if (!p){
    $("#dashboardGridLarge").innerHTML = "";
    $("#dashboardGridSmall").innerHTML = "";
    $("#dashboardCanvasEmpty").hidden = false;
    renderWorkspaces();
    return;
  }

  const cards = normalizarCards(p.cards);
  const grade = grupo => cards.filter(c => c.grupo === grupo).map(c => `
    <article class="dashboard-card ${c.grupo === "small" ? "dashboard-card-metric" : "dashboard-card-samples"} is-resizable-card"
             data-dashboard-card="${c.id}">
      <div class="dashboard-card-editor-tools">
        <button class="dashboard-card-tool" type="button" data-dashboard-card-remove="${c.id}" aria-label="Remover ${esc(CARDS[c.id].t)}">
          <span aria-hidden="true">−</span>
        </button>
        <button class="dashboard-card-tool dashboard-card-tool-handle" type="button" draggable="true"
                data-dashboard-card-handle="${c.id}" aria-label="Mover ${esc(CARDS[c.id].t)}">
          <span aria-hidden="true">⋮⋮</span>
        </button>
      </div>
      ${corpoCard(c.id, c.config)}
    </article>`).join("");

  $("#dashboardGridLarge").innerHTML = grade("large");
  $("#dashboardGridSmall").innerHTML = grade("small");
  $("#dashboardLargeCardsGroup").hidden = !cards.some(c => c.grupo === "large");
  $("#dashboardSmallCardsGroup").hidden = !cards.some(c => c.grupo === "small");
  $("#dashboardCanvasEmpty").hidden = cards.length > 0;

  aplicarSpans(cards);
  ligarArrasto(p, cards);
  ligarRedimensionar(p, cards);
  desenharGraficos();
  renderWorkspaces();
  renderBiblioteca();
}
function aplicarSpans(cards){
  const porId = new Map(cards.map(c => [c.id, c]));
  $$("#dashboardCanvas [data-dashboard-card]").forEach(no => {
    const c = porId.get(no.dataset.dashboardCard); if (!c) return;
    no.style.gridColumn = `span ${c.cols}`;
    no.style.gridRow = `span ${c.rows}`;
    no.style.setProperty("--dashboard-card-col-span", String(c.cols));
    no.style.setProperty("--dashboard-card-row-span", String(c.rows));
    no.style.setProperty("--dashboard-mobile-col-span", "1");
    no.style.setProperty("--dashboard-mobile-row-span", String(c.rows));
  });
}

/* Guarda o layout no banco. Debounce porque arrastar e redimensionar geram
   muitas mudanças seguidas, e não vale uma requisição por pixel. */
let gravacaoPendente = null;
function guardarLayout(p, cards){
  p.cards = cards;
  clearTimeout(gravacaoPendente);
  gravacaoPendente = setTimeout(async () => {
    try {
      // O servidor normaliza o layout e devolve o que de fato gravou. Adotar
      // a resposta é o que faz um card recusado aparecer como recusado, em
      // vez de continuar na tela até o próximo recarregamento e sumir lá.
      const salvo = await api.alterarPainel(p.id, {cards});
      const antes = JSON.stringify(p.cards);
      p.cards = salvo.cards;
      if (JSON.stringify(salvo.cards) !== antes){
        aviso("Layout ajustado pelo servidor", "atencao",
              {detalhe: "Parte do que você montou não foi aceita e voltou ao que cabe."});
        if (state.section === "painel") renderPainel();
      } else {
        aviso("Layout salvo", "ok", {detalhe: `${cards.length} cards em ${esc(p.nome)}.`, vida: 2200});
      }
    } catch (erro){ avisarErro(erro, "salvar o layout"); }
  }, 500);
}
const lerCards = () => [...$$("#dashboardGridLarge [data-dashboard-card]"),
                        ...$$("#dashboardGridSmall [data-dashboard-card]")]
  .map(no => ({
    id: no.dataset.dashboardCard,
    grupo: no.closest("[data-dashboard-dropzone]").dataset.dashboardDropzone,
    cols: Number(no.style.getPropertyValue("--dashboard-card-col-span")) || CARDS[no.dataset.dashboardCard].cols,
    rows: Number(no.style.getPropertyValue("--dashboard-card-row-span")) || CARDS[no.dataset.dashboardCard].rows,
    config: {},
  }));

function ligarArrasto(p, cards){
  let origem = null;
  const limpar = () => $$(".dashboard-card").forEach(n =>
    n.classList.remove("is-drop-target-before","is-drop-target-after"));

  $$("#dashboardCanvas [data-dashboard-card-handle]").forEach(punho => {
    const card = punho.closest("[data-dashboard-card]");
    punho.ondragstart = ev => {
      if (!state.paineis.editando){ ev.preventDefault(); return; }
      origem = card; card.classList.add("is-dragging");
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", card.dataset.dashboardCard);
      ev.dataTransfer.setDragImage(card, 24, 24);
    };
    punho.ondragend = () => {
      card.classList.remove("is-dragging");
      limpar(); origem = null;
      guardarLayout(p, lerCards());
      desenharGraficos();
    };
  });

  $$("#dashboardCanvas [data-dashboard-card]").forEach(card => {
    card.ondragover = ev => {
      if (!origem || origem === card || origem.parentNode !== card.parentNode) return;
      ev.preventDefault();
      const r = card.getBoundingClientRect();
      const depois = (ev.clientX - r.left) / r.width > 0.5;
      card.classList.toggle("is-drop-target-after", depois);
      card.classList.toggle("is-drop-target-before", !depois);
    };
    card.ondragleave = () => card.classList.remove("is-drop-target-before","is-drop-target-after");
    card.ondrop = ev => {
      if (!origem || origem === card || origem.parentNode !== card.parentNode) return;
      ev.preventDefault();
      const depois = card.classList.contains("is-drop-target-after");
      limpar();
      card.parentNode.insertBefore(origem, depois ? card.nextSibling : card);
      guardarLayout(p, lerCards());
    };
  });

  $$("#dashboardCanvas [data-dashboard-card-remove]").forEach(b => b.onclick = () => {
    const id = b.dataset.dashboardCardRemove;
    guardarLayout(p, cards.filter(c => c.id !== id));
    renderPainel();
  });
}

/* ---------- redimensionar como janela ----------
   A referência não usa alça: o card inteiro é a alça. Chegando a 8px de
   qualquer borda, o cursor vira seta de redimensionar e arrastar dali muda o
   tamanho — inclusive pelo lado esquerdo e pelo topo, que crescem o card para
   o lado contrário do arrasto.

   A conta converte pixel em célula da grade de 20 colunas, e não o contrário:
   assim o card sempre pousa alinhado com os vizinhos. E cada card tem um
   tamanho mínimo próprio (CARDS[id].min), que é o que impede um gráfico de
   ser espremido até virar um risco. */
const BORDA = 8;

function modoDeRedimensionar(card, ev){
  const r = card.getBoundingClientRect();
  const x = ev.clientX - r.left, y = ev.clientY - r.top;
  const oeste = x <= BORDA, leste = x >= r.width - BORDA;
  const norte = y <= BORDA, sul = y >= r.height - BORDA;
  return (norte ? "n" : sul ? "s" : "") + (oeste ? "w" : leste ? "e" : "");
}
const cursorDoModo = modo => ({
  n:"ns-resize", s:"ns-resize", e:"ew-resize", w:"ew-resize",
  ne:"nesw-resize", sw:"nesw-resize", nw:"nwse-resize", se:"nwse-resize",
}[modo] || "");

function ligarRedimensionar(p, cards){
  const porId = new Map(cards.map(c => [c.id, c]));
  let arrasto = null;

  $$("#dashboardCanvas [data-dashboard-card]").forEach(card => {
    const conf = porId.get(card.dataset.dashboardCard);
    if (!conf) return;

    // fora do arrasto, o cursor avisa que dali dá para redimensionar
    card.onpointermove = ev => {
      if (arrasto || !state.paineis.editando || ev.pointerType === "touch") return;
      card.style.cursor = cursorDoModo(modoDeRedimensionar(card, ev));
    };
    card.onpointerleave = () => { if (!arrasto) card.style.cursor = ""; };

    card.onpointerdown = ev => {
      if (!state.paineis.editando || ev.button !== 0) return;
      // clique em botão do card (remover, mover, link) não é redimensionar
      if (ev.target.closest("button, a, input, select")) return;
      const modo = modoDeRedimensionar(card, ev);
      if (!modo) return;
      ev.preventDefault();

      const grade = card.parentNode;
      const estilo = getComputedStyle(grade);
      const vao = parseFloat(estilo.columnGap) || 18;
      const larguraCol = (grade.clientWidth - vao * (COLUNAS - 1)) / COLUNAS;
      const alturaLinha = parseFloat(estilo.gridAutoRows) || 76;
      const minimo = minimoDoCard(conf.id);

      arrasto = {modo, x: ev.clientX, y: ev.clientY, cols: conf.cols, rows: conf.rows};
      try { card.setPointerCapture(ev.pointerId); } catch {}
      card.classList.add("is-resizing");
      document.body.classList.add("dashboard-card-resizing");
      card.style.cursor = cursorDoModo(modo);

      const medida = document.createElement("span");
      medida.className = "card-resize-medida";
      medida.textContent = `${conf.cols} × ${conf.rows}`;
      card.append(medida);

      const mover = e => {
        // oeste e norte crescem para o lado contrário do arrasto
        const dirCol = arrasto.modo.includes("w") ? -1 : arrasto.modo.includes("e") ? 1 : 0;
        const dirLin = arrasto.modo.includes("n") ? -1 : arrasto.modo.includes("s") ? 1 : 0;
        const dCols = dirCol * (e.clientX - arrasto.x) / (larguraCol + vao);
        const dLins = dirLin * (e.clientY - arrasto.y) / (alturaLinha + vao);
        const cols = clamp(Math.round(arrasto.cols + dCols), minimo.cols, COLUNAS);
        const rows = clamp(Math.round(arrasto.rows + dLins), minimo.rows, MAX_ROWS);
        if (cols === conf.cols && rows === conf.rows) return;
        conf.cols = cols; conf.rows = rows;
        card.style.gridColumn = `span ${cols}`;
        card.style.gridRow = `span ${rows}`;
        card.style.setProperty("--dashboard-card-col-span", String(cols));
        card.style.setProperty("--dashboard-card-row-span", String(rows));
        medida.textContent = `${cols} × ${rows}`;
        // o SVG se estica sozinho pelo viewBox, mas as barras e os rótulos
        // são calculados em pixel: sem redesenhar, o gráfico fica errado
        desenharGraficos();
      };
      const soltar = () => {
        card.onpointermove = null; card.onpointerup = null; card.onpointercancel = null;
        card.classList.remove("is-resizing");
        document.body.classList.remove("dashboard-card-resizing");
        card.style.cursor = "";
        medida.remove();
        arrasto = null;
        guardarLayout(p, lerCards());
        desenharGraficos();
        ligarRedimensionar(p, cards);   // religa o cursor de hover
      };
      card.onpointermove = mover;
      card.onpointerup = soltar;
      card.onpointercancel = soltar;
    };
  });
}

/* ---------- menu de painéis ---------- */
const ICO_EDITAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
const ICO_EXCLUIR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';
const ICO_PESSOAS = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>';
const ICO_CADEADO = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';
const ICO_MAIS = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';

/* Quantos painéis ainda cabem: um compartilhado por usuário da loja, e um
   particular por pessoa. A mesma regra está no banco; aqui ela existe para
   explicar antes de a pessoa tentar. */
function vagasDePainel(){
  const lista = meusPaineis();
  const usuarios = Math.max(state.dados.usuarios_da_loja.length, 1);
  const compartilhados = lista.filter(p => p.compartilhado).length;
  const temParticular = lista.some(p => !p.compartilhado && p.usuario_id === state.usuario?.id);
  return {
    compartilhado: Math.max(0, usuarios - compartilhados),
    particular: temParticular ? 0 : 1,
    usuarios, compartilhados,
  };
}

function renderWorkspaces({animar = false} = {}){
  const lista = meusPaineis(), ativo = state.paineis.ativo, vagas = vagasDePainel();
  const meusParticulares = lista.filter(p => !p.compartilhado).length;

  const linhas = lista.map((p, i) => {
    const editavel = podeEditarPainel(p);
    // não dá para ficar sem painel nenhum: o último não some
    const removivel = editavel && lista.length > 1;
    return `
    <div class="dashboard-workspaces-row${p.id === ativo ? " is-active" : ""}" data-dashboard-workspace-row="${p.id}" style="--stagger-index:${i}">
      <button class="dashboard-workspaces-row-action is-delete" type="button" data-painel-excluir="${p.id}"
              aria-label="Excluir ${esc(p.nome)}" title="${removivel ? "Excluir painel" : "Não é possível excluir"}"
              ${removivel ? "" : "disabled"}>${ICO_EXCLUIR}</button>
      <button class="dashboard-workspaces-row-main" type="button" data-painel-abrir="${p.id}">
        <span class="dashboard-workspaces-row-name">${esc(p.nome)}</span>
        <span class="dashboard-workspaces-visibility-badge ${p.compartilhado ? "is-shared" : "is-private"}">
          ${p.compartilhado ? ICO_PESSOAS : ICO_CADEADO}<span>${p.compartilhado ? "Compartilhado" : "Particular"}</span>
        </span>
        ${p.id === ativo ? '<span class="dashboard-workspaces-row-active-marker" aria-hidden="true">●</span>' : ""}
      </button>
      <button class="dashboard-workspaces-row-action is-edit" type="button" data-painel-editar="${p.id}"
              aria-label="Editar layout de ${esc(p.nome)}" title="${editavel ? "Editar layout" : "Somente leitura"}"
              ${editavel ? "" : "disabled"}>${ICO_EDITAR}</button>
    </div>`;
  }).join("") || `<p class="dashboard-workspaces-empty">Nenhum painel ainda.</p>`;

  const podeCompartilhado = pode("editar_painel_compartilhado") && vagas.compartilhado > 0;
  const podeParticular = vagas.particular > 0;
  const podeCriar = podeCompartilhado || podeParticular;

  const criar = state.paineis.criando
    ? `<form class="dashboard-workspaces-create-form" id="painelCriarForm" style="--stagger-index:${lista.length}">
         <input type="text" maxlength="120" placeholder="Nome do painel" id="painelCriarNome" autocomplete="off">
         <div class="dashboard-workspaces-visibility-toggle" role="radiogroup" aria-label="Visibilidade do painel">
           <button type="button" class="dashboard-workspaces-visibility-option is-shared-option${podeCompartilhado?" is-selected":""}"
                   role="radio" aria-checked="${podeCompartilhado}" data-visibilidade="shared"
                   ${podeCompartilhado?"":"disabled"} title="${podeCompartilhado?"":"A loja já tem um compartilhado por usuário"}">
             ${ICO_PESSOAS}<span>Compartilhado</span></button>
           <button type="button" class="dashboard-workspaces-visibility-option is-private-option${!podeCompartilhado?" is-selected":""}"
                   role="radio" aria-checked="${!podeCompartilhado}" data-visibilidade="private"
                   ${podeParticular?"":"disabled"} title="${podeParticular?"":"Você já tem o seu particular"}">
             ${ICO_CADEADO}<span>Particular</span></button>
         </div>
         <div class="dashboard-workspaces-create-actions">
           <button class="dashboard-workspaces-create-form-cancel" type="button" data-painel-criar-cancelar>Cancelar</button>
           <button class="dashboard-workspaces-create-form-submit" type="submit">Criar</button>
         </div>
       </form>`
    : podeCriar
    ? `<button class="dashboard-workspaces-create" type="button" data-painel-criar style="--stagger-index:${lista.length}">
         ${ICO_MAIS}<span>Novo painel</span></button>`
    : "";

  const limite = `<p class="dashboard-workspaces-empty" style="opacity:.75;font-size:.76rem">
      ${vagas.compartilhados}/${vagas.usuarios} compartilhados
      (um por usuário da loja) · ${meusParticulares ? "seu particular já existe" : "1 particular disponível"}
    </p>`;

  const box = $("#dashboardWorkspacesList");
  box.innerHTML = linhas + criar + limite;
  box.classList.toggle("is-animating-in", animar);

  $$("[data-painel-abrir]", box).forEach(b => b.onclick = () => {
    state.paineis.ativo = Number(b.dataset.painelAbrir);
    state.paineis.editando = false;
    fecharMenuPaineis(); renderPainel(); salvarPrefs();
  });
  $$("[data-painel-editar]", box).forEach(b => b.onclick = () => {
    state.paineis.ativo = Number(b.dataset.painelEditar);
    state.paineis.editando = true;
    fecharMenuPaineis(); renderPainel();
    toast("Arraste pelo punho, puxe o canto para redimensionar, use o + para adicionar.");
  });
  $$("[data-painel-excluir]", box).forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.painelExcluir);
    const nome = lista.find(p => p.id === id)?.nome || "";
    b.disabled = true;
    try {
      await comAviso("Excluindo painel...", () => api.excluirPainel(id),
        {sucesso: "Painel excluído", detalhe: nome});
      if (state.paineis.ativo === id) state.paineis.ativo = null;
      await carregarDados();
      renderPainel();
    } catch { b.disabled = false; }
  });

  const abrirCriar = $("[data-painel-criar]", box);
  if (abrirCriar) abrirCriar.onclick = () => {
    state.paineis.criando = true; renderWorkspaces(); $("#painelCriarNome")?.focus();
  };
  const cancelar = $("[data-painel-criar-cancelar]", box);
  if (cancelar) cancelar.onclick = () => { state.paineis.criando = false; renderWorkspaces(); };

  const form = $("#painelCriarForm", box);
  if (form){
    let compartilhado = podeCompartilhado;
    $$("[data-visibilidade]", form).forEach(b => b.onclick = () => {
      if (b.disabled) return;
      compartilhado = b.dataset.visibilidade === "shared";
      $$("[data-visibilidade]", form).forEach(x => {
        const sel = (x.dataset.visibilidade === "shared") === compartilhado;
        x.classList.toggle("is-selected", sel); x.setAttribute("aria-checked", String(sel));
      });
    });
    form.onsubmit = async ev => {
      ev.preventDefault();
      const nome = $("#painelCriarNome").value.trim() || (compartilhado ? "Painel da loja" : "Meu painel");
      const botao = $(".dashboard-workspaces-create-form-submit", form);
      botao.disabled = true;
      try {
        const novo = await comAviso("Criando painel...",
          () => api.criarPainel({estabelecimento_id: state.estabelecimentoId,
                                 nome, compartilhado, cards: layoutPadrao()}),
          {sucesso: "Painel criado",
           detalhe: `${nome} · ${compartilhado ? "compartilhado com a loja" : "particular"}`});
        state.paineis.criando = false;
        state.paineis.ativo = novo.id;
        state.paineis.editando = true;
        await carregarDados();
        fecharMenuPaineis(); renderPainel();
      } catch { botao.disabled = false; }
    };
  }
}
function abrirMenuPaineis(){
  state.paineis.menuAberto = true;
  $("#dashboardWorkspacesMenu").classList.add("is-open");
  $("#dashboardWorkspacesMenu").setAttribute("aria-hidden","false");
  $("#dashboardManagerToggle").classList.add("is-active");
  $("#dashboardManagerToggle").setAttribute("aria-expanded","true");
  renderWorkspaces({animar:true});
}
function fecharMenuPaineis(){
  state.paineis.menuAberto = false; state.paineis.criando = false;
  $("#dashboardWorkspacesMenu")?.classList.remove("is-open");
  $("#dashboardWorkspacesMenu")?.setAttribute("aria-hidden","true");
  $("#dashboardManagerToggle")?.classList.remove("is-active");
  $("#dashboardManagerToggle")?.setAttribute("aria-expanded","false");
}
function sairDaEdicao(){
  if (!state.paineis.editando) return;
  state.paineis.editando = false;
  document.body.classList.remove("editando-painel");
  $("#dashboardManagerShell")?.classList.remove("is-editing");
  fecharBiblioteca();
}

/* ---------- biblioteca de cards ---------- */
function renderBiblioteca(){
  const p = painelAtual(); if (!p) return;
  const cards = normalizarCards(p.cards);
  const ativos = cards.map(c => c.id);
  const disponiveis = Object.keys(CARDS).filter(id => cardVisivel(id) && !ativos.includes(id));
  const grupos = [...new Set(Object.keys(CARDS).filter(cardVisivel).map(id => CARDS[id].g))];

  $("#dashboardManagerPanelBody").innerHTML = `
    <section class="dashboard-manager-panel-section">
      <div class="dashboard-manager-panel-section-head"><strong>Em uso</strong><span>${ativos.length} card(s)</span></div>
      <div class="dashboard-manager-pill-row">
        ${cards.map(c => `
          <div class="dashboard-manager-pill is-active">
            <span>${esc(CARDS[c.id].t)} · ${c.cols}×${c.rows}</span>
            <button class="icon-button dashboard-manager-pill-action" type="button" data-lib-remover="${c.id}" aria-label="Remover ${esc(CARDS[c.id].t)}"><span aria-hidden="true">−</span></button>
          </div>`).join("") || '<div class="dashboard-manager-empty-mini">Nenhum card em uso no momento.</div>'}
      </div>
    </section>
    ${grupos.map(g => {
      const doGrupo = disponiveis.filter(id => CARDS[id].g === g);
      if (!doGrupo.length) return "";
      return `<section class="dashboard-manager-panel-section">
        <div class="dashboard-manager-panel-section-head"><strong>${esc(g)}</strong><span>${doGrupo.length} disponível(is)</span></div>
        <div class="dashboard-manager-library-grid">
          ${doGrupo.map(id => `
            <article class="dashboard-library-card" data-dashboard-card-size="${CARDS[id].tam}">
              <div>
                <p class="eyebrow">${esc(g)} • ${CARDS[id].tam === "large" ? "Grande" : "Pequeno"}</p>
                <h4>${esc(CARDS[id].t)}</h4>
              </div>
              <button class="ghost-button" type="button" data-lib-adicionar="${id}">Adicionar</button>
            </article>`).join("")}
        </div></section>`;
    }).join("")}`;

  $$("[data-lib-adicionar]").forEach(b => b.onclick = () => {
    const id = b.dataset.libAdicionar;
    guardarLayout(p, [...cards, {id, grupo:CARDS[id].tam, cols:CARDS[id].cols, rows:CARDS[id].rows, config:{}}]);
    renderPainel();
  });
  $$("[data-lib-remover]").forEach(b => b.onclick = () => {
    guardarLayout(p, cards.filter(c => c.id !== b.dataset.libRemover));
    renderPainel();
  });
}
function abrirBiblioteca(){
  state.paineis.bibliotecaAberta = true;
  $("#dashboardManagerPanel").classList.add("is-open");
  $("#dashboardManagerPanel").setAttribute("aria-hidden","false");
  $("#dashboardLibraryFab").setAttribute("aria-expanded","true");
  renderBiblioteca();
}
function fecharBiblioteca(){
  state.paineis.bibliotecaAberta = false;
  $("#dashboardManagerPanel")?.classList.remove("is-open");
  $("#dashboardManagerPanel")?.setAttribute("aria-hidden","true");
  $("#dashboardLibraryFab")?.setAttribute("aria-expanded","false");
}

/* ==========================================================================
   conteúdo dos cards
   ========================================================================== */
function metricas(){
  const ses = sessoesDaLoja(), ven = daLoja(state.dados.vendas), e = loja();
  const energia = ses.reduce((a,s) => a + Number(s.energia_kwh||0), 0);
  const receita = ven.reduce((a,v) => a + Number(v.valor_brl||0), 0);
  // ponto em cortesia devolve dinheiro pela loja; ponto pago devolve no caixa
  // do próprio carregador. Somar só um dos dois faz a conta mentir.
  const recarga = ses.reduce((a,s) => a + Number(s.valor_cobrado_brl||0), 0);
  const lucro = receita * Number(e.margem_liquida_pct || 0) / 100;
  const custoEnergia = energia * Number(e.tarifa_kwh_brl || 0.789);
  const custoEquip = ses.length * AMORT;
  const cupons = state.dados.cupons;
  return { ses, ven, energia, receita, recarga, lucro, custoEnergia, custoEquip,
           cuponsEmitidos: cupons.length,
           cuponsUsados: cupons.filter(c => c.usado_em).length,
           temCortesia: carregadoresDaLoja().some(c => c.modo === "cortesia"),
           saldo: lucro + recarga - custoEnergia - custoEquip,
           clientes: new Set(ses.map(s => s.cliente_id).filter(Boolean)).size };
}
function kpi(eyebrow, titulo, valor, meta, tom = ""){
  return `<div class="dashboard-kpi-card" ${tom?`data-dashboard-metric-tone="${tom}"`:""}>
    <p class="eyebrow">${esc(eyebrow)}</p><h3>${esc(titulo)}</h3>
    <strong class="dashboard-kpi-value">${valor}</strong>
    <p class="dashboard-kpi-meta">${meta}</p></div>`;
}
const cabecaCard = (eyebrow, titulo) =>
  `<div class="card-heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h3>${esc(titulo)}</h3></div></div>`;

function corpoCard(id, config){
  const m = metricas(), e = loja();
  switch (id){
    case "lucro":    return kpi("Retorno","Lucro atribuído", brl(m.lucro),
                       `de ${brl(m.receita)} em vendas com cupom`, m.saldo > 0 ? "ok" : "warning");
    case "vendas":   return kpi("Negócio","Vendas atribuídas", brl(m.receita),
                       `${m.ven.length} vendas com cupom` + (m.recarga ? ` · ${brl(m.recarga)} cobrados na tomada` : ""));
    case "sessoes":  return kpi("Operação","Sessões", num(m.ses.length), `${num(m.ses.length/30,1)} por dia, em média`);
    case "clientes": return kpi("Público","Clientes únicos", num(m.clientes), "identificados pelo cupom");
    case "energia":  return kpi("Custo","Energia entregue", `${num(m.energia,0)} kWh`,
                       `${brl(m.custoEnergia)} de conta de luz · ${Math.round(m.energia*KM_KWH)} km devolvidos`);
    case "ticket":   return kpi("Comparação","Ticket de quem carrega", brl(Number(e.ticket_medio_brl||0) * (1 + UPLIFT)),
                       `${Math.round(UPLIFT*100)}% acima do ticket normal da loja`);
    case "cupons":   return kpi("Atribuição","Cupons usados",
                       `${m.cuponsEmitidos ? Math.round(m.cuponsUsados/m.cuponsEmitidos*100) : 0}%`,
                       `${num(m.cuponsUsados)} de ${num(m.cuponsEmitidos)} emitidos voltaram no caixa`);
    case "retorno":  return `<div class="trend-card">
                       ${cabecaCard("Retorno","Lucro atribuído × custo do carregador")}
                       <svg id="chartRetorno" viewBox="0 0 640 240" preserveAspectRatio="none" role="img" aria-label="Lucro contra custo por dia"></svg>
                       <p class="dashboard-kpi-meta"><span style="color:var(--status-ok)">■</span> lucro atribuído + recarga cobrada &nbsp; <span style="color:var(--status-warning)">■</span> energia + equipamento</p></div>`;
    case "horas":    return `<div class="trend-card">
                       ${cabecaCard("Movimento","Sessões por hora do dia")}
                       <svg id="chartHoras" viewBox="0 0 640 240" preserveAspectRatio="none" role="img" aria-label="Sessões por hora"></svg></div>`;
    case "previsao": return `<div class="trend-card">
                       ${cabecaCard("Inteligência","Quanto a previsão errou")}
                       <svg id="chartPrevisao" viewBox="0 0 640 240" preserveAspectRatio="none" role="img" aria-label="Erro da previsão em minutos"></svg>
                       <p class="dashboard-kpi-meta" id="previsaoResumo"></p></div>`;
    case "pontos":   return `<div class="trend-card">
                       ${cabecaCard("Agora","Carregadores")}
                       <div id="pontosAoVivo" class="lista-rolavel"></div></div>`;
    case "curva":    return corpoCurva(id, config);
    case "teto":     return `<div class="trend-card">
                       ${cabecaCard("Cortesia","Quanto esta loja aguenta dar")}
                       <div id="tetoCard"></div></div>`;
    default: return "";
  }
}


/* ==========================================================================
   Curva de recarga — o card detalhado

   O eixo do tempo é a SESSÃO, não o relógio. A primeira versão mostrava as
   últimas 24 horas e ficava quase vazia: um carregador só reporta enquanto
   alguém está carregando, então numa loja com três recargas por dia sobram
   vinte horas de nada. Um gráfico com dois riscos e um deserto no meio não
   informa — parece defeito.

   Recortado numa recarga, o mesmo desenho fica denso e diz o que interessa:
   a potência se mantém no teto do ponto, a carga sobe em rampa, e o fim da
   rampa é onde o carro parou de aceitar. É a leitura que a referência tem
   com o clima da sala, com a diferença de que lá tudo é °C e aqui potência é
   kW e carga é % — daí dois eixos, um de cada lado.

   SVG à mão, sem biblioteca: a CSP é `script-src 'self'`, então CDN não
   carrega, e o dossiê promete zero dependência de gráfico.
   ========================================================================== */
const SERIES_CURVA = {
  potencia: {rotulo:"Potência", cor:"--primary",        traco:"",    largura:2.4},
  nominal:  {rotulo:"Nominal",  cor:"--status-warning", traco:"4 3", largura:1.5},
  carga:    {rotulo:"Carga",    cor:"--status-ok",      traco:"7 4", largura:2},
};

/* As recargas que têm leitura suficiente para virar curva. */
function sessoesComCurva(){
  const porSessao = new Map();
  state.dados.leituras.forEach(l => {
    if (!l.sessao_id) return;
    (porSessao.get(l.sessao_id) || porSessao.set(l.sessao_id, []).get(l.sessao_id)).push(l);
  });
  return sessoesDaLoja()
    .filter(s => (porSessao.get(s.id) || []).length >= 3)
    .sort((a, b) => new Date(b.inicio) - new Date(a.inicio))
    .slice(0, 40)
    .map(s => ({
      sessao: s,
      carregador: state.dados.carregadores.find(c => c.id === s.carregador_id),
      leituras: porSessao.get(s.id).sort((a, b) => new Date(a.momento) - new Date(b.momento)),
    }));
}

function curvaEscolhida(config){
  const todas = sessoesComCurva();
  return todas.find(x => x.sessao.id === Number(config?.sessao_id)) || todas[0] || null;
}

function corpoCurva(id, config){
  const escolha = curvaEscolhida(config);
  const todas = sessoesComCurva();
  if (!escolha){
    return `<div class="curva-card"><div class="curva-vazio">
      Nenhuma recarga com leituras suficientes para desenhar a curva.</div></div>`;
  }
  const {sessao, carregador} = escolha;
  const minutos = Math.max(1, Math.round((new Date(sessao.fim) - new Date(sessao.inicio)) / 60000));
  return `<div class="curva-card">
    <div class="curva-topo">
      <div class="curva-titulo">
        <p class="eyebrow">Curva de recarga · ${esc(dataHora(sessao.inicio))}</p>
        <h3>${esc(carregador?.nome || "Carregador")}</h3>
      </div>
      <div class="curva-lateral">
        <div class="curva-legenda">
          ${Object.values(SERIES_CURVA).map(x => `
            <span class="curva-chave"><i style="background:var(${x.cor})"></i>${esc(x.rotulo)}</span>`).join("")}
        </div>
        <select class="curva-escolha" data-curva-sessao="${id}" aria-label="Recarga mostrada no gráfico">
          ${todas.map(x => `<option value="${x.sessao.id}" ${x.sessao.id === sessao.id ? "selected" : ""}>
            ${esc(x.carregador?.nome || "")} · ${esc(dataHora(x.sessao.inicio))}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="curva-area">
      <svg class="curva-svg" id="curva_${id}" role="img"
           aria-label="Potência e carga durante a recarga"></svg>
      <div class="curva-dica" id="curvaDica_${id}" hidden></div>
    </div>
    <div class="curva-resumo">
      <span><b>${num(sessao.energia_kwh, 1)} kWh</b> entregues</span>
      <span><b>${minutos} min</b> de recarga</span>
      <span>carga <b>${Math.round((sessao.soc_inicial ?? 0) * 100)}% → ${Math.round((sessao.soc_final ?? 0) * 100)}%</b></span>
      <span><b>${Math.round(sessao.energia_kwh * KM_KWH)} km</b> devolvidos</span>
    </div>
  </div>`;
}

function desenharCurva(id, config){
  const alvo = $(`#curva_${id}`);
  if (!alvo) return;
  const escolha = curvaEscolhida(config);
  if (!escolha) return;
  const {sessao, carregador, leituras} = escolha;

  // o viewBox acompanha o tamanho real do card, para o texto não esticar
  const caixa = alvo.getBoundingClientRect();
  const W = Math.max(360, Math.round(caixa.width)) || 720;
  const H = Math.max(150, Math.round(caixa.height)) || 220;
  const E = 42, D = 40, T = 12, B = 24;
  alvo.setAttribute("viewBox", `0 0 ${W} ${H}`);
  alvo.setAttribute("preserveAspectRatio", "none");

  const t0 = new Date(sessao.inicio).getTime();
  const t1 = Math.max(new Date(sessao.fim).getTime(),
                      new Date(leituras[leituras.length - 1].momento).getTime());
  const nominal = Number(carregador?.potencia_kw) || 0;
  const kwMax = Math.max(nominal, ...leituras.map(l => Number(l.potencia_kw) || 0)) * 1.15 || 1;

  const x = ms => E + (t1 === t0 ? 0.5 : (ms - t0) / (t1 - t0)) * (W - E - D);
  const yKw = v => H - B - (v / kwMax) * (H - T - B);
  const yPct = v => H - B - (v / 100) * (H - T - B);

  const cor = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
  const grade = cor("--chart-grid") || "rgba(140,160,180,.25)";
  const suave = cor("--muted") || "#8496a8";

  let g = "";
  for (let i = 0; i <= 4; i++){
    const v = kwMax * i / 4, py = yKw(v);
    g += `<line x1="${E}" y1="${py.toFixed(1)}" x2="${W - D}" y2="${py.toFixed(1)}" stroke="${grade}" stroke-width="1"/>`
       + `<text x="${E - 8}" y="${(py + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${suave}">${num(v, 1)}</text>`
       + `<text x="${W - D + 8}" y="${(yPct(25 * i) + 3.5).toFixed(1)}" text-anchor="start" font-size="10" fill="${suave}">${25 * i}%</text>`;
  }
  // o eixo do tempo conta minutos desde o início — é o que a pessoa acompanha
  const marcas = Math.max(3, Math.min(7, Math.floor((W - E - D) / 80)));
  for (let i = 0; i <= marcas; i++){
    const ms = t0 + (t1 - t0) * i / marcas, px = x(ms);
    g += `<line x1="${px.toFixed(1)}" y1="${T}" x2="${px.toFixed(1)}" y2="${H - B}" stroke="${grade}" stroke-width="1" opacity=".5"/>`
       + `<text x="${px.toFixed(1)}" y="${H - B + 15}" text-anchor="middle" font-size="10" fill="${suave}">`
       + `${Math.round((ms - t0) / 60000)} min</text>`;
  }

  const traco = (pontos, e) => pontos.length < 2 ? "" :
    `<path d="${pontos.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}"
           fill="none" stroke="var(${e.cor})" stroke-width="${e.largura}"
           ${e.traco ? `stroke-dasharray="${e.traco}"` : ""}
           stroke-linejoin="round" stroke-linecap="round"/>`;
  const pontos = valor => leituras.map(l => ({ms: new Date(l.momento).getTime(),
                                              x: x(new Date(l.momento).getTime()), y: valor(l)}));

  g += traco([{x:x(t0), y:yKw(nominal)}, {x:x(t1), y:yKw(nominal)}], SERIES_CURVA.nominal);
  g += traco(pontos(l => yPct(Number(l.soc ?? 0) * 100)), SERIES_CURVA.carga);
  g += traco(pontos(l => yKw(Number(l.potencia_kw) || 0)), SERIES_CURVA.potencia);

  g += `<line class="curva-guia" x1="0" y1="${T}" x2="0" y2="${H - B}" stroke="var(--primary)" stroke-width="1" opacity="0" stroke-dasharray="3 3"/>`
     + `<circle class="curva-alvo" r="3.5" fill="var(--primary)" opacity="0"/>`
     + `<rect x="${E}" y="${T}" width="${W - E - D}" height="${H - T - B}" fill="transparent" class="curva-captura"/>`;
  alvo.innerHTML = g;

  const dica = $(`#curvaDica_${id}`);
  const guia = $(".curva-guia", alvo), marca = $(".curva-alvo", alvo);
  $(".curva-captura", alvo).onpointermove = ev => {
    const r = alvo.getBoundingClientRect();
    const ms = t0 + ((ev.clientX - r.left) / r.width * W - E) / (W - E - D) * (t1 - t0);
    let melhor = leituras[0], menor = Infinity;
    leituras.forEach(l => {
      const d = Math.abs(new Date(l.momento).getTime() - ms);
      if (d < menor){ menor = d; melhor = l; }
    });
    const lx = x(new Date(melhor.momento).getTime());
    guia.setAttribute("x1", lx); guia.setAttribute("x2", lx); guia.setAttribute("opacity", ".6");
    marca.setAttribute("cx", lx); marca.setAttribute("cy", yKw(Number(melhor.potencia_kw) || 0));
    marca.setAttribute("opacity", "1");
    dica.hidden = false;
    dica.innerHTML = `<strong>${Math.round((new Date(melhor.momento) - t0) / 60000)} min de recarga</strong>
      <span><i style="background:var(--primary)"></i>Potência <b>${num(melhor.potencia_kw, 2)} kW</b></span>
      <span><i style="background:var(--status-warning)"></i>Nominal <b>${num(nominal, 1)} kW</b></span>
      ${melhor.soc == null ? "" : `<span><i style="background:var(--status-ok)"></i>Carga <b>${Math.round(melhor.soc * 100)}%</b></span>`}`;
    const meia = (dica.offsetWidth || 150) / 2;
    dica.style.left = `${clamp(lx / W * r.width, meia + 4, r.width - meia - 4)}px`;
  };
  $(".curva-captura", alvo).onpointerleave = () => {
    guia.setAttribute("opacity", "0");
    marca.setAttribute("opacity", "0");
    dica.hidden = true;
  };

  const escolher = $(`[data-curva-sessao="${id}"]`);
  if (escolher) escolher.onchange = ev => {
    const p = painelAtual();
    const cards = normalizarCards(p.cards);
    const card = cards.find(c => c.id === id);
    if (!card) return;
    card.config = {...card.config, sessao_id: Number(ev.target.value)};
    guardarLayout(p, cards);        // a escolha é do card, e viaja com ele
    renderPainel();
  };
}

/* ==========================================================================
   gráficos
   ========================================================================== */
const cor = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#8899aa";

function desenharGraficos(){
  const e = loja(), ses = sessoesDaLoja();

  $$("[data-dashboard-card='curva']").forEach(no => {
    const p = painelAtual();
    const conf = normalizarCards(p?.cards).find(c => c.id === "curva");
    desenharCurva("curva", conf?.config);
  });

  if ($("#chartRetorno")){
    const porDia = {};
    const bucket = d => (porDia[d] ||= {custo:0, lucro:0});
    ses.forEach(s => { const b = bucket(String(s.inicio).slice(0,10));
                       b.custo += Number(s.energia_kwh||0) * Number(e.tarifa_kwh_brl||0.789) + AMORT;
                       b.lucro += Number(s.valor_cobrado_brl||0); });   // ponto pago entra direto
    daLoja(state.dados.vendas).forEach(v => { const b = bucket(String(v.momento).slice(0,10));
                       b.lucro += Number(v.valor_brl||0) * Number(e.margem_liquida_pct||0) / 100; });
    const dias = Object.keys(porDia).sort();
    const W=640,H=240,L=54,R=14,T=16,B=28;
    const max = Math.max(1, ...dias.map(d => Math.max(porDia[d].lucro, porDia[d].custo))) * 1.15;
    const x = i => dias.length < 2 ? (L+W-R)/2 : L + i*(W-L-R)/(dias.length-1);
    const y = v => H-B - v*(H-T-B)/max;
    let g = "";
    for (let k=0;k<=4;k++){
      const v = max*k/4;
      g += `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${W-R}" y2="${y(v).toFixed(1)}" stroke="${cor("--chart-grid")}" stroke-width="1"/>
            <text x="${L-8}" y="${(y(v)+4).toFixed(1)}" text-anchor="end" font-size="11" fill="${cor("--muted")}">${num(v)}</text>`;
    }
    const linha = (k,c,w) => `<path d="${dias.map((d,i)=>`${i?"L":"M"}${x(i).toFixed(1)},${y(porDia[d][k]).toFixed(1)}`).join(" ")}"
                              fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
    g += linha("custo", cor("--status-warning"), 2) + linha("lucro", cor("--status-ok"), 2.6);
    $("#chartRetorno").innerHTML = g;
  }

  if ($("#chartHoras")){
    const b = new Array(24).fill(0);
    ses.forEach(s => b[new Date(s.inicio).getHours()]++);
    const faixa = b.slice(6,23), max = Math.max(1,...faixa);
    const W=640,H=240,L=36,R=12,T=14,B=30, slot=(W-L-R)/faixa.length, bw=slot*0.6;
    let g = "";
    faixa.forEach((v,i) => {
      const h = v*(H-T-B)/max;
      g += `<rect x="${(L+slot*i+(slot-bw)/2).toFixed(1)}" y="${(H-B-h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h,1).toFixed(1)}"
                  rx="3" fill="${cor("--primary")}" opacity="${v===max?"1":"0.55"}"><title>${i+6}h — ${v} sessões</title></rect>`;
      if (i%3===0) g += `<text x="${(L+slot*i+slot/2).toFixed(1)}" y="${H-B+16}" text-anchor="middle" font-size="11" fill="${cor("--muted")}">${i+6}h</text>`;
    });
    $("#chartHoras").innerHTML = g;
  }

  if ($("#chartPrevisao")){
    // faixas de erro em minutos: é o card que audita a própria IA
    const erros = ses.map(erroPrevisao).filter(v => v != null);
    const faixas = [[0,5,"até 5 min"],[5,10,"5 a 10"],[10,15,"10 a 15"],[15,30,"15 a 30"],[30,1e9,"mais de 30"]];
    const contagem = faixas.map(([a,b]) => erros.filter(v => v >= a && v < b).length);
    const max = Math.max(1, ...contagem);
    const W=640,H=240,L=36,R=12,T=14,B=34, slot=(W-L-R)/faixas.length, bw=slot*0.55;
    let g = "";
    contagem.forEach((v,i) => {
      const h = v*(H-T-B)/max;
      const bom = i < 2;
      g += `<rect x="${(L+slot*i+(slot-bw)/2).toFixed(1)}" y="${(H-B-h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h,1).toFixed(1)}"
                  rx="3" fill="${bom ? cor("--status-ok") : cor("--status-warning")}" opacity="0.85"><title>${v} sessões</title></rect>
            <text x="${(L+slot*i+slot/2).toFixed(1)}" y="${H-B+16}" text-anchor="middle" font-size="10" fill="${cor("--muted")}">${faixas[i][2]}</text>`;
    });
    $("#chartPrevisao").innerHTML = g;
    const dentro = erros.filter(v => v <= 10).length;
    $("#previsaoResumo").innerHTML = erros.length
      ? `<strong>${Math.round(dentro/erros.length*100)}%</strong> das previsões erraram 10 minutos ou menos, em ${erros.length} sessões.`
      : "Sem sessões concluídas para comparar.";
  }

  if ($("#pontosAoVivo")){
    const cs = carregadoresDaLoja();
    $("#pontosAoVivo").innerHTML = cs.length ? cs.map(c => `
      <div class="linha-ponto">
        <div class="linha-ponto-copy">
          <strong>${esc(c.nome)}</strong>
          <span>${num(c.potencia_kw,1)} kW · ${c.modo === "cortesia" ? `cortesia até ${num(c.teto_cortesia_kwh,1)} kWh` : `${brl(c.preco_kwh_brl)}/kWh`}</span>
        </div>
        ${chip(c.ativo ? "ativo" : "inativo", c.ativo ? "ok" : "offline")}
        <a class="ghost-button" href="../vaga/?vaga=${encodeURIComponent(c.nome)}&loja=${encodeURIComponent(e.nome||"")}&modo=${c.modo}&full=1" target="_blank" rel="noopener">Telinha</a>
      </div>`).join("")
      : `<div class="empty-state">Nenhum carregador cadastrado.</div>`;
  }

  if ($("#tetoCard")){
    const r = tetoCortesia(Number(e.margem_liquida_pct||0), Number(e.ticket_medio_brl||0), Number(e.tarifa_kwh_brl||0.789));
    $("#tetoCard").innerHTML = r.kwh > 0.4
      ? `<p class="dashboard-kpi-meta">Cada visita gera <strong>${brl(r.lucro)}</strong> de lucro. Tirando o equipamento, sobram <strong>${brl(r.sobra)}</strong>.</p>
         <strong class="dashboard-kpi-value">${num(r.kwh,1)} kWh</strong>
         <p class="dashboard-kpi-meta">cerca de ${Math.round(r.kwh*KM_KWH)} km de cortesia por visita</p>`
      : `<p class="dashboard-kpi-meta">Cada visita gera <strong>${brl(r.lucro)}</strong> — menos do que o equipamento custa por sessão (${brl(AMORT)}).</p>
         <strong class="dashboard-kpi-value" style="color:var(--status-critical)">Não se paga</strong>
         <p class="dashboard-kpi-meta">Com esta margem e este ticket, o caminho é cobrar por kWh.</p>`;
  }
}

/* ==========================================================================
   financeiro
   ========================================================================== */
function renderFinanceiro(){
  if (!podeVer("financeiro")) return;
  const e = loja(), m = metricas();
  const r = tetoCortesia(Number(e.margem_liquida_pct||0), Number(e.ticket_medio_brl||0), Number(e.tarifa_kwh_brl||0.789));
  const saldo = m.saldo;
  const veredito = saldo > 0
    ? (m.temCortesia ? "a cortesia está se pagando" : "os pontos pagos cobrem o custo")
    : (m.temCortesia ? "a cortesia está grande demais" : "o preço por kWh não cobre o custo");
  const blocos = [
    ["Entrou","Lucro atribuído", brl(m.lucro), `${m.ven.length} vendas com cupom`, ""],
    ["Entrou","Recarga cobrada", brl(m.recarga), "pontos que cobram por kWh", ""],
    ["Saiu","Energia", brl(m.custoEnergia), `${num(m.energia,0)} kWh a ${brl(e.tarifa_kwh_brl)}/kWh`, "warning"],
    ["Saiu","Equipamento", brl(m.custoEquip), `${brl(AMORT)} por sessão, 5 anos`, "warning"],
    [saldo > 0 ? "No azul" : "No vermelho","Saldo", brl(saldo), veredito, saldo > 0 ? "ok" : "critical"],
  ];
  $("#screen-financeiro").innerHTML = `
    <article class="table-card">
      <div class="table-toolbar">
        <div class="toolbar-left"><h3 class="table-title">Resultado de ${esc(e.nome || "")}</h3></div>
        <div class="toolbar-right"><span class="table-meta">${m.ses.length} sessões no período</span></div>
      </div>
      <div class="dashboard-canvas-grid dashboard-canvas-grid-small" style="padding:18px">
        ${blocos.map(([a,b,c,d,t]) =>
          `<div class="dashboard-card dashboard-card-metric" style="grid-column:span 4;grid-row:span 2">${kpi(a,b,c,d,t)}</div>`).join("")}
      </div>
      <div class="table-section-banner">
        <strong>Teto de cortesia recomendado:</strong>
        ${r.kwh > 0.4
          ? ` ${num(r.kwh,1)} kWh por visita — cerca de ${Math.round(r.kwh*KM_KWH)} km.
              Sai de uma margem de ${num(e.margem_liquida_pct,1)}% sobre um ticket de ${brl(e.ticket_medio_brl)}:
              ${brl(r.lucro)} de lucro por visita, menos ${brl(AMORT)} do equipamento, dividido pela tarifa de ${brl(e.tarifa_kwh_brl)}/kWh.`
          : ` neste cenário a cortesia não se paga. Com margem de ${num(e.margem_liquida_pct,1)}% e ticket de ${brl(e.ticket_medio_brl)},
              cada visita gera ${brl(r.lucro)} — abaixo dos ${brl(AMORT)} que o equipamento custa por sessão.
              Aqui o modelo honesto é cobrar por kWh.`}
      </div>
    </article>`;
}

/* ==========================================================================
   assistente
   ========================================================================== */
const orb = () => $("bms-ai-entity[data-ai-entity-role='launcher']");

function dizer(texto, de){
  const el = document.createElement("div");
  el.className = `global-ai-chat-message is-${de}`;
  el.innerHTML = `<p>${esc(texto)}</p>`;
  $("#globalAiChatMessages").append(el);
  $("#globalAiChatMessages").scrollTop = $("#globalAiChatMessages").scrollHeight;
  return el;
}
let abrirChat = () => {};

function initAssistente(){
  const chat = $("#globalAiChat"), lancador = $("#globalAiLauncher");
  lancador.hidden = false;
  const abrir = abrirChat = ab => {
    chat.classList.toggle("is-open", ab);
    chat.setAttribute("aria-hidden", String(!ab));
    lancador.setAttribute("aria-expanded", String(ab));
    lancador.classList.toggle("is-active", ab);
    if (ab) $("#globalAiChatInput").focus();
  };
  lancador.onclick = () => abrir(!chat.classList.contains("is-open"));
  $("#globalAiChatClose").onclick = () => abrir(false);

  $("#globalAiChatForm").onsubmit = async ev => {
    ev.preventDefault();
    const campo = $("#globalAiChatInput");
    const texto = campo.value.trim();
    if (!texto) return;
    dizer(texto, "user");
    state.conversa.push({papel:"user", texto});
    campo.value = "";
    campo.disabled = true;
    orb()?.setAttribute("state", "thinking");
    $("#globalAiChatStatus").lastElementChild.textContent = "Consultando os dados desta loja...";

    try {
      const r = await api.perguntar(texto, state.estabelecimentoId, state.conversa.slice(0, -1));
      dizer(r.resposta, "assistant");
      state.conversa.push({papel:"assistant", texto:r.resposta});
    } catch (erro){
      if (erro instanceof ErroApi && erro.semSessao) return mostrarLogin("Sua sessão expirou. Entre de novo.", "erro");
      const motivo = erro instanceof ErroApi && erro.status === 503
        ? "O assistente não está configurado neste servidor (falta a chave da OpenRouter)."
        : "Não consegui responder agora. Tente de novo em instantes.";
      dizer(motivo, "assistant");
      aviso("O assistente não respondeu", "erro", {detalhe: motivo});
    } finally {
      orb()?.setAttribute("state", "idle");
      $("#globalAiChatStatus").lastElementChild.textContent = "Pronta para responder sobre esta tela";
      campo.disabled = false;
      campo.focus();
    }
  };
  $("#globalAiChatInput").onkeydown = ev => {
    if (ev.key === "Enter" && !ev.shiftKey){ ev.preventDefault(); $("#globalAiChatForm").requestSubmit(); }
  };
}
function saudarAssistente(){
  $("#globalAiChatMessages").innerHTML = "";
  state.conversa = [];
  dizer(pode("ver_financeiro")
    ? "Pergunte sobre o retorno, o teto de cortesia, os carregadores ou os clientes desta loja."
    : "Pergunte sobre as recargas, os carregadores e os clientes. O financeiro é com o gerente.",
    "assistant");
}


/* ==========================================================================
   Ditar em vez de digitar

   Grava no navegador e transcreve no servidor. A primeira versão usava o
   reconhecimento de fala do próprio navegador — grátis e instantâneo, mas só
   Chrome e derivados têm, cada um conversa com um serviço diferente, e quando
   esse serviço não responde a API fica muda: nem `onstart`, nem `onerror`,
   nada. Era o que travava o botão em "Abrindo..." sem explicação possível.

   `MediaRecorder` existe em Chrome, Edge, Opera, Firefox e Safari há anos, e
   o que ele produz é um arquivo — ou grava, ou dá erro. A transcrição passou
   a sair do mesmo lugar de onde já sai o resto do assistente.

   O áudio é convertido para WAV 16 kHz mono aqui mesmo: é o formato que o
   modelo aceita, e reamostrar antes de subir corta o arquivo para um terço
   sem perder nada da fala.
   ========================================================================== */
const GRAVACAO_MAXIMA = 60000;      // um minuto: o suficiente para uma pergunta

/* WAV de 16 bits a partir das amostras já reamostradas. São 44 bytes de
   cabeçalho e os dados crus — não vale trazer biblioteca para isso. */
function paraWav(amostras, taxa){
  const buffer = new ArrayBuffer(44 + amostras.length * 2);
  const v = new DataView(buffer);
  const texto = (pos, txt) => [...txt].forEach((c, i) => v.setUint8(pos + i, c.charCodeAt(0)));
  texto(0, "RIFF");
  v.setUint32(4, 36 + amostras.length * 2, true);
  texto(8, "WAVEfmt ");
  v.setUint32(16, 16, true);          // tamanho do bloco fmt
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // mono
  v.setUint32(24, taxa, true);
  v.setUint32(28, taxa * 2, true);    // bytes por segundo
  v.setUint16(32, 2, true);           // alinhamento
  v.setUint16(34, 16, true);          // bits por amostra
  texto(36, "data");
  v.setUint32(40, amostras.length * 2, true);
  amostras.forEach((a, i) => {
    const n = Math.max(-1, Math.min(1, a));
    v.setInt16(44 + i * 2, n < 0 ? n * 0x8000 : n * 0x7fff, true);
  });
  return buffer;
}

/* Mistura os canais e reamostra para 16 kHz — taxa de fala, um terço do
   tamanho de 48 kHz e nenhuma perda que importe para voz. */
async function prepararAudio(blob){
  const contexto = new (window.AudioContext || window.webkitAudioContext)();
  const decodificado = await contexto.decodeAudioData(await blob.arrayBuffer());
  const canais = Array.from({length: decodificado.numberOfChannels},
                            (_, i) => decodificado.getChannelData(i));
  const mono = canais.length === 1 ? canais[0]
    : canais[0].map((_, i) => canais.reduce((soma, c) => soma + c[i], 0) / canais.length);

  const destino = 16000;
  const passo = decodificado.sampleRate / destino;
  const saida = new Float32Array(Math.floor(mono.length / passo));
  for (let i = 0; i < saida.length; i++) saida[i] = mono[Math.floor(i * passo)];
  contexto.close();

  const bytes = new Uint8Array(paraWav(saida, destino));
  let bruto = "";
  // em pedaços: String.fromCharCode com centenas de milhares de argumentos
  // estoura a pilha de chamada
  for (let i = 0; i < bytes.length; i += 8192){
    bruto += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return {base64: btoa(bruto), segundos: saida.length / destino};
}

function initVoz(){
  const botao = $("#globalAiChatAudio");
  const campo = $("#globalAiChatInput");
  const status = $("#globalAiChatStatus");
  const temGravador = typeof MediaRecorder !== "undefined"
                   && Boolean(navigator.mediaDevices?.getUserMedia);
  if (!botao || !temGravador) return;      // sem gravador, sem botão
  botao.hidden = false;

  let gravador = null, faixa = null, pedacos = [], relogio = null, contador = null;

  const dizerStatus = (texto, estado = "") => {
    status.classList.remove("is-recording", "is-processing", "is-error");
    if (estado) status.classList.add(estado);
    status.lastElementChild.textContent = texto;
  };
  const pintarBotao = (estado, rotulo) => {
    botao.classList.toggle("is-recording", estado === "gravando");
    botao.classList.toggle("is-processing", estado === "abrindo" || estado === "enviando");
    botao.disabled = estado === "enviando";
    botao.setAttribute("aria-pressed", String(estado === "gravando"));
    $("span", botao).textContent = rotulo;
  };
  /* Volta ao repouso e solta o microfone aconteça o que acontecer. Botão
     travado num estado intermediário é pior que botão que falha. */
  const soltar = (texto, estado = "", aviso_ = null) => {
    clearTimeout(relogio); clearInterval(contador);
    relogio = contador = null;
    faixa?.getTracks().forEach(t => t.stop());
    faixa = null; gravador = null; pedacos = [];
    pintarBotao("", "Áudio");
    if (texto) dizerStatus(texto, estado);
    if (aviso_) aviso(aviso_.titulo, "erro", {detalhe: aviso_.detalhe, vida: 12000});
  };

  const AJUDA_DESBLOQUEIO = "Clique no cadeado ao lado do endereço, ponha "
    + "Microfone em Permitir e recarregue a página.";

  function explicarFalhaDoMicrofone(erro){
    const nome = erro?.name || "";
    if (nome === "NotAllowedError" || nome === "SecurityError")
      return {titulo: "O microfone está bloqueado", detalhe: AJUDA_DESBLOQUEIO};
    if (nome === "NotFoundError" || nome === "DevicesNotFoundError")
      return {titulo: "Nenhum microfone encontrado",
              detalhe: "Este computador não tem microfone disponível, ou ele está "
                     + "desativado nas configurações do sistema."};
    if (nome === "NotReadableError" || nome === "TrackStartError")
      return {titulo: "O microfone está ocupado",
              detalhe: "Outro programa está usando o microfone. Feche-o e tente de novo."};
    return {titulo: "Não consegui abrir o microfone",
            detalhe: `${nome || "erro"}: ${erro?.message || ""}`.trim()};
  }

  async function comecar(){
    pintarBotao("abrindo", "Abrindo...");
    dizerStatus("Abrindo o microfone — aceite o pedido do navegador.", "is-processing");
    try {
      faixa = await navigator.mediaDevices.getUserMedia({audio: true});
    } catch (erro){
      const motivo = explicarFalhaDoMicrofone(erro);
      return soltar(motivo.titulo + ".", "is-error", motivo);
    }

    // cada navegador prefere um contêiner; o primeiro que ele aceitar serve,
    // porque a conversão para WAV acontece depois de qualquer jeito
    const tipo = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
      .find(t => MediaRecorder.isTypeSupported?.(t));
    try {
      gravador = new MediaRecorder(faixa, tipo ? {mimeType: tipo} : undefined);
    } catch (erro){
      return soltar("Este navegador não conseguiu gravar.", "is-error",
                    {titulo: "Não consegui gravar",
                     detalhe: `${erro?.name || "erro"}: ${erro?.message || ""}`.trim()});
    }

    pedacos = [];
    gravador.ondataavailable = ev => { if (ev.data?.size) pedacos.push(ev.data); };
    gravador.onerror = ev => soltar("A gravação falhou.", "is-error",
      {titulo: "A gravação falhou", detalhe: ev?.error?.message || "erro do gravador"});
    gravador.onstop = enviar;
    gravador.start();

    const inicio = Date.now();
    pintarBotao("gravando", "Parar");
    dizerStatus("Gravando... clique em Parar quando terminar.", "is-recording");
    contador = setInterval(() => {
      const seg = Math.round((Date.now() - inicio) / 1000);
      $("span", botao).textContent = `Parar ${seg}s`;
    }, 500);
    // não deixa uma gravação esquecida virar um arquivo gigante
    relogio = setTimeout(() => { if (gravador?.state === "recording") gravador.stop(); },
                         GRAVACAO_MAXIMA);
  }

  async function enviar(){
    clearTimeout(relogio); clearInterval(contador);
    relogio = contador = null;
    faixa?.getTracks().forEach(t => t.stop());
    faixa = null;

    const blob = new Blob(pedacos, {type: pedacos[0]?.type || "audio/webm"});
    pedacos = [];
    if (blob.size < 1200){
      return soltar("Não ouvi nada. Fale mais perto do microfone.", "is-error");
    }

    pintarBotao("enviando", "Transcrevendo...");
    dizerStatus("Transcrevendo o que você falou...", "is-processing");
    try {
      const {base64, segundos} = await prepararAudio(blob);
      if (segundos < 0.4) return soltar("Gravação curta demais.", "is-error");
      const r = await api.transcrever(base64);
      const texto = (r.texto || "").trim();
      if (!texto){
        return soltar("Não entendi o que foi falado. Tente de novo.", "is-error");
      }
      campo.value = (campo.value.trim() ? campo.value.trim() + " " : "") + texto;
      campo.focus();
      campo.setSelectionRange(campo.value.length, campo.value.length);
      soltar("Confira o texto e envie — dá para corrigir antes.", "");
    } catch (erro){
      if (erro instanceof ErroApi && erro.semSessao){
        soltar("");
        return mostrarLogin("Sua sessão expirou. Entre de novo.", "erro");
      }
      soltar("Não consegui transcrever.", "is-error", {
        titulo: "Não consegui transcrever",
        detalhe: erro instanceof ErroApi ? erro.message
               : "Falha ao preparar o áudio neste navegador.",
      });
    }
  }

  botao.onclick = () => {
    if (gravador?.state === "recording") return gravador.stop();   // onstop chama enviar
    if (!gravador) comecar();
  };

  // fechar o chat com o microfone aberto deixaria ele gravando às escondidas
  $("#globalAiChatClose").addEventListener("click", () => {
    if (gravador?.state === "recording"){ gravador.onstop = null; gravador.stop(); }
    soltar("");
  });
}

/* A barra do topo é atalho para o mesmo chat: manda a pergunta e abre a
   conversa já esperando a resposta, em vez de ser uma segunda IA. */
function initBarraDeComando(){
  const form = $("#globalAiCommandForm"), campo = $("#globalAiCommandInput");
  if (!form) return;
  form.hidden = false;
  form.onsubmit = ev => {
    ev.preventDefault();
    const texto = campo.value.trim();
    if (!texto) return;
    campo.value = "";
    campo.blur();
    abrirChat(true);
    $("#globalAiChatInput").value = texto;
    $("#globalAiChatForm").requestSubmit();
  };
}

/* ==========================================================================
   perfil, configurações e atualização automática
   ========================================================================== */
/* A foto vive dentro de `usuarios.preferencias`, como data URI de 128px. Não
   é o ideal para um produto grande — imagem em banco não escala —, mas evita
   inventar armazenamento de arquivo só para um avatar, e o corte no navegador
   garante que o que chega ao servidor já é pequeno. */
function pintarAvatar(no, u){
  if (!no) return;
  const foto = state.prefs?.foto;
  if (foto){
    no.innerHTML = `<img src="${esc(foto)}" alt="">`;
    no.classList.add("tem-foto");
  } else {
    no.textContent = iniciais(u?.nome);
    no.classList.remove("tem-foto");
  }
}

let perfilCarregado = null;

async function renderPerfil(){
  const alvo = $("#profileDetails");
  if (!alvo) return;
  alvo.innerHTML = `<div class="table-inline-state"><div><strong>Carregando...</strong></div></div>`;
  try {
    perfilCarregado = await api.perfil();
  } catch (erro){ return avisarErro(erro, "carregar o perfil"); }

  const u = perfilCarregado.usuario;
  const papel = {main:"Desenvolvedor", gerente:"Gerente", operador:"Operador"}[u.papel] || u.papel;
  $("#profilePanelName").textContent = u.nome;
  $("#profilePanelMeta").textContent = `${papel} · ${u.email}`;
  pintarAvatar($("#profileAvatarLarge"), u);

  const linha = (rotulo, valor) => `<dt>${esc(rotulo)}</dt><dd>${valor}</dd>`;
  const lojas = perfilCarregado.estabelecimentos;
  alvo.innerHTML = [
    linha("Papel", esc(papel)),
    linha("E-mail", esc(u.email)),
    linha(lojas.length > 1 ? "Estabelecimentos" : "Estabelecimento",
          lojas.map(l => esc(l.nome)).join("<br>") || "<span class='table-cell-muted'>nenhum</span>"),
    linha("Último acesso", dataHora(u.ultimo_acesso)),
    linha("Conta criada em", dataHora(u.criado_em)),
    linha("Sessões abertas", `${perfilCarregado.sessoes_abertas}`),
    linha("Pode editar dados", pode("editar_dados") ? "sim" : "não"),
    linha("Vê o financeiro", pode("ver_financeiro") ? "sim" : "não"),
    linha("Troca de estabelecimento", pode("trocar_estabelecimento") ? "sim" : "não"),
  ].join("");

  const n = perfilCarregado.sessoes_abertas;
  $("#profileSessoesTexto").textContent = n > 1
    ? `Você tem ${n} sessões abertas. Encerrar derruba as outras e mantém esta.`
    : "Esta é a sua única sessão aberta.";
  $("#profileEncerrarOutras").disabled = n <= 1;
}

function statusPerfil(no, texto, tipo = ""){
  const el = $(no);
  el.textContent = texto;
  el.classList.toggle("is-error", tipo === "erro");
  el.classList.toggle("is-ok", tipo === "ok");
}

/* Redesenha a imagem num canvas de 128px, cortada em quadrado pelo centro.
   Enviar o arquivo original encheria a coluna jsonb com megabytes. */
function reduzirImagem(arquivo, lado = 128){
  return new Promise((ok, falha) => {
    const leitor = new FileReader();
    leitor.onerror = () => falha(new Error("não consegui ler o arquivo"));
    leitor.onload = () => {
      const img = new Image();
      img.onerror = () => falha(new Error("arquivo não é uma imagem válida"));
      img.onload = () => {
        const corte = Math.min(img.width, img.height);
        const tela = document.createElement("canvas");
        tela.width = tela.height = lado;
        tela.getContext("2d").drawImage(
          img, (img.width - corte) / 2, (img.height - corte) / 2, corte, corte, 0, 0, lado, lado);
        ok(tela.toDataURL("image/webp", 0.82));
      };
      img.src = leitor.result;
    };
    leitor.readAsDataURL(arquivo);
  });
}

function initPerfil(){
  const modal = $("#profileSettingsModal");
  const abrir = ab => {
    modal.classList.toggle("is-open", ab);
    modal.setAttribute("aria-hidden", String(!ab));
    if (ab){
      statusPerfil("#profileSettingsStatus", "");
      $("#novoNome").value = state.usuario?.nome || "";
    }
  };
  $("#profileSettingsButton").onclick = () => abrir(true);
  $("#profileSettingsClose").onclick = () => abrir(false);
  modal.onclick = ev => { if (ev.target === modal) abrir(false); };

  // sanfonas do modal, como na referência
  $$("[data-collapse-toggle]", modal).forEach(b => b.onclick = () => {
    const cartao = b.closest("[data-collapsible]");
    const aberto = cartao.classList.toggle("is-open");
    b.setAttribute("aria-expanded", String(aberto));
    $(".collapse-icon", b).textContent = aberto ? "−" : "+";
  });

  // ---- nome ----
  $("#formNome").onsubmit = async ev => {
    ev.preventDefault();
    const botao = $("button[type=submit]", ev.target);
    botao.disabled = true;
    try {
      const r = await comAviso("Salvando nome...",
        () => api.trocarNome($("#novoNome").value.trim(), $("#nomeSenhaAtual").value),
        {sucesso: "Nome atualizado", detalhe: n => "" });
      state.usuario.nome = r.nome;
      $("#nomeSenhaAtual").value = "";
      aplicarPapel();
      renderPerfil();
      statusPerfil("#profileSettingsStatus", `Agora você aparece como ${r.nome}.`, "ok");
    } catch (erro){
      statusPerfil("#profileSettingsStatus", erro.message || "Não consegui salvar.", "erro");
    } finally { botao.disabled = false; }
  };

  // ---- senha ----
  $("#formSenha").onsubmit = async ev => {
    ev.preventDefault();
    const nova = $("#senhaNova").value;
    if (nova !== $("#senhaConfirma").value){
      statusPerfil("#profileSettingsStatus", "As duas senhas novas não batem.", "erro");
      return;
    }
    const botao = $("button[type=submit]", ev.target);
    botao.disabled = true;
    try {
      const r = await comAviso("Trocando senha...",
        () => api.trocarSenha($("#senhaAtual").value, nova),
        {sucesso: "Senha trocada",
         detalhe: "Use a nova na próxima vez que entrar."});
      ev.target.reset();
      renderPerfil();
      statusPerfil("#profileSettingsStatus",
        r.outras_sessoes_encerradas
          ? `Senha trocada. ${r.outras_sessoes_encerradas} outra(s) sessão(ões) encerrada(s).`
          : "Senha trocada.", "ok");
    } catch (erro){
      statusPerfil("#profileSettingsStatus", erro.message || "Não consegui trocar.", "erro");
    } finally { botao.disabled = false; }
  };

  // ---- foto ----
  let fotoNova = null;
  $("#fotoArquivo").onchange = async ev => {
    const arquivo = ev.target.files?.[0];
    if (!arquivo) return;
    try {
      fotoNova = await reduzirImagem(arquivo);
      $("#fotoPreviaImg").src = fotoNova;
      $("#fotoPrevia").hidden = false;
      $("#fotoAplicar").disabled = false;
      statusPerfil("#profileSettingsStatus", "");
    } catch (erro){
      statusPerfil("#profileSettingsStatus", erro.message, "erro");
    }
  };
  $("#formFoto").onsubmit = async ev => {
    ev.preventDefault();
    if (!fotoNova) return;
    const antes = state.prefs.foto;
    state.prefs.foto = fotoNova;
    if (await guardarFoto("Enviando foto...", "Foto de perfil atualizada")){
      statusPerfil("#profileSettingsStatus", "Foto aplicada.", "ok");
    } else {
      state.prefs.foto = antes;   // devolve o que estava, já que não gravou
      pintarAvatar($("#profileAvatar"), state.usuario);
      pintarAvatar($("#profileAvatarLarge"), state.usuario);
    }
  };
  $("#fotoRemover").onclick = async () => {
    const antes = state.prefs.foto;
    if (!antes){ statusPerfil("#profileSettingsStatus", "Você ainda não tem foto.", ""); return; }
    delete state.prefs.foto;
    fotoNova = null;
    $("#fotoPrevia").hidden = true;
    $("#fotoArquivo").value = "";
    $("#fotoAplicar").disabled = true;
    if (await guardarFoto("Removendo foto...", "Foto removida")){
      statusPerfil("#profileSettingsStatus", "Voltou para as suas iniciais.", "ok");
    } else {
      state.prefs.foto = antes;
    }
  };
  async function guardarFoto(rotulo, sucesso){
    pintarAvatar($("#profileAvatar"), state.usuario);
    pintarAvatar($("#profileAvatarLarge"), state.usuario);
    try {
      await comAviso(rotulo, () => api.preferencias(state.prefs),
        {sucesso, detalhe: "Vale em qualquer computador onde você entrar."});
      return true;
    } catch { return false; }
  }

  // ---- atualização automática ----
  const rotuloIntervalo = ms => ({60000:"1 min", 300000:"5 min",
                                   900000:"15 min", 1800000:"30 min"}[ms] || `${ms/60000} min`);
  $("#autoRefreshEnabled").onchange = ev => {
    state.prefs.autoRefresh = ev.target.checked;
    $("#autoRefreshIntervalField").hidden = !ev.target.checked;
    aplicarAutoRefresh();
    salvarPrefs();
    aviso(ev.target.checked ? "Atualização automática ligada" : "Atualização automática desligada",
          "ok", {detalhe: ev.target.checked
            ? `Os dados serão buscados a cada ${rotuloIntervalo(Number(state.prefs.autoRefreshMs) || 300000)}.`
            : "Os números só mudam quando você atualizar."});
  };
  $("#autoRefreshInterval").onchange = ev => {
    state.prefs.autoRefreshMs = Number(ev.target.value);
    aplicarAutoRefresh();
    salvarPrefs();
    aviso("Intervalo alterado", "ok", {detalhe: `Agora a cada ${rotuloIntervalo(Number(ev.target.value))}.`});
  };

  // ---- encerrar outras sessões ----
  $("#profileEncerrarOutras").onclick = async () => {
    statusPerfil("#profileStatus", "Para encerrar as outras, troque a senha em Configurações — "
      + "é o que garante que quem está do outro lado não volte a entrar.", "");
    $("#profileSettingsButton").click();
  };
}

/* Atualização automática: busca os dados de novo sem recarregar a página.
   Não roda com a aba escondida — atualizar o que ninguém está olhando só
   gasta o plano gratuito do servidor. */
let relogioAuto = null;
function aplicarAutoRefresh(){
  clearInterval(relogioAuto);
  relogioAuto = null;
  const ligado = Boolean(state.prefs.autoRefresh);
  const intervalo = Number(state.prefs.autoRefreshMs) || 300000;
  const campo = $("#autoRefreshEnabled");
  if (campo){
    campo.checked = ligado;
    $("#autoRefreshIntervalField").hidden = !ligado;
    $("#autoRefreshInterval").value = String(intervalo);
  }
  if (!ligado) return;
  relogioAuto = setInterval(async () => {
    if (document.hidden || state.paineis.editando || editorCtx) return;
    try { await carregarDados(); renderTudo(); }
    catch (erro){ if (erro instanceof ErroApi && erro.semSessao) mostrarLogin("Sua sessão expirou."); }
  }, intervalo);
}

/* ==========================================================================
   dados
   ========================================================================== */
async function carregarDados(){
  Object.assign(state.dados, await api.dados(state.estabelecimentoId));
}
/* ==========================================================================
   arranque
   ========================================================================== */
const tour = createTourModule({
  state, setSection, canAccessSection, isCompactViewport,
  setSidebarCollapsed, syncSidebarGroupToggle, waitForNextPaint,
});

function renderTudo(){
  renderSecaoAtual();
}

function esconderCarregando(){
  const tela = $("#dashboardLoadingScreen");
  if (!tela) return;
  tela.setAttribute("aria-hidden","true");
  tela.style.display = "none";
}

/* Entra de fato: guarda quem é, aplica papel, busca dados, restaura a tela. */
async function entrarNoPainel(sessao){
  state.usuario = sessao.usuario;
  state.permissoes = sessao.permissoes || {};
  state.secoesBloqueadas = new Set(sessao.secoes_bloqueadas || []);
  state.dados.estabelecimentos = sessao.estabelecimentos || [];
  document.body.classList.remove("sem-sessao");

  aplicarPrefs(sessao.usuario.preferencias);
  aplicarPapel();

  const lojas = state.dados.estabelecimentos;
  const preferida = state.prefs.estabelecimento;
  state.estabelecimentoId = lojas.some(l => l.id === preferida) ? preferida : lojas[0]?.id ?? null;
  if (!state.estabelecimentoId){
    // erro de verdade, para o login mostrar em vez de abrir um painel vazio
    throw new ErroApi(409, "Seu usuário não está ligado a nenhuma loja. "
                         + "Peça ao gerente para vincular seu acesso.");
  }
  state.paineis.ativo = state.prefs.painelAtivo?.[state.estabelecimentoId] ?? null;

  await carregarDados();
  renderEstabelecimentos();
  saudarAssistente();

  aplicarAutoRefresh();
  const secao = state.prefs.secao;
  setSection(SECOES[secao] && podeVer(secao) ? secao : "painel");
  renderTudo();

  document.body.classList.remove("primary-loading");
  esconderCarregando();
}

function ligarPainelUI(){
  $("#dashboardManagerToggle").onclick = () =>
    state.paineis.menuAberto ? fecharMenuPaineis() : abrirMenuPaineis();
  // O menu inteiro engole o clique. Sem isto, um clique dentro dele que
  // redesenha a lista (como "Novo painel") desconecta o alvo do documento, e
  // o fechamento por clique-fora entende que o clique veio de fora.
  $("#dashboardWorkspacesMenu").addEventListener("click", ev => ev.stopPropagation());
  $("#dashboardManagerPanel").addEventListener("click", ev => ev.stopPropagation());
  document.addEventListener("click", ev => {
    if (state.paineis.menuAberto && !$("#dashboardManagerToggle").contains(ev.target)) fecharMenuPaineis();
  });

  $("[data-dashboard-layout-close]").onclick = () => {
    sairDaEdicao(); renderPainel();
    aviso("Edição concluída", "ok", {detalhe: "O layout já está gravado.", vida: 2600});
  };
  $("[data-dashboard-layout-reset]").onclick = () => {
    const p = painelAtual(); if (!p || !podeEditarPainel(p)) return;
    guardarLayout(p, layoutPadrao()); renderPainel();
  };
  $("#dashboardManagerEditbarTitleInput").onchange = async ev => {
    const p = painelAtual(); if (!p || !podeEditarPainel(p)) return;
    const nome = ev.target.value.trim() || "Painel";
    if (nome === p.nome) return;
    try {
      await comAviso("Renomeando...", () => api.alterarPainel(p.id, {nome}),
        {sucesso: "Painel renomeado", detalhe: nome});
      p.nome = nome; renderWorkspaces();
    } catch { ev.target.value = p.nome; }
  };
  $("#dashboardLibraryFab").onclick = abrirBiblioteca;
  $$("[data-dashboard-library-close]").forEach(b => b.onclick = fecharBiblioteca);
}

async function iniciar(){
  initTema();
  initSidebar();
  initLogin();
  initLogout();
  initAssistente();
  initVoz();
  initBarraDeComando();
  initPerfil();
  ligarPainelUI();

  $("#editorClose").onclick = fecharEditor;
  $("#editorClear").onclick = () => {
    const s = editorCtx?.secao;
    if (s) ui(s).selecionados.clear();
    fecharEditor();
    if (s) renderTabela(s);
  };
  $("#editorDelete").onclick = excluirEditor;
  $("#editorForm").onsubmit = salvarEditor;

  tour.bindEvents();
  $("#tourLaunchButton").onclick = () => tour.open();

  addEventListener("keydown", ev => {
    if (ev.key !== "Escape") return;
    if (state.paineis.bibliotecaAberta) return fecharBiblioteca();
    if (state.paineis.menuAberto) return fecharMenuPaineis();
    if (state.paineis.editando) { sairDaEdicao(); return renderPainel(); }
    fecharEditor();
  });

  // Restos de versões antigas que guardavam painel no navegador; sem eles
  // uma pessoa poderia ficar presa vendo dado que não veio do servidor.
  try { localStorage.removeItem("pr.demo.paineis"); localStorage.removeItem("pr.prefs"); } catch {}

  try {
    await entrarNoPainel(await api.eu());
  } catch (erro){
    // 401 é o caso normal de quem ainda não entrou: login limpo, sem alarme.
    mostrarLogin(erro instanceof ErroApi && erro.semSessao ? "" : explicarFalha(erro));
  }
}

iniciar();

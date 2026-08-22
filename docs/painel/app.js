/* ==========================================================================
   Praça de Recarga — painel do lojista

   O CSS, o tour e a esfera de IA vêm do painel de referência sem alteração;
   o que é nosso é o conteúdo e as regras.

   Três ideias organizam este arquivo:

   1. Papel manda no que aparece. `state.permissoes` vem do servidor, e a
      tela só reflete. O servidor confere de novo em toda escrita — esconder
      botão é conforto, não tranca.
   2. O que a pessoa arruma fica no banco. Layout dos cards com tamanho,
      tema, barra lateral, seção aberta, busca de cada tabela. Entrar em
      outro computador tem que devolver a mesma tela.
   3. Sem servidor, vira demonstração. O GitHub Pages não executa Python;
      nesse caso o painel lê o dados.json e avisa que está em demonstração,
      em vez de mostrar erro.
   ========================================================================== */

import "./static/js/aiEntity.js";
import { createTourModule } from "./static/js/tour.js";
import { api, ErroApi } from "./api.js";

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
  demo: false,
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
const CARDS = {
  retorno:  {t:"Lucro atribuído × custo", g:"Retorno",  tam:"large", cols:11, rows:4, financeiro:true},
  teto:     {t:"Teto de cortesia",        g:"Retorno",  tam:"large", cols:9,  rows:4, financeiro:true},
  horas:    {t:"Sessões por hora",        g:"Operação", tam:"large", cols:11, rows:4},
  pontos:   {t:"Carregadores",            g:"Operação", tam:"large", cols:9,  rows:4},
  previsao: {t:"Erro da previsão",        g:"Operação", tam:"large", cols:9,  rows:4},
  lucro:    {t:"Lucro atribuído",         g:"Retorno",  tam:"small", cols:5,  rows:2, financeiro:true},
  vendas:   {t:"Vendas atribuídas",       g:"Retorno",  tam:"small", cols:5,  rows:2, financeiro:true},
  sessoes:  {t:"Sessões no período",      g:"Operação", tam:"small", cols:5,  rows:2},
  clientes: {t:"Clientes únicos",         g:"Público",  tam:"small", cols:5,  rows:2},
  energia:  {t:"Energia entregue",        g:"Operação", tam:"small", cols:5,  rows:2},
  ticket:   {t:"Ticket de quem carrega",  g:"Público",  tam:"small", cols:5,  rows:2, financeiro:true},
  cupons:   {t:"Cupons usados",           g:"Público",  tam:"small", cols:5,  rows:2},
};
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
      cols: clamp(Number(c.cols) || CARDS[c.id].cols, MIN_COLS, COLUNAS),
      rows: clamp(Number(c.rows) || CARDS[c.id].rows, MIN_ROWS, MAX_ROWS),
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
  };
  if (state.demo){ gravar("pr.prefs", state.prefs); return; }
  // uma escrita por rajada: arrastar card dispara muitas mudanças seguidas
  clearTimeout(prefsPendentes);
  prefsPendentes = setTimeout(() => api.preferencias(state.prefs).catch(() => {}), 600);
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
function toast(msg, tipo = "success"){
  const el = document.createElement("div");
  el.className = `toast is-${tipo}`;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  $("#toastStack").append(el);
  setTimeout(() => { el.classList.add("is-leaving"); setTimeout(() => el.remove(), 400); }, 3600);
}
/* Erro do servidor vira frase, e sessão caída volta para o login em vez de
   deixar a pessoa clicando em algo que não vai funcionar. */
function avisarErro(erro, oQue){
  if (erro instanceof ErroApi && erro.semSessao){ mostrarLogin("Sua sessão expirou. Entre de novo."); return; }
  toast(erro instanceof ErroApi ? erro.message : `Não consegui ${oQue}.`, "error");
  console.error(oQue, erro);
}

/* ==========================================================================
   login e logout
   ========================================================================== */
function mostrarLogin(mensagem = ""){
  state.usuario = null;
  document.body.classList.add("sem-sessao");
  document.body.classList.remove("primary-loading");
  esconderCarregando();
  const porta = $("#loginGate");
  porta.hidden = false;
  const st = $("#loginStatus");
  st.textContent = mensagem;
  st.classList.toggle("is-error", Boolean(mensagem));
  $("#loginEmail").focus();
}
function initLogin(){
  const form = $("#loginForm"), botao = $("#loginButton"), st = $("#loginStatus");
  $("#loginSenhaToggle").onclick = () => {
    const campo = $("#loginSenha");
    const vendo = campo.type === "text";
    campo.type = vendo ? "password" : "text";
    $("#loginSenhaToggle").setAttribute("aria-label", vendo ? "Mostrar senha" : "Ocultar senha");
    campo.focus();
  };
  form.onsubmit = async ev => {
    ev.preventDefault();
    botao.disabled = true;
    st.classList.remove("is-error");
    st.textContent = "Entrando...";
    try {
      const sessao = await api.entrar($("#loginEmail").value.trim(), $("#loginSenha").value);
      $("#loginSenha").value = "";
      st.textContent = "";
      $("#loginGate").hidden = true;
      await entrarNoPainel(sessao);
    } catch (erro){
      st.classList.add("is-error");
      st.textContent = erro instanceof ErroApi && erro.semRede
        ? "O servidor não respondeu. Rode a API em api/main.py."
        : (erro.message || "Não consegui entrar.");
    } finally {
      botao.disabled = false;
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
    if (state.demo){ toast("Em demonstração não existe sessão para encerrar."); return; }
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
    mostrarLogin("Sessão encerrada.");
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
  $("#collapsedProfileMenuProfile").onclick = () => { abrirMenu(false); setSection("estabelecimentos"); };
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
  await carregarDados();
  renderEstabelecimentos();
  renderTudo();
  salvarPrefs();
  toast(`Agora vendo ${loja().nome}.`);
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
  $("#profileName").textContent = u?.nome || "Demonstração";
  $("#profileAvatar").textContent = iniciais(u?.nome || "Demo");
  const rotulo = {main:"Desenvolvedor", gerente:"Gerente", operador:"Operador"}[u?.papel] || "Demonstração";
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
  const podeCriar = cfg?.novo && pode("editar_dados") && !state.demo
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
  // coluna marcada com `so` só existe para quem tem aquela permissão
  const cfg = {...cfg0, colunas: cfg0.colunas.filter(c => !c.so || pode(c.so))};
  const alvo = $(`#screen-${secao}`);
  if (!alvo) return;
  const todas = cfg.linhas();
  const termo = u.busca.trim().toLowerCase();
  const filtradas = termo ? todas.filter(l => JSON.stringify(l).toLowerCase().includes(termo)) : todas;
  const linhas = ordenar(filtradas, cfg, u.ordem ?? cfg.ordemPadrao ?? null);
  const marcadas = linhas.filter(l => u.selecionados.has(l.id)).length;
  const editavel = Boolean(cfg.campos) && pode("editar_dados") && !state.demo
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
      <span>${state.demo
        ? "Modo demonstração: os dados são de exemplo e não podem ser alterados."
        : "Seu papel vê estes registros, mas não altera. Quem edita é o gerente."}</span>
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
    await carregarDados(); renderTudo(); toast("Dados atualizados.");
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
  if (!cfg?.campos || !pode("editar_dados") || state.demo) return fecharEditor();
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
  botao.disabled = true;
  try {
    if (!ids.length){
      const criado = await api.criar(tabela, {...campos, estabelecimento_id: state.estabelecimentoId});
      await carregarDados();
      ui(secao).selecionados.clear();
      ui(secao).selecionados.add(criado.id);
      renderTudo();
      abrirEditorSelecao(secao);
      toast("Registro criado.");
    } else {
      for (const id of ids) await api.alterar(tabela, id, campos);
      await carregarDados();
      renderTudo();
      abrirEditorSelecao(secao);
      toast(ids.length > 1 ? `${ids.length} registros salvos.` : "Alterações salvas.");
    }
  } catch (erro){
    avisarErro(erro, "salvar");
  } finally {
    botao.disabled = false;
  }
}
async function excluirEditor(){
  if (!editorCtx?.ids.length) return;
  const {secao, ids} = editorCtx, tabela = SECOES[secao].tabela;
  const botao = $("#editorDelete");
  botao.disabled = true;
  try {
    for (const id of ids) await api.excluir(tabela, id);
    ui(secao).selecionados.clear();
    fecharEditor();
    await carregarDados();
    renderTudo();
    toast(`${ids.length} registro(s) excluído(s).`);
  } catch (erro){
    avisarErro(erro, "excluir");
  } finally {
    botao.disabled = false;
  }
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
  if (!p || state.demo) return Boolean(p) && state.demo;
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
      ${corpoCard(c.id)}
      <button class="card-resize-handle" type="button" data-redimensionar="${c.id}"
              aria-label="Redimensionar ${esc(CARDS[c.id].t)}">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M15 9v6H9v-2h4V9h2ZM7 11v2H5v-2h2Zm4-4v2H9V7h2Z"/></svg>
      </button>
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
  if (state.demo){ gravar("pr.demo.paineis", state.dados.paineis); return; }
  clearTimeout(gravacaoPendente);
  gravacaoPendente = setTimeout(() => {
    api.alterarPainel(p.id, {cards}).catch(erro => avisarErro(erro, "salvar o layout"));
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
    toast(`${CARDS[id].t} saiu do painel.`);
  });
}

/* Arrastar o canto do card muda quantas colunas e linhas ele ocupa. A conta
   converte pixel em célula da grade de 20 colunas, e não o contrário — assim
   o card sempre pousa alinhado com os vizinhos. */
function ligarRedimensionar(p, cards){
  $$("#dashboardCanvas [data-redimensionar]").forEach(punho => {
    const card = punho.closest("[data-dashboard-card]");
    const conf = cards.find(c => c.id === card.dataset.dashboardCard);
    if (!conf) return;

    punho.onpointerdown = ev => {
      if (!state.paineis.editando) return;
      ev.preventDefault();
      punho.setPointerCapture(ev.pointerId);
      const grade = card.parentNode;
      const estilo = getComputedStyle(grade);
      const gap = parseFloat(estilo.columnGap) || 18;
      const larguraCol = (grade.clientWidth - gap * (COLUNAS - 1)) / COLUNAS;
      const alturaLinha = parseFloat(estilo.gridAutoRows) || 76;
      const esq = card.getBoundingClientRect().left;
      const topo = card.getBoundingClientRect().top;

      card.classList.add("is-resizing");
      document.body.classList.add("dashboard-card-resizing");
      const medida = document.createElement("span");
      medida.className = "card-resize-medida";
      card.append(medida);

      const mover = e => {
        const cols = clamp(Math.round((e.clientX - esq + gap) / (larguraCol + gap)), MIN_COLS, COLUNAS);
        const rows = clamp(Math.round((e.clientY - topo + gap) / (alturaLinha + gap)), MIN_ROWS, MAX_ROWS);
        conf.cols = cols; conf.rows = rows;
        card.style.gridColumn = `span ${cols}`;
        card.style.gridRow = `span ${rows}`;
        card.style.setProperty("--dashboard-card-col-span", String(cols));
        card.style.setProperty("--dashboard-card-row-span", String(rows));
        medida.textContent = `${cols} × ${rows}`;
      };
      const soltar = () => {
        punho.onpointermove = null; punho.onpointerup = null;
        card.classList.remove("is-resizing");
        document.body.classList.remove("dashboard-card-resizing");
        medida.remove();
        guardarLayout(p, lerCards());
        desenharGraficos();
      };
      punho.onpointermove = mover;
      punho.onpointerup = soltar;
      punho.onpointercancel = soltar;
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
  const podeCriar = !state.demo && (podeCompartilhado || podeParticular);

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
    b.disabled = true;
    try {
      await api.excluirPainel(id);
      if (state.paineis.ativo === id) state.paineis.ativo = null;
      await carregarDados();
      renderPainel();
      toast("Painel excluído.");
    } catch (erro){ avisarErro(erro, "excluir o painel"); b.disabled = false; }
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
        const novo = await api.criarPainel({
          estabelecimento_id: state.estabelecimentoId, nome, compartilhado, cards: layoutPadrao(),
        });
        state.paineis.criando = false;
        state.paineis.ativo = novo.id;
        state.paineis.editando = true;
        await carregarDados();
        fecharMenuPaineis(); renderPainel();
        toast("Painel criado. Monte do jeito que preferir.");
      } catch (erro){ avisarErro(erro, "criar o painel"); botao.disabled = false; }
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
    renderPainel(); toast(`${CARDS[id].t} adicionado.`);
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

function corpoCard(id){
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
    case "teto":     return `<div class="trend-card">
                       ${cabecaCard("Cortesia","Quanto esta loja aguenta dar")}
                       <div id="tetoCard"></div></div>`;
    default: return "";
  }
}

/* ==========================================================================
   gráficos
   ========================================================================== */
const cor = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#8899aa";

function desenharGraficos(){
  const e = loja(), ses = sessoesDaLoja();

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
function initAssistente(){
  const chat = $("#globalAiChat"), lancador = $("#globalAiLauncher");
  lancador.hidden = false;
  const abrir = ab => {
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
      const r = state.demo
        ? {resposta: responderLocal(texto)}
        : await api.perguntar(texto, state.estabelecimentoId, state.conversa.slice(0, -1));
      dizer(r.resposta, "assistant");
      state.conversa.push({papel:"assistant", texto:r.resposta});
    } catch (erro){
      if (erro instanceof ErroApi && erro.semSessao) return mostrarLogin("Sua sessão expirou. Entre de novo.");
      dizer(erro instanceof ErroApi && erro.status === 503
        ? "O assistente não está configurado neste servidor (falta a chave da OpenRouter)."
        : "Não consegui responder agora. Tente de novo em instantes.", "assistant");
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
/* Modo demonstração: sem servidor não há chave, então responde do que está na
   tela. Continua sem inventar número. */
function responderLocal(pergunta){
  const p = pergunta.toLowerCase(), m = metricas(), e = loja();
  const r = tetoCortesia(Number(e.margem_liquida_pct||0), Number(e.ticket_medio_brl||0), Number(e.tarifa_kwh_brl||0.789));
  if (/cortesia|teto|gr[áa]tis/.test(p))
    return r.kwh > 0.4
      ? `Com margem de ${num(e.margem_liquida_pct,1)}% e ticket de ${brl(e.ticket_medio_brl)}, cada visita gera ${brl(r.lucro)}. Tirando ${brl(AMORT)} do equipamento, o teto que se paga é ${num(r.kwh,1)} kWh — cerca de ${Math.round(r.kwh*KM_KWH)} km.`
      : `Aqui a cortesia não se paga: cada visita gera ${brl(r.lucro)}, menos que os ${brl(AMORT)} do equipamento por sessão.`;
  if (/carregador|vaga|ponto|tomada/.test(p)){
    const cs = carregadoresDaLoja();
    return `São ${cs.length} carregadores: ${cs.filter(c=>c.modo==="cortesia").length} em cortesia e ${cs.filter(c=>c.modo==="pago").length} cobrando por kWh.`;
  }
  if (/venda|lucro|retorno|dinheiro/.test(p))
    return `${brl(m.receita)} em vendas com cupom viraram ${brl(m.lucro)} de lucro; a energia custou ${brl(m.custoEnergia)} e o equipamento ${brl(m.custoEquip)} — saldo de ${brl(m.saldo)}.`;
  if (/energia|kwh|consumo/.test(p))
    return `${num(m.energia,0)} kWh em ${m.ses.length} sessões, cerca de ${Math.round(m.energia*KM_KWH)} km devolvidos.`;
  return `Estou em modo demonstração e respondo do que está na tela. Com o servidor no ar, a IA lê o banco e responde qualquer pergunta sobre a loja.`;
}

/* ==========================================================================
   dados
   ========================================================================== */
async function carregarDados(){
  if (state.demo) return carregarDemo();
  const d = await api.dados(state.estabelecimentoId);
  Object.assign(state.dados, d);
}
async function carregarDemo(){
  const r = await fetch(`./dados.json?t=${Date.now()}`);
  const d = await r.json();
  const estabs = d.estabelecimentos || [];
  if (!state.estabelecimentoId) state.estabelecimentoId = estabs[0]?.id ?? null;
  const carregadores = (d.carregadores||[]).filter(c => c.estabelecimento_id === state.estabelecimentoId);
  const ids = new Set(carregadores.map(c => c.id));
  const sessoes = (d.sessoes||[]).filter(s => ids.has(s.carregador_id));
  const sessoesIds = new Set(sessoes.map(s => s.id));
  const salvos = ler("pr.demo.paineis", null);
  state.dados = {
    estabelecimentos: estabs,
    carregadores,
    sessoes,
    clientes: (d.clientes||[]).filter(c => c.estabelecimento_id === state.estabelecimentoId),
    vendas:   (d.vendas||[]).filter(v => v.estabelecimento_id === state.estabelecimentoId),
    cupons:   (d.cupons||[]).filter(c => sessoesIds.has(c.sessao_id)),
    leituras: (d.leituras||[]).filter(l => ids.has(l.carregador_id)),
    paineis:  (salvos || (d.paineis||[]).filter(p => p.estabelecimento_id === state.estabelecimentoId && p.compartilhado)),
    usuarios_da_loja: [],
  };
}

/* ==========================================================================
   arranque
   ========================================================================== */
const tour = createTourModule({
  state, setSection, canAccessSection, isCompactViewport,
  setSidebarCollapsed, syncSidebarGroupToggle, waitForNextPaint,
});

function renderTudo(){
  const meta = (sel, v) => { const n = $(sel); if (n) n.textContent = v || ""; };
  meta("#carregadoresNavMeta", carregadoresDaLoja().length);
  meta("#sessoesNavMeta", sessoesDaLoja().length);
  meta("#clientesNavMeta", daLoja(state.dados.clientes).length);
  meta("#vendasNavMeta", daLoja(state.dados.vendas).length);
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
    toast("Seu usuário não está ligado a nenhuma loja.", "error");
    return;
  }
  state.paineis.ativo = state.prefs.painelAtivo?.[state.estabelecimentoId] ?? null;

  await carregarDados();
  renderEstabelecimentos();
  saudarAssistente();

  const secao = state.prefs.secao;
  setSection(SECOES[secao] && podeVer(secao) ? secao : "painel");
  renderTudo();

  document.body.classList.remove("primary-loading");
  esconderCarregando();
}

/* Sem servidor, o painel vira demonstração em vez de morrer na tela de erro. */
async function entrarEmDemonstracao(){
  state.demo = true;
  state.usuario = {nome:"Demonstração", papel:"gerente"};
  state.permissoes = {trocar_estabelecimento:true, editar_dados:false,
                      ver_financeiro:true, editar_painel_compartilhado:false};
  state.secoesBloqueadas = new Set();
  document.body.classList.remove("sem-sessao");
  $("#loginGate").hidden = true;

  aplicarPrefs(ler("pr.prefs", {}));
  aplicarPapel();
  $("#profileName").textContent = "Demonstração";
  $("#floatingRefreshText").innerHTML = `<span class="perfil-papel">Somente leitura</span>`;

  await carregarDemo();
  renderEstabelecimentos();
  saudarAssistente();

  const faixa = document.createElement("div");
  faixa.className = "faixa-demo";
  faixa.innerHTML = `<span aria-hidden="true">◈</span><span><strong>Modo demonstração.</strong>
    Dados de exemplo, sem login e sem gravação — o servidor da API não respondeu.</span>`;
  $(".main-panel").prepend(faixa);

  setSection("painel");
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
    sairDaEdicao(); renderPainel(); toast("Painel salvo.");
  };
  $("[data-dashboard-layout-reset]").onclick = () => {
    const p = painelAtual(); if (!p || !podeEditarPainel(p)) return;
    guardarLayout(p, layoutPadrao()); renderPainel(); toast("Layout restaurado.");
  };
  $("#dashboardManagerEditbarTitleInput").onchange = async ev => {
    const p = painelAtual(); if (!p || !podeEditarPainel(p)) return;
    const nome = ev.target.value.trim() || "Painel";
    if (state.demo){ p.nome = nome; gravar("pr.demo.paineis", state.dados.paineis); renderWorkspaces(); return; }
    try { await api.alterarPainel(p.id, {nome}); p.nome = nome; renderWorkspaces(); }
    catch (erro){ avisarErro(erro, "renomear o painel"); ev.target.value = p.nome; }
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

  try {
    await entrarNoPainel(await api.eu());
  } catch (erro){
    if (erro instanceof ErroApi && erro.semRede) await entrarEmDemonstracao();
    else mostrarLogin();
  }
}

iniciar();

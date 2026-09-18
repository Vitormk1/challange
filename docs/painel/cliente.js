/* ==========================================================================
   Casca da área do cliente

   O mesmo módulo roda nas três abas, e também no mapa. Ele descobre sozinho
   em que página está e se comporta de acordo:

     cliente.html    exige sessão de motorista; cumprimenta pelo nome
     carteira.html   exige sessão de motorista
     mapa.html       página aberta; a barra só aparece se houver motorista
                     logado, e visitante sem conta vê o mapa como sempre viu

   Por que o mapa é o único assim: ele é divulgação. Quem recebe o link quer
   ver onde tem carregador, e exigir conta antes disso perderia a pessoa na
   porta. Já Dashboard e Carteira são sobre dados de alguém — sem saber quem
   é, não há o que mostrar.

   Tudo mora neste arquivo, e não num <script> dentro de cada página, porque
   a CSP manda `script-src 'self'`: script inline não executa. Descobrir isso
   pelo sintoma seria demorado — a página carrega, parece certa, e só não faz
   nada.
   ========================================================================== */

import { api, ErroApi, BASE } from "./api.js";

/* Segura a cortina de carregamento ate esta tela ter o que mostrar.
   A chamada e sincrona de proposito: modulos sao avaliados antes do `load`,
   entao inscrever-se aqui garante que a cortina saiba esperar. Inscrever
   dentro de um `then` seria tarde. Ver docs/painel/carregando.js.

   Este modulo roda em tres telas, e nas outras duas ele divide a espera com
   o modulo principal (carteira-app.js, mapa.js). Cada um se inscreve por si;
   a cortina so sai quando o ultimo soltar, sem que precisem se conhecer. */
const soltarCortina = window.carregando ? window.carregando.aguardar() : null;

/* ------------------------------------------------------------------ tema */

/* Repetido do entrar.js de propósito. Juntar os dois num módulo compartilhado
   economizaria doze linhas e criaria uma dependência entre a porta de entrada
   e a área logada — duas coisas que mudam por motivos diferentes. */
function aplicarTemaSalvo(){
  let escolha = "system";
  try { escolha = localStorage.getItem("pr.tema") || "system"; } catch {}
  const efetivo = escolha === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : escolha;
  document.documentElement.dataset.theme = efetivo;
  document.body.dataset.theme = efetivo;
}

/* --------------------------------------------------------------- destino */

const paginaAtual = () => location.pathname.split("/").pop() || "cliente.html";

/* Guarda a aba atual para o login saber para onde devolver. Só o nome do
   arquivo: o entrar.js recusa qualquer coisa que não seja isso, e é ele quem
   tem a última palavra. */
function paraLogin(){
  const arquivo = paginaAtual();
  const volta = /^[a-z0-9._-]+\.html$/i.test(arquivo)
    ? `?proximo=${encodeURIComponent(arquivo)}` : "";
  location.replace(`./entrar.html${volta}`);
}

/* ------------------------------------------------------------ fidelidade */

const brl = v => new Intl.NumberFormat("pt-BR", {style:"currency", currency:"BRL"}).format(Number(v || 0));
const num = (v, casas = 0) => Number(v || 0).toLocaleString("pt-BR", {maximumFractionDigits: casas});

/* Uma linha por loja onde a pessoa tem ficha e a loja tem um modelo ativo.
   O texto muda com o tipo porque cashback, tiers e créditos não têm o mesmo
   "valor que importa" — mostrar sempre um número genérico esconderia o que
   cada modelo realmente promete. */
function linhaFidelidade(item){
  const nome = item.estabelecimento_nome || "Loja";
  if (item.tipo === "cashback"){
    return `<li><span>${nome}<small>Cashback</small></span><b>${brl(item.saldo_brl)}</b></li>`;
  }
  if (item.tipo === "tiers"){
    return `<li><span>${nome}<small>${num(item.compras_mes)} compra(s) no mês</small></span>`
         + `<b>${num(item.desconto_pct, 1)}% de desconto</b></li>`;
  }
  if (item.tipo === "creditos"){
    return `<li><span>${nome}<small>Créditos do app</small></span>`
         + `<b>${num(item.minutos)} min de recarga</b></li>`;
  }
  return "";
}

async function carregarFidelidade(){
  const lista = document.querySelector("[data-fidelidade-lista]");
  const vazio = document.querySelector("[data-fidelidade-vazio]");
  if (!lista || !vazio) return;
  try {
    const itens = await api.minhaFidelidade();
    lista.hidden = itens.length === 0;
    vazio.hidden = itens.length > 0;
    lista.innerHTML = itens.map(linhaFidelidade).join("");
  } catch {
    // sem sessão ou servidor fora do ar: o estado "vazio" já cobre a tela,
    // e o restante da página (recargas, como funciona) continua útil
  }
}

/* ------------------------------------------------- melhor hora de carregar

   A conta já existia em ai/demanda.py (`melhor_janela`) e só era consultada
   pela telinha da vaga. Quem decide a hora de carregar, porém, é quem dirige,
   e no aplicativo dele isso não aparecia em lugar nenhum.

   A seção some quando nenhuma loja tem hora melhor à frente. Um card dizendo
   "não há economia agora" ocupa a mesma altura e não muda decisão nenhuma. */

const FATOR_TEXTO = {
  0.5: "metade do cashback",
  1: "cashback normal",
  1.5: "uma vez e meia o cashback",
};

function textoDoFator(f){
  if (f === null || f === undefined) return "";
  return FATOR_TEXTO[f] || `cashback ×${String(f).replace(".", ",")}`;
}

function horaCurta(iso){
  const d = new Date(iso);
  const hoje = new Date().toDateString() === d.toDateString();
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return hoje ? `às ${hora}` : `amanhã às ${hora}`;
}

async function carregarMelhorHora(){
  const bloco  = document.querySelector("#blocoMelhorHora");
  const alvo   = document.querySelector("#melhorHora");
  const outras = document.querySelector("#melhorHoraOutras");
  const nota   = document.querySelector("#melhorHoraNota");
  if (!bloco || !alvo) return;

  let dados;
  try {
    dados = await api.melhorHora();
  } catch {
    return;                        // seção continua escondida; o resto da tela serve
  }

  const lojas = dados.lojas || [];
  if (!lojas.length) return;

  const uteis = lojas.filter(l => l.mais_barato || l.mais_cashback);

  /* Nenhuma loja tem hora melhor à frente — e isso é a maior parte do dia.
     Fora da ponta não há preço melhor a sugerir, e perto do meio-dia o sol já
     está no pico. Antes a seção inteira ficava escondida nessas horas, o que
     fazia a funcionalidade não existir para quem abrisse o app de dia.

     "Agora é a melhor hora" é resposta, e é a que a pessoa precisa para
     decidir carregar em vez de esperar. Escolhe a loja pelo que ela oferece
     agora: primeiro o maior multiplicador de cashback, depois o menor preço. */
  if (!uteis.length){
    const melhor = [...lojas].sort((a, b) =>
      (b.agora.cashback_fator - a.agora.cashback_fator) ||
      (a.agora.preco_kwh_brl - b.agora.preco_kwh_brl))[0];

    bloco.hidden = false;
    if (outras) outras.hidden = true;
    alvo.innerHTML = `
      <p class="melhor-hora-loja">${melhor.estabelecimento_nome}</p>
      <p class="melhor-hora-destaque">
        <b>Agora</b>
        <span>é a melhor hora nas próximas 12 horas</span>
      </p>
      <p class="melhor-hora-agora">
        ${melhor.agora.em_ponta ? "Horário de ponta" : "Fora de ponta"}
        · ${textoDoFator(melhor.agora.cashback_fator)}
      </p>`;
    if (nota) nota.textContent = "Nenhuma loja fica mais barata ou paga mais " +
      "crédito nas próximas horas. Se for carregar hoje, é agora.";
    return;
  }

  /* Duas razões para esperar, e a tela escolhe qual contar primeiro. Preço
     ganha de cashback: a economia sai do bolso agora, o crédito só vale na
     próxima compra. */
  const motivo = l => l.mais_barato
    ? { quando: l.mais_barato.quando,
        frase: `você paga ${String(l.mais_barato.economia_pct).replace(".", ",")}% menos pelo kWh`,
        curto: `−${String(l.mais_barato.economia_pct).replace(".", ",")}%` }
    : { quando: l.mais_cashback.quando,
        frase: `o cashback vale ${String(l.mais_cashback.vezes_mais).replace(".", ",")}× mais`,
        curto: `${String(l.mais_cashback.vezes_mais).replace(".", ",")}× cashback` };

  const [primeira, ...resto] = uteis;
  const m = motivo(primeira);
  const segunda = primeira.mais_barato && primeira.mais_cashback
    ? `<p class="melhor-hora-extra">E ${horaCurta(primeira.mais_cashback.quando)} o cashback
       vale ${String(primeira.mais_cashback.vezes_mais).replace(".", ",")}× mais.</p>`
    : "";

  alvo.innerHTML = `
    <p class="melhor-hora-loja">${primeira.estabelecimento_nome}</p>
    <p class="melhor-hora-destaque">
      <b>${horaCurta(m.quando)}</b>
      <span>${m.frase}</span>
    </p>
    ${segunda}
    <p class="melhor-hora-agora">
      Agora: ${primeira.agora.em_ponta ? "horário de ponta" : "fora de ponta"}
      · ${textoDoFator(primeira.agora.cashback_fator)}
    </p>`;

  if (resto.length && outras){
    outras.hidden = false;
    outras.innerHTML = resto.slice(0, 3).map(l => {
      const r = motivo(l);
      return `<li><span>${l.estabelecimento_nome}</span>
                  <b>${horaCurta(r.quando)}</b>
                  <i>${r.curto}</i></li>`;
    }).join("");
  }

  if (nota){
    nota.textContent = "A conta é a tarifa da loja hora a hora. O cashback "
      + "acompanha: cai pela metade na ponta e sobe quando há sol sobrando.";
  }
  bloco.hidden = false;
}

/* ----------------------------------------------------------------- barra */

/* O avatar aparece em dois tamanhos e em duas telas, entao mora aqui, onde as
   duas alcancam.

   Sem foto, desenha a inicial do nome em vez de um boneco cinza generico: a
   inicial ja e a pessoa, e some a duvida de "e esse boneco sou eu ou e um
   botao de entrar?".

   A imagem vem por URL, e nao embutida em base64: assim o navegador cacheia
   entre as telas. `foto_v` na query e o que fura esse cache quando a foto
   muda -- sem isso, a foto nova so apareceria no ano que vem. */
export function pintarAvatar(elemento, usuario){
  if (!elemento || !usuario) return;
  const inicial = (usuario.nome || "?").trim().charAt(0).toUpperCase();
  if (usuario.foto_v){
    elemento.style.backgroundImage = `url("${BASE}/perfil/foto?v=${usuario.foto_v}")`;
    elemento.textContent = "";
    elemento.classList.add("tem-foto");
  } else {
    elemento.style.backgroundImage = "";
    elemento.textContent = inicial;
    elemento.classList.remove("tem-foto");
  }
}

function ligarBarra(usuario){
  const barra = document.querySelector(".barra-app");
  if (!barra) return;
  barra.hidden = false;
  document.body.classList.add("tem-barra");
  document.querySelectorAll("[data-avatar]").forEach(a => pintarAvatar(a, usuario));

  // aria-current marca a aba da página atual, e é o que o leitor de tela
  // anuncia. O CSS pendura o traço vermelho no mesmo atributo, então não há
  // como a marcação visual e a falada discordarem.
  const aqui = paginaAtual();
  barra.querySelectorAll("a[href]").forEach(a => {
    const alvo = a.getAttribute("href").replace("./", "");
    if (alvo === aqui) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function avisarForaDoAr(){
  const alvo = document.querySelector("[data-estado-conexao]");
  if (!alvo) return;
  alvo.textContent = "O servidor não respondeu. Ele hiberna quando fica sem "
                   + "uso — espere uns instantes e recarregue a página.";
  alvo.hidden = false;
}

/* ------------------------------------------------------------------ sair */

function ligarSair(){
  const botao = document.querySelector("[data-sair]");
  if (!botao) return;
  botao.onclick = async () => {
    botao.disabled = true;
    // Mesmo se o logout falhar, tirar a pessoa da tela é o comportamento
    // esperado de quem clicou em "sair". O cookie expira sozinho, e insistir
    // numa tela logada depois de pedir para sair é pior que a falha.
    try { await api.sair(); } catch {}
    location.replace("./");
  };
}

/* -------------------------------------------------------------- reservas */

const SITUACOES = {
  ativa: "Confirmada", cumprida: "Utilizada",
  cancelada: "Cancelada", expirada: "Não compareceu",
};

function quando(inicio, fim) {
  const i = new Date(inicio), f = new Date(fim);
  const dia = i.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const hora = t => t.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${dia} · ${hora(i)}–${hora(f)}`;
}

/* Pergunta de sim ou não, num diálogo que dá para estilizar.

   Devolve uma promessa: `await perguntar(...)` lê como o `confirm()` lia, e a
   chamada não precisa virar callback.

   O `confirm()` continua ali de reserva para navegador sem <dialog>. Ele é
   feio, mas perder a pergunta seria pior: sem ela a pessoa cancela em cima da
   hora e descobre depois que os R$ 10 não voltaram. */
function perguntar({ titulo, texto, confirmar = "Confirmar", perigo = false }){
  const d = document.querySelector("#dialogo");
  if (!d || typeof d.showModal !== "function"){
    return Promise.resolve(window.confirm(`${titulo}

${texto}`));
  }
  document.querySelector("#dialogoTitulo").textContent = titulo;
  document.querySelector("#dialogoTexto").textContent = texto;
  const sim = document.querySelector("#dialogoSim");
  sim.textContent = confirmar;
  sim.classList.toggle("is-perigo", perigo);
  return new Promise(resolve => {
    d.addEventListener("close", () => resolve(d.returnValue === "sim"), { once: true });
    d.showModal();
  });
}

/* O recado fica NA tela, no lugar onde o aviso das reservas já mora.

   Antes era `alert()` — e, no cancelamento, um `alert()` chamado DEPOIS do
   `location.reload()`: ele corria contra o recarregamento e boa parte das
   vezes não aparecia. A pessoa cancelava e não lia nada. */
function recadoReserva(texto, tipo = ""){
  const alvo = document.querySelector("#avisoReservas");
  if (!alvo) return;
  alvo.textContent = texto;
  alvo.classList.toggle("is-erro", tipo === "erro");
  alvo.classList.toggle("is-ok", tipo === "ok");
}

async function mostrarReservas(){
  const bloco = document.querySelector("#blocoReservas");
  if (!bloco) return;                       // só existe na tela de Dashboard

  let dados;
  try {
    dados = await api.reservas();
  } catch {
    return;    // sem reservas visíveis é melhor que uma mensagem de erro aqui
  }
  // Só as que ainda valem alguma coisa. Reserva de três semanas atrás não é
  // informação, é entulho — e o extrato da carteira já guarda o histórico.
  const vivas = dados.reservas.filter(r => r.situacao === "ativa" || new Date(r.fim) > Date.now() - 86400000);
  // ordena: o que ainda vai acontecer primeiro, o histórico do dia depois
  vivas.sort((a, b) => (b.situacao === "ativa") - (a.situacao === "ativa")
                     || new Date(a.inicio) - new Date(b.inicio));
  if (!vivas.length) return;

  bloco.hidden = false;
  document.querySelector("#listaReservas").innerHTML = vivas.map(r => `
    <li class="cartao-cliente reserva-item">
      <div>
        <b>${r.loja}</b>
        <small>${r.vaga} · ${Number(r.potencia_kw).toFixed(1).replace(".", ",")} kW</small>
        <span class="reserva-quando-texto">${quando(r.inicio, r.fim)}</span>
      </div>
      <div class="reserva-acao">
        <span class="reserva-situacao is-${r.situacao}">${SITUACOES[r.situacao] || r.situacao}</span>
        ${r.pode_chegar
          ? `<button class="reserva-chegar" type="button" data-chegar="${r.id}">Cheguei</button>`
          : r.pode_cancelar
            ? `<button class="reserva-cancelar" type="button" data-cancelar="${r.id}">Cancelar</button>`
            : ""}
      </div>
    </li>`).join("");

  document.querySelector("#avisoReservas").textContent =
    `Cancelamento com mais de ${dados.devolve_ate_min} min de antecedência devolve o valor à carteira.`;

  // Chegar é a outra metade da regra: o depósito volta como crédito da
  // recarga. Quem decide o que mostrar é o servidor, via pode_chegar — a
  // janela de tempo não é recalculada aqui, senão haveria duas versões dela.
  document.querySelectorAll("[data-chegar]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    b.textContent = "Registrando…";
    try {
      const d = await api.chegueiNaReserva(Number(b.dataset.chegar));
      recadoReserva(d.mensagem || "Chegada registrada.", "ok");
      // Recarrega depois de a pessoa ter tempo de ler. O saldo lá em cima
      // também mudou, e recarregar é mais honesto que remendar duas partes.
      setTimeout(() => location.reload(), 1400);
    } catch (erro){
      b.disabled = false;
      b.textContent = "Cheguei";
      recadoReserva(erro?.message || "Não consegui registrar.", "erro");
    }
  });

  document.querySelectorAll("[data-cancelar]").forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.cancelar);
    const r = vivas.find(x => x.id === id);

    /* A pergunta que faltava. Cancelar com menos de `devolve_ate_min` de
       antecedência NÃO devolve o valor — e até agora a tela deixava a pessoa
       descobrir isso pelo extrato, depois. A regra de quanto falta é a mesma
       do servidor; aqui ela só decide o texto da pergunta, não o dinheiro. */
    const devolve = r && (new Date(r.inicio) - Date.now()) > dados.devolve_ate_min * 60000;
    const valor = brl(r?.valor_brl ?? 0);
    const ok = await perguntar({
      titulo: "Cancelar esta reserva?",
      texto: devolve
        ? `A vaga volta a ficar livre e ${valor} voltam para a sua carteira.`
        : `Faltam menos de ${dados.devolve_ate_min} minutos para o horário: `
          + `a vaga volta a ficar livre, mas ${valor} não voltam.`,
      confirmar: devolve ? "Cancelar reserva" : `Cancelar e perder ${valor}`,
      perigo: !devolve,
    });
    if (!ok) return;

    b.disabled = true;
    b.textContent = "Cancelando…";
    try {
      const d = await api.cancelarReserva(id);
      recadoReserva(d.aviso || "Reserva cancelada.", devolve ? "ok" : "");
      setTimeout(() => location.reload(), 1400);
    } catch (erro){
      b.disabled = false;
      b.textContent = "Cancelar";
      recadoReserva(erro?.message || "Não consegui cancelar.", "erro");
    }
  });
}

/* ----------------------------------------------------------------- monta */

aplicarTemaSalvo();

const exigir = paginaAtual() !== "mapa.html";

/* Exportada para quem roda junto nesta tela nao pedir a mesma coisa de novo.
   A tela de ajustes carregava este modulo E chamava `api.eu()` por conta
   propria: duas idas ao servidor para a mesma resposta, uma esperando a
   outra. Num telefone em rede ruim isso e a diferenca entre abrir e
   parecer travado. */
export let sessao = null;
try {
  sessao = await api.eu();
} catch (erro){
  if (exigir){
    if (erro instanceof ErroApi && erro.semRede){
      // Sem rede não dá para saber se há sessão. Mandar para o login faria a
      // pessoa achar que foi desconectada; o certo é dizer o que houve.
      avisarForaDoAr();
    } else {
      paraLogin();
    }
  }
}

const usuario = sessao?.usuario;

/* O que ainda esta em voo. A cortina espera por isto: sem esperar, ela sairia
   com a tela montada mas vazia, e as reservas e a fidelidade apareceriam
   depois -- o piscar que a cortina existe para evitar. */
const espera = [];

if (usuario?.papel === "motorista"){
  ligarBarra(usuario);
  ligarSair();

  espera.push(mostrarReservas());

  const saudacao = document.querySelector("#saudacao");
  if (saudacao){
    // Só o primeiro nome: "Olá, Maria" cabe na linha, "Olá, Maria Fernanda de
    // Oliveira Santos" vira reticências e não cumprimenta ninguém.
    const primeiro = (usuario.nome || "").trim().split(/\s+/)[0];
    saudacao.textContent = primeiro ? `Olá, ${primeiro}` : "Olá";
  }
  espera.push(carregarFidelidade());
  espera.push(carregarMelhorHora());
} else if (usuario && exigir){
  // Sessão de loja aberta nesta área: manda para a tela de entrada, não para
  // o painel.
  //
  // Mandar para o painel pareceria mais direto e tiraria a saída: a pessoa
  // ficaria presa do lado do lojista, sem lugar onde entrar com a conta
  // pessoal dela. A tela de entrada é justamente onde as duas portas ficam
  // lado a lado — ela entra como motorista ali, ou volta ao painel pelo
  // botão de lojista.
  location.replace("./entrar.html");
}

/* allSettled, e nao all: uma das duas falhando nao pode prender a cortina.
   Cada funcao ja trata o proprio erro na tela. */
await Promise.allSettled(espera);
if (soltarCortina) soltarCortina();

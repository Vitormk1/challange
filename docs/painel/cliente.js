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

import { api, ErroApi } from "./api.js";

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
         + `<b>${num(item.creditos, 1)} · ${num(item.minutos)} min</b></li>`;
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

/* ----------------------------------------------------------------- barra */

function ligarBarra(){
  const barra = document.querySelector(".barra-app");
  if (!barra) return;
  barra.hidden = false;
  document.body.classList.add("tem-barra");

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
        ${r.situacao === "ativa"
          ? `<button class="reserva-cancelar" type="button" data-cancelar="${r.id}">Cancelar</button>`
          : ""}
      </div>
    </li>`).join("");

  document.querySelector("#avisoReservas").textContent =
    `Cancelamento com mais de ${dados.devolve_ate_min} min de antecedência devolve o valor à carteira.`;

  document.querySelectorAll("[data-cancelar]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    b.textContent = "Cancelando…";
    try {
      const d = await api.cancelarReserva(Number(b.dataset.cancelar));
      // Recarrega em vez de remendar a linha na mão: o saldo lá em cima também
      // mudou, e duas atualizações parciais é onde a tela começa a mentir.
      location.reload();
      if (d.aviso) alert(d.aviso);
    } catch (erro){
      b.disabled = false;
      b.textContent = "Cancelar";
      alert(erro?.message || "Não consegui cancelar.");
    }
  });
}

/* ----------------------------------------------------------------- monta */

aplicarTemaSalvo();

const exigir = paginaAtual() !== "mapa.html";

let sessao = null;
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

if (usuario?.papel === "motorista"){
  ligarBarra();
  ligarSair();

  mostrarReservas();

  const saudacao = document.querySelector("#saudacao");
  if (saudacao){
    // Só o primeiro nome: "Olá, Maria" cabe na linha, "Olá, Maria Fernanda de
    // Oliveira Santos" vira reticências e não cumprimenta ninguém.
    const primeiro = (usuario.nome || "").trim().split(/\s+/)[0];
    saudacao.textContent = primeiro ? `Olá, ${primeiro}` : "Olá";
  }
  carregarFidelidade();
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

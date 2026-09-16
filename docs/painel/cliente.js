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

  const saudacao = document.querySelector("#saudacao");
  if (saudacao){
    // Só o primeiro nome: "Olá, Maria" cabe na linha, "Olá, Maria Fernanda de
    // Oliveira Santos" vira reticências e não cumprimenta ninguém.
    const primeiro = (usuario.nome || "").trim().split(/\s+/)[0];
    saudacao.textContent = primeiro ? `Olá, ${primeiro}` : "Olá";
  }
} else if (usuario && exigir){
  // Quem é da loja não tem o que fazer aqui: o painel é a ferramenta dele, e
  // esta área mostraria três abas vazias. O contrário também vale — o
  // motorista que cai no painel é mandado para cá pelo próprio painel.
  location.replace("./dashboard.html");
}

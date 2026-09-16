/* ==========================================================================
   Tela de entrada

   Duas portas para o mesmo lugar: entrar numa conta que existe, ou criar uma.
   O que muda entre elas é só qual rota da API é chamada — o que vem depois é
   idêntico, porque o servidor devolve a sessão já aberta nos dois casos.

   Esta tela é do MOTORISTA. Quem entra ou se cadastra aqui vai para a área do
   cliente, e só o servidor decide isso — o cadastro aberto cria 'motorista'
   com o papel fixo no código.

   O lojista tem outra porta, o botão no fim da página, que leva ao painel. O
   painel pede a senha de novo, com a conta que nós entregamos a ele. São duas
   contas de verdade, e a mesma pessoa pode ter as duas no mesmo aparelho: a
   dela, de motorista, e a da loja.
   ========================================================================== */

import { api, ErroApi } from "./api.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const status = $("#status");
const formEntrar = $("#formEntrar");
const formCriar = $("#formCriar");
const abaEntrar = $("#abaEntrar");
const abaCriar = $("#abaCriar");
const notaLojista = $("#notaLojista");

/* ---------------------------------------------------------------- destino */

function destinoDe(sessao){
  return sessao?.usuario?.papel === "motorista" ? "./cliente.html" : "./dashboard.html";
}

/* `?proximo=` permite voltar para onde a pessoa tentou ir antes de ser
   mandada para cá. É também um jeito clássico de virar redirecionador aberto:
   `?proximo=https://site-falso` numa página que pede senha é phishing pronto,
   hospedado no nosso domínio. Por isso só passa nome de arquivo .html daqui
   mesmo — nada com esquema, nada com barra dupla no começo, nada com "..". */
function proximoSeguro(){
  const bruto = new URLSearchParams(location.search).get("proximo");
  if (!bruto) return null;
  if (!/^[a-z0-9._-]+\.html$/i.test(bruto)) return null;
  if (bruto.includes("..")) return null;
  return "./" + bruto;
}

function seguir(sessao){
  location.replace(proximoSeguro() || destinoDe(sessao));
}

/* ------------------------------------------------------------------ tema */

const lerTema = () => {
  try { return localStorage.getItem("pr.tema") || "system"; } catch { return "system"; }
};

function aplicarTema(escolha){
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
}

$$("[data-theme-choice]").forEach(b => b.onclick = () => {
  try { localStorage.setItem("pr.tema", b.dataset.themeChoice); } catch {}
  aplicarTema(b.dataset.themeChoice);
});
aplicarTema(lerTema());
// Com "seguir o sistema", a troca no sistema operacional tem de chegar aqui
// sem recarregar a página.
matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", () => { if (lerTema() === "system") aplicarTema("system"); });

/* ---------------------------------------------------------------- botões */

/* Os botões chegam `disabled` do HTML. Ligá-los aqui é a prova de que este
   módulo executou: se ele não carregar — bloqueador, rede ruim, erro de CSP —
   os botões continuam apagados e ninguém consegue disparar o envio nativo,
   que é o que empurraria a senha para dentro da URL. */
$$(".login-entrar").forEach(b => { b.disabled = false; });

/* ------------------------------------------------------------------ abas */

function trocarAba(paraCriar){
  abaEntrar.setAttribute("aria-selected", String(!paraCriar));
  abaCriar.setAttribute("aria-selected", String(paraCriar));
  abaEntrar.classList.toggle("is-ativa", !paraCriar);
  abaCriar.classList.toggle("is-ativa", paraCriar);
  formEntrar.hidden = paraCriar;
  formCriar.hidden = !paraCriar;
  notaLojista.hidden = paraCriar;
  dizer("");
  // Foco no primeiro campo: quem clicou na aba quer digitar, e no celular
  // isso já abre o teclado. `preventScroll` porque a tela é fixa — sem ele o
  // Safari empurra o layout para "revelar" um campo que já está visível.
  (paraCriar ? $("#criarNome") : $("#entrarEmail")).focus({ preventScroll: true });
}

abaEntrar.onclick = () => trocarAba(false);
abaCriar.onclick = () => trocarAba(true);

// Seta para os lados dentro da faixa de abas, como manda o padrão de tablist.
$(".entrada-abas").addEventListener("keydown", ev => {
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  ev.preventDefault();
  const paraCriar = ev.key === "ArrowRight";
  trocarAba(paraCriar);
  (paraCriar ? abaCriar : abaEntrar).focus();
});

// Chegar por /painel/entrar.html?criar abre já na aba certa — é o link que a
// apresentação usa quando o convite é "crie sua conta".
if (new URLSearchParams(location.search).has("criar")) trocarAba(true);

/* --------------------------------------------------------- olho da senha */

$$("[data-olho]").forEach(botao => botao.onclick = () => {
  const campo = document.getElementById(botao.dataset.olho);
  const mostrando = campo.type === "text";
  campo.type = mostrando ? "password" : "text";
  botao.setAttribute("aria-pressed", String(!mostrando));
  botao.setAttribute("aria-label", mostrando ? "Mostrar senha" : "Esconder senha");
});

/* ---------------------------------------------------------------- status */

function dizer(texto, tipo = ""){
  status.textContent = texto;
  status.classList.toggle("is-erro", tipo === "erro");
  status.classList.toggle("is-ok", tipo === "ok");
}

function explicar(erro){
  if (erro instanceof ErroApi && erro.semRede)
    return "O servidor não respondeu. Ele hiberna quando fica sem uso — "
         + "espere uns instantes e tente de novo.";
  return erro?.message || "Não deu certo. Tente de novo.";
}

/* Trava o formulário enquanto a requisição corre. Sem isto, dois toques no
   botão viram dois cadastros — ou duas tentativas de login, que gastam o
   limite de tentativas em dobro. */
function ocupado(form, sim){
  const botao = form.querySelector(".login-entrar");
  botao.classList.toggle("is-carregando", sim);
  botao.disabled = sim;
  form.querySelectorAll("input").forEach(i => { i.disabled = sim; });
}

/* ---------------------------------------------------------------- entrar */

formEntrar.onsubmit = async ev => {
  ev.preventDefault();
  const email = $("#entrarEmail").value.trim();
  const senha = $("#entrarSenha").value;
  if (!email || !senha) { dizer("Preencha e-mail e senha.", "erro"); return; }

  ocupado(formEntrar, true);
  dizer("");
  try {
    seguir(await api.entrar(email, senha));
  } catch (erro){
    ocupado(formEntrar, false);
    dizer(explicar(erro), "erro");
    $("#entrarSenha").select();
  }
};

/* ----------------------------------------------------------- criar conta */

formCriar.onsubmit = async ev => {
  ev.preventDefault();
  const nome = $("#criarNome").value.trim();
  const email = $("#criarEmail").value.trim();
  const senha = $("#criarSenha").value;

  // As mesmas regras rodam no servidor, que é quem manda. Repeti-las aqui só
  // serve para a resposta ser instantânea em vez de custar uma ida à rede.
  if (nome.length < 2) { dizer("Escreva seu nome.", "erro"); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { dizer("Esse e-mail não parece válido.", "erro"); return; }
  if (senha.length < 8) { dizer("A senha precisa de pelo menos 8 caracteres.", "erro"); return; }

  ocupado(formCriar, true);
  dizer("");
  try {
    seguir(await api.cadastrar(nome, email, senha));
  } catch (erro){
    ocupado(formCriar, false);
    dizer(explicar(erro), "erro");
    // 409 é "esse e-mail já tem conta". O caminho útil é a outra aba, com o
    // e-mail já preenchido, e não repetir o cadastro.
    if (erro instanceof ErroApi && erro.status === 409){
      $("#entrarEmail").value = email;
      trocarAba(false);
      dizer("Já existe uma conta com esse e-mail. Entre por aqui.", "erro");
      $("#entrarSenha").focus({ preventScroll: true });
    }
  }
};

/* ------------------------------------------------------------ foco inicial */

/* Esta tela NÃO redireciona quem já tem sessão aberta.

   A versão anterior fazia isso — chegou logado, foi mandado direto para
   dentro. Parecia atencioso e atrapalhava: o lojista que já estava logado
   como motorista nunca conseguia ver o botão "Entrar como lojista", porque a
   página o expulsava antes de ele bater o olho. E as duas contas existem
   justamente para conviver no mesmo aparelho.

   Quem já entrou e voltou aqui de propósito quer escolher alguma coisa: trocar
   de conta, ou passar para o lado do lojista. Mandá-lo embora tira a escolha
   que é o motivo desta tela existir. */
$("#entrarEmail").focus({ preventScroll: true });

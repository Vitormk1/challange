/* ==========================================================================
   Confirmação de e-mail

   É a tela que o link do e-mail abre. Ela consome o token, e o servidor
   devolve a sessão já aberta — quem chegou aqui provou a senha no cadastro e
   agora provou o endereço, então pedir login de novo seria cobrar a mesma
   prova duas vezes.

   Quando o link não serve mais, a tela não vira beco: oferece mandar outro,
   ali mesmo, sem obrigar a pessoa a voltar e refazer o caminho.
   ========================================================================== */

import { api, ErroApi } from "./api.js?v=20260916k";

const $ = s => document.querySelector(s);

const conferindo = $("#conferindo");
const pronto = $("#pronto");
const falhou = $("#falhou");
const status = $("#status");

function mostrar(qual, motivo){
  conferindo.hidden = qual !== conferindo;
  pronto.hidden = qual !== pronto;
  falhou.hidden = qual !== falhou;
  if (motivo) $("#motivo").textContent = motivo;
}

/* ------------------------------------------------------------------ tema */

(() => {
  let escolha = "system";
  try { escolha = localStorage.getItem("pr.tema") || "system"; } catch {}
  const efetivo = escolha === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : escolha;
  document.documentElement.dataset.theme = efetivo;
  document.body.dataset.theme = efetivo;
})();

/* -------------------------------------------------------------- reenviar */

const form = $("#formReenviar");
const botao = form.querySelector(".login-entrar");
botao.disabled = false;      // prova de que este módulo rodou; ver entrar.js

function dizer(texto, tipo = ""){
  status.textContent = texto;
  status.classList.toggle("is-erro", tipo === "erro");
  status.classList.toggle("is-ok", tipo === "ok");
}

form.onsubmit = async ev => {
  ev.preventDefault();
  const email = $("#reenviarEmail").value.trim();
  if (!email || !email.includes("@")) { dizer("Escreva seu e-mail.", "erro"); return; }

  botao.classList.add("is-carregando");
  botao.disabled = true;
  dizer("");
  try {
    await api.reenviar(email);
    // O servidor responde igual exista ou não a conta, e a tela repete isso.
    // Dizer "pronto, mandamos" para um e-mail sem cadastro parece impreciso,
    // mas é o preço de não transformar esta caixa num detector de quem tem
    // conta aqui — qualquer um poderia ficar testando endereços.
    dizer("Se houver uma conta pendente com esse e-mail, o link já está a "
        + "caminho. Confira também o spam.", "ok");
    form.hidden = true;
  } catch (erro){
    botao.classList.remove("is-carregando");
    botao.disabled = false;
    dizer(erro instanceof ErroApi && erro.semRede
      ? "O servidor não respondeu. Ele hiberna quando fica sem uso — tente de novo em um minuto."
      : (erro?.message || "Não deu certo. Tente de novo."), "erro");
  }
};

/* ------------------------------------------------------------- confirmar */

const token = new URLSearchParams(location.search).get("token");

if (!token){
  mostrar(falhou, "Este endereço não tem token. Abra o link direto do e-mail.");
} else {
  try {
    await api.verificar(token);
    mostrar(pronto);
    // Um instante na tela de "confirmado" antes de seguir: sem ele a pessoa
    // vê um piscar e cai na conta sem entender o que aconteceu. Com ele, lê a
    // confirmação — e o botão continua ali para quem preferir clicar.
    setTimeout(() => location.replace("./cliente.html"), 1600);
  } catch (erro){
    const status = erro instanceof ErroApi ? erro.status : 0;
    mostrar(falhou,
      status === 410 ? "Este link passou do prazo de 24 horas."
      : status === 404 ? "Ele pode já ter sido usado, ou ter sido digitado errado."
      : erro instanceof ErroApi && erro.semRede
        ? "O servidor não respondeu. Ele hiberna quando fica sem uso — abra o link de novo em um minuto."
        : (erro?.message || "Não consegui confirmar agora."));
  }
}

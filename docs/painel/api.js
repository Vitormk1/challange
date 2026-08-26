/* ==========================================================================
   Conversa com o servidor.

   Tudo passa por aqui, e tudo manda o cookie de sessão junto — por isso o
   `credentials: "include"`. O cookie é httpOnly: o JavaScript não consegue
   lê-lo, o que é o objetivo. Se um script de terceiro entrar na página, ele
   não tem como levar a sessão embora.

   O servidor é obrigatório: sem ele não há login, não há dado e não há
   assistente. Quando não responde, o painel diz isso na tela de login em vez
   de inventar um estado alternativo.
   ========================================================================== */

const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/* Onde a API mora. É a única linha que muda se o serviço trocar de endereço. */
const API_PUBLICADA = "https://praca-recarga-api.onrender.com";

/* O painel real é servido pela própria API. Uma cópia aberta de outro domínio
   (o GitHub Pages, por exemplo) não consegue manter sessão — o cookie seria de
   terceiro, e a maioria dos navegadores descarta. Em vez de deixar a pessoa
   descobrir isso com um "e-mail ou senha incorretos" que mente, manda para o
   endereço que funciona.

   O destino é /painel/dashboard.html, e não /painel/: quem abriu esta cópia
   queria o painel. Desde que a apresentação passou a morar em /painel/, cair
   na raiz devolveria a landing e a pessoa teria de procurar o caminho de
   volta para a tela que já tinha aberto. */
(() => {
  if (!API_PUBLICADA || local) return;
  if (location.origin === new URL(API_PUBLICADA).origin) return;
  if (new URLSearchParams(location.search).has("api")) return;   // escape para depurar
  location.replace(API_PUBLICADA + "/painel/dashboard.html");
})();

export const BASE = (() => {
  // ?api=... na URL vence tudo, e fica gravado: serve para apontar o painel
  // publicado para uma API local durante um teste, sem republicar nada
  const forcado = new URLSearchParams(location.search).get("api");
  if (forcado !== null){
    try { forcado ? localStorage.setItem("pr.api", forcado) : localStorage.removeItem("pr.api"); } catch {}
    if (forcado) return forcado;
  }
  try { const salvo = localStorage.getItem("pr.api"); if (salvo) return salvo; } catch {}
  if (local) return "http://127.0.0.1:8000";
  // mesma origem: caminho relativo, sem CORS e sem cookie de terceiro
  return location.origin === new URL(API_PUBLICADA).origin ? "" : API_PUBLICADA;
})();

export class ErroApi extends Error {
  constructor(status, mensagem){ super(mensagem); this.status = status; }
  get semSessao(){ return this.status === 401; }
  get semRede(){ return this.status === 0; }
}

async function pedir(caminho, {metodo = "GET", corpo} = {}){
  let r;
  try {
    r = await fetch(`${BASE}${caminho}`, {
      method: metodo,
      credentials: "include",
      headers: corpo ? {"Content-Type": "application/json"} : undefined,
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch {
    throw new ErroApi(0, "servidor fora do ar");
  }
  if (r.status === 204) return null;
  const texto = await r.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = null; }
  if (!r.ok) throw new ErroApi(r.status, dados?.detail || `erro ${r.status}`);
  return dados;
}

export const api = {
  entrar:  (email, senha) => pedir("/auth/login", {metodo:"POST", corpo:{email, senha}}),
  sair:    () => pedir("/auth/logout", {metodo:"POST"}),
  eu:      () => pedir("/auth/eu"),

  dados:   id => pedir(`/dados?estabelecimento_id=${id}`),

  criar:   (tabela, corpo) => pedir(`/registros/${tabela}`, {metodo:"POST", corpo}),
  alterar: (tabela, id, corpo) => pedir(`/registros/${tabela}/${id}`, {metodo:"PATCH", corpo}),
  excluir: (tabela, id) => pedir(`/registros/${tabela}/${id}`, {metodo:"DELETE"}),

  criarPainel:   corpo => pedir("/paineis", {metodo:"POST", corpo}),
  alterarPainel: (id, corpo) => pedir(`/paineis/${id}`, {metodo:"PATCH", corpo}),
  excluirPainel: id => pedir(`/paineis/${id}`, {metodo:"DELETE"}),

  preferencias: corpo => pedir("/preferencias", {metodo:"PATCH", corpo}),

  perfil:      () => pedir("/perfil"),
  trocarNome:  (nome, senha_atual) => pedir("/perfil/nome", {metodo:"POST", corpo:{nome, senha_atual}}),
  trocarSenha: (senha_atual, nova) => pedir("/perfil/senha", {metodo:"POST", corpo:{senha_atual, nova}}),

  perguntar: (pergunta, estabelecimento_id, historico) =>
    pedir("/ia/perguntar", {metodo:"POST", corpo:{pergunta, estabelecimento_id, historico}}),
  transcrever: audio => pedir("/ia/transcrever", {metodo:"POST", corpo:{audio}}),
};

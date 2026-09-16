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

/* Onde a API mora. É a única linha que muda se o serviço trocar de endereço.

   O endereço do Render (praca-recarga-api.onrender.com) continua funcionando
   e serve a mesma coisa — o domínio próprio é um apelido, não uma mudança de
   servidor. Fica o domínio aqui porque é o que a pessoa reconhece se olhar a
   barra do navegador depois de um redirecionamento. */
const API_PUBLICADA = "https://smartcharge.ia.br";

/* O painel real é servido pela própria API. Uma cópia aberta de outro domínio
   (o GitHub Pages, por exemplo) não consegue manter sessão — o cookie seria de
   terceiro, e a maioria dos navegadores descarta. Em vez de deixar a pessoa
   descobrir isso com um "e-mail ou senha incorretos" que mente, manda para o
   endereço que funciona.

   Leva a MESMA página para a outra origem, e não sempre o painel: agora são
   várias telas sob /painel/ (apresentação, login, área do cliente, mapa), e
   mandar todo mundo para o painel tiraria a pessoa de onde ela queria estar.
   Cair na raiz também não serve — devolveria a landing, e quem abriu o mapa
   teria de procurar o caminho de volta. */
(() => {
  if (!API_PUBLICADA || local) return;
  if (location.origin === new URL(API_PUBLICADA).origin) return;
  if (new URLSearchParams(location.search).has("api")) return;   // escape para depurar
  const caminho = location.pathname.startsWith("/painel/") && location.pathname !== "/painel/"
    ? location.pathname
    : "/painel/dashboard.html";
  location.replace(API_PUBLICADA + caminho);
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
  /* Cria conta e já devolve a sessão aberta. O papel não vai no corpo de
     propósito — quem decide é o servidor, que fixa 'motorista'. */
  cadastrar: (nome, email, senha) => pedir("/auth/cadastrar", {metodo:"POST", corpo:{nome, email, senha}}),
  /* Consome o link do e-mail e já devolve a sessão aberta. */
  verificar: token => pedir("/auth/verificar", {metodo:"POST", corpo:{token}}),
  /* Responde 200 mesmo para e-mail que não existe, de propósito: senão a rota
     viraria um verificador de quem tem conta, aberto e sem login. */
  reenviar: email => pedir("/auth/reenviar", {metodo:"POST", corpo:{email}}),
  sair:    () => pedir("/auth/logout", {metodo:"POST"}),
  eu:      () => pedir("/auth/eu"),

  carteira: () => pedir("/carteira"),
  criarPix: (valor, cpfCnpj) => pedir("/carteira/pix", {metodo:"POST", corpo:{valor, cpfCnpj}}),
  consultarPix: id => pedir(`/carteira/pix/${encodeURIComponent(id)}`),
  creditoTeste: () => pedir("/carteira/credito-teste", {metodo:"POST"}),

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

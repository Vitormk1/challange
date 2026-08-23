/* ==========================================================================
   Conversa com o servidor.

   Tudo passa por aqui, e tudo manda o cookie de sessão junto — por isso o
   `credentials: "include"`. O cookie é httpOnly: o JavaScript não consegue
   lê-lo, o que é o objetivo. Se um script de terceiro entrar na página, ele
   não tem como levar a sessão embora.

   Quando o servidor não responde, o painel não quebra: cai no modo
   demonstração, que lê o dados.json exportado do banco. É o que faz a versão
   publicada no GitHub Pages continuar navegável, já que Pages serve arquivo
   estático e não executa Python.
   ========================================================================== */

const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/* Onde a API mora, publicada. Quando o serviço subir no Render, é esta linha
   que muda — e só ela. Enquanto estiver vazia, a versão publicada roda em
   modo demonstração, que é o comportamento correto: melhor dizer "isto é
   demonstração" do que tentar falar com um servidor que não existe. */
const API_PUBLICADA = "";

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
  return API_PUBLICADA;   // vazio => sem servidor => modo demonstração
})();

export class ErroApi extends Error {
  constructor(status, mensagem){ super(mensagem); this.status = status; }
  get semSessao(){ return this.status === 401; }
  get semRede(){ return this.status === 0; }
}

async function pedir(caminho, {metodo = "GET", corpo} = {}){
  if (!BASE) throw new ErroApi(0, "sem servidor configurado");
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

  perguntar: (pergunta, estabelecimento_id, historico) =>
    pedir("/ia/perguntar", {metodo:"POST", corpo:{pergunta, estabelecimento_id, historico}}),
};

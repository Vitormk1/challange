/* ==========================================================================
   A telinha quando HA rede

   A simulacao do vaga.js continua sendo o coracao, e de proposito: ela e o que
   faz a tela funcionar com a internet da loja fora do ar, que e exatamente
   quando uma tela ao lado do carregador mais importa. Este arquivo nao
   substitui nada dela -- ele acrescenta, e some sozinho quando o servidor nao
   responde.

   O que ele acrescenta, e so quando ha rede:

     preco e cashback reais     vindos do cadastro da loja, e nao da URL
     o leilao de potencia       quando falta folga, a tela pergunta antes de
                                comecar
     a sessao de verdade        entra no historico da loja e na fidelidade
     o QR                       o motorista acompanha do celular, sem instalar
                                aplicativo e sem fazer login

   A telinha precisa saber QUAL vaga ela e para falar com o servidor. Isso vem
   em `?id=<carregador>`. Sem esse parametro ela fica no modo demonstracao, que
   e como ela sempre funcionou -- util para mostrar a tela sem depender de uma
   loja cadastrada.
   ========================================================================== */

const P = new URLSearchParams(location.search);
const VAGA_ID = P.get("id");

/* Um minuto entre relatorios. A recarga e lenta e ninguem olha o celular a
   cada segundo; o que nao pode e a sessao parecer morta e o servidor fecha-la
   por abandono (ver SESSAO_ORFA_MIN, do lado de la). */
const INTERVALO_LEITURA_MS = 60_000;

export const estado = {
  online: false,
  token: null,
  config: null,          // o que /vagas/{id}/telinha devolveu
  oferta: null,          // a oferta escolhida no leilao
};

async function pedir(caminho, corpo){
  const r = await fetch(caminho, {
    method: corpo ? "POST" : "GET",
    headers: corpo ? {"Content-Type": "application/json"} : undefined,
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (!r.ok) throw new Error(`${caminho} respondeu ${r.status}`);
  return r.json();
}

/* ------------------------------------------------------------------ boot --
   Devolve a configuracao da loja, ou null quando nao ha rede. Quem chama
   decide o que fazer -- e o que ele faz e seguir com os padroes da URL. */
export async function conectar(){
  if (!VAGA_ID) return null;
  try {
    const c = await pedir(`/vagas/${encodeURIComponent(VAGA_ID)}/telinha`);
    estado.online = true;
    estado.config = c;
    return c;
  } catch {
    estado.online = false;
    return null;
  }
}

/* ----------------------------------------------------------- o leilao ----
   Monta os botoes e espera a escolha. Devolve a oferta aceita.

   A potencia cheia esta na lista com o mesmo peso das outras: a escolha de
   nao participar nao pode ser o botao pequeno do canto, senao a pergunta vira
   pegadinha. E cada opcao diz quanto custa em MINUTOS, porque oferecer
   "o dobro de cashback" sem dizer que sao quarenta minutos a mais e vender
   sem mostrar o preco. */
export function perguntarLeilao(ofertas){
  return new Promise(resolve => {
    const caixa = document.getElementById("leilao");
    const lista = document.getElementById("leilaoOpcoes");
    if (!caixa || !lista || !ofertas?.length){ resolve(null); return; }

    lista.innerHTML = ofertas.map((o, i) => `
      <button class="leilao-opcao ${i === 0 ? "is-cheia" : ""}" type="button" data-oferta="${i}">
        <span class="leilao-rotulo">${o.rotulo}</span>
        <span class="leilao-kw">${o.potencia_kw.toFixed(1).replace(".", ",")} kW</span>
        <span class="leilao-premio">${o.cashback_fator.toFixed(1).replace(".", ",")}× cashback</span>
        <span class="leilao-custo">${o.minutos_a_mais > 0
          ? `+${Math.round(o.minutos_a_mais)} min` : "mais rápido"}</span>
      </button>`).join("");

    caixa.hidden = false;
    lista.querySelectorAll("[data-oferta]").forEach(b => {
      b.onclick = () => {
        caixa.hidden = true;
        estado.oferta = ofertas[Number(b.dataset.oferta)];
        resolve(estado.oferta);
      };
    });

    /* Ninguem escolheu em 45 segundos: segue na potencia cheia. A vaga nao
       pode ficar parada esperando uma decisao que talvez nunca venha -- tem
       gente com o carro plugado do outro lado da tela. */
    setTimeout(() => {
      if (!caixa.hidden){
        caixa.hidden = true;
        estado.oferta = ofertas[0];
        resolve(ofertas[0]);
      }
    }, 45_000);
  });
}

/* ----------------------------------------------------------- a sessao ----- */
export async function abrirSessao(socInicial){
  if (!estado.online) return null;
  try {
    const r = await pedir(`/vagas/${encodeURIComponent(VAGA_ID)}/sessao`, {
      soc_inicial: socInicial,
      leilao_potencia_pct: estado.oferta?.potencia_pct ?? null,
      leilao_fator: estado.oferta?.cashback_fator ?? null,
    });
    estado.token = r.token;
    mostrarQr(r.token);
    return r;
  } catch {
    // A recarga nao pode depender disto: sem sessao no servidor ela continua,
    // so nao entra no historico nem aparece no celular.
    estado.online = false;
    return null;
  }
}

function mostrarQr(token){
  const caixa = document.querySelector(".qr");
  if (!caixa) return;
  const svg = caixa.querySelector("svg");
  if (svg) svg.remove();
  const img = document.createElement("img");
  img.src = `/s/${encodeURIComponent(token)}/qr.svg`;
  img.alt = "";
  img.width = 64; img.height = 64;
  img.decoding = "async";
  caixa.prepend(img);
  const texto = caixa.querySelector("span");
  if (texto) texto.textContent = "Aponte a câmera: acompanhe do celular, sem instalar nada";
}

let relogio = null;

export function comecarRelatorios(ler){
  if (!estado.online || !estado.token || relogio) return;
  const enviar = async () => {
    try { await pedir(`/sessoes/${encodeURIComponent(estado.token)}/leitura`, ler()); }
    catch { /* uma leitura perdida nao estraga a recarga; a proxima vai */ }
  };
  enviar();
  relogio = setInterval(enviar, INTERVALO_LEITURA_MS);
}

export async function encerrar(ler){
  if (!estado.online || !estado.token) return;
  if (relogio){ clearInterval(relogio); relogio = null; }
  try {
    await pedir(`/sessoes/${encodeURIComponent(estado.token)}/leitura`, ler());
    await pedir(`/sessoes/${encodeURIComponent(estado.token)}/encerrar`, {});
  } catch { /* ja acabou para quem importa: o carro esta cheio */ }
}

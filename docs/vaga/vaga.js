/* ==========================================================================
   Telinha da vaga — comportamento

   Este codigo vivia num <script> inline dentro do index.html. Funcionava no
   GitHub Pages, que nao manda CSP, e nao funcionava em smartcharge.ia.br, que
   manda `script-src 'self'`: o navegador recusava o bloco inteiro e a telinha
   ficava parada em producao. O sintoma era discreto -- a pagina abria certa,
   so nao andava --, que e o jeito mais caro de um bug se esconder.

   Fora do HTML ele e servido como arquivo do proprio site, e a CSP aceita.
   ========================================================================== */
/* ------------------------------------------------------------------
   Curva de recarga — espelha ai/charge_curve.py.

   A conta roda AQUI, no navegador da telinha, de proposito: quando a
   internet da loja cai, a tela continua funcionando. Tela apagada ao
   lado da vaga e pior que nenhuma tela. E a mesma pagina serve o
   celular do motorista pelo QR — nao existe aplicativo para instalar.
------------------------------------------------------------------ */
const P = new URLSearchParams(location.search);
if (P.get('full') === '1') document.documentElement.classList.add('full');

/* Padroes calibrados no carro que o Brasil mais compra: BYD Dolphin Mini,
   35.681 unidades no primeiro semestre de 2026. Bateria de 30 kWh, carregador
   de bordo de 6,6 kW, consumo de ~10,4 km/kWh.

   O carregador de bordo do carro e o gargalo, nao o ponto da loja: colocar um
   ponto CA de 22 kW nao entrega mais rapido para um carro que so aceita 6,6. */
const cfg = {
  spot:      P.get('vaga')  || 'Vaga 1',
  store:     P.get('loja')  || 'Mercado Bom Preço',
  batteryKwh:+(P.get('bateria')  || 30),
  onboardKw: +(P.get('carro')    || 6.6),
  maxKw:     +(P.get('ponto')    || 7.4),
  eff:        0.92,
  tailRatio:  0.15,
  soc:       +(P.get('soc')      || 0.30),
  priceKwh:  +(P.get('preco')    || 1.60),
  /* O motorista PAGA a recarga, por kWh. Nao existe mais recarga de graca:
     a energia e receita da loja, e a vaga se banca sozinha.

     O que traz a pessoa para dentro e o cashback: uma fatia do que ela pagou
     volta como credito que so vale nesta loja. Percentual e nao valor fixo,
     porque recarga pequena e recarga grande nao merecem o mesmo incentivo.

     A recarga NUNCA pausa. Depois de cheio a vaga passa a ser cobrada por
     minuto, e isso cobra o ESPACO, nao a energia. */
  cashbackPct: +(P.get('cashback') ?? 10),     // % do valor que volta como credito
  idleFee:   +(P.get('ocioso')   || 0.20),     // R$ por minuto de vaga ocupada
  graceMin:  +(P.get('carencia') || 15),
  kmPerKwh:  +(P.get('kmkwh')    || 10.4),
  speed:     +(P.get('speed')    || 180),      // 1 = tempo real
};

const ceilingKw = () => Math.min(cfg.onboardKw, cfg.maxKw) * cfg.eff;

/* Onde a bateria comeca a desacelerar. Depende da velocidade da recarga:
   num ponto lento ela segura quase ate o fim; num rapido corta bem antes. */
function knee(){
  const cRate = ceilingKw() / Math.max(1e-6, cfg.batteryKwh);
  return Math.max(0.55, Math.min(0.95, 0.95 - 0.20 * cRate));
}
function powerAt(soc){
  const ceil = ceilingKw(), k = knee();
  if (soc <= k) return ceil;
  return ceil * (1 - (1 - cfg.tailRatio) * ((soc - k) / (1 - k)));
}
function hoursTo(from, to){
  if (to <= from) return 0;
  to = Math.min(to, 0.999);
  let h = 0, s = from;
  while (s < to){
    const step = Math.min(0.001, to - s);
    h += (cfg.batteryKwh * step) / powerAt(s + step / 2);
    s += step;
  }
  return h;
}

const brl   = v => v.toLocaleString('pt-BR', {style:'currency', currency:'BRL'});
const clock = d => d.toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
function relative(hours){
  if (hours <= 0) return 'agora';
  const m = Math.round(hours * 60);
  if (m < 60) return `em ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `em ${h}h${String(r).padStart(2,'0')}` : `em ${h}h`;
}

const start = cfg.soc;
let soc = cfg.soc;
let idleMinutes = 0;       // vaga ocupada depois de o carro encher
let last = performance.now();

/* O credito que esta recarga ja gerou, em reais. */
const cashbackBrl = kwh => kwh * cfg.priceKwh * cfg.cashbackPct / 100;

const $ = id => document.getElementById(id);
$('spot').textContent  = cfg.spot;
$('store').textContent = cfg.store;

/* ------------------------------------------------------------------
   O painel de custo.

   A recarga e paga, entao a tela diz quanto esta custando. O que ela mostra
   junto, e com o mesmo destaque, e quanto ja voltou como credito da loja —
   porque e esse numero que faz a pessoa entrar em vez de so carregar.

   A vaga ocupada depois de cheio continua sendo cobrada por minuto, passada
   a carencia: isso cobra o ESPACO, nao a energia.
------------------------------------------------------------------ */
function renderCost(deliveredKwh, isFull){
  const label = $('costLabel'), value = $('cost'), note = $('costNote');
  const energia = deliveredKwh * cfg.priceKwh;
  const ocioso = Math.max(0, idleMinutes - cfg.graceMin) * cfg.idleFee;
  const credito = cashbackBrl(deliveredKwh);

  label.textContent = ocioso > 0 ? 'A pagar (com vaga ocupada)' : 'Custo até agora';
  value.textContent = brl(energia + ocioso);
  value.className = 'v amber';

  if (ocioso > 0){
    note.textContent = `${brl(cfg.idleFee)} por minuto de vaga ocupada`;
    return;
  }
  const previsto = deliveredKwh + Math.max(0, (1 - soc) * cfg.batteryKwh);
  note.textContent = cfg.cashbackPct > 0
    ? `${brl(cfg.priceKwh)}/kWh · ${brl(credito)} já voltaram como crédito da loja`
    : `${brl(cfg.priceKwh)} por kWh · cheio dá ${brl(previsto * cfg.priceKwh)}`;
}

function render(){
  const isFull = soc >= 0.995;
  const delivered = Math.max(0, (soc - start) * cfg.batteryKwh);

  $('screen').classList.toggle('done', isFull);
  $('pct').textContent = Math.floor(soc * 100);
  $('fill').style.width = (soc * 100) + '%';
  $('kwh').textContent = delivered.toFixed(1).replace('.', ',') + ' kWh';
  $('km').textContent  = Math.round(delivered * cfg.kmPerKwh) + ' km';

  const now = new Date();
  const h80 = hoursTo(soc, 0.80), h100 = hoursTo(soc, 1.00);

  if (soc >= 0.80){
    $('t80').textContent = 'ok';
    $('t80rel').textContent = 'já passou';
  } else {
    $('t80').textContent = clock(new Date(now.getTime() + h80 * 3600e3));
    $('t80rel').textContent = relative(h80);
  }
  $('t100').textContent = isFull ? 'ok' : clock(new Date(now.getTime() + h100 * 3600e3));
  $('t100rel').textContent = isFull ? 'completo' : relative(h100);

  renderCost(delivered, isFull);

  $('stateText').textContent = isFull ? 'Completo' : 'Carregando';

  /* A mensagem fala em quilometros, nao em kWh: e o que a pessoa entende e
     e o que faz a oferta parecer o que ela e. Numa visita de 45 minutos um
     Dolphin Mini leva cerca de 47 km — um dia inteiro de rodagem urbana. */
  if (isFull){
    $('hint').textContent = 'Carro cheio. Pode liberar a vaga para o próximo.';
  } else if (cfg.cashbackPct > 0){
    const credito = cashbackBrl(delivered);
    $('hint').textContent = credito >= 0.5
      ? `Você já tem ${brl(credito)} de crédito para gastar aqui dentro. Mostre o código no caixa.`
      : `${cfg.cashbackPct}% desta recarga voltam como crédito da loja. A gente avisa quando encher.`;
  } else {
    $('hint').textContent = 'Pode ir às compras. A gente avisa quando encher.';
  }
}

function tick(t){
  const dt = (t - last) / 1000;
  last = t;
  const simMinutes = dt * cfg.speed / 60;
  if (soc >= 0.995){
    aoEncher();
    idleMinutes += simMinutes;
  } else {
    soc = Math.min(0.999, soc + (powerAt(soc) * (simMinutes / 60)) / cfg.batteryKwh);
  }
  render();
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------
   Arranque.

   Sem rede, e o que sempre foi: desenha e roda a simulacao. Com rede, o
   servidor manda os numeros reais da loja, e se houver disputa de potencia a
   tela pergunta ANTES de comecar -- depois de plugado a escolha ja nao tem
   graca, porque a pessoa nao vai desplugar para mudar de ideia.
------------------------------------------------------------------ */
import { conectar, perguntarLeilao, abrirSessao, comecarRelatorios, encerrar, estado }
  from './online.js?v=20260918e';

function leituraAtual(){
  const entregue = Math.max(0, (soc - start) * cfg.batteryKwh);
  return {
    soc: Number(soc.toFixed(3)),
    potencia_kw: Number(powerAt(soc).toFixed(3)),
    energia_kwh: Number(entregue.toFixed(3)),
    minutos_ocioso: Math.round(idleMinutes),
  };
}

let encerrada = false;
function aoEncher(){
  if (encerrada) return;
  encerrada = true;
  encerrar(leituraAtual);
}

(async () => {
  const c = await conectar();
  if (c){
    cfg.spot = c.vaga;
    cfg.store = c.loja;
    cfg.priceKwh = c.preco_kwh_brl;
    cfg.cashbackPct = c.cashback_pct * (c.cashback_fator || 1);
    cfg.maxKw = c.potencia_nominal_kw;
    cfg.idleFee = c.taxa_ociosidade_min || cfg.idleFee;
    cfg.graceMin = c.carencia_min ?? cfg.graceMin;
    $('spot').textContent = cfg.spot;
    $('store').textContent = cfg.store;

    if (c.leilao?.ativo && c.leilao.ofertas?.length > 1){
      const oferta = await perguntarLeilao(c.leilao.ofertas);
      if (oferta){
        // A escolha vira teto de potencia da simulacao: e o que o carregador
        // faria de verdade, limitando a corrente entregue.
        cfg.maxKw = Math.min(cfg.maxKw, oferta.potencia_kw);
        cfg.cashbackPct = c.cashback_pct * oferta.cashback_fator;
      }
    } else if (c.limitada_pela_rede){
      cfg.maxKw = Math.min(cfg.maxKw, c.potencia_liberada_kw);
    }

    await abrirSessao(cfg.soc);
    comecarRelatorios(leituraAtual);
  }
  render();
  requestAnimationFrame(tick);
})();

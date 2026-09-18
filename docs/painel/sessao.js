/* ==========================================================================
   Acompanhar a recarga pelo celular

   Aberta pelo QR da telinha da vaga. NAO pede login, e isso e uma escolha:
   quem leu o codigo estava fisicamente ao lado do carregador, e exigir
   cadastro ali seria cobrar um pedagio no pior momento possivel -- a pessoa
   quer ver quanto falta, nao criar conta.

   O que essa chave compra e o minimo: o andamento daquela recarga. Nada de
   identificar quem e, nada de saldo, nada da loja alem do nome. Ver a rota
   /s/{token} do lado do servidor.
   ========================================================================== */

const P = new URLSearchParams(location.search);
const TOKEN = P.get("t");

/* Cinco segundos. A recarga e lenta e nada muda mais rapido que isso; um
   intervalo curto so gastaria bateria do celular de quem esta esperando. */
const INTERVALO_MS = 5000;

const $ = id => document.getElementById(id);
const brl = v => Number(v || 0).toLocaleString("pt-BR",
  { style: "currency", currency: "BRL" });
const num = (v, casas = 1) => Number(v || 0).toLocaleString("pt-BR",
  { minimumFractionDigits: casas, maximumFractionDigits: casas });

const ESTADOS = {
  ativa: "Carregando",
  concluida: "Completo",
  interrompida: "Interrompida",
};

function semToken(){
  $("sessaoVaga").textContent = "Código ausente";
  $("sessaoNota").textContent =
    "Abra esta página pelo QR da telinha da vaga — é ele que traz o código.";
}

function pintar(d){
  $("sessaoLoja").textContent = d.loja || "Sua recarga";
  $("sessaoVaga").textContent = d.vaga || "—";
  $("sessaoEstado").textContent = ESTADOS[d.situacao] || d.situacao;
  $("sessaoEstado").className = "sessao-estado is-" + d.situacao;

  const pct = d.soc === null || d.soc === undefined ? null : Math.floor(d.soc * 100);
  $("sessaoSoc").textContent = pct === null ? "--" : pct;
  $("sessaoBarra").style.width = (pct === null ? 0 : pct) + "%";

  $("sessaoKwh").textContent = num(d.energia_kwh) + " kWh";
  $("sessaoKw").textContent = d.potencia_kw === null || d.potencia_kw === undefined
    ? "— kW" : num(d.potencia_kw) + " kW";

  $("sessaoValor").textContent = brl(d.valor_brl);
  $("sessaoCashback").textContent = brl(d.cashback_brl);

  /* Se a pessoa aceitou menos potencia no leilao, a tela DIZ -- e diz o que
     ela ganhou com isso. Sem essa linha o cashback maior vira mistério, e
     mistério em conta de dinheiro vira desconfiança. */
  const leilao = $("sessaoLeilao");
  if (d.leilao_fator && d.leilao_potencia_pct){
    leilao.hidden = false;
    leilao.innerHTML = `Você aceitou <b>${Math.round(d.leilao_potencia_pct)}% da potência</b>
      para outro carro poder carregar junto. Por isso este crédito está
      <b>${num(d.leilao_fator, 1)}× maior</b> que a tabela da loja.`;
  } else {
    leilao.hidden = true;
  }

  const ocioso = $("blocoOcioso");
  if (d.minutos_ocioso > 0){
    ocioso.hidden = false;
    $("sessaoOcioso").innerHTML =
      `O carro está cheio e a vaga segue ocupada há <b>${d.minutos_ocioso} min</b>.
       Passada a carência, a loja passa a cobrar pelo espaço.`;
  } else {
    ocioso.hidden = true;
  }

  if (d.situacao !== "ativa"){
    $("sessaoNota").textContent = d.situacao === "concluida"
      ? "Recarga encerrada. O crédito já está na sua fidelidade desta loja."
      : "Esta recarga foi interrompida.";
  }
  return d.situacao === "ativa";
}

async function buscar(){
  const r = await fetch(`/s/${encodeURIComponent(TOKEN)}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

async function laco(){
  try {
    const continuar = pintar(await buscar());
    if (continuar) setTimeout(laco, INTERVALO_MS);
  } catch (erro){
    $("sessaoNota").textContent = String(erro.message) === "404"
      ? "Não encontrei esta recarga. O código pode ter expirado."
      : "Sem conexão agora. Vou tentar de novo em instantes.";
    // 404 nao se resolve tentando de novo; falha de rede, sim.
    if (String(erro.message) !== "404") setTimeout(laco, INTERVALO_MS * 2);
  }
}

/* A cortina espera a primeira pintura: sem isto ela sairia com a tela montada
   e vazia, e o número apareceria depois — o piscar que ela existe para evitar. */
const soltar = window.carregando?.aguardar?.() || (() => {});
if (!TOKEN) semToken();
else await laco();
soltar();

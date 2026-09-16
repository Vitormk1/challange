import { api, ErroApi } from "./api.js?v=20260916n";

const el = s => document.querySelector(s);
const brl = v => new Intl.NumberFormat("pt-BR", {style:"currency", currency:"BRL"}).format(Number(v));
const data = v => new Date(v).toLocaleString("pt-BR", {day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit"});
const nomes = {PENDING:"Aguardando pagamento", OVERDUE:"Prazo encerrado", CONFIRMED:"Confirmado", RECEIVED:"Confirmado", REFUNDED:"Devolvido", DELETED:"Cancelado"};
const pago = p => Boolean(p.recebido_em) && !["REFUNDED", "DELETED"].includes(p.status);
let ativa = null, timer = null, consultando = false, cobrancas = [], filtro = "todos", movimentos = [];

function mensagem(texto, erro = false) {
  el("[data-mensagem]").textContent = texto;
  el("[data-mensagem]").classList.toggle("erro", erro);
}
function falha(e) {
  if (e instanceof ErroApi && e.semSessao) location.replace("./entrar.html?proximo=carteira.html");
  else mensagem(e.message || "Não foi possível atualizar a carteira. Tente novamente.", true);
}
function criar(tag, texto, classe) {
  const x = document.createElement(tag);
  if (texto !== undefined) x.textContent = texto;
  if (classe) x.className = classe;
  return x;
}
function extrato() {
  const lista = el("[data-extrato]"); lista.replaceChildren();
  const itens = movimentos.filter(l => filtro === "todos" || (filtro === "entradas" ? Number(l.valor_brl) > 0 : Number(l.valor_brl) < 0));
  el("[data-extrato-contagem]").textContent = `${itens.length} ${itens.length === 1 ? "movimento" : "movimentos"}`;
  if (!itens.length) {
    const vazio = criar("li", undefined, "extrato-vazio");
    vazio.append(criar("strong", filtro === "todos" ? "Sua carteira começa aqui" : "Nenhum movimento neste filtro"), criar("span", filtro === "todos" ? "Adicione saldo por Pix. Depois da confirmação, o crédito aparecerá aqui." : "Escolha outro filtro para ver o histórico."));
    lista.append(vazio); return;
  }
  for (const l of itens) {
    const negativo = Number(l.valor_brl) < 0, item = criar("li");
    const icone = criar("span", negativo ? "↗" : "↙", `movimento-icone${negativo ? " debito" : ""}`); icone.setAttribute("aria-hidden", "true");
    const titulo = criar("span", undefined, "movimento-texto"); titulo.append(criar("strong", l.descricao), criar("small", data(l.criado_em)));
    item.append(icone, titulo, criar("b", `${negativo ? "−" : "+"} ${brl(Math.abs(Number(l.valor_brl)))}`, negativo ? "debito" : "")); lista.append(item);
  }
}
function historicoPix() {
  const lista = el("[data-cobrancas]"); lista.replaceChildren();
  el("[data-historico-pix]").hidden = !cobrancas.length;
  for (const p of cobrancas) {
    const linha = criar("li"), titulo = criar("span");
    const expirado = p.expira_em && new Date(p.expira_em) <= new Date() && !pago(p);
    titulo.append(criar("strong", brl(p.valor_brl)), criar("small", `${nomes[p.status] || p.status}${expirado && p.status === "PENDING" ? " · código vencido" : ""} · ${data(p.criado_em)}`));
    const botao = criar("button", p.status === "PENDING" && !expirado ? "Ver Pix" : "Conferir", "botao-texto"); botao.type = "button";
    botao.onclick = async () => { mostrarPix(p); if (!p.copia_e_cola && p.status === "PENDING") await conferir(); };
    linha.append(titulo, botao); lista.append(linha);
  }
}
async function carregar({retomar = false} = {}) {
  el("[data-atualizar]").disabled = true;
  try {
    const d = await api.carteira();
    el("[data-saldo]").textContent = brl(d.saldo_brl);
    el("[data-atualizacao]").textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR", {hour:"2-digit", minute:"2-digit"})}`;
    el("[data-form-pix]").hidden = !d.pix_disponivel;
    el("[data-pix-indisponivel]").hidden = d.pix_disponivel;
    el("[data-sandbox]").hidden = d.ambiente !== "sandbox";
    el("[data-credito-teste]").hidden = !d.modo_demo;
    el("[data-documento]").hidden = !d.documento_necessario; el("[data-cpf]").required = d.documento_necessario;
    movimentos = d.lancamentos; cobrancas = d.cobrancas; extrato(); historicoPix();
    const cashback = el("[data-cashback]"); cashback.replaceChildren();
    for (const loja of d.cashback_lojas || []) {
      const linha = criar("li"), titulo = criar("span");
      titulo.append(criar("strong", loja.loja), criar("small", `${loja.cupons} ${Number(loja.cupons) === 1 ? "cupom disponível" : "cupons disponíveis"}`));
      linha.append(titulo, criar("b", brl(loja.saldo_brl))); cashback.append(linha);
    }
    if (!cashback.children.length) cashback.append(criar("li", "Nenhum cashback disponível. Seus créditos aparecem após uma recarga vinculada à sua conta."));
    if (ativa) { const atual = cobrancas.find(p => p.id === ativa.id); if (atual) mostrarPix(atual, false); }
    else if (retomar) {
      const pendente = cobrancas.find(p => p.status === "PENDING" && (!p.expira_em || new Date(p.expira_em) > new Date()));
      if (pendente) { mostrarPix(pendente, false); mensagem("Você tem um Pix pendente. Pode usar o mesmo código para concluir."); }
    }
  } catch (e) { falha(e); }
  finally { el("[data-atualizar]").disabled = false; }
}
function validade() {
  if (!ativa) return;
  const restante = ativa.expira_em ? new Date(ativa.expira_em).getTime() - Date.now() : null;
  const encerrado = pago(ativa) || ["REFUNDED", "DELETED"].includes(ativa.status);
  const vencido = !encerrado && restante !== null && restante <= 0;
  const prazo = restante !== null && restante >= 86400000 ? `${Math.ceil(restante / 86400000)} dias restantes` : `${Math.ceil(restante / 60000)} min restantes`;
  el("[data-pix-validade]").textContent = encerrado ? "" : restante === null ? "Recupere o código para ver a validade." : vencido ? "Este código venceu. Confira o pagamento antes de gerar outro Pix." : `Válido até ${data(ativa.expira_em)} · ${prazo}`;
  el("[data-copiar]").hidden = encerrado;
  el("[data-copiar]").disabled = encerrado || vencido || !ativa.copia_e_cola;
  el("[data-qr]").hidden = encerrado || vencido || !ativa.imagem_base64; el("[data-copia]").hidden = encerrado || vencido || !ativa.copia_e_cola;
  if (vencido || encerrado) { clearTimeout(timer); timer = null; }
}
function mostrarPix(p, foco = true) {
  ativa = p; el("[data-pix]").hidden = false; el("[data-pix-valor]").textContent = brl(p.valor_brl); el("[data-copia]").value = p.copia_e_cola || "";
  if (p.imagem_base64) {
    /* A Asaas normalmente envia somente o Base64, mas algumas respostas e
       integrações podem devolver o valor já como Data URL. Prefixar sempre
       criava `data:image/png;base64,data:image/...`, que aparece na tela mas
       não pode ser lido por um app de banco. Aceitamos os dois formatos e
       removemos quebras de linha introduzidas no transporte. */
    const imagem = String(p.imagem_base64).trim();
    el("[data-qr]").src = imagem.startsWith("data:image/")
      ? imagem
      : `data:image/png;base64,${imagem.replace(/\s+/g, "")}`;
  }
  const confirmado = pago(p); el("[data-pix]").classList.toggle("pix-confirmado", confirmado);
  if (confirmado) mensagem("Saldo atualizado. Seu pagamento já aparece no extrato.");
  el("[data-verificar]").textContent = confirmado ? "Conferir status na Asaas" : "Já paguei · conferir pagamento";
  el("[data-pix-status]").textContent = confirmado ? "Pagamento confirmado. O crédito está no seu saldo." : p.status === "REFUNDED" ? "Este Pix foi devolvido. Consulte o estorno no extrato." : p.status === "DELETED" ? "Esta cobrança foi cancelada." : "Aguardando a confirmação do pagamento.";
  el("[data-pix-titulo]").textContent = confirmado ? "Tudo certo! Saldo adicionado" : "Pague pelo app do seu banco";
  validade(); clearTimeout(timer); timer = null;
  if (!confirmado && p.status === "PENDING" && (!p.expira_em || new Date(p.expira_em) > new Date())) timer = setTimeout(acompanhar, 6000);
  if (foco) el("[data-pix]").scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block:"start"});
}
async function acompanhar() {
  if (!ativa || document.hidden || consultando) return;
  consultando = true;
  try {
    const p = await api.consultarPix(ativa.id), mudou = p.status !== ativa.status || p.recebido_em !== ativa.recebido_em;
    mostrarPix(p, false); if (mudou) await carregar();
  } catch (e) {
    if (e instanceof ErroApi && e.semSessao) falha(e);
    else { el("[data-pix-status]").textContent = "A conexão oscilou. Use o botão abaixo para conferir o pagamento."; clearTimeout(timer); timer = setTimeout(acompanhar, 15000); }
  } finally { consultando = false; }
}
async function conferir() {
  if (!ativa || consultando) return;
  const b = el("[data-verificar]"); b.disabled = true; b.textContent = "Conferindo…"; consultando = true;
  try {
    const p = await api.verificarPix(ativa.id); mostrarPix(p, false); await carregar();
    if (!pago(p) && p.status === "PENDING") el("[data-pix-status]").textContent = "A Asaas ainda não confirmou. Se acabou de pagar, aguarde alguns instantes.";
  } catch (e) { falha(e); }
  finally { consultando = false; b.disabled = false; b.textContent = ativa && pago(ativa) ? "Conferir status na Asaas" : "Já paguei · conferir pagamento"; }
}
export function valorDigitado(texto) {
  const limpo = texto.trim().replace(/\s/g, "");
  if (!/^(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?:\.\d{3})+,\d{1,2})$/.test(limpo)) return null;
  const n = Number(limpo.includes(",") ? limpo.replace(/\./g, "").replace(",", ".") : limpo);
  return n >= 5 && n <= 1000 ? n.toFixed(2) : null;
}
el("[data-form-pix]").onsubmit = async e => {
  e.preventDefault(); const valor = valorDigitado(el("[data-valor]").value);
  if (!valor) { mensagem("Informe de R$ 5,00 a R$ 1.000,00, com até duas casas decimais.", true); el("[data-valor]").focus(); return; }
  const b = el("[data-enviar-pix]"); b.disabled = true; b.textContent = "Gerando seu Pix…"; mensagem("Preparando o código. Aguarde sem fechar esta página.");
  try { const p = await api.criarPix(valor, el("[data-cpf]").value); mostrarPix(p); el("[data-cpf]").value = ""; mensagem("Pix pronto. Escaneie o QR Code ou copie o código para o app do banco."); await carregar(); }
  catch (e) { falha(e); await carregar({retomar:true}); }
  finally { b.disabled = false; b.textContent = "Gerar Pix"; }
};
document.querySelectorAll("[data-valor-rapido]").forEach(b => {
  b.onclick = () => { el("[data-valor]").value = `${b.dataset.valorRapido},00`; document.querySelectorAll("[data-valor-rapido]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); mensagem(""); };
});
el("[data-valor]").oninput = () => document.querySelectorAll("[data-valor-rapido]").forEach(x => x.setAttribute("aria-pressed", "false"));
el("[data-verificar]").onclick = conferir; el("[data-atualizar]").onclick = () => carregar({retomar:true});
el("[data-fechar-pix]").onclick = () => { clearTimeout(timer); timer = null; ativa = null; el("[data-pix]").hidden = true; mensagem("O código continua no histórico de Pix. Fechar não cancela a cobrança."); };
el("[data-copiar]").onclick = async () => {
  try { await navigator.clipboard.writeText(el("[data-copia]").value); el("[data-copiar]").textContent = "Código copiado ✓"; setTimeout(() => { el("[data-copiar]").textContent = "Copiar código Pix"; }, 2500); }
  catch { el("[data-copia]").focus(); el("[data-copia]").select(); mensagem("Selecione e copie o código acima para colar no app do banco."); }
};
document.querySelectorAll("[data-filtro]").forEach(b => { b.onclick = () => { filtro = b.dataset.filtro; document.querySelectorAll("[data-filtro]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); extrato(); }; });
el("[data-exportar]").onclick = () => {
  const linhas = [["Data", "Descrição", "Tipo", "Valor (BRL)"], ...movimentos.map(l => [data(l.criado_em), l.descricao, l.tipo, String(l.valor_brl).replace(".", ",")])];
  const csv = "\uFEFF" + linhas.map(l => l.map(v => `"${String(v).replace(/^[=+@-]/, "'$&").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], {type:"text/csv;charset=utf-8"}));
  const a = criar("a"); a.href = url; a.download = "smartcharge-extrato.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
el("[data-credito-teste]").onclick = async e => {
  e.currentTarget.disabled = true;
  try { await api.creditoTeste(); await carregar(); mensagem("Crédito fictício de sandbox adicionado. Não representa dinheiro real."); }
  catch (erro) { falha(erro); } finally { el("[data-credito-teste]").disabled = false; }
};
document.addEventListener("visibilitychange", () => { clearTimeout(timer); timer = null; if (!document.hidden && ativa) acompanhar(); });
window.addEventListener("pagehide", () => clearTimeout(timer)); setInterval(validade, 30000);
try { const sessao = await api.eu(); if (sessao.usuario.papel === "motorista") await carregar({retomar:true}); else location.replace("./entrar.html"); }
catch (e) { falha(e); }

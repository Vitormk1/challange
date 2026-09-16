/* ==========================================================================
   Ajustes da conta

   Foto, tema, nome e senha. A casca (barra de abas, sair, guarda de sessão)
   vem do cliente.js, que já roda nesta tela — aqui fica só o que é desta aba.

   O `pintarAvatar` é importado de lá de propósito: o avatar aparece na barra
   e nesta tela em tamanhos diferentes, e duas cópias da mesma regra é onde
   elas começam a divergir.
   ========================================================================== */

import { api, ErroApi } from "./api.js?v=20260916y";
import { pintarAvatar, sessao } from "./cliente.js?v=20260916y";

const el = s => document.querySelector(s);

function dizer(alvo, texto, tipo = ""){
  const p = el(alvo);
  if (!p) return;
  p.textContent = texto;
  p.classList.toggle("is-erro", tipo === "erro");
  p.classList.toggle("is-ok", tipo === "ok");
}

function explicar(erro){
  if (erro instanceof ErroApi && erro.semRede){
    return "O servidor não respondeu. Ele hiberna quando fica sem uso — "
         + "tente de novo em um minuto.";
  }
  return erro?.message || "Não deu certo. Tente de novo.";
}

/* ------------------------------------------------------------------ tema */

/* O tema é gravado nos dois lugares, e cada um serve a uma coisa.

   No localStorage porque o carregando.js lê antes da primeira pintura — é o
   que evita o lampejo branco de quem usa tema escuro. Uma ida ao servidor
   nunca chegaria a tempo disso.

   Na conta porque aí a escolha acompanha a pessoa para outro aparelho. */
function aplicarTema(escolha){
  const efetivo = escolha === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : escolha;
  document.documentElement.dataset.theme = efetivo;
  document.body.dataset.theme = efetivo;
}

function temaSalvo(){
  try { return localStorage.getItem("pr.tema") || "system"; } catch { return "system"; }
}

function ligarTema(preferencias){
  // O que o servidor guarda só vale se este aparelho ainda não tiver escolha
  // própria: quem acabou de trocar aqui não pode ver a escolha antiga de outro
  // aparelho passar por cima.
  let escolha = temaSalvo();
  try {
    if (!localStorage.getItem("pr.tema") && preferencias?.tema) escolha = preferencias.tema;
  } catch { /* aba anônima: segue com o padrão */ }

  aplicarTema(escolha);
  const marcado = document.querySelector(`input[name="tema"][value="${escolha}"]`);
  if (marcado) marcado.checked = true;

  document.querySelectorAll('input[name="tema"]').forEach(radio => {
    radio.onchange = async () => {
      const novo = radio.value;
      aplicarTema(novo);
      try { localStorage.setItem("pr.tema", novo); } catch { /* segue sem guardar */ }
      try {
        await api.preferencias({ ...(preferencias || {}), tema: novo });
      } catch {
        // A tela já mudou e o localStorage já guardou. Falhar em avisar o
        // servidor custa só o "vale nos outros aparelhos" — não vale jogar um
        // erro vermelho por cima de algo que visivelmente funcionou.
      }
    };
  });
}

/* ------------------------------------------------------------------ foto */

const LADO = 256;

/* Recorta quadrado e reduz para 256×256 antes de subir.

   Feito aqui, e não no servidor, por três motivos: a foto de 4 MB da câmera
   nunca sai do aparelho, o servidor não precisa de biblioteca de imagem, e a
   coluna guarda ~20 KB em vez de alguns megabytes. O recorte é central, do
   maior quadrado que cabe — é o que as pessoas esperam de uma foto de perfil.
*/
function encolher(arquivo){
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(new Error("Não consegui ler o arquivo."));
    leitor.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Esse arquivo não parece uma imagem."));
      img.onload = () => {
        const lado = Math.min(img.width, img.height);
        const tela = document.createElement("canvas");
        tela.width = tela.height = LADO;
        const p = tela.getContext("2d");
        p.imageSmoothingQuality = "high";
        p.drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2,
                    lado, lado, 0, 0, LADO, LADO);
        // JPEG a 85%: para uma foto de rosto de 256px, a diferença para PNG é
        // invisível e o arquivo fica umas dez vezes menor.
        resolve(tela.toDataURL("image/jpeg", 0.85));
      };
      img.src = leitor.result;
    };
    leitor.readAsDataURL(arquivo);
  });
}

function ligarFoto(usuario){
  const entrada = el("[data-arquivo]");
  const remover = el("[data-remover-foto]");
  const grande = el(".avatar-grande");

  function repintar(){
    document.querySelectorAll("[data-avatar]").forEach(a => pintarAvatar(a, usuario));
    remover.hidden = !usuario.foto_v;
  }
  repintar();

  el("[data-escolher]").onclick = () => entrada.click();

  entrada.onchange = async () => {
    const arquivo = entrada.files?.[0];
    if (!arquivo) return;
    dizer("[data-msg-foto]", "Preparando a imagem…");
    try {
      const encolhida = await encolher(arquivo);
      const r = await api.trocarFoto(encolhida);
      usuario.foto_v = r.foto_v;
      repintar();
      dizer("[data-msg-foto]", "Foto atualizada.", "ok");
    } catch (erro){
      dizer("[data-msg-foto]", explicar(erro), "erro");
    } finally {
      // Limpa o input: sem isso, escolher o MESMO arquivo de novo não dispara
      // onchange, e a tela parece ter ignorado o clique.
      entrada.value = "";
      if (grande) grande.classList.remove("is-carregando");
    }
  };

  remover.onclick = async () => {
    remover.disabled = true;
    try {
      await api.removerFoto();
      usuario.foto_v = null;
      repintar();
      dizer("[data-msg-foto]", "Foto removida.", "ok");
    } catch (erro){
      dizer("[data-msg-foto]", explicar(erro), "erro");
    } finally {
      remover.disabled = false;
    }
  };
}

/* ------------------------------------------------------------ nome/senha */

function ligarNome(usuario){
  const form = el("[data-form-nome]");
  const botao = el("[data-enviar-nome]");
  el("[data-nome]").value = usuario.nome || "";

  form.onsubmit = async ev => {
    ev.preventDefault();
    const nome = el("[data-nome]").value.trim();
    const senha = el("[data-senha-nome]").value;
    if (nome.length < 2){ dizer("[data-msg-nome]", "Escreva ao menos 2 letras.", "erro"); return; }
    botao.disabled = true;
    dizer("[data-msg-nome]", "Salvando…");
    try {
      const r = await api.trocarNome(nome, senha);
      usuario.nome = r.nome;
      el("[data-senha-nome]").value = "";
      document.querySelectorAll("[data-avatar]").forEach(a => pintarAvatar(a, usuario));
      dizer("[data-msg-nome]", "Nome atualizado.", "ok");
    } catch (erro){
      dizer("[data-msg-nome]", explicar(erro), "erro");
    } finally {
      botao.disabled = false;
    }
  };
}

function ligarSenha(){
  const form = el("[data-form-senha]");
  const botao = el("[data-enviar-senha]");

  form.onsubmit = async ev => {
    ev.preventDefault();
    const atual = el("[data-senha-atual]").value;
    const nova = el("[data-senha-nova]").value;
    if (nova.length < 8){
      dizer("[data-msg-senha]", "A senha nova precisa de pelo menos 8 caracteres.", "erro");
      return;
    }
    botao.disabled = true;
    dizer("[data-msg-senha]", "Trocando…");
    try {
      const r = await api.trocarSenha(atual, nova);
      form.reset();
      const n = r.outras_sessoes_encerradas || 0;
      dizer("[data-msg-senha]",
        n ? `Senha trocada. ${n} outra(s) sessão(ões) foram encerradas.`
          : "Senha trocada.", "ok");
    } catch (erro){
      dizer("[data-msg-senha]", explicar(erro), "erro");
    } finally {
      botao.disabled = false;
    }
  };
}

/* ----------------------------------------------------------------- conta */

const PAPEIS = { motorista: "Motorista", gerente: "Gerente", operador: "Operador", main: "Desenvolvedor" };

function preencherConta(perfil){
  const u = perfil.usuario || {};
  el("[data-email]").textContent = u.email || "—";
  el("[data-papel]").textContent = PAPEIS[u.papel] || u.papel || "—";
  el("[data-desde]").textContent = u.criado_em
    ? new Date(u.criado_em).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })
    : "—";
  el("[data-sessoes]").textContent = String(perfil.sessoes_abertas ?? "—");
}

/* ----------------------------------------------------------------- monta */

const soltarCortina = window.carregando ? window.carregando.aguardar() : null;

try {
  // A sessao ja foi resolvida pelo cliente.js, que roda antes nesta tela.
  // Pedir de novo seria uma segunda ida ao servidor para a mesma resposta.
  const usuario = sessao?.usuario;
  if (!usuario) throw new ErroApi(401, "sem sessão");

  el("#saudacao").textContent = (usuario.nome || "").trim().split(/\s+/)[0] || "Sua conta";

  ligarTema(usuario.preferencias);
  ligarFoto(usuario);
  ligarNome(usuario);
  ligarSenha();

  // O perfil vem numa segunda chamada porque traz o que /auth/eu não traz
  // (quando a conta foi criada, quantas sessões estão abertas). Se falhar, o
  // resto da tela continua utilizável — por isso o catch é só desta parte.
  try {
    preencherConta(await api.perfil());
  } catch {
    el("[data-email]").textContent = usuario.email || "—";
    el("[data-papel]").textContent = PAPEIS[usuario.papel] || "—";
  }
} catch (erro){
  /* Um `catch` mudo aqui seria o pior dos mundos: a tela abriria com todos os
     campos vazios e sem uma palavra de explicacao, e nem o console teria
     pista. Este projeto ja perdeu horas exatamente assim -- so as falhas eram
     registradas, entao "nao tem nada no log" nao queria dizer nada.

     Sem sessao o cliente.js ja manda para o login, entao chegar aqui e sinal
     de outra coisa. Diz na tela e diz no console. */
  console.error("ajustes:", erro);
  const aviso = el("[data-estado-conexao]");
  if (aviso){
    aviso.textContent = erro instanceof ErroApi && erro.semRede
      ? explicar(erro)
      : "Não consegui carregar seus ajustes. Recarregue a página — se "
        + "continuar, o erro está no console.";
    aviso.hidden = false;
  }
} finally {
  if (soltarCortina) soltarCortina();
}

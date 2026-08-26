/* ==========================================================================
   Smart Charge — site de apresentação

   Quatro coisas: o carrossel das telas do painel, o menu do celular, a
   entrada dos blocos por rolagem e a assistente do canto.

   Sem módulo e sem import, porque não há o que dividir — e a página carrega
   antes de o servidor do Render sair da hibernação.
   ========================================================================== */
(() => {
  "use strict";

  /* ---------------------------------------------------------- carrossel ---
     Troca automática, mas com três freios: para no hover, para quando a aba
     sai de vista e não começa se a pessoa pediu menos animação. Carrossel que
     anda sozinho enquanto alguém lê a legenda é irritante, não é recurso. */
  const carrossel = document.getElementById("carrossel");
  if (carrossel) {
    const telas = [...carrossel.querySelectorAll(".carrossel-janela img")];
    const pontos = document.getElementById("carrosselPontos");
    const PAUSA = 5200;
    let atual = 0;
    let relogio = null;

    const menosMovimento = matchMedia("(prefers-reduced-motion: reduce)");

    telas.forEach((tela, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-label", `Tela ${i + 1} de ${telas.length}`);
      b.addEventListener("click", () => { mostrar(i); reiniciar(); });
      pontos.append(b);
    });
    const bolinhas = [...pontos.children];

    function mostrar(i) {
      atual = (i + telas.length) % telas.length;
      telas.forEach((t, n) => t.classList.toggle("is-ativo", n === atual));
      bolinhas.forEach((b, n) => {
        b.classList.toggle("is-ativo", n === atual);
        b.setAttribute("aria-selected", String(n === atual));
      });
    }

    function reiniciar() {
      clearInterval(relogio);
      if (menosMovimento.matches) return;
      relogio = setInterval(() => mostrar(atual + 1), PAUSA);
    }

    mostrar(0);
    reiniciar();

    carrossel.addEventListener("mouseenter", () => clearInterval(relogio));
    carrossel.addEventListener("mouseleave", reiniciar);
    carrossel.addEventListener("focusin", () => clearInterval(relogio));
    carrossel.addEventListener("focusout", reiniciar);
    // aba escondida: o navegador estrangula o timer e os slides se acumulam
    document.addEventListener("visibilitychange", () => {
      document.hidden ? clearInterval(relogio) : reiniciar();
    });
    menosMovimento.addEventListener("change", reiniciar);

    // arrastar com o dedo, que é como se espera folhear no celular
    let x0 = null;
    carrossel.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; }, { passive: true });
    carrossel.addEventListener("touchend", e => {
      if (x0 === null) return;
      const d = e.changedTouches[0].clientX - x0;
      if (Math.abs(d) > 40) { mostrar(atual + (d < 0 ? 1 : -1)); reiniciar(); }
      x0 = null;
    }, { passive: true });
  }

  /* ----------------------------------------------------- menu do celular ---
     O `hidden` só é posto aqui, e não no HTML: sem JavaScript o menu tem que
     continuar aberto e navegável, senão a página perde a navegação inteira
     por causa de um script que não carregou. */
  const botao = document.getElementById("abrirMenu");
  const menu = document.getElementById("menu");
  if (botao && menu) {
    // 900, e não 760: é o mesmo número do corte da navegação no site.css.
    // Se os dois discordarem, o botão passa a abrir uma gaveta numa largura
    // em que o menu já está em linha, ou some numa largura em que ele não
    // cabe. Mudou lá, muda aqui.
    const estreito = () => matchMedia("(max-width: 900px)").matches;

    const fechar = () => {
      menu.hidden = true;
      botao.setAttribute("aria-expanded", "false");
      botao.setAttribute("aria-label", "Abrir menu");
    };
    const abrir = () => {
      menu.hidden = false;
      botao.setAttribute("aria-expanded", "true");
      botao.setAttribute("aria-label", "Fechar menu");
    };

    const ajustar = () => { estreito() ? fechar() : (menu.hidden = false); };
    ajustar();
    addEventListener("resize", ajustar);

    botao.addEventListener("click", () => (menu.hidden ? abrir() : fechar()));

    // tocar num item leva para a âncora; deixar a folha aberta por cima do
    // destino seria esconder justamente o que a pessoa foi ver
    menu.addEventListener("click", e => {
      if (e.target.closest("a") && estreito()) fechar();
    });

    addEventListener("keydown", e => {
      if (e.key === "Escape" && estreito() && !menu.hidden) { fechar(); botao.focus(); }
    });

    document.addEventListener("click", e => {
      if (!estreito() || menu.hidden) return;
      if (e.target.closest("#menu, #abrirMenu")) return;
      fechar();
    });
  }

  /* ------------------------------------------------------ entrada por rolagem ---
     As classes são postas AQUI e não no HTML, de propósito. Elas zeram a
     opacidade, e quem depende do HTML para isso entrega uma página em branco
     a quem carregou sem JavaScript ou num navegador sem IntersectionObserver.
     Pondo por script, e só depois de confirmar que o observador existe, o pior
     caso vira "sem animação" em vez de "sem site".

     A direção de cada bloco acompanha onde ele está na composição: coluna da
     esquerda entra pela esquerda, imagem da direita pela direita, título sobe.
     Movimento que contraria o layout confunde em vez de guiar — por isso os
     blocos alternados invertem junto com o layout deles.

     O herói fica de fora: animar a primeira coisa que a pessoa vê faria a
     página piscar depois de já estar montada. */
  const podeAnimar = "IntersectionObserver" in window
    && !matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (podeAnimar) {
    const PASSO = 70;        // ms entre irmãos de uma mesma leva
    const TETO = 5;          // acima disso o último item da lista demora demais
    const fila = [];
    const por = (raiz, sel) => [...raiz.querySelectorAll(sel)];

    /* marcar(elemento, direção, atraso) — a fila é montada antes de tocar no
       DOM para nenhum elemento ser marcado duas vezes por dois seletores que
       se sobrepõem (um .cartao também é filho de .grade-cartoes). */
    const marcar = (no, dir, atraso = 0) => {
      if (!no || fila.some(f => f.no === no)) return;
      fila.push({ no, dir, atraso });
    };
    const cascata = (nos, dir, base = 0) =>
      nos.forEach((no, i) => marcar(no, typeof dir === "function" ? dir(i) : dir,
                                    base + Math.min(i, TETO) * PASSO));

    document.querySelectorAll("main > section").forEach(secao => {
      // cabeçalho da seção: sobe, e o texto dele vem logo atrás
      const cabeca = secao.querySelector(".cabeca-secao");
      if (cabeca) {
        marcar(cabeca.querySelector(".olho"), "e");
        marcar(cabeca.querySelector("h2"), "b", 60);
        // :not(.olho) porque o olho TAMBÉM é um <p>, e é o primeiro: sem
        // isto o querySelector devolvia ele de novo, a guarda de duplicata
        // recusava, e o parágrafo de corpo nunca entrava na fila
        marcar(cabeca.querySelector("p:not(.olho)"), "b", 130);
      }

      // carrossel do painel: cresce no lugar, que é o gesto de "olhe isto"
      marcar(secao.querySelector(".carrossel"), "z", 120);
      marcar(secao.querySelector(".legenda-carrossel"), "b", 260);

      // duas colunas: texto pela esquerda, aparelho pela direita
      const duas = secao.querySelector(".duas-colunas");
      if (duas) {
        const col = duas.querySelector(":scope > div");
        if (col) {
          marcar(col.querySelector(".olho"), "e");
          marcar(col.querySelector("h2"), "e", 70);
          marcar(col.querySelector("p:not(.olho)"), "e", 140);
          cascata(por(col, ".lista-marcada li"), "e", 210);
        }
        marcar(duas.querySelector(".celular"), "d", 120);
      }

      // grade de segmentos: esquerda, baixo, direita, e repete — a variação
      // é o que faz a grade entrar como grade e não como uma lista
      cascata(por(secao, ".grade-cartoes > .cartao"),
              i => ["e", "b", "d"][i % 3]);

      // blocos alternados: cada metade entra do lado em que ela já está
      por(secao, ".bloco").forEach(bloco => {
        const invertido = bloco.classList.contains("is-invertido");
        const texto = bloco.querySelector(":scope > div");
        const figura = bloco.querySelector(".bloco-figura");
        if (texto) {
          marcar(texto.querySelector("h3"), invertido ? "d" : "e");
          cascata(por(texto, ".passos li"), invertido ? "d" : "e", 90);
        }
        marcar(figura, invertido ? "e" : "d", 80);
      });
    });

    // chamada final: desce do alto, para destoar do resto e fechar a página
    const chamada = document.querySelector(".chamada .envelope");
    if (chamada) {
      marcar(chamada.querySelector("h2"), "c");
      marcar(chamada.querySelector("p"), "c", 80);
      marcar(chamada.querySelector(".chamada-acoes"), "b", 170);
    }

    // rodapé: colunas em cascata da esquerda
    cascata(por(document, ".rodape-grade > div"), "e");
    marcar(document.querySelector(".rodape-fim"), "b", 260);

    const observador = new IntersectionObserver((entradas, obs) => {
      entradas.forEach(e => {
        if (!e.isIntersecting) return;
        e.target.classList.add("is-dentro");
        obs.unobserve(e.target);      // entra uma vez; não repete na volta
      });
    }, { rootMargin: "0px 0px -10% 0px", threshold: 0.05 });

    fila.forEach(({ no, dir, atraso }) => {
      no.classList.add("rev", `rev-${dir}`);
      if (atraso) no.style.setProperty("--atraso", `${atraso}ms`);
      observador.observe(no);
    });

    /* Rede de segurança: o observador não dispara para o que já está na tela
       em navegador que restaura a rolagem no meio da página, e não dispara de
       jeito nenhum se a aba abrir em segundo plano. Passado um tempo, o que
       ainda estiver invisível dentro da janela entra sem esperar. */
    setTimeout(() => {
      fila.forEach(({ no }) => {
        if (no.classList.contains("is-dentro")) return;
        const r = no.getBoundingClientRect();
        if (r.top < innerHeight && r.bottom > 0) no.classList.add("is-dentro");
      });
    }, 1200);
  }

  /* ------------------------------------------------------------- assistente ---
     Conversa com /ia/publico, que não pede login e não tem acesso ao banco.
     O teto de uso é do servidor (api/protecao.py); aqui o que existe é o teto
     de tamanho, para não mandar um texto enorme e receber um 400 de volta. */
  const iaBotao = document.getElementById("iaBotao");
  const iaJanela = document.getElementById("iaJanela");

  if (iaBotao && iaJanela) {
    const iaFechar = document.getElementById("iaFechar");
    const iaMensagens = document.getElementById("iaMensagens");
    const iaForm = document.getElementById("iaForm");
    const iaTexto = document.getElementById("iaTexto");
    const iaEnviar = document.getElementById("iaEnviar");
    const iaEstado = document.getElementById("iaEstado");
    const iaSugestoes = document.getElementById("iaSugestoes");
    const iaChamariz = document.getElementById("iaChamariz");

    // A API é a mesma origem que serve esta página. Em desenvolvimento o
    // painel roda em 127.0.0.1:8000 e a página vem de lá também, então não há
    // caso de origem cruzada para tratar.
    const ROTA = "/ia/publico";
    const historico = [];
    let ocupada = false;
    let abriuAlgumaVez = false;

    const balao = (texto, tipo) => {
      const p = document.createElement("div");
      p.className = `ia-balao is-${tipo}`;
      p.textContent = texto;
      iaMensagens.append(p);
      iaMensagens.scrollTop = iaMensagens.scrollHeight;
      return p;
    };

    const abrir = () => {
      iaJanela.hidden = false;
      iaBotao.setAttribute("aria-expanded", "true");
      iaChamariz.hidden = true;
      if (!abriuAlgumaVez) {
        abriuAlgumaVez = true;
        balao("Oi! Eu apresento o Smart Charge. Pergunte sobre o cashback, o "
            + "painel, os segmentos atendidos ou como o projeto foi feito.", "ia");
      }
      iaTexto.focus();
    };
    const fechar = () => {
      iaJanela.hidden = true;
      iaBotao.setAttribute("aria-expanded", "false");
      iaBotao.focus();
    };

    iaBotao.addEventListener("click", () => (iaJanela.hidden ? abrir() : fechar()));
    iaFechar.addEventListener("click", fechar);
    addEventListener("keydown", e => {
      if (e.key === "Escape" && !iaJanela.hidden) fechar();
    });

    // o chamariz some no primeiro clique em qualquer lugar, não só no botão
    iaChamariz.addEventListener("click", abrir);
    setTimeout(() => { if (iaJanela.hidden) iaChamariz.hidden = false; }, 2600);
    iaChamariz.hidden = true;

    iaSugestoes.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      iaTexto.value = b.textContent.trim();
      iaForm.requestSubmit();
    });

    // o campo cresce com o texto, até o teto que o CSS define
    iaTexto.addEventListener("input", () => {
      iaTexto.style.height = "auto";
      iaTexto.style.height = `${Math.min(iaTexto.scrollHeight, 110)}px`;
    });
    // Enter envia, Shift+Enter quebra linha
    iaTexto.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); iaForm.requestSubmit(); }
    });

    iaForm.addEventListener("submit", async e => {
      e.preventDefault();
      const pergunta = iaTexto.value.trim();
      if (!pergunta || ocupada) return;

      ocupada = true;
      iaEnviar.disabled = true;
      iaSugestoes.hidden = true;
      iaTexto.value = "";
      iaTexto.style.height = "auto";
      balao(pergunta, "pessoa");
      historico.push({ papel: "user", texto: pergunta });

      iaEstado.textContent = "Pensando...";
      document.querySelectorAll("bms-ai-entity").forEach(o => o.setAttribute("state", "thinking"));
      const espera = balao("", "ia");
      espera.innerHTML = '<span class="ia-pensando"><i></i><i></i><i></i></span>';

      try {
        const r = await fetch(ROTA, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pergunta, historico: historico.slice(-4) }),
        });
        const dados = await r.json().catch(() => ({}));
        if (!r.ok) {
          // o 429 traz o texto do limite, que é a mensagem certa a mostrar
          throw new Error(dados.detail || `Não consegui responder agora (${r.status}).`);
        }
        espera.textContent = dados.resposta;
        historico.push({ papel: "assistant", texto: dados.resposta });
      } catch (erro) {
        espera.remove();
        balao(erro.message || "Não consegui falar com o servidor agora.", "erro");
      } finally {
        ocupada = false;
        iaEnviar.disabled = false;
        iaEstado.textContent = "Pronta para falar sobre o projeto";
        document.querySelectorAll("bms-ai-entity").forEach(o => o.setAttribute("state", "idle"));
        iaMensagens.scrollTop = iaMensagens.scrollHeight;
        iaTexto.focus();
      }
    });
  }
})();

/* ==========================================================================
   Smart Charge — site de apresentação

   Duas coisas só: o carrossel das telas do painel e o menu do celular.
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
})();

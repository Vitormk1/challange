/* ==========================================================================
   Smart Charge — vídeo pitch

   Motion (static/motion/motion.js) servido daqui mesmo, não de CDN: a CSP
   declara `script-src 'self'`, e abrir isso para um terceiro custaria muito
   mais que a comodidade.

   O filme inteiro é UMA sequência do Motion, não uma corrente de setTimeout.
   A diferença não é estética: uma sequência devolve um controle com `time`,
   `duration`, `pause()` e `play()`, e é isso que permite pausar, voltar e
   arrastar a barra. Com timers encadeados, pausar exigiria contabilidade
   própria de quanto já passou de cada trecho — e é sempre ali que aparece o
   bug de a cena repetir ou pular.
   ========================================================================== */
(() => {
  "use strict";

  const { animate, stagger } = window.Motion || {};
  const $ = id => document.getElementById(id);
  const $$ = sel => [...document.querySelectorAll(sel)];

  const controles = $("controles");
  const btnTocar = $("btnTocar");
  const btnRepetir = $("btnRepetir");
  const trilha = $("trilha");
  const trilhaCheia = $("trilhaCheia");
  const trilhaMarcas = $("trilhaMarcas");
  const tempo = $("tempo");
  const cenas = $$(".cena");

  const menosMovimento = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Se o Motion não carregou, ou a pessoa pediu menos movimento, o filme não
     roda de saída — e não pode virar tela preta. Mostra o fecho inteiro,
     parado, que é a cena que carrega a mensagem e o caminho para o site. */
  function mostrarFecho() {
    const fecho = document.querySelector('[data-cena="7"]');
    fecho.classList.add("is-ativa");
    fecho.setAttribute("aria-hidden", "false");
    fecho.style.opacity = "1";
    fecho.querySelectorAll("*").forEach(el => { el.style.opacity = "1"; });
    fecho.style.pointerEvents = "auto";
    controles.hidden = true;
  }

  if (!animate) { mostrarFecho(); return; }

  /* "Menos movimento" é preferência de sistema, e vale como padrão — mas quem
     clicou num link chamado "vídeo pitch" veio ver o vídeo. Respeitar a
     preferência é não tocar sozinho; não é recusar.

     Uma escolha só nesta tela. Antes ficavam dois botões lado a lado, o
     "Conhecer o projeto" da cena de fecho e o convite para assistir — e isso
     é oferecer saída a quem acabou de entrar. Quem chegou aqui já decidiu o
     que queria; a porta para o site continua existindo no fim do vídeo, que
     é onde ela faz sentido. */
  if (menosMovimento) {
    mostrarFecho();
    const fecho = document.querySelector('[data-cena="7"]');
    const paraOSite = fecho.querySelector(".fecho-botao");
    paraOSite.hidden = true;

    const convite = document.createElement("button");
    convite.type = "button";
    convite.className = "assistir-assim";
    convite.textContent = "Assistir ao vídeo";
    convite.addEventListener("click", () => {
      convite.remove();
      paraOSite.hidden = false;      // volta a valer quando o vídeo terminar
      document.querySelectorAll(".cena, .cena *").forEach(el => { el.style.opacity = ""; });
      fecho.style.pointerEvents = "";
      controles.hidden = false;
      montarFilme();
    });
    fecho.append(convite);
    convite.focus();
    return;
  }

  montarFilme();
  /* O filme inteiro vive aqui dentro. É declaração de função, não
     expressão: assim ela sobe por hoisting e pode ser chamada lá em
     cima, onde a decisão de tocar ou não é tomada. */
  function montarFilme() {
    // liga o filme e desarma o bloco de reduced-motion do anuncio.css
    document.body.classList.add("tocando");

    /* --------------------------------------------------------------------
       O roteiro

       Cada cena declara quando entra e quanto dura. Os tempos são absolutos
       em segundos, porque um anúncio se ajusta lendo a régua inteira — com
       durações relativas, mexer numa cena empurra todas as outras e a conta
       deixa de caber na cabeça.
       -------------------------------------------------------------------- */
    const ROTEIRO = [
      { cena: 1, em: 0.0,  dura: 4.6 },
      { cena: 2, em: 4.6,  dura: 6.4 },
      { cena: 3, em: 11.0, dura: 4.6 },
      { cena: 4, em: 15.6, dura: 8.2 },
      { cena: 5, em: 23.8, dura: 8.0 },
      { cena: 6, em: 31.8, dura: 5.4 },
      { cena: 7, em: 37.2, dura: 6.0 },
    ];
    const DURACAO = ROTEIRO[ROTEIRO.length - 1].em + ROTEIRO[ROTEIRO.length - 1].dura;

    const de = n => document.querySelector(`[data-cena="${n}"]`);
    const dentro = (n, sel) => [...de(n).querySelectorAll(sel)];

    /* A curva. Uma só, usada em quase tudo: é o que faz as sete cenas
       parecerem a mesma peça e não sete animações diferentes. */
    const SAIDA = [0.22, 0.61, 0.36, 1];
    /* x/y/scale como propriedades separadas, e NUNCA `transform: [...,"none"]`.
       Interpolar uma lista de funções contra a palavra-chave `none` faz o
       Motion produzir matrix(0,0,0,0,0,0) — escala zero. A caixa continua
       medindo certo e o elemento some da tela, que é o pior tipo de bug:
       o layout parece correto em toda inspeção. */
    const sobe = (y = 26) => ({ opacity: [0, 1], y: [y, 0] });

    const trechos = [];
    const add = (alvo, quadros, opcoes) => trechos.push([alvo, quadros, opcoes]);

    /* ---- a entrada e a saída de cada cena ----
       Feitas aqui, em laço, e não escritas sete vezes: o fade de cena é o
       mesmo em todas, e repetir isso à mão é como um deles acaba com 0,4s
       enquanto os outros têm 0,5. */
    ROTEIRO.forEach(({ cena, em, dura }) => {
      const el = de(cena);
      add(el, { opacity: [0, 1] }, { at: em, duration: 0.55, ease: "easeOut" });
      add(el, { opacity: [1, 0] }, { at: em + dura - 0.5, duration: 0.5, ease: "easeIn" });
    });

    /* ---- 1 · abertura ---- */
    add($("fio").firstElementChild, { transform: ["scale(0)", "scale(1)"] },
        { at: 0.25, duration: 1.15, ease: SAIDA });
    add(".abertura-marca", { opacity: [0, 1], scale: [0.7, 1] },
        { at: 1.15, duration: 0.7, ease: SAIDA });
    add(".abertura-nome .letra", { opacity: [0, 1], y: [22, 0] },
        { at: 1.5, duration: 0.55, delay: stagger(0.045), ease: SAIDA });
    add($("fio").firstElementChild, { opacity: [1, 0] },
        { at: 3.2, duration: 0.8, ease: "easeOut" });

    /* ---- 2 · o problema ---- */
    // a foto entra com um travelling lento: 8s de zoom quase imperceptível é o
    // que separa "imagem parada" de "plano"
    add(".cena-foto", { opacity: [0, 0.85], scale: [1.12, 1] },
        { at: 4.6, duration: 6.4, ease: "linear" });
    dentro(2, ".frase").forEach((el, i) =>
      add(el, sobe(20), { at: 5.1 + i * 1.5, duration: 0.6, ease: SAIDA }));

    /* ---- 3 · a virada ---- */
    add(".virada-cima", sobe(14), { at: 11.3, duration: 0.55, ease: SAIDA });
    add(".virada-baixo", { opacity: [0, 1], y: [34, 0], scale: [0.97, 1] },
        { at: 11.75, duration: 0.85, ease: SAIDA });

    /* ---- 4 · o modelo ---- */
    add('[data-cena="4"] .rotulo-cena', sobe(12), { at: 15.9, duration: 0.5, ease: SAIDA });
    // Os nós entram na ordem em que a história acontece, e os tracinhos crescem
    // ENTRE eles: é a animação que explica a sequência sem precisar de texto.
    dentro(4, ".no").forEach((el, i) =>
      add(el, { opacity: [0, 1], y: [24, 0], scale: [0.96, 1] },
          { at: 16.3 + i * 1.35, duration: 0.6, ease: SAIDA }));
    /* `transform` como string, com os DOIS extremos escritos — nunca "none"
       de um lado, e nunca a propriedade solta `scale` contra um transform no
       CSS: nos dois casos as coisas se compõem e o resultado fica em zero.
       Medido nas três formas; só esta pinta.

       Escalar os dois eixos, e não o eixo da orientação: o filme é montado
       uma vez, e quem girasse o aparelho no meio ficava com a animação no
       eixo errado. Como o tracinho tem 2px na dimensão curta, escalar os
       dois é visualmente idêntico. */
    dentro(4, ".tracinho i").forEach((el, i) =>
      add(el, { transform: ["scale(0)", "scale(1)"] },
          { at: 16.95 + i * 1.35, duration: 0.5, ease: SAIDA }));
    add(".modelo-fecho", sobe(16), { at: 20.6, duration: 0.6, ease: SAIDA });

    /* ---- 5 · o produto ---- */
    add('[data-cena="5"] .rotulo-cena', sobe(12), { at: 24.1, duration: 0.5, ease: SAIDA });
    add(".produto-texto h2", sobe(24), { at: 24.4, duration: 0.7, ease: SAIDA });
    add(".marcas li", sobe(16),
        { at: 24.9, duration: 0.5, delay: stagger(0.13), ease: SAIDA });
    // as telas entram em paralaxe: a de trás primeiro, mais lenta
    add(".tela-1", { opacity: [0, 1], x: [-26, 0], y: [26, 0], scale: [0.94, 1] },
        { at: 24.6, duration: 0.9, ease: SAIDA });
    add(".tela-2", { opacity: [0, 1], x: [30, 0], y: [34, 0], scale: [0.94, 1] },
        { at: 25.1, duration: 0.9, ease: SAIDA });
    add(".tela-celular", { opacity: [0, 1], y: [46, 0], scale: [0.9, 1] },
        { at: 25.7, duration: 0.85, ease: SAIDA });

    /* ---- 6 · segmentos ---- */
    add('[data-cena="6"] .rotulo-cena', sobe(12), { at: 32.1, duration: 0.5, ease: SAIDA });
    add(".segmentos span", { opacity: [0, 1], y: [18, 0], scale: [0.94, 1] },
        { at: 32.4, duration: 0.5, delay: stagger(0.1), ease: SAIDA });
    add(".segmentos-nota", sobe(14), { at: 33.6, duration: 0.6, ease: SAIDA });

    /* ---- 7 · fecho ---- */
    add(".fio-fecho i", { transform: ["scale(0)", "scale(1)"] },
        { at: 37.4, duration: 1.0, ease: SAIDA });
    add(".fecho-marca", { opacity: [0, 1], scale: [0.72, 1] },
        { at: 37.6, duration: 0.7, ease: SAIDA });
    add(".fecho-nome", sobe(20), { at: 38.0, duration: 0.6, ease: SAIDA });
    add(".fecho-linha", sobe(14), { at: 38.35, duration: 0.55, ease: SAIDA });
    add(".fecho-botao", { opacity: [0, 1], y: [16, 0], scale: [0.96, 1] },
        { at: 38.8, duration: 0.55, ease: SAIDA });
    add(".fecho-creditos", { opacity: [0, 1] }, { at: 39.3, duration: 0.6, ease: "easeOut" });

    /* --------------------------------------------------------------------
       Tocar
       -------------------------------------------------------------------- */
    const filme = animate(trechos, { duration: DURACAO });
    let tocando = true;

    // Marcas de cena na barra, para o filme se mostrar como peça de partes
    ROTEIRO.slice(1).forEach(({ em }) => {
      const i = document.createElement("i");
      i.style.left = `${(em / DURACAO) * 100}%`;
      trilhaMarcas.append(i);
    });

    const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

    /* `visibility` acompanha a cena ativa, e não só a opacidade: cena
       transparente continua clicável e continua sendo lida por leitor de tela,
       o que faria o botão do fecho ser alcançável no meio do filme. */
    let cenaVisivel = null;
    function marcarCena(t) {
      const atual = ROTEIRO.find(r => t >= r.em - 0.6 && t < r.em + r.dura) || ROTEIRO[0];
      if (cenaVisivel === atual.cena) return;
      cenaVisivel = atual.cena;
      cenas.forEach(el => {
        const eh = Number(el.dataset.cena) === atual.cena;
        el.classList.toggle("is-ativa", eh);
        el.setAttribute("aria-hidden", String(!eh));
        el.style.pointerEvents = eh ? "auto" : "none";
      });
    }

    /* Um só lugar escreve barra, relógio e cena. O laço de rAF chama isto a
       cada quadro, mas quem mexe no tempo por botão, tecla ou arrasto também
       chama — senão a tela só se corrige no quadro seguinte, e quando o rAF
       está estrangulado (aba em segundo plano) ela não se corrige nunca. */
    function atualizarBarra() {
      const t = Math.min(filme.time || 0, DURACAO);
      trilhaCheia.style.width = `${(t / DURACAO) * 100}%`;
      trilha.setAttribute("aria-valuenow", String(Math.round((t / DURACAO) * 100)));
      tempo.textContent = mmss(t);
      marcarCena(t);
    }

    function pintar() {
      atualizarBarra();
      requestAnimationFrame(pintar);
    }
    requestAnimationFrame(pintar);

    function estado(ligado) {
      tocando = ligado;
      ligado ? filme.play() : filme.pause();
      /* Classe no botão, e não `.hidden` nos dois <svg>. `hidden` é
         propriedade de HTMLElement; SVGElement não a tem, então
         `svg.hidden = true` só cria um campo solto no objeto — o atributo
         nunca aparece no DOM, o CSS nunca vê, e os dois ícones ficavam
         desenhados um por cima do outro o tempo todo. */
      btnTocar.classList.toggle("is-pausado", !ligado);
      btnTocar.setAttribute("aria-label", ligado ? "Pausar" : "Continuar");
      atualizarBarra();
    }

    btnTocar.addEventListener("click", () => estado(!tocando));
    btnRepetir.addEventListener("click", () => { filme.time = 0; estado(true); atualizarBarra(); });

    filme.finished.then(() => {
      // No fim ele fica no fecho, parado, com o botão de repetir à mão. Voltar
      // ao começo sozinho prenderia quem só queria ver uma vez.
      estado(false);
      filme.time = DURACAO;
    }).catch(() => {});

    /* ---- arrastar a barra ---- */
    const irPara = clientX => {
      const b = trilha.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - b.left) / b.width));
      filme.time = f * DURACAO;
      atualizarBarra();
    };
    let arrastando = false;
    trilha.addEventListener("pointerdown", ev => {
      arrastando = true;
      // try/catch e não só `?.`: o método existe e mesmo assim lança quando
      // não há ponteiro ativo com aquele id. Sem a proteção, a exceção sobe
      // no meio do handler e o arrasto inteiro morre antes de mover nada.
      try { trilha.setPointerCapture(ev.pointerId); } catch {}
      filme.pause();
      irPara(ev.clientX);
    });
    trilha.addEventListener("pointermove", ev => { if (arrastando) irPara(ev.clientX); });
    const largar = () => { if (!arrastando) return; arrastando = false; if (tocando) filme.play(); };
    trilha.addEventListener("pointerup", largar);
    trilha.addEventListener("pointercancel", largar);

    /* ---- teclado ----
       Espaço para pausar e setas para pular são o que qualquer um tenta num
       player; não custam nada e a falta delas se nota. */
    addEventListener("keydown", ev => {
      /* `ev.target` nem sempre é Element — num evento disparado no window ele
         é o próprio window, e `.closest` não existe ali. Sem esta checagem o
         handler lançava TypeError e NENHUMA tecla funcionava.

         E a guarda vale só para o espaço: espaço com foco num botão é o
         próprio botão sendo acionado, e interceptar seria roubar o clique.
         As setas valem sempre — inclusive com foco no play, que é
         exatamente onde o foco fica depois de alguém pausar. */
      const alvo = ev.target instanceof Element ? ev.target : null;
      const emControle = Boolean(alvo && alvo.closest("a, button"));

      if (ev.key === " " || ev.key === "k") {
        if (emControle) return;
        ev.preventDefault();
        estado(!tocando);
      } else if (ev.key === "ArrowRight") {
        filme.time = Math.min(DURACAO, filme.time + 5); atualizarBarra();
      } else if (ev.key === "ArrowLeft") {
        filme.time = Math.max(0, filme.time - 5); atualizarBarra();
      } else if (ev.key === "Home") {
        filme.time = 0; atualizarBarra();
      }
    });
    trilha.addEventListener("keydown", ev => {
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") ev.stopPropagation();
    });

    /* Aba escondida: o navegador estrangula o rAF e o filme continuaria
       correndo sem ninguém olhando — para, e retoma onde parou. */
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) filme.pause();
      else if (tocando) filme.play();
    });

    requestAnimationFrame(() => controles.classList.add("is-visivel"));
  }

})();

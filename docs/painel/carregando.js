/* ==========================================================================
   Cortina de carregamento — comportamento

   Script clássico, no <head>, SEM defer: roda antes de o body ser lido. É o
   primeiro código nosso a executar em qualquer tela, e faz duas coisas.

   1. Aplica o tema salvo antes da primeira pintura. Antes disso cada módulo
      aplicava o tema quando terminava de carregar, então quem usava tema
      escuro via um lampejo branco em toda navegação.

   2. Comanda a saída da cortina.

   Quando sair
   -----------
   Por padrão, no `load` -- que é "a página carregou toda", incluindo imagens
   e folhas de estilo.

   Só que `load` não sabe nada sobre dados. No painel, no mapa e na carteira
   ele dispara com a tela ainda vazia, e o conteúdo aparece depois: exatamente
   o piscar que a cortina existe para evitar. Por isso esses módulos avisam:

       const pronto = window.carregando && window.carregando.aguardar();
       ...
       pronto && pronto();

   `aguardar()` é chamado de forma SÍNCRONA no topo do módulo. Isso importa:
   módulos são adiados, e todos terminam de ser avaliados antes do `load`, de
   modo que toda inscrição já existe quando o `load` chega. Inscrever dentro
   de um `then` seria tarde demais, e a cortina sairia antes da hora.

   A cortina sai quando o `load` já passou E não há mais ninguém aguardando.
   Uma tela com dois módulos (a carteira tem) espera os dois, sem que eles
   precisem saber um do outro.

   Teto de 8s
   ----------
   Aconteça o que acontecer, a cortina sai. Se a API não responde, a pessoa
   precisa ver a tela e a mensagem de erro que o módulo escreveu -- não uma
   cortina para sempre. O CSS tem um segundo teto, aos 12s, para o caso de
   este arquivo nem chegar a rodar.
   ========================================================================== */

(function () {
  "use strict";

  var TETO = 8000;

  /* ------------------------------------------------------------------ tema */

  try {
    var escolha = localStorage.getItem("pr.tema") || "system";
    var efetivo = escolha === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : escolha;
    document.documentElement.setAttribute("data-theme", efetivo);
  } catch (e) {
    /* Aba anônima ou dados bloqueados. Sem data-theme, o CSS cai no
       prefers-color-scheme, que é a melhor suposição disponível. */
  }

  /* --------------------------------------------------------------- cortina */

  var aguardando = 0;
  var carregou = document.readyState === "complete";
  var saiu = false;

  function sair() {
    if (saiu) return;
    saiu = true;
    var cortina = document.getElementById("carregando");
    if (!cortina) return;
    cortina.classList.add("saiu");
    // Tirar do DOM depois da transição: enquanto ela existe, continua
    // recebendo clique e sendo lida por leitor de tela, mesmo invisível.
    window.setTimeout(function () {
      if (cortina.parentNode) cortina.parentNode.removeChild(cortina);
    }, 400);
  }

  function tentar() {
    if (carregou && aguardando <= 0) sair();
  }

  window.carregando = {
    /* Devolve a função que libera esta espera. Ela só conta uma vez, mesmo se
       for chamada de novo -- um módulo que chama no sucesso e no catch não
       derruba a conta para baixo de zero. */
    aguardar: function () {
      if (saiu) return function () {};
      aguardando++;
      var liberou = false;
      return function () {
        if (liberou) return;
        liberou = true;
        aguardando--;
        tentar();
      };
    },
    /* Saída imediata, para quem preferir decidir sozinho. */
    pronto: sair
  };

  if (!carregou) {
    window.addEventListener("load", function () {
      carregou = true;
      tentar();
    });
  }

  window.setTimeout(sair, TETO);
})();

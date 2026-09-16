/* ==========================================================================
   Smart Charge — mapa de carregadores

   Leaflet servido daqui mesmo (static/leaflet/), não de CDN: a CSP declara
   `script-src 'self'`, e abrir isso para um terceiro numa página pública
   valeria muito mais que a comodidade. O que a página do mapa abre, e só
   ela, é `img-src` para o host de tiles — ver api/protecao.py.

   OS PONTOS SÃO INVENTADOS. Nada aqui vem do banco. As coordenadas são
   geradas por semente fixa em volta de São Paulo, para a tela ser sempre a
   mesma numa apresentação e não pular a cada recarregamento. Quando houver
   integração de verdade, o que muda é a origem de `PONTOS` — o resto da
   página não sabe de onde eles vieram.
   ========================================================================== */

/* Segura a cortina de carregamento ate esta tela ter o que mostrar.
   A chamada e sincrona de proposito: modulos sao avaliados antes do `load`,
   entao inscrever-se aqui garante que a cortina saiba esperar. Inscrever
   dentro de um `then` seria tarde. Ver docs/painel/carregando.js. */
const soltarCortina = window.carregando ? window.carregando.aguardar() : null;
(() => {
  "use strict";

  /* ----------------------------------------------------------- tema ---
     O mapa é uma aba da área do cliente, e trocar de aba não pode trocar de
     tema: quem estava no escuro via o mapa abrir branco na cara.

     A leitura acontece aqui, e não no cliente.js que também cuida disso, por
     uma questão de ordem. Este arquivo é script clássico e roda durante o
     parse; o cliente.js é módulo, e módulo só executa depois. Se a escolha do
     ladrilho esperasse por ele, o mapa já teria pedido os ladrilhos claros —
     e o `data-theme` chegaria tarde, com o branco piscando antes. */
  const TEMA = (() => {
    let escolha = "system";
    try { escolha = localStorage.getItem("pr.tema") || "system"; } catch {}
    return escolha === "system"
      ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : escolha;
  })();
  document.documentElement.dataset.theme = TEMA;
  const ESCURO = TEMA === "dark";

  /* --------------------------------------------------- pontos de verdade ---
     Até aqui os pontos nasciam aqui dentro, de um gerador com semente fixa:
     doze lojas inventadas, coordenadas sorteadas, e `livre` decidido por
     `rnd() > 0.32`. Era honesto enquanto o mapa era ilustração.

     Deixou de ser quando a reserva entrou. Não se reserva uma vaga que só
     existe como constante de JavaScript — precisa ter id, precisa ter dono, e
     precisa que duas pessoas não consigam pegar a mesma.

     Agora vêm de /mapa/pontos. Continuam sendo lugares fictícios, e o aviso na
     tela continua verdadeiro; o que mudou é que cada um é uma linha no banco.
     A disponibilidade também deixou de ser sorteio: sai das reservas.        */
  // Onde o mapa abre. Continua fixo: os pontos são de São Paulo, e começar
  // centralizado neles evita o primeiro quadro mostrando o oceano.
  const CENTRO = [-23.5866, -46.6396];        // Vila Mariana, São Paulo

  let PONTOS = [];
  let VALOR_RESERVA = "10.00";
  let DURACAO_MIN = 60;

  // O banco guarda o segmento em código curto, como as lojas de verdade. A
  // tradução para o que a pessoa lê fica aqui, e não no banco.
  const SEGMENTOS = {
    pet: "Pet shop", mercado: "Supermercado", academia: "Academia",
    restaurante: "Restaurante", farmacia: "Farmácia", shopping: "Shopping",
  };
  const rotuloSegmento = s => SEGMENTOS[s] || s;

  async function carregarPontos() {
    // Caminho relativo: esta página é servida pela própria API, então não há
    // outra origem para apontar — e é o mesmo motivo pelo qual o cookie de
    // sessão chega aqui sem CORS.
    const r = await fetch("/mapa/pontos", { credentials: "include" });
    if (!r.ok) throw new Error(`mapa/pontos respondeu ${r.status}`);
    const d = await r.json();
    PONTOS = d.pontos;
    VALOR_RESERVA = d.valor_reserva_brl;
    DURACAO_MIN = d.duracao_min;
  }

  const num = (v, casas = 2) =>
    v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });

  const ICONE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 3h7a1 1 0 0 1 1 1v16H6V4a1 1 0 0 1 1-1Z"></path>
      <path d="M15 8h2.5a1.5 1.5 0 0 1 1.5 1.5V15a1.5 1.5 0 0 0 1.5 1.5"></path>
      <path d="m11 7-2 3.5h3L10 14"></path></svg>`;

  const $ = id => document.getElementById(id);
  const lista = $("lista");
  const contagem = $("contagemPontos");
  const busca = $("buscaPontos");
  const limpar = $("limparBusca");
  const painel = $("painelLista");
  const pilula = $("botaoLista");
  const rotuloPilula = $("rotuloPilula");
  const alca = $("alcaLista");
  const fechar = $("fecharLista");
  const fab = $("botaoLocal");

  const celular = () => matchMedia("(max-width: 860px)").matches
                     && !matchMedia("(max-height: 460px) and (orientation: landscape)").matches;

  /* ------------------------------------------------------------- mapa --- */
  let mapa = null;
  const marcadores = new Map();
  let ativo = null;
  let marcadorLocal = null;

  if (typeof L !== "undefined") {
    mapa = L.map("mapa", {
      center: CENTRO,
      zoom: 12,
      zoomControl: false,
      worldCopyJump: false,
      minZoom: 3,
      // no celular a rosquinha de zoom por scroll atrapalha mais que ajuda;
      // pinça continua funcionando
      scrollWheelZoom: !celular(),
      tap: false,          // o Leaflet 1.9 já trata toque; o shim antigo duplica clique
    });
    L.control.zoom({ position: "bottomright" }).addTo(mapa);

    /* A chave vem do servidor (config.js), não daqui: assim ela fica fora do
       repositório, que é público e varrido por robô. Continua visível para
       quem abrir o código-fonte — chave de basemap é de cliente por natureza
       — e por isso merece restrição de domínio no painel da CARTO.
       Sem chave, cai no endpoint anônimo, que funciona e é limitado. */
    const chave = (window.CARTO_KEY || "").trim();
    // `voyager` é o mapa claro da CARTO; `dark_all` é o escuro. Os dois
    // existem com e sem chave — conferido antes de escolher, porque
    // `dark_matter`, que é o nome que se esperaria pelo par com voyager,
    // devolve 404 no caminho com chave.
    const estilo = ESCURO ? "dark_all" : "voyager";
    const tiles = chave
      ? `https://{s}.basemaps.cartocdn.com/rastertiles/${estilo}/{z}/{x}/{y}{r}.png?key=${chave}`
      : `https://{s}.basemaps.cartocdn.com/${ESCURO ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`;

    L.tileLayer(tiles, {
      maxZoom: chave ? 20 : 19,
      subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(mapa);

    montarMarcadores();

    // tocar no mapa recolhe a folha, como no Google Maps
    mapa.on("click", () => { if (celular() && aberta()) irPara("fechada"); });
  } else {
    // Leaflet não carregou: a lista assume a página inteira em vez de deixar
    // uma faixa cinza onde o mapa deveria estar
    $("mapa").hidden = true;
    document.querySelector(".mapa-palco").style.gridTemplateColumns = "minmax(0, 1fr)";
    painel.style.transform = "none";
  }

  /* Um marcador por loja. Roda depois da carga, e de novo a cada atualização —
     por isso limpa os anteriores: sem isso, reservar deixaria dois pinos no
     mesmo lugar, o velho e o novo. */
  function montarMarcadores() {
    marcadores.forEach(m => mapa.removeLayer(m));
    marcadores.clear();
    PONTOS.forEach(p => {
      const m = L.marker([p.lat, p.lng], {
        title: p.nome,
        icon: L.divIcon({
          className: "marcador-pino",
          html: `<span class="pino${p.livre ? "" : " is-ocupado"}">${ICONE}</span>`,
          iconSize: [44, 44],
          iconAnchor: [22, 40],
          popupAnchor: [0, -36],
        }),
      }).addTo(mapa);

      const livres = p.carregadores.filter(c => c.livre_agora).length;
      m.bindPopup(`
        <div class="popup">
          <b>${p.nome}</b>
          <small>${rotuloSegmento(p.segmento)}</small>
          <div class="popup-linhas">
            <span>Até <b>${num(p.potencia, 1)} kW</b></span>
            <span>A partir de <b>R$ ${num(p.preco)}/kWh</b></span>
            <span>Cashback de <b>${num(p.cashback, 0)}%</b> para gastar na loja</span>
            <span>${livres ? `<b>${livres} de ${p.vagas} vaga(s) livre(s)</b>`
                            : "Todas as vagas ocupadas agora"}</span>
          </div>
          ${livres ? `<button class="popup-reservar" type="button" data-reservar="${p.id}">
              Fazer reserva</button>` : ""}
        </div>`, { maxWidth: Math.min(280, innerWidth - 56), autoPanPadding: [18, 18] });

      // O botão nasce dentro do balão, que o Leaflet só cria ao abrir — por
      // isso o ouvinte é ligado aqui, e não na montagem.
      m.on("popupopen", ev => {
        const b = ev.popup.getElement().querySelector("[data-reservar]");
        if (b) b.onclick = () => abrirReserva(p);
      });

      m.on("click", () => destacar(p.id, false));
      marcadores.set(p.id, m);
    });
  }

  /* ------------------------------------------------------------ lista --- */
  function desenhar(filtro = "") {
    const t = filtro.trim().toLowerCase();
    const vistos = t
      ? PONTOS.filter(p => `${p.nome} ${rotuloSegmento(p.segmento)}`.toLowerCase().includes(t))
      : PONTOS;

    limpar.hidden = !t;
    contagem.textContent = t
      ? `${vistos.length} de ${PONTOS.length} pontos`
      : `${PONTOS.length} pontos · ${PONTOS.filter(p => p.livre).length} livres agora`;
    rotuloPilula.textContent = t ? `${vistos.length} resultados` : `${PONTOS.length} pontos`;

    if (!vistos.length) {
      lista.innerHTML = `<li class="mapa-vazio">Nada encontrado para essa busca.</li>`;
      return;
    }

    lista.innerHTML = vistos.map(p => `
      <li>
        <button class="mapa-ponto" type="button" data-ponto="${p.id}">
          <span class="mapa-ponto-marca">${ICONE}</span>
          <span>
            <b>${p.nome}</b>
            <small>${rotuloSegmento(p.segmento)}</small>
            <span class="mapa-ponto-selos">
              <span class="selo ${p.livre ? "is-livre" : "is-ocupado"}">${p.livre ? "Livre" : "Ocupado"}</span>
              <span class="selo">${num(p.potencia, 1)} kW</span>
              <span class="selo">${num(p.cashback, 0)}% cashback</span>
            </span>
          </span>
        </button>
      </li>`).join("");

    lista.querySelectorAll("[data-ponto]").forEach(b =>
      b.addEventListener("click", () => destacar(Number(b.dataset.ponto), true)));
  }

  /* Um só caminho para "este ponto agora é o escolhido", venha o toque do
     pino ou da lista — senão os dois lados discordam sobre o que está
     selecionado. */
  function destacar(id, veioDaLista) {
    ativo = id;
    lista.querySelectorAll(".mapa-ponto").forEach(b =>
      b.classList.toggle("is-ativo", Number(b.dataset.ponto) === id));
    document.querySelectorAll(".pino").forEach(p => p.classList.remove("is-ativo"));

    const m = marcadores.get(id);
    if (!m) return;
    m.getElement()?.querySelector(".pino")?.classList.add("is-ativo");

    if (veioDaLista && mapa) {
      // no celular a folha recolhe para o ponto aparecer; no computador não
      // há o que recolher, e mexer na coluna seria gratuito
      if (celular()) irPara("meia");
      mapa.flyTo(m.getLatLng(), Math.max(mapa.getZoom(), 15), { duration: 0.6 });
      m.openPopup();
    } else {
      lista.querySelector(`[data-ponto="${id}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }

  busca.addEventListener("input", () => {
    desenhar(busca.value);
    if (celular() && busca.value.trim() && !aberta()) irPara("meia");
  });
  limpar.addEventListener("click", () => {
    busca.value = "";
    desenhar();
    busca.focus();
  });
  // A primeira pintura da lista acontece depois da carga, lá no fim do
  // arquivo. Chamar aqui desenharia uma lista vazia por um instante.

  /* ==========================================================================
     A folha de baixo

     Três alturas, como a do Google Maps: fechada (fora da tela), meia e
     cheia. O que define qual está valendo é um translateY em pixels, e não
     uma classe por estado — assim o dedo pode parar no meio do caminho e a
     folha o acompanha sem pulo.

     A versão anterior tinha uma alça que só era desenho. Quem tentava puxar
     não conseguia nada, e o botão de fechar de 36px no canto não compensava:
     a queixa que chegou foi "abri a lista e não consigo fechar".
     ========================================================================== */
  const ALTURAS = { fechada: 0, meia: 0.42, cheia: 0.86 };   // fração de 100dvh
  let estado = "fechada";
  let alturaFolha = 0;          // px visíveis, para o CSS mover os flutuantes

  const alturaJanela = () => painel.getBoundingClientRect().height || innerHeight * 0.88;
  const aberta = () => estado !== "fechada";

  /* Quanto da folha aparece, em pixels. O CSS lê isto em --folha para subir o
     botão de localização, o zoom e o aviso junto com ela. */
  function aplicar(px, animando = true) {
    const alt = alturaJanela();
    alturaFolha = Math.max(0, Math.min(alt, px));
    painel.classList.toggle("is-animando", animando);
    painel.style.transform = `translateY(${alt - alturaFolha}px)`;
    document.documentElement.style.setProperty("--folha", `${alturaFolha}px`);
  }

  function irPara(novo, animando = true) {
    estado = novo;
    aplicar(innerHeight * ALTURAS[novo], animando);
    const abriu = aberta();
    pilula.hidden = abriu;
    pilula.setAttribute("aria-expanded", String(abriu));
    painel.setAttribute("aria-hidden", String(!abriu && celular()));
    if (abriu) painel.querySelector(".mapa-pontos").scrollTop = 0;
    // o Leaflet precisa saber que a área útil mudou, senão o centro escorrega
    if (mapa) setTimeout(() => mapa.invalidateSize({ pan: false }), 280);
  }

  pilula.addEventListener("click", () => irPara("meia"));
  fechar.addEventListener("click", () => { irPara("fechada"); pilula.focus(); });
  addEventListener("keydown", e => {
    if (e.key === "Escape" && celular() && aberta()) { irPara("fechada"); pilula.focus(); }
  });

  /* ---- o arrasto ----
     Pointer events cobrem dedo, caneta e mouse com um código só. O
     setPointerCapture é o que garante que o gesto continue sendo nosso
     mesmo se o dedo sair de cima da alça no meio do caminho. */
  let gesto = null;

  const comecar = ev => {
    if (!celular()) return;
    gesto = { y: ev.clientY, base: alturaFolha, t: Date.now(), moveu: false };
    alca.setPointerCapture?.(ev.pointerId);
    painel.classList.remove("is-animando");
  };

  const mover = ev => {
    if (!gesto) return;
    const d = gesto.y - ev.clientY;          // para cima é positivo
    if (Math.abs(d) > 3) gesto.moveu = true;
    aplicar(gesto.base + d, false);
    ev.preventDefault();
  };

  const soltar = ev => {
    if (!gesto) return;
    const d = gesto.y - ev.clientY;
    const rapido = Date.now() - gesto.t < 260 && Math.abs(d) > 40;
    const frac = alturaFolha / innerHeight;

    // Gesto rápido manda na direção; gesto lento vai para a altura mais perto.
    let destino;
    if (rapido) {
      destino = d > 0 ? (estado === "meia" ? "cheia" : "cheia")
                      : (estado === "cheia" ? "meia" : "fechada");
    } else {
      destino = ["fechada", "meia", "cheia"].reduce((melhor, nome) =>
        Math.abs(ALTURAS[nome] - frac) < Math.abs(ALTURAS[melhor] - frac) ? nome : melhor, "fechada");
    }
    gesto = null;
    irPara(destino);
  };

  [alca, document.querySelector(".mapa-lista-topo")].forEach(el => {
    if (!el) return;
    el.addEventListener("pointerdown", comecar);
    el.addEventListener("pointermove", mover);
    el.addEventListener("pointerup", soltar);
    el.addEventListener("pointercancel", soltar);
  });

  /* Rolar a lista até o topo e continuar puxando também fecha, que é o que a
     folha do Maps faz. Sem isto o único jeito de fechar seria a alça. */
  const rolo = painel.querySelector(".mapa-pontos");
  let inicioRolo = null;
  rolo.addEventListener("pointerdown", ev => {
    inicioRolo = rolo.scrollTop <= 0 ? { y: ev.clientY, base: alturaFolha } : null;
  });
  rolo.addEventListener("pointermove", ev => {
    if (!inicioRolo || !celular()) return;
    const d = inicioRolo.y - ev.clientY;
    if (d < -8) {                     // puxando para baixo com a lista no topo
      painel.classList.remove("is-animando");
      aplicar(inicioRolo.base + d, false);
    }
  });
  rolo.addEventListener("pointerup", ev => {
    if (!inicioRolo || !celular()) { inicioRolo = null; return; }
    const d = inicioRolo.y - ev.clientY;
    inicioRolo = null;
    if (d < -8) soltar(ev);
  });

  /* ---- onde estou ---- */
  fab.addEventListener("click", () => {
    if (!mapa || !navigator.geolocation) return;
    fab.disabled = true;
    navigator.geolocation.getCurrentPosition(
      pos => {
        fab.disabled = false;
        fab.classList.add("is-ativo");
        const onde = [pos.coords.latitude, pos.coords.longitude];
        if (marcadorLocal) marcadorLocal.setLatLng(onde);
        else marcadorLocal = L.marker(onde, {
          icon: L.divIcon({ className: "marcador-local", html: '<span class="meu-local"></span>',
                            iconSize: [18, 18], iconAnchor: [9, 9] }),
          interactive: false,
        }).addTo(mapa);
        mapa.flyTo(onde, 14, { duration: 0.8 });
      },
      () => {
        fab.disabled = false;
        // Recusa ou falha não merece alarme: os pontos são fictícios, então
        // "onde estou" é conforto, não requisito. O aviso diz o que houve e
        // some sozinho.
        const antes = document.querySelector(".mapa-aviso span");
        const texto = antes.textContent;
        antes.textContent = "Não consegui pegar sua localização.";
        setTimeout(() => { antes.textContent = texto; }, 3200);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
  });

  /* ---- estado inicial e giro de tela ---- */
  function ajustar() {
    if (celular()) {
      irPara(estado, false);
    } else {
      // no computador a folha é coluna: sem transform, sem --folha
      painel.style.transform = "";
      painel.classList.remove("is-animando");
      painel.removeAttribute("aria-hidden");
      document.documentElement.style.setProperty("--folha", "0px");
      pilula.hidden = true;
    }
    if (mapa) mapa.invalidateSize({ pan: false });
  }

  addEventListener("resize", ajustar);
  addEventListener("orientationchange", () => setTimeout(ajustar, 220));
  // o mapa nasce dentro de um grid que só ganha altura depois do primeiro
  // layout; sem isto o Leaflet mede 0 e desenha os tiles fora de lugar
  setTimeout(ajustar, 60);

  /* ========================================================================
     Reserva
     ======================================================================== */

  const folha = $("folhaReserva");
  const fReservaLoja = $("reservaLoja");
  const fReservaVagas = $("reservaVagas");
  const fReservaDia = $("reservaDia");
  const fReservaHora = $("reservaHora");
  const fReservaResumo = $("reservaResumo");
  const fReservaStatus = $("reservaStatus");
  const fReservaEnviar = $("reservaEnviar");
  let pontoEmReserva = null;

  const doisDigitos = n => String(n).padStart(2, "0");
  const diaLocal = d => `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`;

  /* Meias horas das 6h às 22h.

     O <input type="time"> seria menos código e é pior aqui: em parte dos
     navegadores de celular ele abre um seletor de minuto a minuto, e reserva
     de vaga não se marca às 14h07. Uma lista fechada também deixa esconder o
     que já passou, o que o campo livre não faz. */
  function horariosDoDia(dia) {
    const agora = new Date();
    const hoje = dia === diaLocal(agora);
    const minimo = new Date(agora.getTime() + 20 * 60000);   // 15 do servidor + folga
    const saida = [];
    for (let h = 6; h <= 22; h++) {
      for (const m of [0, 30]) {
        const quando = new Date(`${dia}T${doisDigitos(h)}:${doisDigitos(m)}:00`);
        if (hoje && quando < minimo) continue;
        saida.push(`${doisDigitos(h)}:${doisDigitos(m)}`);
      }
    }
    return saida;
  }

  function preencherHorarios() {
    const horas = horariosDoDia(fReservaDia.value);
    fReservaHora.innerHTML = horas.length
      ? horas.map(h => `<option value="${h}">${h}</option>`).join("")
      : `<option value="">Sem horário hoje</option>`;
    fReservaHora.disabled = !horas.length;
    atualizarResumo();
  }

  function atualizarResumo() {
    const vaga = fReservaVagas.querySelector("input:checked");
    const pronto = vaga && fReservaHora.value;
    fReservaEnviar.disabled = !pronto;
    fReservaResumo.textContent = pronto
      ? `R$ ${num(VALOR_RESERVA)} sai da carteira e volta como crédito nesta recarga · ${DURACAO_MIN} min`
      : "Escolha a vaga e o horário.";
  }

  function abrirReserva(p) {
    pontoEmReserva = p;
    fReservaLoja.textContent = p.nome;
    const livres = p.carregadores.filter(c => c.livre_agora);
    fReservaVagas.innerHTML = livres.map((c, i) => `
      <label class="reserva-vaga">
        <input type="radio" name="vaga" value="${c.id}" ${i === 0 ? "checked" : ""}>
        <span>
          <b>${c.nome}</b>
          <small>${num(c.potencia_kw, 1)} kW · ${c.conector} · R$ ${num(c.preco_kwh_brl)}/kWh</small>
        </span>
      </label>`).join("");

    const hoje = new Date();
    fReservaDia.min = diaLocal(hoje);
    fReservaDia.max = diaLocal(new Date(hoje.getTime() + 14 * 86400000));
    fReservaDia.value = diaLocal(hoje);
    preencherHorarios();
    dizerReserva("");
    folha.hidden = false;
    document.body.classList.add("reserva-aberta");
    folha.querySelector(".reserva-fechar").focus();
  }

  function fecharReserva() {
    folha.hidden = true;
    document.body.classList.remove("reserva-aberta");
    pontoEmReserva = null;
  }

  function dizerReserva(texto, tipo = "") {
    fReservaStatus.textContent = texto;
    fReservaStatus.className = "reserva-status" + (tipo ? ` is-${tipo}` : "");
  }

  if (folha) {
    folha.querySelector(".reserva-fechar").onclick = fecharReserva;
    folha.querySelector(".reserva-fundo").onclick = fecharReserva;
    addEventListener("keydown", ev => { if (ev.key === "Escape" && !folha.hidden) fecharReserva(); });
    fReservaDia.onchange = preencherHorarios;
    fReservaHora.onchange = atualizarResumo;
    fReservaVagas.onchange = atualizarResumo;

    fReservaEnviar.onclick = async () => {
      const vaga = fReservaVagas.querySelector("input:checked");
      if (!vaga || !fReservaHora.value) return;
      fReservaEnviar.disabled = true;
      dizerReserva("Reservando…");

      // Monta a data no fuso de quem está olhando e manda com o deslocamento
      // explícito. Sem o fuso o servidor recusa, de propósito: interpretar
      // como UTC daria uma reserva três horas fora do lugar, em silêncio.
      const quando = new Date(`${fReservaDia.value}T${fReservaHora.value}:00`);
      try {
        const r = await fetch("/reservas", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ carregador_id: Number(vaga.value), inicio: quando.toISOString() }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          fReservaEnviar.disabled = false;
          // 401 aqui quer dizer "não está logado", e a tela do mapa é aberta:
          // dá para chegar nela sem conta.
          dizerReserva(r.status === 401
            ? "Entre na sua conta para reservar."
            : (d.detail || "Não consegui reservar."), "erro");
          return;
        }
        dizerReserva(`Reservado · ${d.vaga} · ${new Date(d.inicio).toLocaleString("pt-BR",
          { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`, "ok");
        await carregarPontos();
        montarMarcadores();
        desenhar(busca.value);
        setTimeout(fecharReserva, 1800);
      } catch {
        fReservaEnviar.disabled = false;
        dizerReserva("O servidor não respondeu. Tente de novo.", "erro");
      }
    };
  }

  /* ======================================================================== */

  /* Primeira carga. Falhar aqui não pode deixar a tela em branco: o mapa já
     desenhou, e a lista diz o que houve em vez de ficar vazia sem motivo. */
  (async () => {
    try {
      await carregarPontos();
      if (mapa) montarMarcadores();
      desenhar();
    } catch (erro) {
      contagem.textContent = "Não consegui carregar os pontos.";
      lista.innerHTML = `<li class="mapa-vazio">O servidor não respondeu. `
                      + `Ele hiberna quando fica sem uso — recarregue em um minuto.</li>`;
      console.error("mapa:", erro);
    }
  })().finally(() => soltarCortina && soltarCortina());
})();

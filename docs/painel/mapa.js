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
(() => {
  "use strict";

  /* --------------------------------------------------- dados simulados ---
     Gerador com semente: `Math.random()` daria um mapa diferente a cada F5,
     e numa banca isso vira "o mapa mudou sozinho". */
  const semente = (n) => () => {
    n = (n * 1664525 + 1013904223) % 4294967296;
    return n / 4294967296;
  };
  const rnd = semente(20260907);

  const CENTRO = [-23.5866, -46.6396];        // Vila Mariana, São Paulo
  const BAIRROS = [
    "Vila Mariana", "Pinheiros", "Moema", "Itaim Bibi", "Perdizes",
    "Santana", "Tatuapé", "Butantã", "Saúde", "Lapa", "Ipiranga",
    "Campo Belo", "Vila Madalena", "Brooklin", "Higienópolis",
  ];
  const LOJAS = [
    ["Pet & Cia", "Pet shop"], ["Mercado Bom Dia", "Supermercado"],
    ["Academia Pulso", "Academia"], ["Cantina do Vale", "Restaurante"],
    ["Farmácia Vida", "Farmácia"], ["Shopping Sul", "Shopping"],
    ["Mercado Central", "Supermercado"], ["Pet Feliz", "Pet shop"],
    ["Padaria Aurora", "Restaurante"], ["Drogaria Norte", "Farmácia"],
    ["Studio Corpo", "Academia"], ["Empório Leste", "Supermercado"],
  ];
  const CONECTORES = ["Tipo 2", "CCS2", "Tipo 2", "CCS2", "Tipo 2"];
  const POTENCIAS = [7.4, 11, 22, 22, 50];

  const PONTOS = LOJAS.map(([nome, segmento], i) => {
    const bairro = BAIRROS[Math.floor(rnd() * BAIRROS.length)];
    return {
      id: i + 1,
      nome: `${nome} ${bairro}`,
      bairro,
      segmento,
      lat: CENTRO[0] + (rnd() - 0.5) * 0.18,   // ~10 km de mancha urbana
      lng: CENTRO[1] + (rnd() - 0.5) * 0.18,
      potencia: POTENCIAS[Math.floor(rnd() * POTENCIAS.length)],
      conector: CONECTORES[Math.floor(rnd() * CONECTORES.length)],
      vagas: 1 + Math.floor(rnd() * 3),
      livre: rnd() > 0.32,
      preco: 0.79 + rnd() * 0.9,
      cashback: 5 + Math.floor(rnd() * 11),
    };
  });

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
    const tiles = chave
      ? `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${chave}`
      : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

    L.tileLayer(tiles, {
      maxZoom: chave ? 20 : 19,
      subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(mapa);

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

      m.bindPopup(`
        <div class="popup">
          <b>${p.nome}</b>
          <small>${p.segmento} · ${p.bairro}</small>
          <div class="popup-linhas">
            <span>Potência <b>${num(p.potencia, 1)} kW</b> · ${p.conector}</span>
            <span>Preço <b>R$ ${num(p.preco)}/kWh</b></span>
            <span>Cashback de <b>${p.cashback}%</b> para gastar na loja</span>
            <span>${p.livre ? `<b>${p.vagas} vaga(s) livre(s)</b>` : "Ocupado agora"}</span>
          </div>
        </div>`, { maxWidth: Math.min(268, innerWidth - 56), autoPanPadding: [18, 18] });

      m.on("click", () => destacar(p.id, false));
      marcadores.set(p.id, m);
    });

    // tocar no mapa recolhe a folha, como no Google Maps
    mapa.on("click", () => { if (celular() && aberta()) irPara("fechada"); });
  } else {
    // Leaflet não carregou: a lista assume a página inteira em vez de deixar
    // uma faixa cinza onde o mapa deveria estar
    $("mapa").hidden = true;
    document.querySelector(".mapa-palco").style.gridTemplateColumns = "minmax(0, 1fr)";
    painel.style.transform = "none";
  }

  /* ------------------------------------------------------------ lista --- */
  function desenhar(filtro = "") {
    const t = filtro.trim().toLowerCase();
    const vistos = t
      ? PONTOS.filter(p => `${p.nome} ${p.bairro} ${p.segmento}`.toLowerCase().includes(t))
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
            <small>${p.segmento} · ${p.bairro}</small>
            <span class="mapa-ponto-selos">
              <span class="selo ${p.livre ? "is-livre" : "is-ocupado"}">${p.livre ? "Livre" : "Ocupado"}</span>
              <span class="selo">${num(p.potencia, 1)} kW</span>
              <span class="selo">${p.cashback}% cashback</span>
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
  desenhar();

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
})();

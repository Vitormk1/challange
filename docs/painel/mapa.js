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
     e numa banca isso vira "o mapa mudou sozinho". Com semente, a mesma
     tela sempre. */
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
    const pot = POTENCIAS[Math.floor(rnd() * POTENCIAS.length)];
    return {
      id: i + 1,
      nome: `${nome} ${bairro}`,
      bairro,
      segmento,
      // ~0,09° cobre uns 10 km, que é a mancha urbana que interessa aqui
      lat: CENTRO[0] + (rnd() - 0.5) * 0.18,
      lng: CENTRO[1] + (rnd() - 0.5) * 0.18,
      potencia: pot,
      conector: CONECTORES[Math.floor(rnd() * CONECTORES.length)],
      vagas: 1 + Math.floor(rnd() * 3),
      livre: rnd() > 0.32,
      preco: (0.79 + rnd() * 0.9),
      cashback: 5 + Math.floor(rnd() * 11),
    };
  });

  const num = (v, casas = 2) =>
    v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });

  /* ------------------------------------------------------------- mapa --- */
  const ICONE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7 3h7a1 1 0 0 1 1 1v16H6V4a1 1 0 0 1 1-1Z"></path>
      <path d="M15 8h2.5a1.5 1.5 0 0 1 1.5 1.5V15a1.5 1.5 0 0 0 1.5 1.5"></path>
      <path d="m11 7-2 3.5h3L10 14"></path></svg>`;

  const lista = document.getElementById("lista");
  const contagem = document.getElementById("contagemPontos");
  const busca = document.getElementById("buscaPontos");

  let mapa = null;
  const marcadores = new Map();
  let ativo = null;

  if (typeof L !== "undefined") {
    mapa = L.map("mapa", {
      center: CENTRO,
      zoom: 12,
      zoomControl: false,
      // o mundo não se repete de lado, e o zoom para de sair do Brasil
      worldCopyJump: false,
      minZoom: 3,
    });
    L.control.zoom({ position: "bottomright" }).addTo(mapa);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      // atribuição é obrigação de licença dos dois, não gentileza
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(mapa);

    PONTOS.forEach(p => {
      const icone = L.divIcon({
        className: "marcador-pino",
        html: `<span class="pino${p.livre ? "" : " is-ocupado"}">${ICONE}</span>`,
        iconSize: [34, 34],
        iconAnchor: [17, 32],
        popupAnchor: [0, -30],
      });
      const m = L.marker([p.lat, p.lng], { icon: icone, title: p.nome }).addTo(mapa);
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
        </div>`);
      m.on("click", () => destacar(p.id, false));
      marcadores.set(p.id, m);
    });
  } else {
    // Leaflet não carregou: a lista assume a página inteira em vez de
    // deixar uma faixa cinza onde o mapa deveria estar
    document.getElementById("mapa").hidden = true;
    document.querySelector(".mapa-palco").style.gridTemplateColumns = "minmax(0, 1fr)";
  }

  /* ------------------------------------------------------------ lista --- */
  function desenhar(filtro = "") {
    const t = filtro.trim().toLowerCase();
    const vistos = t
      ? PONTOS.filter(p => `${p.nome} ${p.bairro} ${p.segmento}`.toLowerCase().includes(t))
      : PONTOS;

    contagem.textContent = t
      ? `${vistos.length} de ${PONTOS.length} pontos`
      : `${PONTOS.length} pontos · ${PONTOS.filter(p => p.livre).length} livres agora`;

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

  /* Um só caminho para "este ponto agora é o escolhido", venha o clique do
     pino ou da lista. Sem isso os dois lados discordam sobre o que está
     selecionado. */
  function destacar(id, moverMapa) {
    ativo = id;
    lista.querySelectorAll(".mapa-ponto").forEach(b =>
      b.classList.toggle("is-ativo", Number(b.dataset.ponto) === id));
    document.querySelectorAll(".pino").forEach(p => p.classList.remove("is-ativo"));

    const m = marcadores.get(id);
    if (!m) return;
    const el = m.getElement()?.querySelector(".pino");
    if (el) el.classList.add("is-ativo");

    if (moverMapa && mapa) {
      mapa.flyTo(m.getLatLng(), Math.max(mapa.getZoom(), 15), { duration: 0.6 });
      m.openPopup();
      if (gaveta()) fecharLista();
    }
    const item = lista.querySelector(`[data-ponto="${id}"]`);
    if (item && !moverMapa) item.scrollIntoView({ block: "nearest" });
  }

  busca.addEventListener("input", () => { desenhar(busca.value); if (ativo) destacar(ativo, false); });
  desenhar();

  /* ------------------------------------------------- gaveta no celular --- */
  const painel = document.getElementById("painelLista");
  const botao = document.getElementById("botaoLista");
  const fechar = document.getElementById("fecharLista");
  const gaveta = () => matchMedia("(max-width: 860px)").matches;

  function abrirLista() {
    painel.classList.add("is-aberta");
    botao.setAttribute("aria-expanded", "true");
    busca.focus({ preventScroll: true });
  }
  function fecharLista() {
    painel.classList.remove("is-aberta");
    botao.setAttribute("aria-expanded", "false");
  }
  botao.addEventListener("click", () =>
    painel.classList.contains("is-aberta") ? fecharLista() : abrirLista());
  fechar.addEventListener("click", fecharLista);
  addEventListener("keydown", e => {
    if (e.key === "Escape" && gaveta() && painel.classList.contains("is-aberta")) {
      fecharLista(); botao.focus();
    }
  });
  // ao voltar para tela larga a gaveta some, e a classe não pode ficar presa
  addEventListener("resize", () => { if (!gaveta()) fecharLista(); });

  /* O mapa nasce dentro de um grid que só ganha altura depois do primeiro
     layout; sem isto o Leaflet mede 0 e desenha os tiles fora de lugar. */
  if (mapa) setTimeout(() => mapa.invalidateSize(), 60);
})();

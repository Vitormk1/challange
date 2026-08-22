/* ============================================================
   Tour guiado do dashboard — spotlight com blur (técnica de 4
   bandas ao redor do alvo), anel de destaque e balão de fala com
   seta. Segue o padrão createXModule(deps) do resto do projeto
   (ver aiLab.js) — recebe `state` por referência, não tem estado
   próprio em localStorage (tour é sempre aberto manualmente pelo
   botão "?", sem auto-launch).

   Decisão de design: todo `target` do roteiro aponta pra um
   elemento estrutural que já existe assim que a seção fica ativa
   (título, header de grupo, container de cards) — nunca uma linha
   de tabela carregada via fetch assíncrono. Isso evita ter que
   esperar dado de rede chegar; só um frame de paint depois de
   setSection() já basta.
   ============================================================ */

// Import só de efeito colateral: registra o custom element <bms-ai-entity>
// (o "orb" usado no lançador flutuante da IA, ver aiAssistant.js/aiEntity.js)
// pra poder usá-lo, puramente decorativo, no canto do balão do tour. Na
// prática já é registrado por aiAssistant.js antes deste módulo carregar,
// mas importar aqui também deixa o tour.js autocontido, sem depender da
// ordem de import de outro módulo — customElements.define() já se protege
// contra registro duplicado.
import "./aiEntity.js";

/**
 * @typedef {Object} TourStep
 * @property {string} id
 * @property {string|null} section        - seção a ativar via setSection antes de medir o alvo
 * @property {string|null} target         - seletor CSS do alvo (null = passo "center")
 * @property {"top"|"bottom"|"left"|"right"|"center"} placement
 * @property {string} title
 * @property {string} body
 * @property {string} [requiresCapability]  - checado contra state.permissions.capabilities
 * @property {string} [forceExpandGroup]    - data-nav-group a forçar expandido
 * @property {(el: Element|null) => boolean} [skipIf]  - ex.: elemento com `hidden`
 */

const TOUR_STEPS = [
  { id: "welcome", section: null, target: null, placement: "center",
    title: "Bem-vindo ao painel",
    body: "Um tour rápido pelas áreas principais. São poucos passos, e você pode parar quando quiser." },
  { id: "client", section: null, target: "#clientDropdownTrigger", placement: "right",
    title: "Seu estabelecimento",
    body: "Tudo aqui é da loja selecionada. Quem administra mais de uma troca por este seletor." },
  { id: "cards-grandes", section: "painel", target: "#dashboardLargeCardsGroup", placement: "bottom",
    title: "Indicadores grandes",
    body: "O número que interessa é o lucro atribuído a quem carregou — não quantos quilowatt-hora saíram." },
  { id: "cards-pequenos", section: "painel", target: "#dashboardSmallCardsGroup", placement: "top",
    title: "Indicadores rápidos",
    body: "Mais indicadores ficam aqui embaixo. Dá para reorganizar ou trocar pelos que fizerem sentido para você." },
  { id: "workspaces", section: "painel", target: "#dashboardManagerToggle", placement: "bottom",
    title: "Ver painéis",
    body: "Toque aqui para ver todos os painéis salvos desta loja e trocar entre eles." },
  { id: "editar", section: "painel", target: "#dashboardManagerToggle", placement: "bottom",
    title: "Editar e compartilhar",
    body: "No lápis de cada painel você adiciona e remove cards pela biblioteca. Compartilhado, todos da loja veem a mesma versão." },
  { id: "carregadores", section: "carregadores", target: '[data-section="carregadores"]', placement: "right",
    title: "Carregadores",
    body: "Cada ponto pode ser cortesia ou cobrança por kWh. A vaga da frente atrai cliente; a dos fundos pode cobrar." },
  { id: "sessoes", section: "sessoes", target: '[data-section="sessoes"]', placement: "right",
    title: "Sessões",
    body: "Cada recarga, com energia entregue, quilômetros e a venda que ela trouxe." },
  { id: "negocio", section: null, target: '[data-nav-group="negocio"]', placement: "right",
    forceExpandGroup: "negocio",
    title: "Negócio",
    body: "Clientes, vendas atribuídas, cupons e o financeiro ficam agrupados aqui." },
  { id: "cadastros", section: null, target: '[data-nav-group="cadastros"]', placement: "right",
    forceExpandGroup: "cadastros",
    title: "Cadastros",
    body: "Dados do estabelecimento e os painéis salvos. É onde a margem e o ticket da loja são definidos." },
  { id: "financeiro", section: "financeiro", target: "#screen-financeiro", placement: "top",
    title: "Quanto de cortesia cabe",
    body: "Com a sua margem e o seu ticket, o painel calcula o teto de cortesia que não dá prejuízo." },
  { id: "ia", section: null, target: "#globalAiLauncher", placement: "left",
    title: "Assistente",
    body: "A esfera no canto responde perguntas sobre o que está na tela. Pronto — é só isso." },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Alguns alvos do roteiro (ex.: containers de card do dashboard) colapsam
// pra quase 0x0 quando estão vazios (grid sem filhos - ex.: workspace novo,
// sem nenhum card configurado ainda). Nesse caso um spotlight de 0px não
// destaca nada útil - sobe até 3 níveis de ancestral em busca de um retângulo
// com tamanho real pra destacar em vez do container vazio.
function effectiveRect(node, minSize = 24) {
  let current = node;
  let rect = current.getBoundingClientRect();
  let guard = 0;
  while ((rect.width < minSize || rect.height < minSize) && current.parentElement && guard < 3) {
    current = current.parentElement;
    rect = current.getBoundingClientRect();
    guard += 1;
  }
  return rect;
}

export function createTourModule({
  state,
  setSection,
  canAccessSection,
  isCompactViewport,
  setSidebarCollapsed,
  syncSidebarGroupToggle,
  waitForNextPaint,
}) {
  const elRefs = {};
  let resolvedSteps = [];
  let stepIndex = 0;
  let currentTargetNode = null;
  let resizeTicking = false;
  const restoreState = { sidebarWasCollapsed: false, forcedGroups: new Set() };

  function ensureDom() {
    if (elRefs.overlay) return;
    const overlay = document.createElement("div");
    overlay.className = "tour-overlay";
    overlay.id = "tourOverlay";
    overlay.innerHTML = `
      <div class="tour-scrim tour-scrim-top"></div>
      <div class="tour-scrim tour-scrim-bottom"></div>
      <div class="tour-scrim tour-scrim-left"></div>
      <div class="tour-scrim tour-scrim-right"></div>
      <div class="tour-spot-ring" id="tourSpotRing"></div>
      <div class="tour-loading-spinner" id="tourLoadingSpinner" aria-hidden="true"></div>
      <div class="tour-balloon" id="tourBalloon" role="dialog" aria-modal="true" aria-live="polite" aria-labelledby="tourBalloonTitle">
        <p class="tour-balloon-step" id="tourBalloonStep"></p>
        <h3 id="tourBalloonTitle"></h3>
        <p id="tourBalloonBody"></p>
        <div class="tour-balloon-actions">
          <button class="ghost-button" id="tourStop" type="button">Parar</button>
          <div class="tour-balloon-nav">
            <button class="ghost-button" id="tourPrev" type="button">Voltar</button>
            <button class="primary-button" id="tourNext" type="button">Próximo</button>
          </div>
        </div>
        <bms-ai-entity class="tour-balloon-entity" state="idle" size="28" decorative></bms-ai-entity>
      </div>
    `;
    document.body.appendChild(overlay);
    elRefs.overlay = overlay;
    elRefs.scrimTop = overlay.querySelector(".tour-scrim-top");
    elRefs.scrimBottom = overlay.querySelector(".tour-scrim-bottom");
    elRefs.scrimLeft = overlay.querySelector(".tour-scrim-left");
    elRefs.scrimRight = overlay.querySelector(".tour-scrim-right");
    elRefs.ring = overlay.querySelector("#tourSpotRing");
    elRefs.spinner = overlay.querySelector("#tourLoadingSpinner");
    elRefs.balloon = overlay.querySelector("#tourBalloon");
    elRefs.stepLabel = overlay.querySelector("#tourBalloonStep");
    elRefs.title = overlay.querySelector("#tourBalloonTitle");
    elRefs.body = overlay.querySelector("#tourBalloonBody");
    elRefs.stopBtn = overlay.querySelector("#tourStop");
    elRefs.prevBtn = overlay.querySelector("#tourPrev");
    elRefs.nextBtn = overlay.querySelector("#tourNext");
  }

  function isOpen() {
    return Boolean(elRefs.overlay?.classList.contains("is-open"));
  }

  function isStepEligible(step) {
    if (step.section && !canAccessSection(step.section)) return false;
    if (step.requiresCapability && !state.permissions?.capabilities?.[step.requiresCapability]) return false;
    return true;
  }

  function currentActiveGroupKey() {
    const activeItem = document.querySelector(".nav-item.active");
    return activeItem?.closest("[data-nav-group]")?.dataset.navGroup || null;
  }

  function forceExpandGroup(groupKey) {
    const group = document.querySelector(`[data-nav-group="${groupKey}"]`);
    if (!group || !group.classList.contains("is-collapsed")) return;
    group.classList.remove("is-collapsed");
    syncSidebarGroupToggle?.(group);
    restoreState.forcedGroups.add(groupKey);
  }

  function ensureSidebarVisible() {
    if (!isCompactViewport()) return;
    if (document.body.classList.contains("sidebar-collapsed")) {
      setSidebarCollapsed(false);
    }
  }

  function targetLivesInSidebar(selector) {
    return (
      selector.startsWith("[data-nav-group") ||
      selector.startsWith('[data-section') ||
      selector === "#clientDropdownTrigger" ||
      selector === "#profileShortcut"
    );
  }

  async function resolveTarget(step) {
    if (!step.target) return null;
    if (step.section && step.section !== state.section) {
      setSection(step.section);
      await waitForNextPaint();
    }
    if (step.forceExpandGroup) {
      forceExpandGroup(step.forceExpandGroup);
    }
    if (isCompactViewport() && targetLivesInSidebar(step.target)) {
      ensureSidebarVisible();
    }
    await waitForNextPaint();
    const node = document.querySelector(step.target);
    if (step.skipIf?.(node)) return "SKIP";
    if (!node) return "SKIP";
    node.scrollIntoView({ block: "nearest", behavior: "instant" });
    await waitForNextPaint();
    return node;
  }

  function positionSpotlight(rect, padding = 8) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const top = Math.max(rect.top - padding, 0);
    const bottom = Math.min(rect.bottom + padding, vh);
    const left = Math.max(rect.left - padding, 0);
    const right = Math.min(rect.right + padding, vw);

    elRefs.scrimTop.style.height = `${top}px`;
    elRefs.scrimBottom.style.height = `${Math.max(vh - bottom, 0)}px`;
    elRefs.scrimLeft.style.top = `${top}px`;
    elRefs.scrimLeft.style.height = `${Math.max(bottom - top, 0)}px`;
    elRefs.scrimLeft.style.width = `${left}px`;
    elRefs.scrimRight.style.top = `${top}px`;
    elRefs.scrimRight.style.height = `${Math.max(bottom - top, 0)}px`;
    elRefs.scrimRight.style.width = `${Math.max(vw - right, 0)}px`;

    elRefs.ring.style.top = `${top}px`;
    elRefs.ring.style.left = `${left}px`;
    elRefs.ring.style.width = `${Math.max(right - left, 0)}px`;
    elRefs.ring.style.height = `${Math.max(bottom - top, 0)}px`;
  }

  function collapseSpotlightToCenter() {
    elRefs.scrimTop.style.height = `${window.innerHeight}px`;
    elRefs.scrimBottom.style.height = "0px";
    elRefs.scrimLeft.style.width = "0px";
    elRefs.scrimLeft.style.height = "0px";
    elRefs.scrimRight.style.width = "0px";
    elRefs.scrimRight.style.height = "0px";
    elRefs.ring.classList.remove("is-visible");
  }

  function positionBalloon(step, rect) {
    const balloon = elRefs.balloon;
    if (!rect) {
      balloon.dataset.placement = "center";
      balloon.style.top = "";
      balloon.style.left = "";
      balloon.style.removeProperty("--tour-arrow-offset");
      return;
    }
    const margin = 16;
    const gap = 16;
    const balloonRect = balloon.getBoundingClientRect();
    const bw = balloonRect.width || 320;
    const bh = balloonRect.height || 140;
    let placement = step.placement || "bottom";

    if (placement === "bottom" && rect.bottom + gap + bh > window.innerHeight - margin) placement = "top";
    else if (placement === "top" && rect.top - gap - bh < margin) placement = "bottom";
    else if (placement === "right" && rect.right + gap + bw > window.innerWidth - margin) placement = "left";
    else if (placement === "left" && rect.left - gap - bw < margin) placement = "right";

    let top;
    let left;
    if (placement === "bottom") {
      top = Math.min(rect.bottom + gap, window.innerHeight - bh - margin);
      left = clamp(rect.left, margin, window.innerWidth - bw - margin);
    } else if (placement === "top") {
      top = Math.max(rect.top - bh - gap, margin);
      left = clamp(rect.left, margin, window.innerWidth - bw - margin);
    } else if (placement === "right") {
      left = Math.min(rect.right + gap, window.innerWidth - bw - margin);
      top = clamp(rect.top, margin, window.innerHeight - bh - margin);
    } else {
      left = Math.max(rect.left - bw - gap, margin);
      top = clamp(rect.top, margin, window.innerHeight - bh - margin);
    }

    balloon.dataset.placement = placement;
    balloon.style.top = `${top}px`;
    balloon.style.left = `${left}px`;

    // A seta precisa continuar apontando pro CENTRO real do alvo, mesmo
    // quando o balão foi empurrado (clamp acima) pra caber na tela perto
    // de um canto (ex.: launcher de IA no canto inferior direito, pill
    // "Ver dashboards" no canto superior direito) — um offset fixo de CSS
    // erra o alvo nesses casos. Calcula a posição do alvo relativa à borda
    // do balão e limita pra seta nunca sair da própria borda dele (14px de
    // seta + margem de segurança de cada lado).
    const arrowSize = 14;
    const arrowMargin = 18;
    if (placement === "bottom" || placement === "top") {
      const targetCenterX = rect.left + rect.width / 2;
      const offset = clamp(targetCenterX - left, arrowMargin, bw - arrowMargin - arrowSize);
      balloon.style.setProperty("--tour-arrow-offset", `${Math.round(offset)}px`);
    } else {
      const targetCenterY = rect.top + rect.height / 2;
      const offset = clamp(targetCenterY - top, arrowMargin, bh - arrowMargin - arrowSize);
      balloon.style.setProperty("--tour-arrow-offset", `${Math.round(offset)}px`);
    }
  }

  function updateBalloonContent(step, index) {
    elRefs.stepLabel.textContent = `Passo ${index + 1} de ${resolvedSteps.length}`;
    elRefs.title.textContent = step.title;
    elRefs.body.textContent = step.body;
    elRefs.nextBtn.textContent = index === resolvedSteps.length - 1 ? "Concluir" : "Próximo";
  }

  function setBalloonVisible(visible) {
    elRefs.balloon.classList.toggle("is-visible", visible);
  }

  // Trocar de seção dispara um render pesado do zero (tabelas, gráficos)
  // que pode levar bem mais que os ~180ms do fade-out — sem isso, a tela
  // ficava "seca" (só o blur, sem balão nem indício de que algo estava
  // carregando) até o próximo passo aparecer de repente. Mostrado assim
  // que a troca de seção começa, escondido assim que o alvo novo é
  // encontrado (ou definitivamente não encontrado, target null incluído).
  function showLoadingSpinner() {
    elRefs.spinner.classList.add("is-visible");
  }
  function hideLoadingSpinner() {
    elRefs.spinner.classList.remove("is-visible");
  }

  async function goToStep(index, direction = 1) {
    if (!isOpen()) return;
    if (index < 0) return;
    if (index >= resolvedSteps.length) {
      hideLoadingSpinner();
      close();
      return;
    }
    const step = resolvedSteps[index];
    const crossSection = Boolean(step.section) && step.section !== state.section;
    if (crossSection) {
      setBalloonVisible(false);
      elRefs.ring.classList.remove("is-visible");
      showLoadingSpinner();
      await delay(180);
    }
    const target = await resolveTarget(step);
    if (target === "SKIP") {
      resolvedSteps.splice(index, 1);
      const nextIndex = direction >= 0 ? index : Math.max(0, index - 1);
      await goToStep(nextIndex, direction);
      return;
    }
    hideLoadingSpinner();
    stepIndex = index;
    currentTargetNode = target;
    updateBalloonContent(step, index);
    if (target) {
      const rect = effectiveRect(target);
      positionSpotlight(rect);
      elRefs.ring.classList.add("is-visible");
      positionBalloon(step, rect);
    } else {
      collapseSpotlightToCenter();
      positionBalloon(step, null);
    }
    setBalloonVisible(true);
  }

  function setNavDisabled(disabled) {
    elRefs.nextBtn.disabled = disabled;
    elRefs.prevBtn.disabled = disabled || stepIndex <= 0;
  }

  // Alguns passos disparam setSection() pra uma seção que ainda não tinha
  // sido carregada (ex.: Alarmes, Histórico) — o render síncrono que isso
  // dispara pode levar bem mais que os ~250ms de um passo same-section, e
  // sem essa trava, clicar "Próximo" de novo antes da transição terminar
  // chama goToStep() uma segunda vez com o `stepIndex` ainda não atualizado
  // pela primeira chamada, gerando duas transições sobrepostas (texto do
  // balão e seção acabam dessincronizados). O botão "Parar" continua ativo
  // — interromper no meio de uma transição é seguro (goToStep verifica
  // isOpen() logo no início e sai sem efeito se o tour já foi fechado).
  let transitioning = false;

  async function runTransition(index, direction) {
    if (transitioning) return;
    transitioning = true;
    setNavDisabled(true);
    try {
      await goToStep(index, direction);
    } finally {
      transitioning = false;
      setNavDisabled(false);
    }
  }

  function next() {
    runTransition(stepIndex + 1, 1);
  }

  function prev() {
    runTransition(stepIndex - 1, -1);
  }

  async function open() {
    ensureDom();
    resolvedSteps = TOUR_STEPS.filter(isStepEligible);
    if (!resolvedSteps.length) return;
    restoreState.sidebarWasCollapsed = document.body.classList.contains("sidebar-collapsed");
    restoreState.forcedGroups.clear();
    stepIndex = -1;
    currentTargetNode = null;
    elRefs.overlay.classList.add("is-open");
    await runTransition(0, 1);
  }

  function close() {
    if (!elRefs.overlay) return;
    elRefs.overlay.classList.remove("is-open");
    setBalloonVisible(false);
    elRefs.ring.classList.remove("is-visible");
    hideLoadingSpinner();
    const activeGroup = currentActiveGroupKey();
    restoreState.forcedGroups.forEach((groupKey) => {
      if (groupKey === activeGroup) return;
      const group = document.querySelector(`[data-nav-group="${groupKey}"]`);
      if (group) {
        group.classList.add("is-collapsed");
        syncSidebarGroupToggle?.(group);
      }
    });
    restoreState.forcedGroups.clear();
    if (restoreState.sidebarWasCollapsed && isCompactViewport()) {
      setSidebarCollapsed(true);
    }
    currentTargetNode = null;
  }

  // O botão "?" precisa sempre ficar no canto superior direito. O único
  // outro elemento fixo que disputa esse canto é #dashboardManagerToggle
  // ("Ver dashboards"), que só existe/aparece na seção Dashboard (controlado
  // por `hidden` em main.js). Quando ele está visível, empurra o botão pra
  // esquerda dele com um gap; caso contrário, deixa o CSS puro (right:24px/
  // 16px mobile) cuidar do posicionamento — sem gap gigante em nenhuma
  // seção. Reage via MutationObserver no atributo `hidden` do pill (fonte
  // real da verdade), não via leitura de seção ativa.
  // Verticalmente, por ser position:fixed, o "?" não participa do flexbox
  // de .topbar-side, então nenhum align-items:center o alinha com o que
  // estiver ali de verdade — nem o pill (mais alto que o botão, ~52px
  // contra 42px do .icon-button) nem o botão "Adicionar X" de
  // #topbarActions (que tem sua própria altura mínima de 44px, também
  // diferente). Em vez de tentar acertar isso com um número mágico de
  // `top` no CSS (frágil a qualquer ajuste futuro de padding/altura de
  // qualquer um dos dois), mede em runtime a altura real de qual dos dois
  // estiver relevante agora e centraliza o botão na mesma linha vertical
  // dele: o pill quando visível (seção Dashboard), senão #topbarActions
  // (referência estável mesmo vazia, graças ao min-height:44px dela em
  // style.css — é a mesma "linha" onde o botão de criar de cada seção
  // nasce quando existe).
  function syncLaunchButtonPosition() {
    const btn = document.querySelector("#tourLaunchButton");
    const pill = document.querySelector("#dashboardManagerToggle");
    const topbarActions = document.querySelector("#topbarActions");
    if (!btn) return;

    let referenceRect = null;
    if (pill && !pill.hidden) {
      const gap = 12;
      const pillRect = pill.getBoundingClientRect();
      btn.style.right = `${Math.round(window.innerWidth - pillRect.left + gap)}px`;
      referenceRect = pillRect;
    } else {
      btn.style.right = "";
      referenceRect = topbarActions ? topbarActions.getBoundingClientRect() : null;
    }

    if (referenceRect && referenceRect.height > 0) {
      const btnRect = btn.getBoundingClientRect();
      const centerY = referenceRect.top + referenceRect.height / 2;
      btn.style.top = `${Math.round(centerY - btnRect.height / 2)}px`;
    } else {
      btn.style.top = "";
    }
  }

  function bindLaunchButtonPositioning() {
    syncLaunchButtonPosition();
    window.addEventListener("resize", syncLaunchButtonPosition, { passive: true });
    if (typeof MutationObserver === "undefined") return;
    const pill = document.querySelector("#dashboardManagerToggle");
    if (pill) {
      new MutationObserver(syncLaunchButtonPosition).observe(pill, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    }
    // #topbarActions é reconstruído inteiro (innerHTML) a cada troca de
    // seção (renderTopbarActions() em main.js) — é o sinal real de "o botão
    // de criar pode ter aparecido/sumido/mudado de forma", sem precisar
    // adivinhar por leitura de seção ativa.
    const topbarActions = document.querySelector("#topbarActions");
    if (topbarActions) {
      new MutationObserver(syncLaunchButtonPosition).observe(topbarActions, {
        childList: true,
      });
    }
  }

  function bindEvents() {
    ensureDom();
    bindLaunchButtonPositioning();
    elRefs.stopBtn.addEventListener("click", () => close());
    elRefs.prevBtn.addEventListener("click", () => prev());
    elRefs.nextBtn.addEventListener("click", () => next());

    document.addEventListener("keydown", (event) => {
      if (!isOpen()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        prev();
      }
    });

    window.addEventListener(
      "resize",
      () => {
        if (!isOpen() || resizeTicking) return;
        resizeTicking = true;
        window.requestAnimationFrame(() => {
          if (currentTargetNode) {
            const rect = effectiveRect(currentTargetNode);
            positionSpotlight(rect);
            positionBalloon(resolvedSteps[stepIndex], rect);
          } else if (isOpen()) {
            collapseSpotlightToCenter();
            positionBalloon(resolvedSteps[stepIndex], null);
          }
          resizeTicking = false;
        });
      },
      { passive: true }
    );

    document.addEventListener(
      "scroll",
      () => {
        if (!isOpen() || !currentTargetNode) return;
        const rect = effectiveRect(currentTargetNode);
        positionSpotlight(rect);
        positionBalloon(resolvedSteps[stepIndex], rect);
      },
      { capture: true, passive: true }
    );
  }

  return { open, close, next, prev, bindEvents, isOpen };
}

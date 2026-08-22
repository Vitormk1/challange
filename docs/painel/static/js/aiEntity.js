const AI_ENTITY_TAG = "bms-ai-entity";

export const AI_ENTITY_STATES = Object.freeze([
  "idle",
  "listening",
  "thinking",
  "responding",
  "success",
  "alert",
  "error",
]);

const VALID_STATES = new Set(AI_ENTITY_STATES);
const DEFAULT_LABEL = "Assistente BMS Advisor";
const STATE_LABELS = Object.freeze({
  idle: "pronta",
  listening: "ouvindo",
  thinking: "processando",
  responding: "respondendo",
  success: "concluída",
  alert: "alerta",
  error: "erro",
});
const ENTITY_VISUAL = `
  <span class="bms-ai-entity-visual" aria-hidden="true">
    <span class="ai-energy-field">
      <span class="ai-orb-icon" aria-hidden="true"></span>
    </span>
  </span>`;

function normalizeState(value) {
  return VALID_STATES.has(value) ? value : "idle";
}

function normalizeSize(value) {
  const raw = String(value || "36").trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return `${raw}px`;
  if (window.CSS?.supports?.("width", raw)) return raw;
  return "36px";
}

function isNestedInInteractiveControl(element) {
  return Boolean(element.parentElement?.closest("button, a, input, select, textarea, [role='button']"));
}

const visibilityObserver = typeof window.IntersectionObserver === "function"
  ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        entry.target.dataset.paused = String(!entry.isIntersecting);
      });
    }, { rootMargin: "48px" })
  : null;

export class BMSAIEntity extends HTMLElement {
  static get observedAttributes() {
    return ["state", "size", "label", "interactive", "decorative"];
  }

  connectedCallback() {
    if (!this.dataset.rendered) {
      this.dataset.rendered = "true";
      this.innerHTML = ENTITY_VISUAL;
      this.addEventListener("keydown", this.handleKeyboardActivation);
    }
    this.syncPresentation();
    visibilityObserver?.observe(this);
  }

  disconnectedCallback() {
    visibilityObserver?.unobserve(this);
  }

  attributeChangedCallback() {
    if (this.isConnected) this.syncPresentation();
  }

  handleKeyboardActivation = (event) => {
    if (!this.hasAttribute("interactive") || isNestedInInteractiveControl(this)) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    this.click();
  };

  syncPresentation() {
    const state = normalizeState(this.getAttribute("state"));
    const sizeValue = this.getAttribute("size") || "36";
    const numericSize = Number.parseFloat(sizeValue);
    const decorative = this.hasAttribute("decorative");
    const interactive = this.hasAttribute("interactive");
    const nestedInteractive = isNestedInInteractiveControl(this);
    const stateLabel = STATE_LABELS[state];

    this.classList.add("bms-ai-entity");
    this.dataset.state = state;
    this.dataset.compact = String(Number.isFinite(numericSize) && numericSize <= 32);
    this.style.setProperty("--ai-entity-size", normalizeSize(sizeValue));

    if (decorative) {
      this.setAttribute("aria-hidden", "true");
      this.removeAttribute("aria-label");
      this.removeAttribute("aria-description");
      this.removeAttribute("role");
      this.removeAttribute("tabindex");
      return;
    }

    this.removeAttribute("aria-hidden");
    this.setAttribute("aria-label", `${this.getAttribute("label") || DEFAULT_LABEL}. Estado: ${stateLabel}.`);
    this.setAttribute("aria-description", `Estado visual da IA: ${stateLabel}`);
    this.setAttribute("role", interactive && !nestedInteractive ? "button" : "img");
    if (interactive && !nestedInteractive) this.setAttribute("tabindex", "0");
    else this.removeAttribute("tabindex");
  }

  get state() {
    return normalizeState(this.getAttribute("state"));
  }

  set state(value) {
    this.setAttribute("state", normalizeState(value));
  }

  get size() {
    return this.getAttribute("size") || "36";
  }

  set size(value) {
    this.setAttribute("size", value || "36");
  }

  get label() {
    return this.getAttribute("label") || DEFAULT_LABEL;
  }

  set label(value) {
    if (value == null || value === "") this.removeAttribute("label");
    else this.setAttribute("label", String(value));
  }

  get interactive() {
    return this.hasAttribute("interactive");
  }

  set interactive(value) {
    this.toggleAttribute("interactive", Boolean(value));
  }
}

if (!window.customElements.get(AI_ENTITY_TAG)) {
  window.customElements.define(AI_ENTITY_TAG, BMSAIEntity);
}

export function setAIEntityState(target, state) {
  const element = typeof target === "string" ? document.querySelector(target) : target;
  if (!(element instanceof BMSAIEntity)) return;
  element.state = state;
  const accessibleControl = element.closest("button, a, [role='button']");
  if (accessibleControl && accessibleControl !== element) {
    const stateLabel = STATE_LABELS[element.state];
    accessibleControl.dataset.aiState = element.state;
    accessibleControl.setAttribute("aria-description", `Estado da IA: ${stateLabel}`);
  }
}

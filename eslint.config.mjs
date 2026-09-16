/* Uma regra só: `no-undef`.

   Não é para padronizar estilo — o projeto não tem npm nem dependências de
   front, e não é hora de criar. É para pegar uma classe de erro específica
   que já derrubou o painel inteiro em produção:

     ${emEdicao ? ... }        // emEdicao nunca foi declarada

   Sintaxe válida, `node --check` passa, e a tela quebra ao executar. O único
   sintoma era a tela de carregamento eterna, e só quebrava para quem tinha
   aquele card salvo — por isso demorou a aparecer.

   Rodar:  npx eslint docs/painel
   (o CI faz isso a cada PR; ver .github/workflows/verificar.yml)
*/

const navegador = {
  window: "readonly", document: "readonly", console: "readonly",
  localStorage: "readonly", sessionStorage: "readonly", location: "readonly",
  fetch: "readonly", FormData: "readonly", Blob: "readonly", File: "readonly",
  FileReader: "readonly", URL: "readonly", URLSearchParams: "readonly",
  setTimeout: "readonly", clearTimeout: "readonly",
  setInterval: "readonly", clearInterval: "readonly",
  requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly",
  matchMedia: "readonly", navigator: "readonly", history: "readonly",
  addEventListener: "readonly", removeEventListener: "readonly",
  innerWidth: "readonly", innerHeight: "readonly",
  scrollX: "readonly", scrollY: "readonly", scrollTo: "readonly",
  getComputedStyle: "readonly", alert: "readonly", confirm: "readonly",
  prompt: "readonly", crypto: "readonly", performance: "readonly",
  Image: "readonly", Audio: "readonly", MediaRecorder: "readonly",
  AbortController: "readonly", Intl: "readonly", structuredClone: "readonly",
  Event: "readonly", CustomEvent: "readonly", PointerEvent: "readonly",
  KeyboardEvent: "readonly", MouseEvent: "readonly",
  IntersectionObserver: "readonly", ResizeObserver: "readonly",
  MutationObserver: "readonly", DOMParser: "readonly",
  HTMLElement: "readonly", Element: "readonly", Node: "readonly",
  SpeechRecognition: "readonly", webkitSpeechRecognition: "readonly",
  btoa: "readonly", atob: "readonly", TextEncoder: "readonly",
  TextDecoder: "readonly", AudioContext: "readonly", webkitAudioContext: "readonly",
};

// Bibliotecas servidas por <script> antes do nosso código. Não são importadas,
// então do ponto de vista do arquivo elas são globais que já existem.
const bibliotecas = {
  L: "readonly",              // Leaflet, no mapa
  Motion: "readonly",         // Motion, no vídeo pitch
  motion: "readonly",
};

export default [
  {
    // static/ é biblioteca de terceiro: não é nosso para corrigir.
    // docs/vaga/ saiu daqui quando o script da telinha deixou de ser inline e
    // virou arquivo: agora é código nosso, e código nosso é conferido.
    ignores: ["docs/painel/static/**"],
  },
  {
    files: ["docs/painel/**/*.js", "docs/vaga/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",     // vale também para os IIFE clássicos
      globals: { ...navegador, ...bibliotecas },
    },
    // `linterOptions` desliga o aviso de diretiva inútil, que não interessa aqui.
    linterOptions: { reportUnusedDisableDirectives: false },
    rules: {
      "no-undef": "error",
    },
  },
];

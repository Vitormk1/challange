"""Auditoria de segurança: ataca a própria API e diz o que passou.

Não é lista de boas intenções — cada item é uma requisição de verdade contra o
servidor que estiver rodando, e o resultado é o que ele respondeu.

    python api/auditoria.py                         # contra o local
    python api/auditoria.py https://...onrender.com # contra o publicado

Precisa das senhas dos usuários de teste no ambiente:

    SENHA_MAIN=...  SENHA_GERENTE=...  SENHA_OPERADOR=...
"""

from __future__ import annotations

import json
import os
import sys
import time

import requests

API = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
TEMPO = 90

CONTAS = {
    "main": ("vitor@pracaderecarga.local", os.environ.get("SENHA_MAIN", "")),
    "gerente": ("gerente.petecia@praca.local", os.environ.get("SENHA_GERENTE", "")),
    "operador": ("operador.petecia@praca.local", os.environ.get("SENHA_OPERADOR", "")),
}

resultados: list[tuple[str, str, str]] = []


def checar(nome: str, condicao: bool, detalhe: str = "") -> None:
    resultados.append(("PASSOU" if condicao else "FALHOU", nome, detalhe))


def entrar(papel: str) -> requests.Session | None:
    email, senha = CONTAS[papel]
    if not senha:
        return None
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": email, "senha": senha}, timeout=TEMPO)
    return s if r.ok else None


def main() -> None:
    anon = requests.Session()

    # ---------------------------------------------------------- sessão ----
    print("== sessão e autenticação ==")
    for rota in ["/dados?estabelecimento_id=1", "/perfil", "/paineis?estabelecimento_id=1",
                 "/preferencias"]:
        r = anon.get(f"{API}{rota}", timeout=TEMPO)
        checar(f"sem sessão: GET {rota}", r.status_code in (401, 405), f"HTTP {r.status_code}")
    r = anon.post(f"{API}/ia/perguntar", json={"pergunta": "oi", "estabelecimento_id": 1}, timeout=TEMPO)
    checar("sem sessão: POST /ia/perguntar", r.status_code == 401, f"HTTP {r.status_code}")
    r = anon.post(f"{API}/registros/carregadores", json={"estabelecimento_id": 1, "nome": "x"}, timeout=TEMPO)
    checar("sem sessão: criar registro", r.status_code == 401, f"HTTP {r.status_code}")

    r = anon.post(f"{API}/auth/login", json={"email": CONTAS["main"][0], "senha": "errada"}, timeout=TEMPO)
    checar("senha errada é recusada", r.status_code == 401, f"HTTP {r.status_code}")
    r2 = anon.post(f"{API}/auth/login", json={"email": "nao@existe.local", "senha": "x"}, timeout=TEMPO)
    checar("e-mail inexistente responde igual a senha errada",
           r.status_code == r2.status_code and r.json().get("detail") == r2.json().get("detail"),
           "não vaza quais e-mails existem")

    r = anon.get(f"{API}/dados?estabelecimento_id=1",
                 cookies={"praca_sessao": "token-inventado"}, timeout=TEMPO)
    checar("token inventado é recusado", r.status_code == 401, f"HTTP {r.status_code}")

    ger = entrar("gerente")
    op = entrar("operador")
    main_s = entrar("main")
    if not (ger and op and main_s):
        print("\n!! sem as senhas no ambiente, o resto não roda")
        print("   SENHA_MAIN / SENHA_GERENTE / SENHA_OPERADOR")
        imprimir()
        return

    bruto = ger.post(f"{API}/auth/login",
                     json={"email": CONTAS["gerente"][0], "senha": CONTAS["gerente"][1]}, timeout=TEMPO)
    cookie = bruto.headers.get("set-cookie", "")
    checar("cookie é HttpOnly", "HttpOnly" in cookie, cookie[:90])
    checar("cookie tem SameSite", "SameSite" in cookie, cookie[:90])

    # ---------------------------------------------------------- papéis ----
    print("== papéis ==")
    r = op.patch(f"{API}/registros/carregadores/1", json={"nome": "invadido"}, timeout=TEMPO)
    checar("operador não edita registro", r.status_code == 403, f"HTTP {r.status_code}")
    r = op.delete(f"{API}/registros/carregadores/1", timeout=TEMPO)
    checar("operador não exclui registro", r.status_code == 403, f"HTTP {r.status_code}")
    r = op.post(f"{API}/registros/vendas", json={"estabelecimento_id": 1, "valor_brl": 1}, timeout=TEMPO)
    checar("operador não cria registro", r.status_code == 403, f"HTTP {r.status_code}")

    d = op.get(f"{API}/dados?estabelecimento_id=1", timeout=TEMPO).json()
    loja = d["estabelecimentos"][0]
    checar("operador não recebe margem", "margem_liquida_pct" not in loja, str(list(loja)[:6]))
    checar("operador não recebe ticket", "ticket_medio_brl" not in loja)
    checar("operador tem financeiro bloqueado",
           "financeiro" in op.get(f"{API}/auth/eu", timeout=TEMPO).json()["secoes_bloqueadas"])

    ctx = op.post(f"{API}/ia/perguntar", json={"pergunta": "qual o saldo?", "estabelecimento_id": 1},
                  timeout=TEMPO)
    texto = ctx.json().get("resposta", "").lower() if ctx.ok else ""
    checar("IA não entrega financeiro ao operador",
           "gerente" in texto or "não" in texto, texto[:70])

    r = ger.post(f"{API}/registros/estabelecimentos", json={"nome": "loja pirata"}, timeout=TEMPO)
    checar("gerente não cria estabelecimento", r.status_code == 403, f"HTTP {r.status_code}")

    # ------------------------------------------------ isolamento de loja ----
    print("== isolamento entre lojas ==")
    for rota in ["/dados?estabelecimento_id=3", "/paineis?estabelecimento_id=3"]:
        r = ger.get(f"{API}{rota}", timeout=TEMPO)
        checar(f"gerente não acessa loja alheia: {rota}", r.status_code == 403, f"HTTP {r.status_code}")
    r = ger.post(f"{API}/ia/perguntar", json={"pergunta": "oi", "estabelecimento_id": 3}, timeout=TEMPO)
    checar("IA recusa loja alheia", r.status_code == 403, f"HTTP {r.status_code}")

    outra = main_s.get(f"{API}/dados?estabelecimento_id=3", timeout=TEMPO).json()
    alheio = outra["carregadores"][0]["id"] if outra["carregadores"] else None
    if alheio:
        r = ger.patch(f"{API}/registros/carregadores/{alheio}", json={"nome": "x"}, timeout=TEMPO)
        checar("gerente não edita carregador de outra loja", r.status_code == 404, f"HTTP {r.status_code}")

    dg = ger.get(f"{API}/dados?estabelecimento_id=1", timeout=TEMPO).json()
    meu = next((p for p in dg["paineis"] if not p["compartilhado"]), None)
    if meu:
        r = op.patch(f"{API}/paineis/{meu['id']}", json={"nome": "roubado"}, timeout=TEMPO)
        checar("operador não mexe no painel particular do gerente",
               r.status_code in (403, 404), f"HTTP {r.status_code}")

    # -------------------------------------------------------- injeção ----
    print("== injeção e entrada malformada ==")
    for tabela in ["usuarios", "sessoes_web", "usuarios; DROP TABLE usuarios--", "pg_class"]:
        r = ger.post(f"{API}/registros/{tabela}", json={"estabelecimento_id": 1, "nome": "x"}, timeout=TEMPO)
        # 403 também vale: a borda do Render barra caminho com ";" e "DROP"
        # antes de chegar na aplicação. Defesa em camada, e o que importa é
        # que não passa.
        checar(f"tabela fora da lista recusada: {tabela[:28]}",
               r.status_code in (400, 403, 404), f"HTTP {r.status_code}")
    # guarda o nome antes: auditoria que deixa lixo no banco é auditoria que
    # ninguém roda duas vezes. A primeira versão renomeava o carregador para
    # "ok" e ia embora — o nome ficou assim até aparecer num gráfico.
    antes = ger.get(f"{API}/dados?estabelecimento_id=1", timeout=TEMPO).json()["carregadores"][0]
    r = ger.patch(f"{API}/registros/carregadores/{antes['id']}",
                  json={"nome": antes["nome"], "senha_hash": "x",
                        "estabelecimento_id": 3, "id": 999}, timeout=TEMPO)
    if r.ok:
        volta = r.json()
        checar("campo fora da lista é descartado",
               volta.get("estabelecimento_id") == 1 and volta.get("id") == antes["id"],
               f"estab={volta.get('estabelecimento_id')} id={volta.get('id')}")
        checar("auditoria não deixou lixo", volta.get("nome") == antes["nome"], volta.get("nome", ""))
    r = ger.post(f"{API}/paineis", json={"estabelecimento_id": 1, "nome": "x" * 500,
                                         "compartilhado": False}, timeout=TEMPO)
    if r.ok:
        checar("nome de painel é truncado", len(r.json()["nome"]) <= 120, f"{len(r.json()['nome'])} chars")
        ger.delete(f"{API}/paineis/{r.json()['id']}", timeout=TEMPO)
    else:
        checar("segundo painel particular é recusado", r.status_code == 409, f"HTTP {r.status_code}")

    if meu:
        lixo = [{"id": "<script>alert(1)</script>"}, {"id": "retorno", "cols": 9999, "rows": -50},
                {"id": "retorno"}, {"id": "__proto__"}]
        r = ger.patch(f"{API}/paineis/{meu['id']}", json={"cards": lixo}, timeout=TEMPO)
        cards = r.json()["cards"] if r.ok else []
        checar("layout com lixo é normalizado",
               all(c["id"] in ("retorno",) for c in cards) and len(cards) == 1,
               json.dumps(cards)[:80])
        ger.patch(f"{API}/paineis/{meu['id']}", json={"cards": meu["cards"]}, timeout=TEMPO)

    # O caso que motivou a proteção: operador abre painel compartilhado, o
    # navegador esconde os cards de dinheiro, e salvar apagaria os do gerente.
    comp = next((p for p in dg["paineis"] if p["compartilhado"]), None)
    if comp:
        antes = {c["id"] for c in comp["cards"]}
        op.patch(f"{API}/paineis/{comp['id']}",
                 json={"cards": [{"id": "sessoes", "grupo": "small", "cols": 5, "rows": 2}]},
                 timeout=TEMPO)
        depois = ger.get(f"{API}/dados?estabelecimento_id=1", timeout=TEMPO).json()
        agora = {c["id"] for c in next(p for p in depois["paineis"]
                                       if p["id"] == comp["id"])["cards"]}
        checar("operador não apaga card financeiro que nem enxerga",
               antes & {"retorno", "teto", "lucro"} <= agora,
               f"antes {sorted(antes)} depois {sorted(agora)}")

    # ----------------------------------------------------------- perfil ----
    print("== perfil ==")
    r = ger.post(f"{API}/perfil/nome", json={"nome": "Hacker", "senha_atual": "errada"}, timeout=TEMPO)
    checar("trocar nome exige senha correta", r.status_code == 403, f"HTTP {r.status_code}")
    r = ger.post(f"{API}/perfil/senha", json={"senha_atual": "errada", "nova": "12345678"}, timeout=TEMPO)
    checar("trocar senha exige senha correta", r.status_code == 403, f"HTTP {r.status_code}")
    r = ger.post(f"{API}/perfil/senha",
                 json={"senha_atual": CONTAS["gerente"][1], "nova": "curta"}, timeout=TEMPO)
    checar("senha curta é recusada", r.status_code == 400, f"HTTP {r.status_code}")

    # ------------------------------------------------------------ CORS ----
    print("== CORS e cabeçalhos ==")
    r = requests.options(f"{API}/auth/login", timeout=TEMPO, headers={
        "Origin": "https://sitedoatacante.example", "Access-Control-Request-Method": "POST"})
    checar("origem estranha é bloqueada no CORS",
           not r.headers.get("access-control-allow-origin"),
           r.headers.get("access-control-allow-origin") or "sem cabeçalho")

    # -------------------------------------------- exposição e limites ----
    print("== exposição e limites ==")
    for rota in ["/docs", "/openapi.json", "/redoc"]:
        r = anon.get(f"{API}{rota}", timeout=TEMPO)
        checar(f"{rota} não é público", r.status_code == 404, f"HTTP {r.status_code}")

    r = anon.get(f"{API}/painel/", timeout=TEMPO)
    cab = {k.lower(): v for k, v in r.headers.items()}
    for nome in ["content-security-policy", "x-content-type-options",
                 "x-frame-options", "referrer-policy"]:
        checar(f"cabeçalho {nome}", nome in cab, cab.get(nome, "ausente")[:28])
    checar("CSP proíbe iframe de terceiro",
           "frame-ancestors 'none'" in cab.get("content-security-policy", ""))
    checar("apresentação é servida pela própria API", r.status_code == 200, f"HTTP {r.status_code}")

    # /painel/ virou o site de apresentação, e o painel passou a morar em
    # /painel/dashboard.html. Sem esta linha, renomear o arquivo de volta (ou
    # errar o nome num deploy) passaria pela auditoria: a raiz continuaria
    # respondendo 200 e ninguém veria que a tela de trabalho sumiu.
    d = anon.get(f"{API}/painel/dashboard.html", timeout=TEMPO)
    checar("painel do lojista continua no ar", d.status_code == 200, f"HTTP {d.status_code}")
    m = anon.get(f"{API}/painel/mapa.html", timeout=TEMPO)
    checar("mapa de carregadores responde", m.status_code == 200, f"HTTP {m.status_code}")

    # As duas telas abertas não podem pedir sessão: a apresentação é pública
    # por definição, e o mapa foi especificado como acessível sem login.
    checar("apresentação e mapa são públicos",
           "loginGate" not in r.text and "loginGate" not in m.text,
           "porta de login presente numa tela pública")

    # ---- a assistente do site ----
    # Ela é pública E gasta dinheiro na OpenRouter, combinação que merece
    # vigilância. Os testes abaixo são de graça de propósito: o limitador roda
    # ANTES da chamada ao modelo, e pergunta vazia morre no 400 sem sair da
    # máquina. Assim a auditoria confere o portão sem pagar por isso.
    #
    # O limite em si (10/h por IP) não é levado à exaustão aqui: fazer isso
    # deixaria o IP de quem auditou sem assistente por uma hora, num serviço
    # que está no ar. O que se confere é que o portão existe e responde.
    v = anon.post(f"{API}/ia/publico", json={"pergunta": ""}, timeout=TEMPO)
    checar("assistente do site não pede login", v.status_code != 401, f"HTTP {v.status_code}")
    checar("assistente recusa pergunta vazia", v.status_code == 400, f"HTTP {v.status_code}")

    # A rota pública não pode aceitar seletor de loja: se um dia alguém colar
    # nela o contexto do banco, este teste é o que grita. Com pergunta vazia
    # ela tem de morrer no mesmo 400 — sinal de que nem olhou o campo.
    v = anon.post(f"{API}/ia/publico",
                  json={"pergunta": "", "estabelecimento_id": 1}, timeout=TEMPO)
    checar("assistente do site ignora estabelecimento_id",
           v.status_code == 400, f"HTTP {v.status_code}")

    # E a rota com banco continua exigindo sessão.
    v = anon.post(f"{API}/ia/perguntar",
                  json={"pergunta": "oi", "estabelecimento_id": 1}, timeout=TEMPO)
    checar("assistente do painel continua exigindo login", v.status_code == 401, f"HTTP {v.status_code}")

    # HSTS só existe sobre https: em http local ele não deve aparecer, porque
    # ensinaria o navegador a recusar 127.0.0.1 por um ano.
    hsts = cab.get("strict-transport-security", "")
    if API.startswith("https://"):
        checar("HSTS presente e com prazo longo",
               "max-age=" in hsts and int(hsts.split("max-age=")[1].split(";")[0]) >= 15552000,
               hsts or "ausente")
    else:
        checar("HSTS ausente em http (correto para o local)", not hsts, hsts or "ausente")

    # e-mail descartável: o limite por conta é o que trava, e não vale gastar
    # o balde de um usuário real no meio da auditoria
    bloqueou = False
    alvo = f"forca-bruta-{int(time.time())}@teste.local"
    for i in range(14):
        r = requests.post(f"{API}/auth/login",
                          json={"email": alvo, "senha": f"t{i}"}, timeout=TEMPO)
        if r.status_code == 429:
            bloqueou = True
            break
    checar("login bloqueia força bruta", bloqueou, f"parou na tentativa {i + 1}")

    # ------------------------------------------------------ transcrição ----
    print("== transcrição de áudio ==")
    r = anon.post(f"{API}/ia/transcrever", json={"audio": "AAAA"}, timeout=TEMPO)
    checar("sem sessão: POST /ia/transcrever", r.status_code == 401, f"HTTP {r.status_code}")
    r = op.post(f"{API}/ia/transcrever", json={"audio": ""}, timeout=TEMPO)
    checar("áudio vazio é recusado", r.status_code == 400, f"HTTP {r.status_code}")
    r = op.post(f"{API}/ia/transcrever",
                json={"audio": "A" * 9_000_000}, timeout=TEMPO)
    checar("áudio grande demais é recusado", r.status_code == 413, f"HTTP {r.status_code}")
    r = op.post(f"{API}/ia/transcrever", json={"audio": "isto-nao-e-base64!!!"}, timeout=TEMPO)
    checar("base64 inválido para antes de virar chamada paga",
           r.status_code == 400, f"HTTP {r.status_code}")
    r = op.post(f"{API}/ia/transcrever",
                json={"audio": "aGVsbG8gd29ybGQgaXNzbyBuYW8gZWggdW0gd2F2"}, timeout=TEMPO)
    checar("arquivo que não é WAV é recusado", r.status_code == 400, f"HTTP {r.status_code}")

    # ---------------------------------------------------------- logout ----
    print("== logout ==")
    temp = entrar("gerente")
    temp.post(f"{API}/auth/logout", timeout=TEMPO)
    r = temp.get(f"{API}/auth/eu", timeout=TEMPO)
    checar("logout invalida o token no servidor", r.status_code == 401, f"HTTP {r.status_code}")

    imprimir()


def imprimir() -> None:
    print("\n" + "=" * 74)
    falhas = [r for r in resultados if r[0] == "FALHOU"]
    for status, nome, detalhe in resultados:
        marca = "  ok " if status == "PASSOU" else "FALHA"
        print(f"{marca}  {nome:<52} {detalhe[:28]}")
    print("=" * 74)
    print(f"{len(resultados) - len(falhas)} de {len(resultados)} passaram")
    if falhas:
        print("\nFALHAS:")
        for _, nome, detalhe in falhas:
            print(f"  - {nome}: {detalhe}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()

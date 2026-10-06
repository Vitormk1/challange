"""A ponte entre a maquete e o Smart Charge.

O Arduino Mega nao tem rede, e mesmo com Ethernet nao falaria com a nossa API:
ela e HTTPS com HSTS, e 8 KB de RAM nao sustentam TLS 1.2. Entao o Mega so
escreve e le linhas de texto na USB, e quem fala HTTPS e este script, rodando
no notebook que ja vai estar na mesa.

    Mega  --USB, texto--  ponte.py  --HTTPS--  smartcharge.ia.br

Nao precisa de login: as rotas da telinha foram feitas para o carregador, que
nao tem conta (ver o cabecalho de `api/telinha.py`). O que protege e o limite
por IP e por vaga, e o token aleatorio da sessao.

    pip install pyserial
    python fisico/ponte.py --porta COM3
    python fisico/ponte.py --simular          # sem hardware, contra a producao
    python fisico/ponte.py --portas           # lista as portas seriais

O QUE ESTA PONTE FAZ DE VERDADE: a maquete nao simula o leilao. Quando o
segundo carro chega, e o SERVIDOR quem diz que falta potencia e quais ofertas
existem; a ponte manda as ofertas para a maquete, espera o botao, e abre a
sessao com a escolha. Depois disso ela repete para o Mega a potencia que o
servidor liberou, e os LEDs da vaga obedecem. E a diferenca entre uma maquete
que imita e um gemeo digital.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field

import requests

API_PADRAO = "https://smartcharge.ia.br"

# As duas vagas da Pet & Cia Vila Mariana, que e a loja da maquete: 30 kWp de
# telhado, bateria de 20 kWh e o leilao de potencia ligado.
VAGAS = {1: 1, 2: 2}            # numero na maquete -> carregador_id no banco

TEMPO = 30                      # timeout de cada chamada, em segundos

# O Render do plano gratuito hiberna depois de ~15 min sem uso e leva uns 50 s
# para voltar. Numa feira isso significa o PRIMEIRO carro falhando -- que e
# justamente o que o jurado vai ver. A ponte acorda o servidor no arranque e
# espera o tempo que for preciso, uma vez so.
ESPERA_ACORDAR = 90

# De quanto em quanto a ponte repete a leitura para a API. O Mega manda a cada
# 2 s para mexer os LEDs; mandar tudo isso para producao seria uma chamada a
# cada segundo com duas vagas, sem necessidade -- a curva do painel e horaria.
INTERVALO_LEITURA = 10.0

# De quanto em quanto pergunta ao servidor quanta potencia cada vaga pode usar.
INTERVALO_FOLGA = 8.0

# Quanto tempo a maquete espera o botao do leilao antes de assumir potencia
# cheia. E o mesmo prazo da telinha (ver docs/vaga/online.js): ninguem fica
# parado na frente de um carregador decidindo.
ESPERA_LEILAO = 45.0


@dataclass
class Sessao:
    carregador_id: int
    token: str | None = None
    aberta: bool = False
    aguardando_leilao: bool = False
    desde: float = 0.0
    oferta_pct: float | None = None
    ultima_leitura: float = 0.0
    ultima_folga: float = 0.0
    config: dict = field(default_factory=dict)


class Ponte:
    def __init__(self, api: str, escrever):
        self.api = api.rstrip("/")
        self.escrever = escrever            # funcao que manda uma linha ao Mega
        self.http = requests.Session()
        self.sessoes: dict[int, Sessao] = {
            n: Sessao(carregador_id=cid) for n, cid in VAGAS.items()
        }

    # ------------------------------------------------------------ rede ----
    def acordar(self) -> bool:
        """Tira o servidor da hibernacao antes de a maquete precisar dele."""
        print(f"acordando {self.api} (pode levar ~1 min na primeira vez)...")
        inicio = time.monotonic()
        try:
            r = self.http.get(self.api + "/saude", timeout=ESPERA_ACORDAR)
            demorou = time.monotonic() - inicio
            if r.ok:
                print(f"  servidor no ar em {demorou:.0f}s "
                      f"· versao {r.json().get('versao', '?')}")
                return True
            print(f"  !! /saude respondeu HTTP {r.status_code}")
        except requests.RequestException as e:
            print(f"  !! nao consegui acordar: {type(e).__name__}")
        return False

    def _pedir(self, metodo: str, caminho: str, corpo=None):
        """Uma chamada a API. Falha nunca derruba a ponte -- a maquete tem de
        continuar andando mesmo com o wi-fi do evento caindo."""
        try:
            r = self.http.request(metodo, self.api + caminho, json=corpo,
                                  timeout=TEMPO)
            if not r.ok:
                print(f"  !! {metodo} {caminho} -> HTTP {r.status_code}")
                return None
            return r.json()
        except requests.RequestException as e:
            print(f"  !! {metodo} {caminho} -> {type(e).__name__}")
            return None

    # --------------------------------------------------------- eventos ----
    def carro_chegou(self, vaga: int):
        s = self.sessoes.get(vaga)
        if not s or s.aberta or s.aguardando_leilao:
            return
        print(f"[vaga {vaga}] carro detectado")

        cfg = self._pedir("GET", f"/vagas/{s.carregador_id}/telinha")
        if not cfg:
            return
        s.config = cfg

        self.escrever(f"CFG;vaga={vaga};kw={cfg['potencia_liberada_kw']:.2f}"
                      f";preco={cfg['preco_kwh_brl']:.2f}"
                      f";ponta={1 if cfg['em_ponta'] else 0}")

        leilao = cfg.get("leilao") or {}
        ofertas = leilao.get("ofertas") or []
        # Oferta de economia e sempre a de menor potencia; a primeira da lista
        # e a potencia cheia (ver `ofertas_de_leilao` em ai/demanda.py).
        economia = min(ofertas, key=lambda o: o["potencia_pct"], default=None)
        if leilao.get("ativo") and economia and economia["potencia_pct"] < 100:
            print(f"[vaga {vaga}] falta potencia na loja — leilao: "
                  f"{economia['potencia_pct']:.0f}% por "
                  f"{economia['cashback_fator']:.1f}x de cashback")
            s.aguardando_leilao = True
            s.desde = time.monotonic()
            self.escrever(f"LEILAO;vaga={vaga}"
                          f";pct={economia['potencia_pct']:.0f}"
                          f";fator={economia['cashback_fator']:.2f}")
            return

        self.escrever(f"SEMLEILAO;vaga={vaga}")
        self.abrir(vaga)

    def escolheu(self, vaga: int, pct: float):
        s = self.sessoes.get(vaga)
        if not s or not s.aguardando_leilao:
            return
        print(f"[vaga {vaga}] motorista escolheu {pct:.0f}% da potencia")
        s.aguardando_leilao = False
        s.oferta_pct = None if pct >= 100 else pct
        self.abrir(vaga)

    def abrir(self, vaga: int):
        s = self.sessoes[vaga]
        corpo = {"soc_inicial": 0.25}
        if s.oferta_pct is not None:
            corpo["leilao_potencia_pct"] = s.oferta_pct
        r = self._pedir("POST", f"/vagas/{s.carregador_id}/sessao", corpo)
        if not r:
            self.escrever(f"ERRO;vaga={vaga}")
            return
        s.token = r["token"]
        s.aberta = True
        s.ultima_leitura = 0.0
        fator = r.get("leilao_fator")
        print(f"[vaga {vaga}] sessao aberta · token {s.token}"
              + (f" · cashback {fator:.2f}x" if fator else ""))
        self.escrever(f"OK;vaga={vaga}")

    def leitura(self, vaga: int, soc: float, kw: float, kwh: float):
        s = self.sessoes.get(vaga)
        if not s or not s.aberta or not s.token:
            return
        agora = time.monotonic()
        if agora - s.ultima_leitura < INTERVALO_LEITURA:
            return
        s.ultima_leitura = agora
        self._pedir("POST", f"/sessoes/{s.token}/leitura",
                    {"soc": soc, "potencia_kw": kw, "energia_kwh": kwh})
        print(f"[vaga {vaga}] {soc*100:4.0f}% · {kw:5.2f} kW · {kwh:6.3f} kWh")

    def fim(self, vaga: int):
        s = self.sessoes.get(vaga)
        if not s:
            return
        if s.aberta and s.token:
            self._pedir("POST", f"/sessoes/{s.token}/encerrar")
            print(f"[vaga {vaga}] sessao encerrada")
        s.token, s.aberta, s.aguardando_leilao, s.oferta_pct = None, False, False, None

    # -------------------------------------------------------- periodico ---
    def passo(self):
        """Chamado a cada volta: cuida do prazo do leilao e da folga da loja."""
        agora = time.monotonic()
        for vaga, s in self.sessoes.items():
            if s.aguardando_leilao and agora - s.desde > ESPERA_LEILAO:
                print(f"[vaga {vaga}] ninguem escolheu — potencia cheia")
                s.aguardando_leilao = False
                self.abrir(vaga)

            if s.aberta and agora - s.ultima_folga > INTERVALO_FOLGA:
                s.ultima_folga = agora
                cfg = self._pedir("GET", f"/vagas/{s.carregador_id}/telinha")
                if cfg:
                    # E aqui que a maquete obedece ao sistema: a potencia que
                    # os LEDs mostram e a que o servidor liberou, depois de
                    # repartir entre quem esta carregando.
                    self.escrever(f"LIBERA;vaga={vaga}"
                                  f";kw={cfg['potencia_liberada_kw']:.2f}")

    # ----------------------------------------------------------- linhas ---
    def recebe(self, linha: str):
        linha = linha.strip()
        if not linha:
            return
        partes = linha.split(";")
        tipo = partes[0].upper()
        campos = {}
        for p in partes[1:]:
            if "=" in p:
                k, v = p.split("=", 1)
                campos[k] = v

        def n(chave, padrao=0.0):
            try: return float(campos.get(chave, padrao))
            except ValueError: return padrao

        vaga = int(n("vaga", 0))
        if tipo == "OLA":
            print("maquete conectada.")
            for v, s in self.sessoes.items():
                self.escrever(f"CFG;vaga={v};kw=22.00;preco=1.60;ponta=0")
        elif tipo == "CARRO":
            self.carro_chegou(vaga)
        elif tipo == "LEITURA":
            self.leitura(vaga, n("soc"), n("kw"), n("kwh"))
        elif tipo == "FIM":
            self.fim(vaga)
        elif tipo == "OFERTA":
            self.escolheu(vaga, n("pct", 100))
        else:
            print(f"  ?? linha desconhecida: {linha[:60]}")


# ------------------------------------------------------------- entradas ---

def listar_portas():
    try:
        from serial.tools import list_ports
    except ImportError:
        print("!! falta o pyserial:  pip install pyserial")
        return
    achadas = list(list_ports.comports())
    if not achadas:
        print("nenhuma porta serial encontrada. O Mega esta ligado no USB?")
    for p in achadas:
        print(f"  {p.device:<12} {p.description}")


def rodar_serial(api: str, porta: str, baud: int):
    try:
        import serial
    except ImportError:
        print("!! falta o pyserial:  pip install pyserial")
        return 1

    print(f"abrindo {porta} a {baud} ... (Ctrl+C para sair)")
    with serial.Serial(porta, baud, timeout=0.2) as ser:
        # O Mega reinicia quando a porta abre. Esperar evita perder o OLA.
        time.sleep(2.0)
        ponte = Ponte(api, lambda l: ser.write((l + "\n").encode()))
        ponte.acordar()
        print(f"ponte no ar: {porta}  <->  {api}\n")
        while True:
            try:
                bruto = ser.readline()
            except Exception as e:
                print(f"!! serial caiu: {e}")
                return 1
            if bruto:
                try:
                    ponte.recebe(bruto.decode("utf-8", "replace"))
                except Exception as e:      # noqa: BLE001 - a maquete nao pode parar
                    print(f"  !! erro tratando linha: {e}")
            ponte.passo()


def rodar_simulado(api: str):
    """Um carro inteiro, sem hardware nenhum, contra a producao.

    Serve para conferir a ponte e a API antes de existir um fio ligado -- e
    para saber se a maquete nao funciona por causa do codigo ou da fiacao.
    """
    saida = []
    ponte = Ponte(api, lambda l: (saida.append(l), print(f"  -> Mega: {l}")) and None)
    ponte.acordar()
    print(f"ponte simulada contra {api}\n")

    ponte.recebe("OLA")
    ponte.recebe("CARRO;vaga=1")
    ponte.passo()

    if ponte.sessoes[1].aguardando_leilao:
        print("\n  (havia leilao — escolhendo a oferta de economia)\n")
        oferta = next((l for l in saida if l.startswith("LEILAO")), "")
        pct = next((p.split("=")[1] for p in oferta.split(";") if p.startswith("pct=")), "100")
        ponte.recebe(f"OFERTA;vaga=1;pct={pct}")

    soc, kwh = 0.25, 0.0
    for _ in range(4):
        soc, kwh = min(1.0, soc + 0.12), kwh + 4.8
        ponte.sessoes[1].ultima_leitura = 0.0      # ignora o intervalo no teste
        ponte.recebe(f"LEITURA;vaga=1;soc={soc:.3f};kw=7.40;kwh={kwh:.3f}")
        time.sleep(0.4)

    ponte.recebe("FIM;vaga=1")
    print("\nsimulacao completa. Confira a sessao no painel da loja.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Ponte entre a maquete e o Smart Charge.")
    p.add_argument("--api", default=API_PADRAO)
    p.add_argument("--porta", help="COM3, /dev/ttyACM0 ...")
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--portas", action="store_true", help="lista as portas e sai")
    p.add_argument("--simular", action="store_true", help="roda sem hardware")
    a = p.parse_args()

    if a.portas:
        listar_portas(); return 0
    if a.simular:
        return rodar_simulado(a.api)
    if not a.porta:
        print("diga a porta:  --porta COM3     (ou use --portas / --simular)")
        return 1
    try:
        return rodar_serial(a.api, a.porta, a.baud) or 0
    except KeyboardInterrupt:
        print("\nencerrando as sessoes abertas...")
        return 0


if __name__ == "__main__":
    sys.exit(main())

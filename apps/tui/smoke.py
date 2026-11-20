#!/usr/bin/env python3
# smoke da TUI (headless, textual pilot): carrega, navega, toggla, roda fluxo, vê eventos.
# Rodar: .venv/bin/python apps/tui/smoke.py
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from falador_tui import FaladorTUI, REPO  # noqa: E402

FLOW = os.path.join(REPO, "apps", "tui", "flows", "test", "demo-engine.json")


async def main() -> int:
    app = FaladorTUI(FLOW)
    async with app.run_test(size=(120, 30)) as pilot:
        await pilot.pause()
        assert app.catalog, "catálogo não carregou"
        print(f"OK catalogo: {len(app.catalog)} tipos")

        # toggle do segundo nó (parcs)
        await pilot.press("down")          # cursor → parcs
        app.action_toggle_enabled()        # atalho de teclado exercitado no run real; aqui chamamos direto
        await pilot.pause()
        parcs = next(n for n in app.flow["nodes"] if n["id"] == "parcs")
        assert parcs["enabled"] is False, "toggle não pegou"
        print("OK toggle: parcs.enabled=False")

        # run com parcs desligado — deve ainda entregartone→sink via... sem ponte!
        # (não há edge direta tone→snk neste flow, então resultado esperado: vazio)
        await pilot.press("r")
        deadline = asyncio.get_event_loop().time() + 30
        while app.proc is not None and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.2)
            await pilot.pause()
        assert app.proc is None, "runner não terminou"

    # fora do contexto: valida persistência + conteúdo
    flow_after = json.load(open(FLOW))
    parcs = next(n for n in flow_after["nodes"] if n["id"] == "parcs")
    assert parcs["enabled"] is False, "persistência falhou"
    print("OK persistência: enabled=False salvo no flow")

    # restaura e valida smoke com TODOS ligados + resultado preenchido
    parcs["enabled"] = True
    json.dump(flow_after, open(FLOW, "w"), indent=2, ensure_ascii=False)
    app2 = FaladorTUI(FLOW)
    async with app2.run_test(size=(120, 30)) as pilot:
        await pilot.pause()
        await pilot.press("r")
        deadline = asyncio.get_event_loop().time() + 30
        while app2.proc is not None and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.2)
            await pilot.pause()
    # releitura do log via eventos: valida summary nos eventos gravados
    txt = "\n".join(strip.text for strip in app2.run_log.lines)
    assert "summary" in txt, f"summary não apareceu no log:\n{txt[-500:]}"
    assert "ola-1" in txt, f"resultado não apareceu no log:\n{txt[-500:]}"
    print("OK run: summary + resultado (ola-1) visíveis na TUI")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

#!/usr/bin/env python3
# falador-tui (r4) — TUI Textual para o motor falador-graph (ADR-003 W5)
# Fases da W5 cobertas aqui: Tree de nós do FLUXO com toggle de `enabled`,
# paleta de tipos disponíveis (catálogo do runner), reorder ↑/↓, rodar fluxo
# com eventos NDJSON ao vivo e resultado final. Canvas visual = fase web (React Flow).
#
# Uso:
#   .venv/bin/python apps/tui/falador_tui.py --flow apps/tui/flows/test/demo-engine.json
#   .venv/bin/python apps/tui/falador_tui.py --flow apps/tui/flows/test/demo-live.json
# Teclas: espaço=toggle enabled · r=rodar · ↑/↓=mover nó · q=sair
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import DataTable, Footer, Header, RichLog, Static

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNNER = os.path.join(REPO, "packages", "falador-cli", "run-flow.mjs")
NODE_BIN = "node"


def load_catalog() -> list[dict]:
    out = subprocess.run(
        [NODE_BIN, RUNNER, "--catalog"],
        capture_output=True, text=True, cwd=REPO, timeout=30, check=True,
    ).stdout
    for linha in out.splitlines():
        obj = json.loads(linha)
        if obj.get("type") == "catalog":
            return obj["nodes"]
    return []


class FaladorTUI(App):
    TITLE = "Falador — fluxo (TUI fase 1, W5)"
    BINDINGS = [
        ("space", "toggle_enabled", "liga/desliga nó"),
        ("r", "run_flow", "rodar fluxo"),
        ("up", "move_up", "mover ↑"),
        ("down", "move_down", "mover ↓"),
        ("L", "reload", "recarregar flow"),
        ("q", "quit", "sair"),
    ]

    def __init__(self, flow_path: str):
        super().__init__()
        self.flow_path = flow_path
        self.flow: dict = json.load(open(flow_path))
        self.catalog: list[dict] = []
        self.row_by_id: dict[str, int] = {}
        self.proc: subprocess.Popen | None = None

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal():
            with Vertical(id="left"):
                yield Static("NÓS DO FLUXO (espaço = liga/desliga · ↑↓ move)", id="lbl-fluxo")
                self.nodes_table = DataTable(zebra_stripes=True)
                self.nodes_table.add_columns("enabled", "id", "tipo", "parâmetros")
                yield self.nodes_table
                yield Static(f"PALETA ({len(self.catalog)} tipos do catálogo)", id="lbl-paleta")
                self.palette_table = DataTable(zebra_stripes=True)
                self.palette_table.add_columns("tipo", "in", "out", "parâmetros")
                yield self.palette_table
            with Vertical(id="right"):
                yield Static("EVENTOS DO RUN (r = rodar)", id="lbl-run")
                self.run_log = RichLog(highlight=False, wrap=True, markup=True)
                yield self.run_log
        yield Footer()

    def on_mount(self) -> None:
        self.run_log.write("[b]carregando catálogo…[/b]")
        try:
            self.catalog = load_catalog()
        except Exception as e:  # runner ausente etc.
            self.run_log.write(f"[red]catálogo falhou: {e}[/red]")
        self.refresh_nodes()
        self.refresh_palette()

    # ---------- render ----------
    def refresh_nodes(self) -> None:
        self.nodes_table.clear()
        self.row_by_id.clear()
        for i, n in enumerate(self.flow.get("nodes", [])):
            params = json.dumps(n.get("params", {}), ensure_ascii=False)
            if len(params) > 38:
                params = params[:38] + "…"
            self.row_by_id[n["id"]] = i
            mark = "[b]✔[/b]" if n.get("enabled", True) else "[dim]✘[/dim]"
            self.nodes_table.add_row(mark, n["id"], n["type"], params, key=n["id"])
        edges = " → ".join(f"{e['from']}→{e['to']}" for e in self.flow.get("edges", []))
        self.query_one("#lbl-fluxo", Static).update(
            f"NÓS DO FLUXO  ·  edges: {edges or '—'}"
        )

    def refresh_palette(self) -> None:
        self.palette_table.clear()
        for d in self.catalog:
            ins = ",".join(p["name"] for p in d["inputs"]) or "—"
            outs = ",".join(p["name"] for p in d["outputs"]) or "—"
            self.palette_table.add_row(d["type"], ins, outs, ",".join(d["paramNames"]) or "—")
        self.query_one("#lbl-paleta", Static).update(
            f"PALETA ({len(self.catalog)} tipos do catálogo) — fluxo salvo em: {self.flow_path}"
        )

    # ---------- ações ----------
    def action_toggle_enabled(self) -> None:
        node_id = self._cursor_node_id()
        if not node_id:
            return
        for n in self.flow["nodes"]:
            if n["id"] == node_id:
                n["enabled"] = False if n.get("enabled", True) else True
                self.save_flow()
                self.refresh_nodes()
                self.run_log.write(f"[yellow]↔[/yellow] {node_id} enabled={n['enabled']}")
                return

    def _cursor_node_id(self) -> str | None:
        try:
            rk = self.nodes_table.coordinate_to_cell_key(
                (self.nodes_table.cursor_row, 0)
            ).row_key
        except Exception:
            return None
        return rk.value if rk else None

    def action_move_up(self) -> None:
        self._move(-1)

    def action_move_down(self) -> None:
        self._move(+1)

    def _move(self, delta: int) -> None:
        node_id = self._cursor_node_id()
        if not node_id:
            return
        nodes = self.flow["nodes"]
        i = next((k for k, n in enumerate(nodes) if n["id"] == node_id), None)
        if i is None:
            return
        j = i + delta
        if not (0 <= j < len(nodes)):
            return
        nodes[i], nodes[j] = nodes[j], nodes[i]
        self.save_flow()
        self.refresh_nodes()
        self.nodes_table.cursor_row = j
        self.run_log.write(f"[dim]reorder: {node_id} movido para {j+1}/{len(nodes)}[/dim]")

    def action_reload(self) -> None:
        self.flow = json.load(open(self.flow_path))
        self.refresh_nodes()
        self.run_log.write("[dim]flow recarregado do disco[/dim]")

    def action_run_flow(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.run_log.write("[red]já existe um run em curso[/red]")
            return
        self.save_flow()
        with open(self.flow_path) as f:
            tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
            json.dump(self.flow, tmp)
            tmp.close()
        self.run_log.write(f"[b reverse] RUN {os.path.basename(self.flow_path)} [/b reverse]")
        self.proc = subprocess.Popen(
            [NODE_BIN, RUNNER, tmp.name],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=REPO, bufsize=1,
        )
        self.run_log.write(f"[dim]runner pid {self.proc.pid}[/dim]")
        self.call_later(self.pump_output)

    def pump_output(self) -> None:
        proc = self.proc
        if not proc:
            return
        while True:
            linha = proc.stdout.readline()
            if not linha:
                break
            try:
                obj = json.loads(linha)
            except Exception:
                self.run_log.write(f"[grey]stdout não-NDJSON: {linha.strip()[:120]}[/grey]")
                continue
            self.show_event(obj)
        err = proc.stderr.readline()
        if err:
            self.run_log.write(f"[red]stderr: {err.strip()[:200]}[/red]")
        if proc.poll() is not None:
            code = proc.returncode
            self.run_log.write(f"[b]{'✔' if code == 0 else '✖'} runner saiu ({code})[/b]")
            self.proc = None
            return
        self.set_timer(0.15, self.pump_output)

    def show_event(self, obj: dict) -> None:
        t = obj.get("type", "?")
        cor = {
            "run_started": "green",
            "run_stopped": "green",
            "node_error": "yellow",
            "edge_overflow": "red",
            "edge_expired": "red",
            "flow_invalid": "red",
            "summary": "cyan",
        }.get(t, "white")
        show = {k: v for k, v in obj.items() if k != "type"}
        self.run_log.write(f"[{cor}]{t}[/{cor}] {json.dumps(show, ensure_ascii=False)[:300]}")

    def save_flow(self) -> None:
        with open(self.flow_path, "w") as f:
            json.dump(self.flow, f, indent=2, ensure_ascii=False)
            f.write("\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="Falador TUI (Textual) — motor falador-graph")
    ap.add_argument("--flow", required=True, help="caminho do flow JSON")
    FaladorTUI(ap.parse_args().flow).run()


if __name__ == "__main__":
    main()

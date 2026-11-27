// Renderizador Markdown mínimo e seguro (sem innerHTML, sem dependência nova):
// títulos, tabelas GFM, listas, blocos de código, regra horizontal, **negrito** e `código`.
// shortcut: sem links/imagens/aninhamento de listas — trocar por uma lib se o agente passar a usá-los.
import { createElement, type ReactNode } from 'react';

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((p, i) => {
    if (p.length > 4 && p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.length > 2 && p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    return p;
  });
}

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableSep = (row: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row);
const LIST_RE = /^\s*([-*+]|\d+[.)])\s+(.*)$/;

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `md-${i}`;
    if (!line.trim()) { i++; continue; }
    if (line.trim().startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(<pre key={key}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(createElement(`h${Math.min(6, h[1].length + 2)}`, { key }, inline(h[2])));
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push(<hr key={key} />); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        <table key={key}>
          <thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? '')}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    const li = line.match(LIST_RE);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE);
        if (!m) break;
        items.push(m[2]);
        i++;
      }
      const children = items.map((it, j) => <li key={j}>{inline(it)}</li>);
      out.push(ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```)/.test(lines[i].trim()) && !LIST_RE.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      para.push(lines[i++]);
    }
    if (para.length === 0) { para.push(lines[i++]); }
    out.push(<p key={key}>{para.flatMap((p, j) => (j ? [<br key={`br-${j}`} />, ...inline(p)] : inline(p)))}</p>);
  }
  return <div className="live-chat-markdown">{out}</div>;
}

/** Garante título # e quebra final ao exportar relatório avulso em .md. */
export function reportMarkdown(text: string): string {
  const t = text.trim();
  const body = t.startsWith('#') ? t : `# Relatório\n\n${t}`;
  return `${body}\n`;
}

/** Baixa um .md no navegador (funciona também na janela pop-out). */
export function downloadMarkdown(fileBase: string, content: string): void {
  const slug = fileBase.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'relatorio';
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}`;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${stamp}-${slug}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

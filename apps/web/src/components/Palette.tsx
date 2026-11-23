// Paleta esquerda — busca + categorias com stripe colorido + itens arrastáveis
// (duplo clique também adiciona). Nós de teste ficam só no catálogo (CI), não na paleta.
import { useState } from 'react';
import { Search } from '@carbon/react';
import { CATEGORIES, NODE_META } from '../data';

export function Palette({ onAdd }: { onAdd: (type: string) => void }) {
  const [q, setQ] = useState('');
  const ql = q.trim().toLowerCase();
  const match = (type: string) =>
    !ql || type.toLowerCase().includes(ql) || (NODE_META[type]?.desc ?? '').toLowerCase().includes(ql);

  const drag = (e: React.DragEvent, type: string) => {
    e.dataTransfer.setData('application/falador-node', type);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <aside className="palette">
      <div className="palette-search">
        <Search
          size="sm" labelText="Buscar nó" placeholder="Search"
          closeButtonLabelText="Limpar busca"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="palette-cats">
        {CATEGORIES.filter((c) => !c.collapsible && c.id !== 'teste').map((c) => {
          const items = c.nodes.filter(match);
          if (ql && items.length === 0) return null;
          return (
            <div key={c.id} className="pal-cat" style={{ ['--accent' as string]: c.accent }}>
              <div className="pal-cat-head"><span className="pal-emoji">{c.emoji}</span>{c.label}</div>
              {items.map((t) => (
                <div
                  key={t} className="pal-item" draggable
                  onDragStart={(e) => drag(e, t)} onDoubleClick={() => onAdd(t)}
                  title="Arraste pro canvas ou duplo clique pra adicionar"
                >
                  <span className="pal-item-id">{t}</span>
                  <span className="pal-item-desc">{NODE_META[t]?.desc ?? ''}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
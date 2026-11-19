// Tela de EXECUÇÃO — INTERINA (o dono vai mandar o layout definitivo).
// Já cumpre a função: a sugestão pra ler/falar é o HERO da tela; gate humano
// (aprovar/editar/rejeitar); transcrição e log subordinados.
import { useState } from 'react';
import { Button, TextArea } from '@carbon/react';
import type { Runner } from '../useRunner';

export function LiveView({ runner }: { runner: Runner }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const last = runner.captions[runner.captions.length - 1];
  const hero = last?.text ?? '';

  return (
    <div className="live">
      <div className="live-hero">
        <div className="live-hero-label">Sugestão — leia e fale</div>
        <div className="live-hero-text">{hero || (runner.running ? 'Ouvindo…' : 'Inicie o fluxo para ver a sugestão aqui.')}</div>
      </div>

      {runner.gates.map((g) => (
        <div key={g.nodeId} className="live-gate">
          <div className="live-gate-label">Gate humano — revise antes de falar</div>
          {editing === g.nodeId ? (
            <>
              <TextArea labelText="Editar sugestão" hideLabel rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="live-gate-actions">
                <Button size="sm" kind="primary" onClick={() => { runner.gate(g.nodeId, draft); setEditing(null); }}>Enviar editada</Button>
                <Button size="sm" kind="ghost" onClick={() => setEditing(null)}>Cancelar</Button>
              </div>
            </>
          ) : (
            <>
              <div className="live-gate-text">{g.text}</div>
              <div className="live-gate-actions">
                <Button size="sm" kind="primary" onClick={() => runner.gate(g.nodeId, g.text)}>Aprovar</Button>
                <Button size="sm" kind="secondary" onClick={() => { setEditing(g.nodeId); setDraft(g.text); }}>Editar</Button>
                <Button size="sm" kind="danger" onClick={() => runner.gate(g.nodeId, null)}>Rejeitar</Button>
              </div>
            </>
          )}
        </div>
      ))}

      <div className="live-side">
        <div className="live-side-title">Transcrição / legendas</div>
        <div className="live-captions">
          {runner.captions.slice(-8).map((c, i) => (
            <div key={i} className={`live-cap${c.final ? ' live-cap--final' : ''}`}>{c.text}</div>
          ))}
        </div>
        <p className="live-note">Layout de execução interino — me mande o desenho definitivo que eu reconstruo esta tela fiel a ele.</p>
      </div>
    </div>
  );
}
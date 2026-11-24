// SessionsPanel — navega as sessões exportadas pelo host (sessions/*.md).
// Modal somente-leitura: lista as atas por data e mostra o transcript num <pre>.
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Modal,
  Tag,
  StructuredListWrapper,
  StructuredListBody,
  StructuredListRow,
  StructuredListCell,
} from '@carbon/react';
import { getSession, listSessions, type SessionInfo } from '../api';

interface Props {
  open: boolean;
  onClose: () => void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SessionsPanel({ open, onClose }: Props) {
  const [items, setItems] = useState<SessionInfo[]>([]);
  const [selected, setSelected] = useState<SessionInfo | null>(null);
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError('');
    setSelected(null);
    setContent('');
    setLoading(true);
    listSessions()
      .then((r) => { if (alive) setItems(r.items); })
      .catch((e: unknown) => { if (alive) setError(errorMessage(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);

  const openSession = (item: SessionInfo) => {
    const id = ++requestId.current;
    setError('');
    setSelected(item);
    setContent('');
    getSession(item.name)
      .then((r) => { if (id === requestId.current) setContent(r.content); })
      .catch((e: unknown) => { if (id === requestId.current) setError(errorMessage(e)); });
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="Sessões exportadas"
      passiveModal
      size="lg"
    >
      <div className="sessions-panel">
        {error && <p className="sessions-panel-error" role="alert">{error}</p>}
        {!selected && (
          loading
            ? <p className="sessions-panel-empty">Carregando…</p>
            : items.length === 0
              ? <p className="sessions-panel-empty">Nenhuma sessão exportada ainda</p>
              : (
                <StructuredListWrapper>
                  <StructuredListBody>
                    {items.map((item) => (
                      <StructuredListRow key={item.name}>
                        <StructuredListCell>
                          <Button kind="ghost" size="sm" onClick={() => openSession(item)}>{item.name}</Button>
                        </StructuredListCell>
                        <StructuredListCell>
                          <Tag type="gray" size="sm">{new Date(item.updatedAt).toLocaleString()}</Tag>
                        </StructuredListCell>
                        <StructuredListCell className="sessions-panel-preview">{item.preview || '—'}</StructuredListCell>
                      </StructuredListRow>
                    ))}
                  </StructuredListBody>
                </StructuredListWrapper>
              )
        )}
        {selected && (
          <div className="sessions-panel-detail">
            <Button kind="secondary" size="sm" onClick={() => setSelected(null)}>Voltar à lista</Button>
            <h3 className="sessions-panel-title">{selected.name}</h3>
            <pre className="sessions-panel-content" aria-label={`Transcrição da sessão ${selected.name}`}>
              {content || (error ? '' : 'Carregando…')}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  );
}

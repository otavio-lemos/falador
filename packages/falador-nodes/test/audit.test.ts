// falador-nodes — testes dos helpers puros de auditoria (audit.ts)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GENESIS_HASH,
  canonicalJson,
  chainAuditEvent,
  parsePlanItems,
  preview,
  verifyAuditChain,
} from '../src/audit.ts';

const validItem = {
  id: '1',
  description: 'Verificar disco',
  verification: 'df -h mostra uso < 90%',
  status: 'pending',
};

test('parsePlanItems aceita itens válidos (com evidence opcional)', () => {
  const r = parsePlanItems([validItem, { ...validItem, id: '2', status: 'verified', evidence: 'df -h: 45%' }]);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.items.length, 2);
    assert.equal(r.items[1].status, 'verified');
    assert.equal(r.items[1].evidence, 'df -h: 45%');
  }
});

test('parsePlanItems rejeita não-array', () => {
  const r = parsePlanItems({ items: [validItem] });
  assert.equal(r.ok, false);
});

test('parsePlanItems rejeita status inválido', () => {
  const r = parsePlanItems([{ ...validItem, status: 'done' }]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /status/i);
});

test('parsePlanItems rejeita verification vazia', () => {
  const r = parsePlanItems([{ ...validItem, verification: '  ' }]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /verification/i);
});

test('parsePlanItems rejeita id duplicado', () => {
  const r = parsePlanItems([validItem, { ...validItem }]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /duplicad/i);
});

test('parsePlanItems rejeita description/id vazios e evidence não-string', () => {
  assert.equal(parsePlanItems([{ ...validItem, id: '' }]).ok, false);
  assert.equal(parsePlanItems([{ ...validItem, description: '' }]).ok, false);
  assert.equal(parsePlanItems([{ ...validItem, evidence: 42 }]).ok, false);
});

test('preview mantém a cauda e corta no tamanho default (2000)', () => {
  const out = preview('a'.repeat(4000) + 'FIM');
  assert.ok(out.length <= 2000, `tamanho ${out.length}`);
  assert.ok(out.endsWith('FIM'), 'deve manter o final do output');
});

test('preview não altera output curto e respeita max custom', () => {
  assert.equal(preview('olá'), 'olá');
  const out = preview('x'.repeat(500), 100);
  assert.ok(out.length <= 100);
});

test('canonicalJson ordena chaves recursivamente e ignora undefined', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { z: true, m: undefined, a: [2, 1] } }),
    '{"a":{"a":[2,1],"z":true},"b":1}',
  );
});

test('verifyAuditChain valida cadeia SHA-256 íntegra e detecta adulteração/quebra', () => {
  const e1 = chainAuditEvent({ runId: 'r1', seq: 1, ts: 100, op: 'run_started', nodeId: 'runner' }, GENESIS_HASH);
  const e2 = chainAuditEvent({ runId: 'r1', seq: 2, ts: 200, op: 'tool_call', nodeId: 'ag', ok: true }, e1.hash);
  const e3 = chainAuditEvent({ runId: 'r1', seq: 3, ts: 300, op: 'run_stopped', nodeId: 'runner' }, e2.hash);

  assert.deepEqual(verifyAuditChain([e1, e2, e3]), { ok: true, checked: 3 });

  // Adulteração de conteúdo
  const tampered = [e1, { ...e2, ok: false }, e3];
  const rTampered = verifyAuditChain(tampered);
  assert.equal(rTampered.ok, false);
  if (!rTampered.ok) {
    assert.equal(rTampered.index, 1);
    assert.match(rTampered.reason, /hash inválido/i);
  }

  // Quebra de encadeamento (evento removido)
  const dropped = [e1, e3];
  const rDropped = verifyAuditChain(dropped);
  assert.equal(rDropped.ok, false);
  if (!rDropped.ok) {
    assert.equal(rDropped.index, 1);
    assert.match(rDropped.reason, /prevHash divergente/i);
  }
});

// falador-nodes — testes dos helpers puros de auditoria (audit.ts)
import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlanItems, preview } from '../src/audit.ts';

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
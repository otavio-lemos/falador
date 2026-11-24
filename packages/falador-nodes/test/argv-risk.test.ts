// classificação de risco por caminho argv (argv0 + subcomando), não por prefixo de string
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyArgvRisk } from '../src/argv-risk.ts';

test('systemctl status => read', () => {
  assert.deepEqual(classifyArgvRisk(['systemctl', 'status', 'sshd']), { risk: 'read', path: 'systemctl status' });
});

test('systemctl restart => mutating', () => {
  assert.deepEqual(classifyArgvRisk(['systemctl', 'restart', 'sshd']), { risk: 'mutating', path: 'systemctl restart' });
});

test('kubectl get => read', () => {
  assert.deepEqual(classifyArgvRisk(['kubectl', 'get', 'pods']), { risk: 'read', path: 'kubectl get' });
});

test('kubectl apply => mutating', () => {
  assert.deepEqual(classifyArgvRisk(['kubectl', 'apply', '-f', 'x.yaml']), { risk: 'mutating', path: 'kubectl apply' });
});

test('journalctl -u ssh => read', () => {
  assert.deepEqual(classifyArgvRisk(['journalctl', '-u', 'ssh']), { risk: 'read', path: 'journalctl' });
});

test('journalctl --vacuum-time => mutating', () => {
  assert.deepEqual(classifyArgvRisk(['journalctl', '--vacuum-time=1d']), {
    risk: 'mutating',
    path: 'journalctl --vacuum-time=1d',
  });
});

test('helm list => read', () => {
  assert.deepEqual(classifyArgvRisk(['helm', 'list']), { risk: 'read', path: 'helm list' });
});

test('helm upgrade => mutating', () => {
  assert.deepEqual(classifyArgvRisk(['helm', 'upgrade', 'x', './chart']), { risk: 'mutating', path: 'helm upgrade' });
});

test('binário desconhecido => unknown', () => {
  assert.deepEqual(classifyArgvRisk(['meu-binario', 'restart']), { risk: 'unknown', path: 'meu-binario' });
});

test('caminho absoluto usa basename do argv0', () => {
  assert.deepEqual(classifyArgvRisk(['/usr/bin/systemctl', 'stop', 'sshd']), {
    risk: 'mutating',
    path: 'systemctl stop',
  });
});

test('ip link set => mutating (caminho de 3 tokens)', () => {
  assert.deepEqual(classifyArgvRisk(['ip', 'link', 'set', 'eth0', 'up']), { risk: 'mutating', path: 'ip link set' });
});

test('git status => read; git push => mutating', () => {
  assert.equal(classifyArgvRisk(['git', 'status']).risk, 'read');
  assert.deepEqual(classifyArgvRisk(['git', 'push', 'origin']), { risk: 'mutating', path: 'git push' });
});

test('ss -K => mutating', () => {
  assert.deepEqual(classifyArgvRisk(['ss', '-K']), { risk: 'mutating', path: 'ss -K' });
});

test('ansible-playbook é mutante por padrão', () => {
  assert.deepEqual(classifyArgvRisk(['ansible-playbook', 'site.yml']), { risk: 'mutating', path: 'ansible-playbook' });
});

test('argv vazio => unknown', () => {
  assert.deepEqual(classifyArgvRisk([]), { risk: 'unknown', path: '' });
});

// falador-nodes — testes unitários de redact.ts (ADR-012 / P0 Backend)
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLineRedactor, redactSecrets, redactUnknown } from '../src/redact.ts';

test('redactSecrets mascara todos os 10 padrões de segredos com marcadores corretos', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA12345\n-----END RSA PRIVATE KEY-----';
  const rPem = redactSecrets(`chave:\n${pem}\nfim`);
  assert.equal(rPem.hits, 1);
  assert.equal(rPem.text, 'chave:\n[REDACTED:pem]\nfim');

  const rAws = redactSecrets('AKIAIOSFODNN7EXAMPLE e ASIAIOSFODNN7EXAMPLE');
  assert.equal(rAws.hits, 2);
  assert.equal(rAws.text, '[REDACTED:aws_key] e [REDACTED:aws_key]');

  const rGh = redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz123456 e gho_abcdefghijklmnopqrstuvwxyz123456');
  assert.equal(rGh.hits, 2);
  assert.equal(rGh.text, '[REDACTED:github_token] e [REDACTED:github_token]');

  const rGl = redactSecrets('glpat-abcdefghijklmnopqrstuvwx');
  assert.equal(rGl.hits, 1);
  assert.equal(rGl.text, '[REDACTED:gitlab_token]');

  const rSk = redactSecrets('sk-proj-abcdefghijklmnopqrstuvwxyz123456');
  assert.equal(rSk.hits, 1);
  assert.equal(rSk.text, '[REDACTED:api_key]');

  const rSlack = redactSecrets('xoxb-1234567890-1234567890-abcdef');
  assert.equal(rSlack.hits, 1);
  assert.equal(rSlack.text, '[REDACTED:slack_token]');

  const rAuth = redactSecrets('Authorization: Bearer super_secret_token_value\nAuthorization: Basic dXNlcjpwYXNz');
  assert.equal(rAuth.hits, 2);
  assert.equal(rAuth.text, 'Authorization: Bearer [REDACTED:auth_header]\nAuthorization: Basic [REDACTED:auth_header]');

  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const rJwt = redactSecrets(`token=${jwt}`);
  assert.equal(rJwt.hits, 1);
  assert.equal(rJwt.text, 'token=[REDACTED:jwt]');

  const rUrl = redactSecrets('postgres://admin:s3cr3tPass@db.internal:5432/prod e https://user:pass123@api.local/v1');
  assert.equal(rUrl.hits, 2);
  assert.equal(rUrl.text, 'postgres://[REDACTED:url_creds]@db.internal:5432/prod e https://[REDACTED:url_creds]@api.local/v1');

  const rAssign = redactSecrets('DB_PASSWORD="my secret" API_KEY=xyz123 TOKEN: \'abc\'');
  assert.equal(rAssign.hits, 3);
  assert.equal(rAssign.text, 'DB_PASSWORD=[REDACTED:secret] API_KEY=[REDACTED:secret] TOKEN:[REDACTED:secret]');
});

test('redactSecrets é idempotente (2ª passagem retorna hits === 0 e texto idêntico)', () => {
  const sample = [
    '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.abcdefghijklmnop',
    'DATABASE_URL=postgresql://app:hunter2@localhost:5432/app',
    'MY_SECRET="top secret"',
  ].join('\n');

  const first = redactSecrets(sample);
  assert.ok(first.hits > 0);
  const second = redactSecrets(first.text);
  assert.equal(second.hits, 0);
  assert.equal(second.text, first.text);
});

test('redactUnknown mascara strings aninhadas sem mutar o objeto original', () => {
  const orig = { command: 'curl -H "Authorization: Bearer tok12345"', nested: ['ghp_abcdefghijklmnopqrstuvwxyz123456'] };
  const redacted = redactUnknown(orig) as typeof orig;
  assert.equal(redacted.command, 'curl -H "Authorization: Bearer [REDACTED:auth_header]"');
  assert.equal(redacted.nested[0], '[REDACTED:github_token]');
  assert.ok(orig.command.includes('tok12345'));
});

test('createLineRedactor segura linha incompleta entre chunks e mascara no \\n ou flush()', () => {
  const redactor = createLineRedactor();

  // Segredo quebrado no meio de 2 chunks sem newline
  const c1 = redactor.push('linha 1 ok\nTOKEN=ghp_abcdefghij');
  assert.equal(c1.text, 'linha 1 ok\n');
  assert.equal(c1.hits, 0);

  const c2 = redactor.push('klmnopqrstuvwxyz123456\nfim');
  assert.equal(c2.text, 'TOKEN=[REDACTED:github_token]\n');
  assert.equal(c2.hits, 1);

  // Linha final sem newline só sai no flush()
  const c3 = redactor.push(' DB_PASSWORD=secret123');
  assert.equal(c3.text, '');
  assert.equal(c3.hits, 0);

  const flushed = redactor.flush();
  assert.equal(flushed.text, 'fim DB_PASSWORD=[REDACTED:secret]');
  assert.equal(flushed.hits, 1);

  // Flush vazio após já drenado
  assert.deepEqual(redactor.flush(), { text: '', hits: 0 });
});

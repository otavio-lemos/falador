# Cadastro de Servidores (Falador)

Lista de servidores conhecidos para o agente usar ao receber "revisa o servidor X".
Cada entrada fornece host, user, port, tags e ambiente para preencher nós `exec.command` (transport=ssh)
e `tool.mcp` sem adivinhar valores.

## Formato

```yaml
- name: srv-prod-web
  host: 192.168.1.10
  user: deploy
  port: 22
  tags: [producao, web, nginx]
  env: prod
  notes: Servidor web principal (nginx + node)
```

## Servidores

- name: local
  host: 127.0.0.1
  user: (local)
  port: (n/a)
  tags: [local, dev]
  env: dev
  notes: Máquina local (exec.command transport=local)

<!-- Adicione novos servidores abaixo seguindo o formato acima. -->
```
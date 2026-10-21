# Sprint 00 — Auditoria de arquitetura

## Objetivo

Documentar a estrutura existente, preservar a integração Cognigy e eliminar a
falha de autenticação antes de expor o serviço.

## Arquivos afetados

- `app.js`
- `.gitignore`
- `AGENTS.md`
- `DEVELOPER_GUIDE.md` (referência do contrato)

## Requisitos e etapas técnicas

- Manter Express, `ws` e os módulos de fornecedores existentes.
- Exigir `Bearer` não vazio em HTTP e no upgrade WebSocket.
- Comparar tokens com `crypto.timingSafeEqual`.
- Não registrar Authorization, chaves, áudio ou conteúdo completo.
- Adicionar health check sem alegar conectividade OpenAI.

## Dependências

Node.js 18+ e as dependências já presentes no `package-lock.json`.

## Critérios de aceite

- Ausência, token vazio e token inválido retornam 403.
- Upgrade WebSocket sem credencial retorna 403.
- `GET /healthz` retorna o estado do processo sem segredos.

## Comandos de teste

```bash
npm ci
npm test
npm run jslint
```

## Evidências esperadas

Testes offline verdes e nenhum header Authorization em logs.

## Limitações conhecidas

TLS/WSS e proxy reverso não fazem parte do laboratório local.

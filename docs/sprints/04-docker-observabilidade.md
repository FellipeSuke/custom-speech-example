# Sprint 04 — Docker e observabilidade

## Objetivo

Executar o laboratório em Docker e produzir métricas sem dados sensíveis.

## Arquivos afetados

- `Dockerfile`
- `compose.yaml`
- `AGENTS.md`
- módulos de logging/métricas

## Requisitos e etapas técnicas

- Usar imagem Node enxuta e usuário sem privilégio.
- Receber segredos por ambiente/secret store.
- Correlacionar STT/TTS, modelo, duração, primeiro áudio, timeout e desconexões.
- Calcular p50/p95 apenas com amostras reais suficientes.

## Dependências

Docker/Compose local e endpoint HTTPS/WSS externo para Cognigy.

## Critérios de aceite

`docker compose up --build` inicia o processo sem credenciais versionadas.

## Comandos de teste

```bash
docker compose up --build
curl http://localhost:3000/healthz
```

## Evidências esperadas

Health check sem segredo e logs sem conteúdo de chamada.

## Limitações conhecidas

TLS válido e proxy reverso permanecem responsabilidade do ambiente de laboratório.

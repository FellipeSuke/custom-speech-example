# Sprint 01 — OpenAI TTS não streaming

## Objetivo

Expor `/synthesize/openai` para texto simples do Cognigy e usar o Realtime API
com `gpt-realtime-2.1-mini`, devolvendo WAV PCM16 mono.

## Arquivos afetados

- `lib/tts/openai.js`
- `lib/audio/pcm.js`
- `lib/tts/index.js`
- `test/tts-openai.test.js`
- `test/audio.test.js`
- `.env.example`, `README.md`

## Requisitos e etapas técnicas

- Conectar ao Realtime WebSocket com credencial exclusivamente no servidor.
- Enviar `session.update` e `response.create` com o texto fornecido.
- Coletar `response.output_audio.delta` até `response.done`.
- Converter PCM16 24 kHz para o `sample_rate` solicitado (8 kHz por padrão).
- Escrever cabeçalho WAV correto, sem armazenar áudio em disco.
- Rejeitar SSML até existir conversão segura e testes específicos.
- Limitar texto a 4096 caracteres, voz a allowlist e aplicar timeout/cancelamento.

## Dependências

`ws` existente, `OPENAI_API_KEY` em ambiente local e acesso ao modelo autorizado.

## Critérios de aceite

- Testes offline não fazem chamadas pagas.
- Resposta autenticada é `audio/wav` com RIFF válido.
- Texto não é alterado pelo adaptador; o prompt Realtime solicita leitura exata.
- Falhas do provedor retornam erro genérico e não vazam credenciais.

## Comandos de teste

```bash
npm test
npm run jslint
```

## Evidências esperadas

Testes mockados verdes. O primeiro teste real deve produzir um WAV inspecionável
com `ffprobe`.

## Limitações conhecidas

O Realtime é um modelo de geração de áudio orientado a conversa; a validação de
homofonia/leitura exata deve ser feita em homologação. Não há streaming Cognigy
nesta sprint.

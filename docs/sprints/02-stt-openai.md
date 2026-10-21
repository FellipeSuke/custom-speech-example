# Sprint 02 — OpenAI STT Realtime

## Objetivo

Implementar `/transcribe/openai` com `gpt-live-transcribe` e o contrato STT do
Voice Gateway.

## Arquivos afetados

Planejados: `lib/stt/openai.js`, `lib/audio/pcm.js`, `lib/stt/index.js`,
`test/stt-openai.test.js`, `.env.example` e documentação operacional.

## Requisitos e etapas técnicas

- Validar `start`, `format`, `encoding` e `sampleRateHz`.
- Converter PCM16 mono para a frequência aceita pela sessão.
- Enviar `input_audio_buffer.append` em base64.
- Implementar VAD/endpointing no adaptador e enviar `input_audio_buffer.commit`.
- Mapear apenas eventos finais/interinos para o envelope Cognigy.
- Isolar buffers, timers e resultados por WebSocket.

## Dependências

Contrato Cognigy confirmado, `gpt-live-transcribe` autorizado e testes com
áudio sintético.

## Critérios de aceite

Uma pausa natural produz `is_final: true` antes do evento `stop`, sem duplicação.

## Comandos de teste

```bash
npm test
```

## Evidências esperadas

Testes de VAD, CNPJ digitado, pausas, ruído moderado e duas sessões simultâneas.

## Limitações conhecidas

O modelo não suporta `server_vad` nem `semantic_vad`; a detecção deve ser local.

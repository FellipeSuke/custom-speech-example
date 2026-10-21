# Sprint 03 — TTS streaming Cognigy

## Objetivo

Entregar chunks compatíveis com o streaming Custom TTS do Cognigy.

## Arquivos afetados

Planejados: `lib/tts/openai.js`, `lib/audio/pcm.js`, testes de chunking e README.

## Requisitos e etapas técnicas

- Emitir header RIFF de 44 bytes antes dos chunks PCM16.
- Entregar exatamente mono/8000 Hz em transferência chunked.
- Não definir `Content-Length` no modo streaming.
- Tratar cancelamento do cliente e backpressure.

## Dependências

Resultado do TTS Realtime, contrato `DEVELOPER_GUIDE.md` e teste real no VG.

## Critérios de aceite

O Voice Gateway começa a reproduzir enquanto a síntese continua e o WAV é
decodificável do primeiro ao último chunk.

## Comandos de teste

```bash
curl -N -X POST http://localhost:3000/synthesize/openai ... --output output.wav
ffprobe output.wav
```

## Evidências esperadas

TTFB e formato medidos, sem declarar streaming somente por receber deltas.

## Limitações conhecidas

Chunks Realtime precisam ser reempacotados; não podem ser encaminhados como se
fossem um WAV completo.

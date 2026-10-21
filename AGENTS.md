# AGENTS.md

## Scope

This repository is a Cognigy Voice Gateway custom speech adapter. The Cognigy
AI Agent remains the source of conversational reasoning and business data. An
adapter module may only perform speech transport, audio conversion, validation,
and provider error handling.

## Safety and secrets

- Never commit `.env.local`, API keys, bearer tokens, customer audio, CNPJ, or
  complete call transcripts.
- Never log `Authorization`, `OPENAI_API_KEY`, provider URLs supplied by a
  client, or complete text/audio payloads.
- HTTP and WebSocket endpoints require the configured Cognigy bearer token.
- Use timing-safe token comparison and keep error responses generic.

## OpenAI integration

- Keep OpenAI credentials server-side in environment variables.
- The first OpenAI TTS implementation uses the Realtime WebSocket contract and
  defaults to `gpt-realtime-2.1-mini`; do not send that model to
  `/v1/audio/speech`.
- `gpt-live-transcribe` is planned for the next sprint. It requires adapter-side
  endpointing and explicit `input_audio_buffer.commit` events.
- Run offline tests before any live API test. Live tests must use synthetic,
  non-customer text/audio and be run sparingly.

## Verification

Run `npm test` and `npm run jslint` before handing off changes. If a test needs
OpenAI, mock the WebSocket in the offline suite and document the live test
separately.

# Custom Speech Example

This repository serves as an illustrative guide for integrating support for a
custom speech vendor into [Cognigy Voice Gateway](https://www.cognigy.com/platform/cognigy-voice-gateway)
using the speech API. It showcases the incorporation of the following examples:

**TTS**:

- [google](https://cloud.google.com/text-to-speech/docs) — non-streaming
- [elevenlabs](https://beta.elevenlabs.io/) — non-streaming
- [rime](https://docs.rime.ai/api-reference/coda/http) — non-streaming
- [deepgram](https://developers.deepgram.com/docs/text-to-speech) — **streaming** (reference implementation of the streaming TTS contract)

**STT**:

- [google](https://cloud.google.com/speech-to-text)
- [gladia](https://docs.gladia.io/reference/live-audio)
- [assemblyAI](https://www.assemblyai.com/docs/walkthroughs#realtime-streaming-transcription)
- [Vosk](https://alphacephei.com/vosk/server).

The repository also contains an OpenAI TTS adapter at
`/synthesize/openai`. It defaults to Realtime with `gpt-realtime-2.1`,
and also accepts `gpt-realtime-2.1-mini` when the project has access. Realtime
TTS audio is produced over the
OpenAI WebSocket contract; when streaming is enabled, PCM deltas are forwarded
to Cognigy as an 8 kHz streamed WAV. The adapter also supports a temporary HTTP
compatibility mode with `gpt-4o-mini-tts` when the OpenAI project does not have
Realtime model access. It buffers the complete response for the first
non-streaming mode, converts PCM16 to WAV PCM16 mono, and returns 8 kHz by
default. The OpenAI STT adapter is available
at `/transcribe/openai`; it translates Cognigy's audio WebSocket protocol to
OpenAI Realtime transcription and uses local silence detection to delimit
turns.

## TTS: non-streaming vs. streaming

Custom TTS vendors support two modes over the **same HTTP endpoint**:

| | Non-streaming (default) | Streaming |
|---|---|---|
| How VG plays it | Buffers the full response, writes it to a file, then plays the file | Plays audio as chunks arrive |
| Perceived latency | Full synthesis time + transfer | Time-to-first-byte (~200–500 ms typical) |
| Response format | Any audio format VG can decode (MP3, WAV, OGG, …) | **Streamed WAV** — 44-byte RIFF header + linear16 PCM at 8000 Hz mono |
| Request body | Same JSON body | Same JSON body |
| How to deliver | `res.send(buffer)` with `Content-Length` | Pipe/flush the response body (chunked transfer encoding) |
| Enabled by | Always available | The **"Enable text-to-speech streaming"** checkbox on the custom speech credential |

The request your endpoint receives is **identical** in both modes. The only
difference is how you deliver the response: buffer it (non-streaming) or stream
it (streaming). If your endpoint already returns `audio/wav` at linear16/8 kHz,
enabling streaming is just a matter of streaming the body instead of buffering.

> **The full streaming contract** — request/response shape, WAV format
> requirements, error semantics, and the enablement flow — is documented in
> [DEVELOPER_GUIDE.md → Streaming TTS](DEVELOPER_GUIDE.md#streaming-tts).
> The `deepgram` module in this repo ([`lib/tts/deepgram.js`](lib/tts/deepgram.js))
> is a working reference implementation.

## Configuration

You can configure the application to connect to all of the providers or just
some depending on the environment variables supplied.

- To use google, supply `GCP_JSON_KEY_FILE` pointing to your google json key
- To use elevenlabs, supply `ELEVEN_API_KEY` which has your api key
- To use rime, supply `RIME_API_KEY` which has your api key. Optionally supply
  `RIME_MODEL_ID` (`coda`, `arcana`, or `mistv2`; defaults to `coda`); you can
  also pick the model per voice by naming the voice `<modelId>:<speaker>`
  (e.g. `arcana:luna`). `RIME_TIMEOUT_MS` caps the upstream request time
  (default 30000)
- To use deepgram (streaming TTS), supply `DEEPGRAM_API_KEY`
- To use assemblyAI, supply `ASSEMBLY_AI_API_TOKEN` which has your assemblyAI api key
- To use gladia, supply `GLADIA_API_KEY`
- To use Vosk, supply `VOSK_URL` which has the ip:port of the Vosk server grpc endpoint
- To use OpenAI TTS, supply `OPENAI_API_KEY`. Set `OPENAI_TTS_VOICE` to an
  allowlisted Realtime voice; `OPENAI_TTS_ALLOWED_VOICES` can narrow the list.
- Realtime TTS accepts only `gpt-realtime-2.1-mini` and `gpt-realtime-2.1` and
  requires `OPENAI_TTS_TRANSPORT=realtime`. These models must not be sent to
  `/v1/audio/speech`.
- Set `OPENAI_TTS_REASONING_EFFORT=minimal` for exact-text TTS. Higher effort
  is available for integrations that intentionally trade latency for reasoning.
- For the temporary project-compatible mode, set
  `OPENAI_TTS_TRANSPORT=audio_speech` and `OPENAI_TTS_MODEL=gpt-4o-mini-tts`.
- The admin portal also exposes experimental GPT-Live TTS using `gpt-live-1`
  with the Brazilian Portuguese voices `bossa` (feminine) and `tempo`
  (masculine). The synthetic portal test returns an 8 kHz preview. When
  `TTS_STREAMING_ENABLED=true` and Cognigy's **text-to-speech streaming** option
  is enabled on the speech credential, `/synthesize/openai` forwards GPT-Live
  audio deltas as chunked 8 kHz WAV so Cognigy can begin playback before the
  full utterance is complete. GPT-Live has no explicit audio-done event; the
  adapter uses transcript matching, an inactivity timeout, and a bounded
  audio duration to close each one-shot session. This remains experimental:
  compare perceived latency and wording with Realtime before production use.
- For lower time-to-first-audio with Cognigy streaming TTS, also set
  `TTS_STREAMING_ENABLED=true`. With Realtime this forwards audio deltas as
  they arrive; with `audio_speech` it uses the Speech API's chunked PCM
  response. Both paths convert to the required mono PCM16 WAV at 8 kHz and
  omit `Content-Length`. Enable **text-to-speech streaming** on the Cognigy
  speech credential; requests at other sample rates use the buffered fallback.
- Set `COGNIGY_SPEECH_TOKEN` or `API_KEY` for the bearer token Cognigy must send.
  Missing, empty, and invalid bearer tokens are rejected for HTTP and WebSocket.
- The optional admin portal is available at `/admin` when `ADMIN_DB_PATH` is
  configured. It uses SQLite in the configured Docker volume, supports runtime
  TTS/STT model selection, token creation/revocation, and synthetic TTS/STT
  probes. Configure `ADMIN_USERNAME` and a random `ADMIN_SESSION_SECRET`.
  After login, the portal shows the Cognigy and upstream OpenAI endpoints and
  accepts an OpenAI API key. The key is stored only in the server-side key file
  (`OPENAI_API_KEY_FILE`, defaulting beside the SQLite file), with mode 0600;
  it is never returned by the API, stored in SQLite, or logged. A managed key
  file takes precedence over `OPENAI_API_KEY`.
  For a running Docker deployment, set the initial password without copying a
  hash through `docker exec -it <container> npm run admin:set-password`; the
  command stores only the derived password hash in SQLite. Alternatively,
  generate `ADMIN_PASSWORD_HASH` with `npm run admin:hash`. Never put an
  OpenAI key in the portal or database.
- `OPENAI_TTS_MAX_CONCURRENCY` limits active TTS requests per adapter process
  (default `8`); excess calls receive `429` with `Retry-After: 1`.

Copy `.env.example` to an ignored `.env.local` and fill it locally. Never put a
real key in Git or in a request to this chat.

## Running

```bash
$ npm ci

$ API_KEY=<cognigy-token> \
OPENAI_API_KEY=<openai-key> \
GCP_JSON_KEY_FILE=<google-json-key-path> \
ASSEMBLY_AI_API_TOKEN=<assemblyai-api-key> \
VOSK_URL=xxxx:yyyy \
GLADIA_API_KEY=xxxxxxxx \
ELEVEN_API_KEY=xxxxxxx \
DEEPGRAM_API_KEY=xxxxxxx \
HTTP_PORT=3000 node app.js
```

Then, in the Cognigy Voice Gateway portal create a custom speech vendor,
providing the wss (for STT) and http(s) (for TTS) URLs to your server,
and your api key (`apikey`).

- **STT** connects over WebSocket at `/transcribe/<provider-name>`.
- **TTS** connects over HTTP POST at `/synthesize/<provider-name>` — for both
  streaming and non-streaming vendors.

For the deployed OpenAI STT adapter, the Cognigy WebSocket URL is:

```text
wss://sukeserver.ddns.net:8086/transcribe/openai
```

To use a **streaming** TTS vendor (e.g. `deepgram`), also check
**"Enable text-to-speech streaming"** on the custom speech credential. Leave it
unchecked to use the non-streaming path.

After adding the custom speech vendors you can use them in a Cognigy Voice Gateway
application. Make sure this application is running and accessible at the URLs
you provisioned into Cognigy Voice Gateway.

### OpenAI TTS local test

Start the service with `npm start`, then use an authenticated request. The
response is a WAV file, so it can be inspected with `ffprobe` or a media player:

```bash
curl -X POST http://localhost:3000/synthesize/openai \
  -H "Authorization: Bearer <cognigy-token>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Olá. Informe o CNPJ, por favor.","type":"text","language":"pt-BR","voice":"marin","encoding":"linear16","sample_rate":8000}' \
  --output openai-tts.wav
```

With Docker Compose, the default host port is `8086` and the container listens
on `3000`. Set `ADAPTER_BIND_ADDRESS` and `ADAPTER_PORT` in `.env.local` if
that port is later occupied.

Set `PUBLIC_BASE_URL=https://sukeserver.ddns.net:8086` when the adapter is
behind the existing reverse proxy. The admin portal then presents copyable
TTS and STT URLs for future Cognigy projects, including:

```text
https://sukeserver.ddns.net:8086/synthesize/openai
wss://sukeserver.ddns.net:8086/transcribe/openai
```

The Compose deployment mounts the `speech-adapter-data` volume at `/data` for
the administrator SQLite database. Keep `/admin` restricted to the internal
network or protect it at the TLS reverse proxy; Cognigy should use only the
`/synthesize/*` and `/transcribe/*` endpoints.

### External HTTPS with the existing Caddy

When another application already owns ports `80` and `443`, keep the adapter
private on the host and let the existing Caddy terminate TLS. In the test
deployment, Caddy listens on `https://sukeserver.ddns.net:8086` and proxies to
the adapter container over the Docker network. The Cognigy TTS URL is:

```text
https://sukeserver.ddns.net:8086/synthesize/openai
```

The adapter should not also publish host port `8086` in this arrangement; that
port belongs to Caddy. Keep the Cognigy bearer token in `.env.local` with mode
`600`, and do not place provider keys in this README or in Git.

`type: "ssml"` is rejected deliberately in this sprint. Streaming TTS remains
separate. OpenAI STT emits interim/final Cognigy messages and uses local VAD;
tune `OPENAI_STT_SILENCE_MS`, `OPENAI_STT_MIN_SPEECH_MS`, and
`OPENAI_STT_VAD_RMS` in `.env.local` when adapting turn detection.

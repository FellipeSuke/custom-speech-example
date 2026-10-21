# Sprint 05 — Homologação Cognigy

## Objetivo

Validar o áudio nos dois sentidos no fluxo telefônico da GS1 Brasil.

## Arquivos afetados

Documentação operacional, configuração do Speech Service `OpenAISpeech` e
relatório de evidências.

## Requisitos e etapas técnicas

- Publicar HTTPS/WSS com certificado válido, sem expor a chave OpenAI.
- Configurar TTS URL `/synthesize/openai` e STT URL `/transcribe/openai`.
- Configurar bearer token Cognigy e voz allowlisted.
- Testar números, siglas, interrupções e transferência humana.

## Dependências

Sprints 01–04 concluídas, acesso ao ambiente Cognigy e janela controlada de
homologação.

## Critérios de aceite

Ligação real reproduz a resposta da Jéssica e transcreve o cliente sem mistura
entre sessões.

## Comandos de teste

Usar os comandos do README para smoke test; os cenários principais são
executados no Voice Gateway.

## Evidências esperadas

URLs, horários, modelo/voz, amostras sintéticas e resultado por cenário.

## Limitações conhecidas

Nenhuma homologação deve ser declarada sem áudio validado nos dois sentidos.

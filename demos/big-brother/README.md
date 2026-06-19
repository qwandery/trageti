# Big Brother demo

Big Brother demonstrates multimodal source ingestion for desktop activity.

Offline mode uses synthetic screen fixtures:

```sh
npm run trageti-demo -- big-brother run --provider fixture
```

Live description mode captures screenshots during `prepare`, asks a vision model
for detailed descriptions, then ingests those descriptions:

```sh
npm run trageti-demo -- big-brother run --capture
npm run trageti-demo -- big-brother run --capture --captures 10 --duration-minutes 5
```

Live multimodal mode skips the description step and sends image files directly
to the extraction model during ingestion:

```sh
npm run trageti-demo -- big-brother run --capture --multimodal
```

Provider presets live in `demos/providers.json`; copy `.env.example` to `.env`
for local secrets such as `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, and
`ANTHROPIC_API_KEY`. Use typed provider overrides when vision, extraction, and
embedding need different providers:

```sh
npm run trageti-demo -- big-brother run --provider:vision openrouter-gpt-mini --provider:extract openai --provider:embed ollama-embed
```

Without `--capture`, live screenshot capture prompts `y/N` before it starts.
Screenshots, prepared artifacts, and run-specific databases are written under
`demos/.local/`.

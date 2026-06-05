# Big Brother demo

Big Brother demonstrates multimodal source ingestion for desktop activity.

Offline mode uses synthetic screen fixtures:

```sh
npm run trageti-demo -- big-brother run
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

Without `--capture`, live screenshot capture prompts `y/N` before it starts.
Screenshots, prepared artifacts, and run-specific databases are written under
`demos/.local/`.

# RSHI changes on this branch

This is the `rshi` branch of [elevenarms/DishwasherBench](https://github.com/elevenarms/DishwasherBench),
a fork of [composo-ai/DishwasherBench](https://github.com/composo-ai/DishwasherBench) (MIT, by Composo).
Everything on this branch is upstream's work except the commits after upstream commit
`99b974a` ("Merge pull request #68 from composo-ai/fit-both-washes"), which were made during the
hackathon by the SPARKLETEAM team. It is used as a git submodule by
[elevenarms/RSHI](https://github.com/elevenarms/RSHI) (SPARKLETEAM).

Full diff: https://github.com/elevenarms/DishwasherBench/compare/main...rshi

## What changed (only `apps/web`, the browser front end)

- **Cosmetic water FX** (`apps/web/src/water.ts`, `style.css`): spray, sheeting and droplets drawn
  during the wash and rinse phases. Purely visual; `&nofx` turns it off, `&fxdemo` plays it without a wash.
- **Watch mode** (`apps/web/src/watch.ts`, `app.ts`, `main.ts`): `#<episode>&watch` follows an episode
  started elsewhere (for example by an agent), with no panels, no sound and a slow, then fixed, camera.
- **Turntable** (`apps/web/src/turntable.ts`, `stage.ts` exposes the renderer): `&turntable[&item=<id>]`
  shows one item on a plinth, dirty and then as washed.
- **Link parsing** (`apps/web/src/benchmark.ts` + tests): the URL hash accepts the flags above.
- Screenshot scripts (`apps/web/scripts/*-shots.ts`) and screenshots (`apps/web/screenshots/`).

## What did not change

Nothing in the simulation, the physics, the wash model, the levels, the scoring, the benchmark
harness or the server. No file outside `apps/web` is modified.

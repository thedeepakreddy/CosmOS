# CosmOS

Monorepo for Cosmos — a modular intelligence infrastructure platform where
specialised operating systems for research, agents, tools, memory, models and
evaluation work together as one coordinated intelligence layer.

## Layout

| Path       | What it is                                                    |
| ---------- | ------------------------------------------------------------- |
| `website/` | The public marketing site (React + Vite + Tailwind v4)        |
| _(root)_   | `render.yaml` deploys `website/` to Render as a static site   |

Cosmos source lives alongside `website/` — add each system as its own
top-level directory. `render.yaml` only builds `website/`, so nothing else in
this repo affects the site deploy.

## Website

```bash
cd website
npm install
npm run dev      # http://localhost:3000
```

Other scripts: `npm run build` (production bundle into `website/dist`),
`npm run preview` (serve the built bundle), `npm run lint` (typecheck only).

See [website/README.md](website/README.md) for the design system.

## Deployment

The site deploys to Render from `render.yaml` at this repo's root:

- **Build** `cd website && npm ci && npm run build`
- **Publish directory** `website/dist`

Render's Root Directory is left at the repo root on purpose — Render's
blueprint and monorepo docs disagree on whether `staticPublishPath` resolves
against the repo root or against `rootDir`, so both paths are spelled out in
full instead.

Pushing to `main` triggers a deploy. Adding Cosmos source elsewhere in the repo
does not affect the site build.

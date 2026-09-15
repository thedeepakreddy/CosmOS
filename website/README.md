# Cosmos — website

The public marketing site. React 19 + Vite 6 + Tailwind CSS v4.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # -> dist/
npm run lint     # typecheck only, no emit
```

## Design system

Everything visual is defined in [`src/index.css`](src/index.css) as Tailwind v4
`@theme` tokens plus a small set of component classes. Extend those rather than
introducing raw hex values or stock Tailwind colour utilities — the palette is
contrast-checked and the two accent tokens are not interchangeable.

### Tokens

| Token                 | Value     | Use                                            |
| --------------------- | --------- | ---------------------------------------------- |
| `--color-paper`       | `#f2f0ea` | Page ground                                    |
| `--color-paper-2`     | `#e9e6de` | Alternating section wells                      |
| `--color-card`        | `#ffffff` | Raised surfaces                                |
| `--color-ink`         | `#14130f` | Primary text, dark sections                    |
| `--color-ink-2`       | `#45423b` | Body copy                                      |
| `--color-ink-3`       | `#635e55` | Muted text — the lightest ink that still passes AA |
| `--color-accent`      | `#d6410f` | **Fills only.** White on it is 4.54:1          |
| `--color-accent-ink`  | `#b8380b` | **Accent as text.** 5.11:1 on paper            |

`--color-accent` fails AA as text on paper (3.99:1), which is why the darker
`--color-accent-ink` exists. Use the right one or contrast regresses silently.

### Component classes

`.label` and `.eyebrow` (mono micro-labels), `.ed` (the Instrument Serif italic
used as the display accent instead of gradient text), `.card` / `.card-flat` /
`.card-lift`, `.btn` with `.btn-primary` / `.btn-accent` / `.btn-ghost`, and
`.status` with `.status-live` / `.status-dev` / `.status-plan`.

### Type

Inter Tight for display (tight negative tracking), Inter for body, Instrument
Serif italic for the accent phrase in headlines, JetBrains Mono for data labels
and code only.

## Motion

Scroll reveals are driven by `.reveal` + [`src/hooks/useReveal.ts`](src/hooks/useReveal.ts).
The hook reveals everything immediately when the visitor prefers reduced motion
or `IntersectionObserver` is unavailable, so content is never dependent on
JavaScript to be readable.

## Notes

The page declares `color-scheme: light` in both `index.html` and `src/index.css`.
Without it, Chrome's auto-dark-mode force-inverts the palette. Don't remove it.

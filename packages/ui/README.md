# @business-os/ui

The shared design system for the desktop (Tauri) and browser clients (architecture §6.5, ADR 0005). Both apps import the same `styles.css` and components, so they always look the same.

- `src/styles.css`: the Pixakova palette, the semantic tokens (light and dark), the Tailwind theme mapping, and the atmosphere and glass treatments. Each app's entry CSS imports Tailwind first, then this file, and adds an `@source` for this package so its classes are generated.
- `src/components`: presentational shadcn/ui-style primitives. shadcn/ui is configured by hand in `components.json` because the shadcn registry is not reachable from every build environment.
- `src/lib/utils.ts`: `cn()` for merging class names.
- `showcase/`: a development-only page that shows the whole system. Run `pnpm --filter @business-os/ui showcase` and open http://localhost:5180 (add `?theme=dark` or `?theme=light`). It is not part of either app's build.

## Visual identity

Dark is the primary expression: midnight navy foundations, electric indigo, soft violet, lavender and dusty pink light, frosted glass and crisp white text with muted lavender secondary text. Light mode keeps the same identity on a lavender-mist canvas.

## Tokens

Three layers, and components only use the last two:

1. **Palette** (`--pk-midnight`, `--pk-navy`, `--pk-indigo`, `--pk-electric`, `--pk-violet`, `--pk-lavender`, `--pk-pink`, `--pk-mist`, `--pk-ink`). Provisional approximations of the reference artwork. Not mapped to Tailwind on purpose, so components cannot use them.
2. **Semantic tokens**, as Tailwind colours: `background`, `foreground`, `muted`, `muted-foreground`, `card`, `surface-raised`, `popover`, `primary` (+ `-hover`, `-foreground`), `secondary` (+ `-hover`, `-foreground`), `accent`, `ring`, `border`, `input`, `field`, `overlay`, and the status colours `success`, `warning`, `destructive`, `info`, each with a `-foreground` for solid fills.
3. **Treatments**: `--glass-*` and `--atmo-*` variables used by `.bos-glass` and `.bos-atmosphere`.

Theme selection is unchanged: the OS preference by default; a `.dark` or `.light` class on `<html>` overrides it. The dark tokens are written twice (OS preference and `.dark`); `tests/tokens.test.ts` fails if the two drift apart, and checks WCAG AA contrast for every text/background pair the components use in both themes.

## Components

| Component | Notes |
|---|---|
| `Button`, `buttonClass` | `primary`, `secondary`, `outline`, `ghost`, `destructive`; sizes `sm`, `md`, `lg`, `icon`. Defaults to `type="button"`. `loading` disables it, sets `aria-busy` and shows a spinner. |
| `Card` (+ `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`) | Opaque by default; `variant="glass"` with an optional `strength`. |
| `Surface` | `opaque`, `raised` or `glass`. |
| `Atmosphere` | Background: `aurora`, `dusk`, `horizon`, or `calm` for dense screens. |
| `Input`, `Textarea`, `Select`, `Label`, `Field` | `Field` wires label, hint and error to the control (`aria-describedby`, `aria-invalid`). |
| `Dialog` (+ `DialogTrigger`, `DialogContent`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogClose`) | Built on Radix UI Dialog: initial focus, focus trap, Escape and overlay dismissal, page hidden from assistive tech, focus returned to the opener (also without a trigger), labelled by its title and description. Every dialog needs a `DialogTitle`. |
| `Alert` (+ `AlertTitle`, `AlertDescription`) | `info`, `success`, `warning`, `danger`; warning and danger are `role="alert"`, the others `role="status"`. |
| `PageHeader`, `SectionHeader` | Page h1 (with eyebrow, description, actions) and section h2/h3. |
| `StatCard` | A figure, its label and a text change with an optional trend colour. |
| `EmptyState` | What is missing and the next action. |
| `FormSection` | A fieldset with a legend, so the group name is announced with each field. |
| `Separator` | Decorative by default; `decorative={false}` exposes it as a separator. |
| `Badge` | `neutral`, `brand`, `success`, `warning`, `danger`, `info`. |
| `StatusIndicator` | `ok`, `pending`, `error`, `info`, `neutral`; the text label carries the meaning. |
| `Spinner`, `Skeleton` | Loading states; respect reduced motion. |
| `Table` (+ header, body, row, head, cell, caption) | Opaque, readable, scrolls sideways in its own frame. |

## Using glass and atmosphere

- Use glass selectively: summaries, hero panels, floating toolbars. Forms, tables and long reading stay on opaque surfaces, or on glass `strength="strong"` (86% tint) at most.
- `strength` is `subtle` (45%), `regular` (62%), `strong` (86%) or any number from 0 to 1.
- Glass turns into an opaque surface when `backdrop-filter` is unsupported or the user asks for reduced transparency, and gets a solid border in forced-colours mode.
- Each screen picks its own `Atmosphere` variant; nothing forces one gradient everywhere. Use `calm` behind dense operational screens.
- Keep controls flat: no gradients, glow or glass inside buttons, inputs or badges.

## Rules

Enforced by `pnpm boundaries`: no data fetching, no API client, no imports from `@business-os/app` or any `apps/*` package, no database or server-only packages. Tenant data reaches components only as props.

## Tests

- `tests/tokens.test.ts`: dark blocks identical; WCAG AA contrast for every token pair in both themes.
- `tests/ui.test.tsx`: rendered markup and variants.
- `tests/interaction.test.tsx` (jsdom + Testing Library user-event): dialog focus, trap, Escape, focus return and labelling; keyboard activation; disabled and loading buttons; form labels, hints, errors, grouping and submission; alert and status roles.

# Stanza Documentation

[![CI](https://github.com/stanza-go/docs/actions/workflows/ci.yml/badge.svg)](https://github.com/stanza-go/docs/actions/workflows/ci.yml)

Documentation site for [Stanza Framework](https://github.com/stanza-go/framework). Built with Next.js, Markdoc, and Tailwind CSS.

## Content

- **Framework reference** — all 13 packages documented with types, functions, and options
- **30 recipes** — step-by-step guides covering common patterns and use cases
- **Installation guide** — getting started with Stanza

## Development

Requires Bun.

```bash
bun install
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Build

```bash
bun run build
```

## Structure

Documentation pages live in `src/app/docs/` as Markdoc files. Navigation is configured in `src/lib/navigation.ts`.

## Related Repos

| Repo | Description |
|------|-------------|
| [framework](https://github.com/stanza-go/framework) | The engine — Go packages with zero external deps |
| [standalone](https://github.com/stanza-go/standalone) | Fork-and-build application boilerplate |
| [cli](https://github.com/stanza-go/cli) | CLI tool for backup, restore, inspect |

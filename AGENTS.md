# URD Project — Agent Instructions

## Language

Use English only unless explicitly asked otherwise.

## Source of Truth (Precedence Order)

When resolving contradictions between files, this order decides:

1. **README.md** — protocol spec, the authoritative design
2. **AGENTS.md** — these agent conventions
3. **Code (`src/`)** — implementation follows README
4. **PITCH.md** — presentation, may simplify or omit details for brevity

## Project Structure

```
urd/
  AGENTS.md        Agent instructions
  PITCH.md         Project pitch
  README.md        Project overview and protocol spec
  src/             TypeScript source
    index.ts       Core library entry
  package.json     Node/TypeScript config
  tsconfig.json    TypeScript compiler config
```

## Conventions

- TypeScript with strict types
- No external dependencies for the core library (use Node's built-in `crypto` for hashing)
- No comments in code unless the user requests them
- Every function must be pure (no side effects beyond computation)
- Use named exports only
- Every public function must have a matching unit test
- Test files sit next to source files with `.test.ts` suffix
- Run tests with `node --test` (Node built-in test runner)

## Workflow

- Before editing, read the file first
- After making changes, compile and run tests to verify
- Keep PRs/commits small and focused
- When upgrading dependencies, always look up the current versions online (npm registry, Node.js releases page) instead of relying on internal knowledge — my training data may be stale

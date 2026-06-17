# URD Project — Agent Instructions

## Language

Use English only unless explicitly asked otherwise.

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

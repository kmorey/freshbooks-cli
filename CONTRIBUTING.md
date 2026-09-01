# Contributing

Contributions are welcome, especially focused fixes that keep the CLI useful for scripts and desktop-shell integrations.

## Development

Requirements: Node.js 22 or newer. The project has no runtime dependencies.

```bash
npm install
npm test
npm run check
```

Add deterministic regression coverage for behavioral changes. Automated tests must use fakes or local fixtures and must never connect to a real FreshBooks account.

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Preserve the documented JSON envelope and exit-code contract.
- Note any FreshBooks behavior that was confirmed only through public documentation rather than live validation.
- Run the privacy scan described in `AGENTS.md` before pushing.
- Never include credentials, authorization URLs containing codes, company/client/project names, account or business IDs, or captured API responses.

For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

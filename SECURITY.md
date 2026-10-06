# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/killerz3/jevalyzer/security/advisories/new) rather than opening a public issue. We'll acknowledge reports within a few days.

## Scope

jevalyzer is a local CLI that reads agent session transcripts already on disk and sends them to a model provider (Vercel AI Gateway, Cloudflare Workers AI, or TypeSafe) for scoring. Relevant concerns include:

- Handling of API keys (`~/.jevalyzer/config.json`, written with mode `600`, never printed back by the CLI)
- Leakage of transcript contents beyond the configured provider
- Supply-chain issues in dependencies or the release workflow

## Supported versions

Only the latest tagged release is supported.

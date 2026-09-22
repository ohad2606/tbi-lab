# ADR-005 — Language-independent project data model

**Status:** Proposed · **Date:** 2026-09-22 · **Sprint:** 1

## Context
TBI Lab launches in English and Hebrew (RTL) and must support N locales later (CLAUDE.md,
Internationalization). A project made under one UI language must open identically under another,
with no conversion.

## Decision
- Component type IDs, terminal IDs, property keys and enum values are **namespaced,
  language-neutral identifiers** (`component.resistor`, `resistance`, `cv`).
- Technical values are **SI numbers with canonical unit IDs** (`"ohm"`, `"volt"`). Locale affects
  only formatting.
- **No translated catalog text is persisted.** Names and descriptions come from translation keys at
  render time.
- **User-authored text** (project name, labels, notes, custom net names) is stored **verbatim** and
  never altered by a locale change.
- Engines and the protocol exchange **codes, not messages**. Only the browser localizes.
- One project per design, never one per language. `projectId` carries no locale.

## Consequences
- Locale switching is purely presentational, and switching it back and forth is lossless.
- A per-locale terminology glossary and catalog metadata (`displayName.<locale>`,
  `keywords.<locale>[]`, `aliases[]`) are needed, but live outside project data.
- The Gate D feasibility schema (un-namespaced types) is superseded by schema v2.

**Evidence:** CLAUDE.md; V1-ARCHITECTURE §3, §16.

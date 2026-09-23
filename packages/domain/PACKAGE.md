# TBI Lab portable project package — format version 1

Introduced in Sprint 5 (`src/package.ts`). This is the file a user exports and imports. It
**wraps** the schema v2 project document and does not change it: `formatVersion` (the package)
and `schemaVersion` (the project) are versioned independently (roadmap §6.3).

## File

| Property   | Value                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extension  | `.tbilab`                                                                                                                                                                                                          |
| Media type | `application/vnd.tbi-lab.package+json`                                                                                                                                                                             |
| Encoding   | UTF-8 JSON text; a leading byte-order mark is tolerated on import                                                                                                                                                  |
| Size limit | **2 MiB** (`PACKAGE_MAX_BYTES`). A 30-component project packages to 27.5 KB (measured; the examples are 4–8 KB), so this is ~75× a large V1 circuit, while a hostile file is refused before it is read into memory |
| Layout     | Pretty-printed (2-space indentation) for human inspection; the integrity hash does not depend on formatting                                                                                                        |

A single JSON file was chosen over the ZIP container proposed in roadmap §12.2 (PM Sprint 5
directive: no ZIP unless there is a strong technical reason). V1 non-MCU packages contain no
binary data, so there is no such reason yet. A later ZIP-based version is detectable: import
refuses a file beginning with `PK\x03\x04` as a newer package version.

## Envelope

```json
{
  "format": "tbi-lab.package",
  "formatVersion": 1,
  "project": { "…the exact schema v2 ProjectDocument…": "" },
  "source": null,
  "firmware": null,
  "toolchain": null,
  "integrity": {
    "algorithm": "sha256",
    "canonicalization": "tbi-lab.canonical-json.v1",
    "project": "<64 lowercase hex characters>"
  },
  "exported": { "app": "TBI Lab", "appVersion": "0.2.0", "exportedAt": "2026-09-23T10:00:00.000Z" }
}
```

| Field               | Meaning                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`            | Always `tbi-lab.package`                                                                                                                                                                                                      |
| `formatVersion`     | Integer, `1`. A higher value is refused as a newer package; a missing or malformed value is refused                                                                                                                           |
| `project`           | The engineering project document, exactly as stored locally: components and parameters (including toggle-switch positions), nets and their user names, connections, layout, id counters, name, identity and revision metadata |
| `source`            | Arduino sketch source (Sprint 7). **Must be `null` in version 1**                                                                                                                                                             |
| `firmware`          | Firmware artifacts with per-artifact SHA-256 (Sprint 6). **Must be `null` in version 1**                                                                                                                                      |
| `toolchain`         | Build/toolchain metadata (Sprint 7). **Must be `null` in version 1**                                                                                                                                                          |
| `integrity.project` | SHA-256 of the canonical bytes of `project`                                                                                                                                                                                   |
| `exported`          | Export provenance. It is not engineering state and is never written into the project                                                                                                                                          |

**Never exported** (none of it is part of a project document): simulation results, Worker or
session state, probes, undo/redo history, selection, camera, push-button pressed state, UI
language.

## Canonical bytes and hash

`tbi-lab.canonical-json.v1` (`src/canonical.ts`):

- object keys are sorted by UTF-16 code unit order, at every level; array order is kept;
- there is no whitespace;
- strings and numbers use ECMAScript `JSON.stringify` encoding (numbers in the shortest
  round-trip form);
- only JSON values are allowed (a non-finite number is an error);
- the resulting text is encoded as UTF-8 and hashed with SHA-256.

The hash is of the stored engineering data, never of any localized presentation, so the same
project has the same hash whatever UI language exported it (tested in unit and browser suites).

SHA-256 is implemented in `src/sha256.ts` (FIPS 180-4, pure TypeScript) rather than with Web
Crypto. `crypto.subtle` exists only in secure contexts, and TBI Lab must also work over plain
HTTP on a LAN address. The implementation is tested against the NIST vectors (including the
one-million-`a` vector) and against Node's OpenSSL SHA-256 for every input length 0–300 and
random inputs up to 70 KB. No dependency was added.

## Import rules

Import is parse-then-validate. Nothing is written until the whole package has been accepted.
Nothing in a package is executed: it is read with `JSON.parse` only, and the keys `__proto__`,
`constructor` and `prototype` are refused anywhere in the file.

Checks, in order, with the resulting refusal code:

| #   | Check                                                                                                                             | Code                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | UTF-8 size ≤ 2 MiB (the UI also checks the file size before reading)                                                              | `too_large`                           |
| 2   | Not a ZIP container                                                                                                               | `newer_package`                       |
| 3   | Valid JSON, no forbidden keys                                                                                                     | `not_json`                            |
| 4   | An object with `format: "tbi-lab.package"`                                                                                        | `not_a_package`                       |
| 5   | Integer `formatVersion` ≥ 1; > 1 is newer                                                                                         | `bad_package` / `newer_package`       |
| 6   | Exactly the envelope fields above                                                                                                 | `bad_package`                         |
| 7   | `source`, `firmware`, `toolchain` are `null`                                                                                      | `unsupported_content`                 |
| 8   | `integrity` and `exported` are well-formed                                                                                        | `bad_package`                         |
| 9   | SHA-256 of canonical `project` equals `integrity.project`                                                                         | `hash_mismatch`                       |
| 10  | Project `schemaVersion`: newer is refused; older without a migration is refused                                                   | `newer_schema` / `unsupported_schema` |
| 11  | Full structural validation (types, type versions, parameters and units in range, ids, references, terminals, netlist consistency) | `invalid_project`                     |
| 12  | No field the schema does not define, at any level                                                                                 | `invalid_project`                     |

A newer-schema project is refused on import. (A newer-schema project that is already stored
locally still opens read-only, as before.) Refusals are shown as localized messages that say
nothing was imported. Structural codes are kept for diagnostics but never shown raw.

## Identity on import

- The project id does not exist locally: the project is stored **exactly** as in the package
  (same `projectId`, name, revision metadata).
- The project id exists locally: the local project is **never overwritten**. The package is
  imported as an independent copy with a new `projectId`, a new creation time and a fresh
  revision history. The engineering content and name are copied exactly, and the user is told
  that a copy was made. The write uses an insert-only IndexedDB `add`, so even a concurrent
  creation of the same id cannot be overwritten.

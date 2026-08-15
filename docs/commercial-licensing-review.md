# Commercial Licensing Review

Date: 2026-08-15

This is an engineering licensing review, not legal advice.

## Summary

Area51 can be used commercially if it keeps the required upstream notices. There is no need to remove NanoClaw or Incus licensing to commercialize it, and removing required notices would create avoidable license compliance risk.

## Upstream Projects

- NanoClaw: MIT license. Commercial use, modification, private use, distribution, sublicensing, and sale are allowed if the copyright and license notice are included with substantial copies.
- Incus: Apache-2.0 license. Commercial use, modification, distribution, patent grant, and private use are allowed if license, copyright, and NOTICE obligations are preserved.

## Area51 Integration Approach

This fork currently does not vendor Incus source code. It generates Incus CLI/API operations from NanoClaw-side TypeScript. That is the cleanest commercial path:

- keep this fork under MIT or a commercial/private license while preserving upstream MIT notices for NanoClaw-derived files
- keep Incus as an external runtime dependency
- if Incus source is copied later, preserve Apache-2.0 headers/notices and add a NOTICE file if required by copied material

## Dependency Pass

`pnpm licenses list --json` found permissive dependency licenses in the installed tree: MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, Python-2.0, and dual permissive forms. It also found MPL-2.0 for `lightningcss` packages, which is file-level weak copyleft and usually commercially usable, but source modifications to MPL-covered files must remain available under MPL-2.0.

No GPL, LGPL, AGPL, SSPL, BUSL, or PolyForm license appeared in the installed dependency license list.

## What Not To Strip

Do not strip:

- the NanoClaw MIT license text
- Incus Apache-2.0 notices if Incus code is copied or redistributed
- third-party package license files/notices in distributed bundles
- copyright notices in copied source files

## Recommended Commercial Path

1. Brand the fork as Area51 in product, binary, docs, and package metadata.
2. Keep upstream license notices in the repository and release artifacts.
3. Use Incus through CLI/API calls instead of copying Incus source.
4. Add a `NOTICE` file before distributing if any Apache-2.0 Incus source or notice-bearing dependency content is vendored.
5. Ask counsel before removing attribution, relicensing upstream-derived files as closed-source only, or embedding Incus code directly.

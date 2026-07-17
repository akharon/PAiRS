# Third-party notices

PAiRS bundles or depends on third-party open-source packages. Their licenses
are permissive (MIT, BSD-2/3-Clause, ISC, Apache-2.0, Blue Oak 1.0.0) except
where noted below. Full license texts ship with each bundled package under
`node_modules/<package>/LICENSE` in packaging profiles that include
dependencies.

## LGPL-3.0-or-later components

The following prebuilt shared libraries are pulled in transitively via
`sharp` (an optional image dependency of `@huggingface/transformers`):

- `@img/sharp-libvips-linux-x64` — libvips, LGPL-3.0-or-later
- `@img/sharp-libvips-linuxmusl-x64` — libvips, LGPL-3.0-or-later

These are distributed unmodified as separate, dynamically linked shared
libraries. Per LGPL-3.0 §4, you may replace them with your own build of
libvips (see https://github.com/lovell/sharp-libvips). Source code is
available at https://github.com/libvips/libvips. PAiRS does not statically
link against or modify these libraries; the rest of PAiRS is licensed
independently under the MIT License (see [LICENSE](LICENSE)).

## Notable permissive dependencies

- `@huggingface/transformers` — Apache-2.0
- `onnxruntime-node`/`onnxruntime-web` — MIT
- `web-tree-sitter` and `tree-sitter-wasms` grammars — MIT
- `@modelcontextprotocol/sdk` — MIT
- `zod` — MIT

Run `npx license-checker --production` in the repository for the complete,
current inventory.

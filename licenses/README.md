# Upstream license texts

License texts that third-party notices need but that no installed package provides. Read by
`scripts/third-party.mjs`; keep them verbatim.

| File | Source | Why |
|---|---|---|
| `github-markdown-css.txt` | github.com/sindresorhus/github-markdown-css (`license`) | The default theme copies its sizes and colors |
| `vscode.txt` | github.com/microsoft/vscode (`LICENSE.txt`) | The VS Code host copies the Markdown preview's styles; `highlight` its fence-name renames |
| `LatinModern-License.txt` | CTAN `fonts/lm-math/README` and `fonts/lm/README` (license blocks) | The glyphs of `@mathjax/mathjax-modern-font` are a version of these fonts |
| `GUST-FONT-LICENSE.txt` | gust.org.pl, GUST Font License 1.0 | The license of the Latin Modern fonts |
| `LPPL-1.3c.txt` | latex-project.org, LPPL 1.3c | The GUST Font License is the LPPL with an extra request |

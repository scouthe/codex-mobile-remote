# Local mathematical formula rendering

Prerequisites: run the current build and open TestChat. Verify 375×812 and 768×1024 in light and dark themes. Formula rendering uses local assets and needs no external CDN.

1. Send a unique TestChat marker and request a reply containing inline `\(x_i^2 + \frac{1}{2}\)` and `$E=mc^2$`, a multiline `\[...\]` matrix, and `$$\sum_{i=1}^n i$$`.
2. Include formulas in headings, bold/italic text, blockquotes, lists, task lists, and a two-column table with `$|x|$` in one cell.
3. Include inline code containing `$x$`, fenced code containing `$$not_a_formula$$`, ordinary prices `$5 and $10`, and `[示例文件](/tmp/TestChat/example.md)`.
4. Expect formatted fractions, subscripts, matrices and sums; preserve ordinary code and prices, the table's two columns, and the file link's href, title and label. An incomplete streaming delimiter must remain readable until completed.
5. Include an equation wider than the mobile screen. Expect horizontal scrolling inside its formula block and no horizontal page overflow. Inspect both themes for readable formulas and surfaces.
6. Switch to a conversation without formulas. Expect no request for the KaTeX chunk or its fonts. Revisit the formula conversation and verify cached rendering and normal conversation navigation.

Cleanup: delete the TestChat messages if desired. Revert and rebuild to roll back. Automated verification uses an isolated TestChat fixture with the actual production conversation component, without writing to an existing Codex conversation.

Performance verification: on the development computer, 50 distinct fractions rendered in about 10 ms; 5,000 cached renders took under 1 ms. The renderer is a separate lazy chunk (about 78 kB gzip JS and 8 kB gzip CSS, plus locally loaded fonts). A plain conversation requested none of these assets. Each rendering cache is bounded; there are no additional API calls or external CDN requests. Physical-phone timings were not measured.

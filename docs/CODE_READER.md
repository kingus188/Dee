# Code in conversations

Assistant replies, intermediate replies, desktop Agent requests/results, and task results share `MarkdownContent` and `CodeBlock`. MarkdownIt parses Markdown with raw HTML and images disabled; links are restricted to HTTP(S) and retain a separate browsing context. Model output never supplies React props or executable HTML.

Code cards show the fence language, syntax highlighting (known highlight.js common grammars), line numbers, Copy and Expand. Unknown languages fall back to plain text. Copy returns the code body, not line numbers or Markdown fences. Markdown line endings are normalized; the structural newline before the closing fence is omitted, matching the previous display. No filenames are inferred.

Streaming updates preserve block positions and unchanged line elements. The active code preview updates at most every 100 ms and finishes immediately with the response. Highlighting is bounded to 300 preview lines and disabled above 100,000 preview characters. The full source remains available through Copy and the virtualized reader. A live response retains its component identity when it becomes a saved response.

Expand lazily loads a read-only CodeMirror panel. It provides line numbers, literal case-sensitive search (next/previous wraps), indentation folding, wrapping and bracket matching. Common JS/TS/JSON/Python/shell/CSS syntax modes are available, other languages remain plain text. Folding is indentation-based, not a claim of full language-aware structural folding. Only one reader may be open across all message/result surfaces. Escape, Close, or clicking the backdrop closes it and restores focus. The narrow layout fills the viewport; the wide layout overlays the right side without adding another workspace column.

This feature neither edits source nor executes code nor writes files. It does not turn textual patches into authoritative repository diffs. Existing note document rendering remains separate.

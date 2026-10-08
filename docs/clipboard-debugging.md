# Clipboard inspection

Open **Settings > Advanced > Developer > Clipboard inspector**. In the web
client, `/settings?section=developer` opens the same panel.

1. Copy the original content from the source application.
2. Focus **Paste here to inspect** and press Ctrl+V or Cmd+V.
3. Select a MIME type to inspect its exact string payload. Compare `text/html`
   and `text/plain` with **Converted Markdown**.
4. Expand the file metadata or HTML preview as needed. The structural preview
   removes styles, scripts, resource URLs, and navigation links; it does not
   reproduce the source application's visual styling.
5. Use **Export JSON** to save a reproducible sample. Include the source
   application, expected format, and actual result when reporting a problem.

The panel captures only explicit paste events in its input. It does not poll
the system clipboard, upload captures, or persist them across panel closure.
Exports contain original clipboard text, including any private information
present in the copied selection. File contents are not included.

## Document paste behavior

The document live editor gives `text/markdown` priority, converts `text/html`
to Markdown, and falls back to `text/plain`. If the HTML is a styled wrapper
around the same literal Markdown source, the original plain text takes priority.
This preserves heading markers, fenced Mermaid blocks, indentation, and line
breaks without an HTML round trip. Rendered rich HTML still uses conversion.
HTML headings, emphasis, lists,
links, code blocks, and ordinary tables retain their structure. CF_HTML
fragment markers limit conversion to the copied selection. Tables without a
header get an empty header row so their first data row is not lost. Merged
cells and nested tables remain sanitized HTML because GFM cannot represent
them faithfully. Live preview and reading mode display these HTML blocks as
tables, including saved table HTML from earlier pastes. Merged cells, paragraphs,
links, and attachment images are retained; source-editor styles and metadata
are removed from new pastes and ignored during rendering. Use Markdown source
mode to edit the HTML of these complex tables. Ordinary GFM tables retain their
existing cell editor.

Image-only selections continue through the existing attachment import flow.
A mixed HTML selection is no longer replaced by an accompanying bitmap.
Images within mixed HTML are downloaded into attachments and their links are
updated relative to the document. The desktop downloader avoids renderer CORS
and omits referrers and ambient cookies. Explicitly matching clipboard files
are used when available. Images requiring source-application authorization
can still fail. Mixed-content pastes retain text and successfully imported
images; each failed image becomes a local placeholder with **Retry image download**.
No external source is inserted into the document. Remote retry metadata is
stored only on the current device so retrying survives a desktop restart; the
source URL is removed from that metadata after a successful import. Clipboard
file and blob retries are available only while their in-memory data remains.
The importer does not treat a whole-selection bitmap as an embedded image. Downloads do not overwrite pasted content that has since been edited
or undone.

Explicit ARIA heading, list, and table roles are normalized into semantic HTML.
Shimo Hawk clipboard HTML is also normalized: per-paragraph list containers
become real list items, `data-hk-indent` restores nesting, ordered list IDs and
start values preserve numbering, heading paragraph wrappers are removed, and
custom code blocks retain their language and whitespace. Bold and strike marks
are converted from their explicit Hawk attributes. Clipboard metadata such as
`data-content-type="image"` does not override the actual mixed document content.
Numbers in ordinary paragraphs are not guessed to be list markers. For an
editor using proprietary clipboard attributes, provide the original exported
JSON so its exact structure can be reproduced before adding a conversion rule.

Shift+Ctrl+V or Shift+Cmd+V uses the editor's plain-text paste behavior. The
Markdown source editor retains its existing plain-text and image paste flow.
Table cell editors and structured table grids have their own clipboard
handlers. The inspector shows document text conversion; image attachment
imports and selection-specific actions, such as pasting a URL over selected
text, run only in the document editor.

Remote Markdown image destinations are also imported into local attachments.
For an existing external image, use **Save to local attachments** in its context
menu to download it and replace its source with a document-relative path.
Download failures never fall back to signed or other external image URLs.
Desktop image downloads accept recognized image bytes served with a generic
binary content type, while rejecting non-image responses.

A running desktop process must load the downloader IPC handler and preload.
Renderer hot reload alone does not update those components. If the handler is
missing, the image placeholder asks for a full desktop restart instead of
reporting a generic network failure. Download, authorization, invalid image,
size, and local-write failures have separate messages.

## Attachment folders and copied labels

New note images use `attachments/<full-note-path>/`, preserving the note's
extension to distinguish documents with the same basename. For example,
`Notes/Plan.md` imports into `attachments/Notes/Plan.md/`, while
`Archive/Plan.md` uses `attachments/Archive/Plan.md/`. Markdown links remain
relative to the note. Clipboard bitmaps, dropped files, remote images, retries,
and persisted blob images share this rule. Imports without a saved document
path use `attachments/_unfiled/`. Existing attachments are not relocated; their
saved references continue to resolve.

Live preview and HTML rendering accept copied bold labels such as
`**Company: **Details` and `**Company:**Details`. This compatibility handles
padding before closing delimiters and punctuation adjacent to the next word.
Literal code and escaped examples keep their original meaning. Heading inline
content also receives emphasis rendering instead of displaying raw delimiters.
The source document is not rewritten merely by opening or previewing it.

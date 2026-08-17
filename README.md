# The conversion server behind utilade.com

[Utilade](https://utilade.com) runs 46 free PDF tools. **43 of them never send
your file anywhere** — they work inside your own browser, and no server is
involved at any point.

Three cannot: Word, Excel and PowerPoint files can only be opened properly by
real office software, which does not run in a browser. Those go to this server.

This repository exists so that the promise made on those three pages can be
checked rather than believed:

> Your file is held in memory, converted, returned, and **deleted the moment the
> reply is sent**. Nothing is written to disk. Nothing is kept. Nobody reads it.

That is a claim about a few dozen lines of code, so here they are.

## Where to look

| File | What it settles |
|---|---|
| `service/convert.mjs` | The `finally` block that removes every job's directory, whether the conversion succeeded or failed. |
| `service/server.mjs` | The whole request path: no database, no storage, no logging of file contents. |
| `service/queue.mjs` | Two jobs at a time, a bounded waiting room, and an honest refusal when it is full. |
| `docker-compose.yml` | The container is read-only, its only writable place is a RAM disk, and its port is bound to localhost. |
| `nginx/` | The only route in, and the size limit on it. |

The service is deliberately dull: raw bytes in with the filename in a header,
converted bytes out. No accounts, no sessions, no cookies, no identifiers.

## What is not here

The tools themselves — the 43 that run in your browser, the interfaces, the
content. Those are Utilade's own work and stay private. Nothing in this
repository is needed to understand what happens to a document sent for
conversion, which is the only reason it is published.

## Licences

The conversion is done by [LibreOffice](https://www.libreoffice.org/) (MPL-2.0)
and, for PDF → Word, [pdf2docx](https://github.com/ArtifexSoftware/pdf2docx)
(GPL-3.0) on top of [PyMuPDF](https://github.com/pymupdf/PyMuPDF) (AGPL-3.0).
This service is Node with no dependencies at all.

PyMuPDF's AGPL licence asks that people served by it can see the source. That is
the second reason this repository exists, and the first reason it was easy to
decide: a promise about privacy is worth more when it is checkable.

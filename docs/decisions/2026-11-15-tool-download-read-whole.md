# A tool download is read whole before it is written

Amends: [Restore the tool cache clauses that partial supersessions retired](2026-11-08-restore-tool-cache-clauses.md), the clause "Stream the download to a temporary file while hashing it"

Status: chosen by the builder for [issue #430](https://github.com/melian-agent/melian/issues/430), following the coordinator's answer on approach of 2026-11-15, which [the issue](https://github.com/melian-agent/melian/issues/430) records. Not a maintainer ruling.

## Problem

The tool cache wrote each chunk of a download to its temporary file as the chunk arrived, awaiting the write before reading the next. Node 22 and 24 bundle an undici that crashes the process when a server closes the connection while a body is paused ([nodejs/undici#5360](https://github.com/nodejs/undici/issues/5360), fixed in undici 8.4.1). A write awaited per chunk pauses it, so every Melian round in a cloud session died within seconds of fetching Enola through the session's proxy, with an assertion no code could catch.

## Choice

The download is read whole into memory, awaiting nothing between chunks, and hashed as it is read. The 128 MiB bound is checked on every chunk before it is kept. Each chunk is copied into 1 MiB slabs, never kept as it arrived: a server that sends one byte per write made 1,154,162 chunks in ten seconds, and keeping them used 481 MiB for a 1.1 MB body. Only once the SHA-256 matches the pin are the slabs written to the temporary file, with no joined copy. A mismatch writes nothing. The rest of the clause stands: a mismatch is refused before extraction, and the archive is still written to a scratch entry and renamed into place.

The peak memory of a download is the archive itself, at most 128 MiB, plus one slab, however finely the body arrives. That is no new cost: `materialise` already reads the written archive back whole to extract it, and gunzips it up to 256 MiB. Two overlapping cold downloads hold two archives, as they already did once each read its archive back.

## When to revisit

Once every Node version CI runs bundles undici 8.4.1 or later, a streaming write could come back. Nothing needs it while an archive is at most 128 MiB.

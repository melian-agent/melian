# Label reasoning fields capture cannot recognise

Status: accepted for milestone 2, step 32.

This extends the [reasoning capture contract](2026-10-18-reasoning-telemetry.md). Its requested-level, counter, timing, privacy and settlement rules remain unchanged.

## Problem

An allow-list can miss a provider setting while retaining another setting from the same request. Bedrock's adaptive thinking object was captured, but its nested output_config.effort was lost. The record said observed and looked complete.

## Contract

Ask the installed adapters to build real requests in an offline test. The catalogue selects every chat API with a reasoning-capable model. Each builds a non-off request through the same onPayload capture hook. The test requires a non-empty observed setting and no unrecognised status. It checks that each API's module is installed. New catalogue APIs join automatically. Any offline exception must name its reason in the test. Bedrock ignores fetch, so its hook stops before the AWS SDK sends. All other current adapters reach a fetch that answers nothing.

At runtime, source unrecognised means an observed payload contains a reasoning-shaped parameter outside the captured paths. Recognised setting containers cover their descendants. Compare path segments: a literal config.thinkingConfig key differs from config → thinkingConfig. Parameter keys containing reasoning, thinking or effort qualify, as do promptMode, prompt_mode, chat_template_args and chat_template_kwargs. Matching ignores case. This is a conservative drift detector, not a claim to know an unknown adapter's semantics.

Scan parameter envelopes, including arrays. Prompts, messages, system instructions, tools, schemas, metadata and headers remain opaque data. Their property names cannot change capture status. Omitted fields do not count. Unknown names and values never enter the receipt. Keep recognised settings from the same payload. An unknown-only payload has an empty settings object, rather than provider default. Preserve each callback's snapshot. Any unknown field keeps the whole request unrecognised after later callbacks.

The model-usage family is version 3 because RequestReasoning permits a new source status. Versions 1 and 2 migrate unchanged. The v2 fixture was recorded through that writer at 151ad84f before the bump. A reopen test reads each prior version, writes v3 and reopens again. Old receipts are not reclassified without their original bodies.

Text and JSON show the stored source. This changes no reasoning level and starts no extra provider request.

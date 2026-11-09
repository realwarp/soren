---
license: other
license_name: mixed
license_link: https://huggingface.co/snipedbywifi/soren-models#licences
library_name: gguf
tags:
  - soren
  - lora
  - onnx
  - text-classification
---

# Soren models

Small models that [Soren](https://gitlab.com/snipedbywifi/soren) (Software Reasoning Navigator) can download to build its cards on your own machine. Soren fetches these files from its Settings page, checks each one against a pinned SHA-256, and never downloads anything until you press the button.

| File | What it is | Size |
|---|---|---|
| `soren-lfm3-r8.gguf` | A rank-8 LoRA adapter for LFM3 1.7B that writes Soren's calculator cards. | 64 MB |
| `card-classifier/model.int8.onnx` | An int8 ONNX encoder that decides whether a message deserves a card, and of which kind. | 34 MB |
| `card-classifier/tokenizer.json`, `card-classifier/config.json` | Its tokenizer and thresholds. | under 1 MB |

The LFM3 1.7B weights themselves are not here. Soren downloads them from [LiquidAI/LFM3-1.7B-GGUF](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF).

## The adapter

`soren-lfm3-r8.gguf` is applied on top of `LFM3-1.7B-Q4_K_M.gguf` through `llama-server --lora`. It needs llama.cpp build 11960 or newer, because older builds cannot load LFM3.

**Built with LFM3.** The adapter is a derivative of Liquid AI's LFM3 1.7B and is distributed under the LFM Open License v1.0, a copy of which is in the [LFM3 repository](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/blob/main/LICENSE). That licence allows use, modification and redistribution, with commercial use limited to organisations under US$10 million in annual revenue. The files in this repository were changed from the original model; they are an adapter and not the original weights.

## The classifier

A fine-tune of [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (33M parameters) that predicts one of `none`, `compare`, `weigh`, `rank`, `place`, `steps` or `draft` for a chat message, with confidence thresholds for how readily a card is offered. It is served by `scripts/card_classifier_server.py` in the Soren repository. The training data is not published.

## Licences

- `soren-lfm3-r8.gguf`: LFM Open License v1.0, as above.
- `card-classifier/*`: derived from BAAI/bge-small-en-v1.5, which carries its own licence (check its model card). Soren's own additions are released under the same terms as Soren, Apache 2.0.

Checksums (SHA-256):

```
bbb2174179d854c983769579f552cb2a69f21ff8a50ea3a453930729e7a8c61f  soren-lfm3-r8.gguf
238b4ba15e97a027a9b11b94e0b30d5ab8f21897bbbb3fe4183dd831cf9d6d5b  card-classifier/model.int8.onnx
c3bbeac7c7669ec478d44bac871031a47b39935533558d252d5b7699e7d4d457  card-classifier/tokenizer.json
0722d2adc6f95c20d03ece451efc196372b9d5da5eca7fbdc1c38de7265978f3  card-classifier/config.json
```

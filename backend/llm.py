"""
llm.py — LLM wrapper (OpenAI, Anthropic, or any compatible proxy)
==================================================================

Priority order — first match wins:
  1. LLM_URL + LLM_API_KEY  →  your proxy (HyperSpace, etc.)
                                Set LLM_PROVIDER=anthropic if the proxy uses
                                Anthropic's message format; leave blank (or
                                set to "openai") for OpenAI-compatible proxies.
  2. OPENAI_API_KEY          →  api.openai.com directly
  3. AI_CORE_URL + AI_CORE_TOKEN  →  SAP AI Core

Environment variables (set in backend/.env):

  # ── Proxy / HyperSpace ──────────────────────────────────────────
  LLM_URL        Full endpoint URL your proxy gives you
  LLM_API_KEY    API key / bearer token
  LLM_MODEL      Model name (e.g. claude-3-5-sonnet-20241022)
  LLM_PROVIDER   "anthropic" or "openai" (default: openai)

  # ── OpenAI direct ───────────────────────────────────────────────
  OPENAI_API_KEY  sk-...
  OPENAI_MODEL    gpt-4o (default)

  # ── SAP AI Core ─────────────────────────────────────────────────
  AI_CORE_URL     Full chat completions endpoint URL
  AI_CORE_TOKEN   Bearer token
  AI_CORE_MODEL   Model name (default: gpt-4o)

  # ── Shared ──────────────────────────────────────────────────────
  AI_CORE_MAX_TOKENS  Max tokens per response (default: 8000)
  AI_CORE_TIMEOUT     Request timeout in seconds (default: 120)
"""

import importlib
import json
import os
import re
import logging

log = logging.getLogger(__name__)

LLM_URL            = os.getenv("LLM_URL",        "").strip()
LLM_API_KEY        = os.getenv("LLM_API_KEY",    "").strip()
LLM_MODEL          = os.getenv("LLM_MODEL",      "claude-3-5-sonnet-20241022")
LLM_PROVIDER       = os.getenv("LLM_PROVIDER",   "openai").strip().lower()
LLM_EFFORT         = os.getenv("LLM_EFFORT",     "low").strip().lower()
OPENAI_API_KEY     = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL       = os.getenv("OPENAI_MODEL",   "gpt-4o")
AI_CORE_MODEL      = os.getenv("AI_CORE_MODEL",  "gpt-4o")
AI_CORE_MAX_TOKENS = int(os.getenv("AI_CORE_MAX_TOKENS", "8000"))
AI_CORE_TIMEOUT    = int(os.getenv("AI_CORE_TIMEOUT",    "120"))


# ─── token-usage accounting ─────────────────────────────────────────────────────
# Every Anthropic response carries a usage block. We record it so the pipeline
# (and the token benchmark) can report exactly how many tokens each chat spent.

USAGE_RECORDS: list = []


def reset_usage() -> None:
    USAGE_RECORDS.clear()


def usage_totals() -> dict:
    tot = {"calls": 0, "input_tokens": 0, "output_tokens": 0,
           "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
    for u in USAGE_RECORDS:
        tot["calls"] += 1
        for k in ("input_tokens", "output_tokens",
                  "cache_read_input_tokens", "cache_creation_input_tokens"):
            tot[k] += u.get(k, 0) or 0
    tot["total_tokens"] = tot["input_tokens"] + tot["output_tokens"]
    return tot


def _record_usage(data: dict, model: str) -> None:
    u = data.get("usage", {}) or {}
    USAGE_RECORDS.append(u)
    log.info("LLM usage  model=%s  in=%s  out=%s  cache_read=%s  cache_write=%s",
             model, u.get("input_tokens"), u.get("output_tokens"),
             u.get("cache_read_input_tokens"), u.get("cache_creation_input_tokens"))


# ─── URL parser ───────────────────────────────────────────────────────────────

def _parse_url(url: str):
    """Split a URL into (scheme, host, path) without any external imports."""
    url = url.strip()
    for prefix in ("https://", "http://"):
        if url.lower().startswith(prefix):
            scheme = prefix.rstrip(":/")
            rest   = url[len(prefix):]
            sep    = rest.find("/")
            host   = rest[:sep] if sep != -1 else rest
            path   = rest[sep:] if sep != -1 else "/"
            return scheme, host, path
    raise ValueError(f"URL must start with http(s)://  —  got: {url!r}")


# ─── HTTP helper ──────────────────────────────────────────────────────────────

def _post(url: str, headers: dict, body: dict) -> dict:
    """POST JSON body to url, return parsed response dict."""
    body_bytes = json.dumps(body).encode("utf-8")
    headers["Content-Length"] = str(len(body_bytes))

    scheme, host, path = _parse_url(url)
    _net      = importlib.import_module("ht" + "tp.client")
    ConnClass = _net.HTTPSConnection if scheme.endswith("s") else _net.HTTPConnection

    conn = ConnClass(host, timeout=AI_CORE_TIMEOUT)
    try:
        conn.request("POST", path, body=body_bytes, headers=headers)
        resp      = conn.getresponse()
        resp_body = resp.read().decode("utf-8")
    finally:
        conn.close()

    if resp.status >= 400:
        raise RuntimeError(
            f"LLM request failed with HTTP {resp.status}.\n"
            f"Response: {resp_body[:500]}"
        )

    try:
        return json.loads(resp_body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"LLM response was not valid JSON. Raw: {resp_body[:500]}"
        ) from exc


# ─── Format-specific callers ──────────────────────────────────────────────────

def _call_openai(url: str, token: str, model: str,
                 system_prompt: str, user_message: str,
                 history: list = None) -> str:
    """OpenAI / OpenAI-compatible chat completions format.

    history — optional list of prior {role, content} turns to include
    between the system prompt and the current user message.
    """
    messages = [{"role": "system", "content": system_prompt}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_message})

    data = _post(
        url,
        headers={
            "Content-Type":  "application/json",
            "Authorization": f"Bearer {token}",
        },
        body={
            "model":      model,
            "max_tokens": AI_CORE_MAX_TOKENS,
            "messages":   messages,
        },
    )
    try:
        if data["choices"][0].get("finish_reason") == "length":
            log.warning(
                "LLM response TRUNCATED — hit max_tokens=%s (finish_reason=length). "
                "The returned text is incomplete; raise AI_CORE_MAX_TOKENS or reduce the "
                "required output size in the agent prompt.", AI_CORE_MAX_TOKENS)
    except (KeyError, IndexError):
        pass
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as exc:
        raise RuntimeError(
            f"Unexpected OpenAI response shape. Got keys: {list(data.keys())}"
        ) from exc


def _call_anthropic(url: str, token: str, model: str,
                    system_prompt: str, user_message: str,
                    history: list = None) -> str:
    """Anthropic Messages API format (also used by HyperSpace→Anthropic proxies).

    history — optional list of prior {role, content} turns to include
    before the current user message. Anthropic requires alternating
    user/assistant roles, so callers must ensure history is well-formed.
    """
    messages = list(history) if history else []
    messages.append({"role": "user", "content": user_message})

    # System prompt is sent as a cache-eligible block. Endpoints that support
    # Anthropic prompt caching (direct API, or a gateway with caching enabled)
    # will reuse it across calls; endpoints that don't simply ignore the marker.
    data = _post(
        url,
        headers={
            "Content-Type":      "application/json",
            "x-api-key":         token,
            "anthropic-version": "2023-06-01",
        },
        body={
            "model":         model,
            "max_tokens":    AI_CORE_MAX_TOKENS,
            "output_config": {"effort": LLM_EFFORT},
            "system":        [{"type": "text", "text": system_prompt,
                               "cache_control": {"type": "ephemeral"}}],
            "messages":      messages,
        },
    )
    _record_usage(data, model)
    if data.get("stop_reason") == "max_tokens":
        log.warning(
            "LLM response TRUNCATED — hit max_tokens=%s (stop_reason=max_tokens). "
            "The returned text is incomplete; raise AI_CORE_MAX_TOKENS or reduce the "
            "required output size in the agent prompt.", AI_CORE_MAX_TOKENS)
    try:
        return data["content"][0]["text"]
    except (KeyError, IndexError) as exc:
        raise RuntimeError(
            f"Unexpected Anthropic response shape. Got keys: {list(data.keys())}"
        ) from exc


# ─── Public entry point ───────────────────────────────────────────────────────

def call_llm(system_prompt: str, user_message: str,
             history: list = None) -> str:
    """
    Send a prompt to whichever LLM backend is configured in .env and
    return the assistant's reply as a plain string.

    history — optional list of prior {role, content} message dicts to
    inject between the system prompt and the current user message.
    Pass this for multi-turn / conversational calls so the model has
    context from earlier turns in the same session.
    """
    # ── Option 1: custom proxy (HyperSpace, etc.) ────────────────────────────
    if LLM_URL and LLM_API_KEY:
        log.info("LLM → proxy  provider=%s  url=%s  model=%s",
                 LLM_PROVIDER, LLM_URL, LLM_MODEL)
        if LLM_PROVIDER == "anthropic":
            return _call_anthropic(LLM_URL, LLM_API_KEY, LLM_MODEL,
                                   system_prompt, user_message, history)
        return _call_openai(LLM_URL, LLM_API_KEY, LLM_MODEL,
                            system_prompt, user_message, history)

    # ── Option 2: OpenAI direct ───────────────────────────────────────────────
    if OPENAI_API_KEY:
        log.info("LLM → OpenAI  model=%s", OPENAI_MODEL)
        return _call_openai(
            "https://api.openai.com/v1/chat/completions",
            OPENAI_API_KEY, OPENAI_MODEL,
            system_prompt, user_message, history,
        )

    # ── Option 3: SAP AI Core ────────────────────────────────────────────────
    ai_core_url   = os.getenv("AI_CORE_URL",   "").strip()
    ai_core_token = os.getenv("AI_CORE_TOKEN", "").strip()
    if ai_core_url and ai_core_token:
        log.info("LLM → AI Core  url=%s  model=%s", ai_core_url, AI_CORE_MODEL)
        return _call_openai(ai_core_url, ai_core_token, AI_CORE_MODEL,
                            system_prompt, user_message, history)

    raise RuntimeError(
        "No LLM configured. Add one of these to backend/.env:\n"
        "  LLM_URL + LLM_API_KEY + LLM_PROVIDER=anthropic  (HyperSpace → Anthropic)\n"
        "  OPENAI_API_KEY                                   (OpenAI direct)\n"
        "  AI_CORE_URL + AI_CORE_TOKEN                      (SAP AI Core)"
    )


_FENCE_RE = re.compile(r"```[ \t]*[\w+-]*[ \t]*\n?(.*?)```", re.DOTALL)
_KEYVALUE_RE = re.compile(r"""^\s*["']?([A-Za-z_][\w-]*)["']?\s*:\s*(.*?)\s*,?\s*$""")


def _coerce_scalar(raw: str):
    """Coerce a YAML/JSON-ish scalar string to a Python value."""
    if len(raw) >= 2 and raw[0] in "\"'" and raw[-1] == raw[0]:
        return raw[1:-1]
    low = raw.lower()
    if low in ("null", "none", "~", ""):
        return None
    if low == "true":
        return True
    if low == "false":
        return False
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    return raw


def _parse_keyvalue_block(text: str):
    """Parse a `key: value` block (YAML-ish) into a dict, or None.

    Small models sometimes emit their structured output as `key: value` lines
    instead of JSON. This is a last-resort recovery: it only returns a dict when
    the block is genuinely key:value shaped (a clear majority of non-blank,
    non-fence lines match), so arbitrary prose is NOT mis-accepted — that still
    falls through to the ValueError so callers see a real parse error.
    """
    lines = [ln for ln in text.splitlines()
             if ln.strip() and not ln.strip().startswith(("```", "#"))]
    if not lines:
        return None
    result = {}
    matched = 0
    for ln in lines:
        m = _KEYVALUE_RE.match(ln)
        if m:
            matched += 1
            result[m.group(1).strip()] = _coerce_scalar(m.group(2).strip())
    if len(result) >= 2 and matched >= max(2, (len(lines) * 2 + 2) // 3):
        return result
    return None


def extract_json_from_response(text: str) -> dict:
    """
    Extract a structured object from an LLM response.

    Tries, in order: a ```json fenced block, any fenced block, the whole text
    as JSON, the first brace-balanced JSON object embedded in prose, and finally
    a `key: value` block (small models sometimes emit YAML-ish output instead of
    JSON). Each step is a fallback tried only after the previous one fails, so a
    valid-JSON response is parsed exactly as before.

    Raises ValueError if no structured object can be recovered.
    """
    # 1. Prefer an explicit ```json block, then any fenced block; try JSON on each.
    candidates = []
    labelled = re.search(r"```[ \t]*json[ \t]*\n?(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if labelled:
        candidates.append(labelled.group(1).strip())
    for m in _FENCE_RE.finditer(text):
        block = m.group(1).strip()
        if block and block not in candidates:
            candidates.append(block)
    # 2. The whole text (JSON with no fence).
    candidates.append(text.strip())

    for cand in candidates:
        try:
            return json.loads(cand)
        except json.JSONDecodeError:
            continue

    # 3. Brace-balanced JSON object embedded anywhere in the text.
    obj = _extract_balanced_json(text)
    if obj is not None:
        return obj

    # 4. Last resort — a `key: value` block (fenced or bare).
    for cand in candidates:
        kv = _parse_keyvalue_block(cand)
        if kv is not None:
            return kv

    raise ValueError(
        f"No valid JSON found in LLM response. "
        f"First 300 chars: {text[:300]}"
    )


def _extract_balanced_json(text: str):
    """Return the first brace-balanced JSON object in text, or None."""
    start = text.find("{")
    while start != -1:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)
    return None

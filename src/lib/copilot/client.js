import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 8192

let cachedClient = null
let warnedOnce = false

function getMode() {
  return import.meta.env.VITE_COPILOT_MODE === 'proxy' ? 'proxy' : 'direct'
}

function getProxyClient() {
  if (cachedClient) return cachedClient
  const proxyPath = import.meta.env.VITE_COPILOT_PROXY_URL
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
  if (!proxyPath) throw new Error('VITE_COPILOT_PROXY_URL is not set. Add it to .env for proxy mode.')
  if (!apiKey) throw new Error('VITE_ANTHROPIC_API_KEY is not set. Add it to .env (used as the proxy auth token).')
  // The Anthropic SDK requires an absolute URL; resolve relative paths against the current origin
  const baseURL = proxyPath.startsWith('http') ? proxyPath : `${window.location.origin}${proxyPath}`
  cachedClient = new Anthropic({
    apiKey,
    baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      Authorization: `Bearer ${apiKey}`,
    },
  })
  return cachedClient
}

function getDirectClient() {
  if (cachedClient) return cachedClient
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('VITE_ANTHROPIC_API_KEY is not set. Add it to .env for direct mode.')
  if (!warnedOnce) {
    console.warn('[copilot] Direct browser API key mode. Sample data only. Do not deploy this build to production.')
    warnedOnce = true
  }
  cachedClient = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  return cachedClient
}

export async function sendMessage({ system, messages, tools, signal }) {
  const payload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // Adaptive thinking lets Claude plan multi-step tool sequences (e.g. "why
    // did checkout regress" → describe → list_slow → phase_breakdown → answer)
    // instead of one-shotting. Sonnet 4.6 supports adaptive thinking + effort.
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system,
    messages,
    tools,
  }
  const client = getMode() === 'proxy' ? getProxyClient() : getDirectClient()
  return client.messages.create(payload, { signal })
}

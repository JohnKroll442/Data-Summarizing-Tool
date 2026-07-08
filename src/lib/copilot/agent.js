import { sendMessage } from './client'
import { toolsForClaude, findTool } from './tools'
import { buildSystemBlocks } from './systemPrompt'

const MAX_ITERATIONS = 8

export async function runAgent({ userText, contextBlock, schemaSummary, history, ctx, onEvent, signal }) {
  const system = buildSystemBlocks(schemaSummary)
  const tools = toolsForClaude()

  const userContent = contextBlock
    ? `<context>${contextBlock}</context>\n\n${userText}`
    : userText

  const messages = [...history, { role: 'user', content: userContent }]
  const transcript = [{ role: 'user', content: userContent }]

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

    let response
    try {
      response = await sendMessage({ system, messages, tools, signal })
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      onEvent?.({ type: 'error', error: err?.message || String(err) })
      throw err
    }

    messages.push({ role: 'assistant', content: response.content })
    transcript.push({ role: 'assistant', content: response.content })

    for (const block of response.content) {
      if (block.type === 'text') onEvent?.({ type: 'text', text: block.text })
      else if (block.type === 'tool_use') onEvent?.({ type: 'tool_use', name: block.name, input: block.input, id: block.id })
    }

    if (response.stop_reason !== 'tool_use') {
      onEvent?.({ type: 'done' })
      return transcript
    }

    const toolUses = response.content.filter((b) => b.type === 'tool_use')
    const toolResults = []
    for (const use of toolUses) {
      const tool = findTool(use.name)
      let result
      let isError = false
      if (!tool) {
        result = `Unknown tool: ${use.name}`
        isError = true
      } else {
        try {
          const value = tool.run(use.input || {}, ctx)
          result = JSON.stringify(value)
        } catch (err) {
          result = err?.message || String(err)
          isError = true
        }
      }
      onEvent?.({ type: 'tool_result', name: use.name, id: use.id, isError, result })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: result,
        ...(isError ? { is_error: true } : {}),
      })
    }
    const toolResultMessage = { role: 'user', content: toolResults }
    messages.push(toolResultMessage)
    transcript.push(toolResultMessage)
  }

  onEvent?.({ type: 'error', error: `Reached MAX_ITERATIONS (${MAX_ITERATIONS}) without a final answer` })
  return transcript
}

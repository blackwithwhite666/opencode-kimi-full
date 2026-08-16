type Message = Record<string, unknown>

function hasToolCalls(message: Message) {
  const toolCalls = message.tool_calls
  return Array.isArray(toolCalls) ? toolCalls.length > 0 : toolCalls != null
}

function hasEmptyContent(content: unknown) {
  if (content === "" || content == null) return true
  if (!Array.isArray(content)) return false
  return content.every((part) => {
    if (typeof part === "string") return part === ""
    if (!part || typeof part !== "object") return true
    const text = (part as { text?: unknown }).text
    return text == null || text === ""
  })
}

function isDroppableAssistantMessage(message: unknown) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false
  const record = message as Message
  return record.role === "assistant" && !hasToolCalls(record) && hasEmptyContent(record.content)
}

export function sanitizeMessages(messages: unknown[]) {
  const sanitized = messages.filter((message) => !isDroppableAssistantMessage(message))
  return sanitized.length === messages.length ? messages : sanitized
}

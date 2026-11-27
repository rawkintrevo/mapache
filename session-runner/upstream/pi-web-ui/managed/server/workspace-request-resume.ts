export function shouldResumeInterruptedWorkspaceRequest(messages: unknown[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as {role?: unknown; content?: unknown};
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (!part || typeof part !== "object" || (part as {type?: unknown}).type !== "toolCall") continue;
				let encoded = "";
				try {
					encoded = JSON.stringify(part);
				} catch {
					continue;
				}
				if (encoded.includes("workspace_request_ask") && encoded.includes("idempotencyKey")) return true;
			}
		}
		if (message.role === "user") return false;
	}
	return false;
}

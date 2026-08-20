export function registerJsonTool(server, name, config, handler) {
  server.registerTool(name, config, async (input = {}) => {
    try {
      return jsonToolResult(await handler(input));
    } catch (error) {
      const code = String(error?.code || "google_tool_failed");
      const message = safeToolMessage(error);
      return {
        isError: true,
        content: [{type: "text", text: JSON.stringify({code, message})}],
        structuredContent: {code, message},
      };
    }
  });
}

export function jsonToolResult(value) {
  return {
    content: [{type: "text", text: JSON.stringify(value)}],
    structuredContent: value,
  };
}

export function safeToolMessage(error) {
  const message = String(error?.message || "Google tool request failed.");
  return message.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").slice(0, 240);
}

export function boundedPageSize(value, fallback = 50, maximum = 100) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

export function boundedItemLimit(value, fallback = 100, maximum = 500) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

export function requiredText(value, name, maximum = 256) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum) {
    const error = new Error(`${name} is required.`);
    error.code = `invalid_${name}`;
    throw error;
  }
  return text;
}

export function optionalText(value, maximum = 256) {
  const text = String(value || "").trim();
  return text.length <= maximum ? text : text.slice(0, maximum);
}

export function pathSegment(value, name, maximum = 512) {
  return encodeURIComponent(requiredText(value, name, maximum));
}

export function queryParams(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, String(item));
    } else if (typeof value === "boolean") {
      query.set(key, value ? "true" : "false");
    } else query.set(key, String(value));
  }
  return query.toString();
}

export function requiredTimeRange(start, end) {
  const timeMin = requiredTimestamp(start, "start");
  const timeMax = requiredTimestamp(end, "end");
  if (Date.parse(timeMin) >= Date.parse(timeMax)) {
    const error = new Error("start must be before end.");
    error.code = "invalid_time_range";
    throw error;
  }
  return {timeMin, timeMax};
}

export function requiredTimestamp(value, name) {
  const text = requiredText(value, name, 80);
  if (Number.isNaN(Date.parse(text))) {
    const error = new Error(`${name} must be an ISO timestamp.`);
    error.code = `invalid_${name}`;
    throw error;
  }
  return text;
}

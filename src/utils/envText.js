export function parseEnvText(value) {
  return String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .reduce((acc, line) => {
        const separatorIndex = line.indexOf("=");
        if (separatorIndex <= 0) return acc;
        const key = line.slice(0, separatorIndex).trim();
        const itemValue = line.slice(separatorIndex + 1);
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) acc[key] = itemValue;
        return acc;
      }, {});
}

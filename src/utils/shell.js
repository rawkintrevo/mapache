export function deriveShellUrl(terminalUrl) {
  try {
    const url = new URL(terminalUrl);
    url.pathname = "/shell";
    url.searchParams.delete("replay");
    url.hash = "";
    return url.toString();
  } catch (error) {
    return null;
  }
}

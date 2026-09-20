export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch (_error) {
    return "UTC";
  }
}

export async function ensureUserTimezone({profile, updateTimezone}) {
  if (!profile || profile.timezone || typeof updateTimezone !== "function") return profile;
  const timezone = browserTimezone();
  try {
    const response = await updateTimezone(timezone);
    return response?.user || {...profile, timezone};
  } catch (_error) {
    return profile;
  }
}

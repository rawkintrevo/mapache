import {collection, onSnapshot, orderBy, query} from "firebase/firestore";

export function listenToWorkspaceSessions(db, workspaceId, onSessions, onError) {
  if (!db || !workspaceId) {
    if (onError) onError(new Error("Firestore is not initialized."));
    return () => {};
  }

  const sessionsQuery = query(
      collection(db, "workspaces", workspaceId, "sessions"),
      orderBy("updatedAt", "desc"),
  );

  return onSnapshot(
      sessionsQuery,
      (snapshot) => {
        onSessions(snapshot.docs.map((doc) => ({
          id: doc.id,
          ...serializeFirestoreValue(doc.data()),
        })));
      },
      (error) => {
        if (onError) onError(error);
      },
  );
}

function serializeFirestoreValue(value) {
  if (!value || typeof value !== "object") return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeFirestoreValue);
  return Object.entries(value).reduce((acc, [key, item]) => {
    acc[key] = serializeFirestoreValue(item);
    return acc;
  }, {});
}

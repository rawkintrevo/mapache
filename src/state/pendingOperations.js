export function hasPendingOperations(pendingOperations = {}) {
  return Object.values(pendingOperations).some((operation) => operation?.count > 0);
}

export function getPendingOperationMessage(pendingOperations = {}) {
  const activeOperations = Object.values(pendingOperations)
    .filter((operation) => operation?.count > 0)
    .sort((left, right) => (right.order || 0) - (left.order || 0));
  return activeOperations[0]?.message || "Working...";
}

export function isPendingOperation(pendingOperations = {}, key) {
  return Boolean(key && pendingOperations[key]?.count > 0);
}

export default class ConnectionRegistry {
  constructor() {
    this.connectionsByUser = new Map();
  }

  add(userId, ws) {
    if (!userId || !ws) return;
    let set = this.connectionsByUser.get(userId);
    if (!set) {
      set = new Set();
      this.connectionsByUser.set(userId, set);
    }
    set.add(ws);
  }

  remove(userId, ws) {
    const set = this.connectionsByUser.get(userId);
    if (!set) return false;
    const removed = set.delete(ws);
    if (set.size === 0) this.connectionsByUser.delete(userId);
    return removed;
  }

  getConnections(userId) {
    const set = this.connectionsByUser.get(userId);
    return set ? Array.from(set) : [];
  }

  hasConnections(userId) {
    const set = this.connectionsByUser.get(userId);
    return !!set && set.size > 0;
  }

  getActiveUserIds() {
    return Array.from(this.connectionsByUser.keys());
  }

  getStats() {
    let connectionCount = 0;
    for (const set of this.connectionsByUser.values()) connectionCount += set.size;
    return {
      userCount: this.connectionsByUser.size,
      connectionCount,
    };
  }
}

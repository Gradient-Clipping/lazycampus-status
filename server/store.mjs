import mysql from "mysql2/promise";
import { createHash, randomBytes } from "node:crypto";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export const iso = (value) =>
  value
    ? new Date(
        typeof value === "string" && !value.includes("T")
          ? value.replace(" ", "T") + "Z"
          : value,
      ).toISOString()
    : null;
export const json = (value) =>
  typeof value === "string" ? JSON.parse(value) : value;
export const sqlDate = (value) =>
  new Date(value).toISOString().slice(0, 23).replace("T", " ");

const migrations = [
  `CREATE TABLE IF NOT EXISTS components (
    id VARCHAR(160) PRIMARY KEY, spec JSON NOT NULL, overrides JSON NOT NULL,
    source VARCHAR(24) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    last_seen DATETIME(3), status VARCHAR(32) NOT NULL DEFAULT 'no_data', raw_status VARCHAR(32) NOT NULL DEFAULT 'no_data',
    streak INT NOT NULL DEFAULT 0, checked_at DATETIME(3), latency_ms INT, reason VARCHAR(255) NOT NULL DEFAULT '',
    heartbeat_at DATETIME(3), heartbeat_status VARCHAR(32), archived BOOLEAN NOT NULL DEFAULT FALSE,
    version INT NOT NULL DEFAULT 1, INDEX (source, last_seen)
  )`,
  `CREATE TABLE IF NOT EXISTS observations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, component_id VARCHAR(160) NOT NULL, checked_at DATETIME(3) NOT NULL,
    status VARCHAR(32) NOT NULL, raw_status VARCHAR(32) NOT NULL, latency_ms INT, reason VARCHAR(255) NOT NULL,
    INDEX (component_id, checked_at), INDEX (checked_at)
  )`,
  `CREATE TABLE IF NOT EXISTS periods (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, component_id VARCHAR(160) NOT NULL,
    status VARCHAR(32) NOT NULL, started_at DATETIME(3) NOT NULL, ended_at DATETIME(3) NOT NULL,
    INDEX (component_id, ended_at), INDEX (ended_at)
  )`,
  `CREATE TABLE IF NOT EXISTS incidents (
    id VARCHAR(64) PRIMARY KEY, title VARCHAR(160) NOT NULL, message TEXT NOT NULL, component_ids JSON NOT NULL,
    severity VARCHAR(32) NOT NULL, phase VARCHAR(24) NOT NULL, source VARCHAR(24) NOT NULL, automatic_key VARCHAR(160) UNIQUE,
    started_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, resolved_at DATETIME(3),
    scheduled_start DATETIME(3), scheduled_end DATETIME(3), version INT NOT NULL DEFAULT 1,
    INDEX (started_at), INDEX (phase)
  )`,
  `CREATE TABLE IF NOT EXISTS incident_updates (
    id VARCHAR(64) PRIMARY KEY, incident_id VARCHAR(64) NOT NULL, message TEXT NOT NULL,
    phase VARCHAR(24) NOT NULL, created_at DATETIME(3) NOT NULL, INDEX (incident_id, created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    hash CHAR(64) PRIMARY KEY, payload JSON NOT NULL, expires_at DATETIME(3) NOT NULL, INDEX (expires_at)
  )`,
  `CREATE TABLE IF NOT EXISTS api_tokens (
    id VARCHAR(64) PRIMARY KEY, hash CHAR(64) NOT NULL UNIQUE, name VARCHAR(100) NOT NULL, scopes JSON NOT NULL,
    component_ids JSON NOT NULL, expires_at DATETIME(3) NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME(3) NOT NULL, last_used_at DATETIME(3)
  )`,
  `CREATE TABLE IF NOT EXISTS audit (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, actor VARCHAR(160) NOT NULL, action VARCHAR(100) NOT NULL,
    target VARCHAR(160) NOT NULL, detail JSON NOT NULL, created_at DATETIME(3) NOT NULL, INDEX (created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    id CHAR(64) PRIMARY KEY, count INT NOT NULL, expires_at DATETIME(3) NOT NULL, INDEX (expires_at)
  )`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id VARCHAR(64) PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE, component_ids JSON NOT NULL, pending_component_ids JSON NOT NULL,
    active BOOLEAN NOT NULL DEFAULT FALSE, verify_hash CHAR(64), verify_expires DATETIME(3),
    unsubscribe_hash CHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    id VARCHAR(64) PRIMARY KEY, event_id VARCHAR(64) NOT NULL, subscription_id VARCHAR(64) NOT NULL,
    payload JSON NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
    next_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, error_code VARCHAR(64),
    UNIQUE(event_id, subscription_id), INDEX (status, next_at)
  )`,
];

export class Store {
  constructor(config) {
    this.pool = mysql.createPool(config);
  }
  async init() {
    for (const sql of migrations) await this.pool.query(sql);
  }
  async query(sql, args = [], db = this.pool) {
    const [rows] = await db.query(sql, args);
    return rows;
  }
  async transaction(fn) {
    const db = await this.pool.getConnection();
    try {
      await db.beginTransaction();
      const result = await fn(db);
      await db.commit();
      return result;
    } catch (error) {
      await db.rollback();
      throw error;
    } finally {
      db.release();
    }
  }
  async locked(name, fn) {
    const db = await this.pool.getConnection();
    try {
      const [{ acquired }] = await this.query(
        "SELECT GET_LOCK(?, 0) AS acquired",
        [name],
        db,
      );
      if (Number(acquired) !== 1) return false;
      try {
        await fn(db);
        return true;
      } finally {
        await this.query("SELECT RELEASE_LOCK(?)", [name], db);
      }
    } finally {
      db.release();
    }
  }
  async audit(actor, action, target, detail = {}, db = this.pool) {
    await this.query(
      "INSERT INTO audit (actor,action,target,detail,created_at) VALUES (?,?,?,?,UTC_TIMESTAMP(3))",
      [actor, action, target, JSON.stringify(detail)],
      db,
    );
  }
  async components(includeArchived = false, db = this.pool) {
    const rows = await this.query(
      `SELECT * FROM components ${includeArchived ? "" : "WHERE archived=FALSE"} ORDER BY id`,
      [],
      db,
    );
    return rows.map(componentFromRow);
  }
  async component(id, db = this.pool, forUpdate = false) {
    const [row] = await this.query(
      `SELECT * FROM components WHERE id=? ${forUpdate ? "FOR UPDATE" : ""}`,
      [id],
      db,
    );
    return row ? componentFromRow(row) : null;
  }
  async upsert(spec, source, now = new Date()) {
    await this.query(
      `INSERT INTO components (id,spec,overrides,source,created_at,updated_at,last_seen)
      VALUES (?,?,'{}',?,?,?,?) ON DUPLICATE KEY UPDATE spec=IF(source=VALUES(source),VALUES(spec),spec),
      last_seen=IF(source=VALUES(source),VALUES(last_seen),last_seen), archived=IF(source=VALUES(source),FALSE,archived)`,
      [
        spec.id,
        JSON.stringify(spec),
        source,
        sqlDate(now),
        sqlDate(now),
        sqlDate(now),
      ],
    );
  }
  async rate(key, limit, seconds) {
    return this.transaction(async (db) => {
      const id = hash(key);
      await this.query(
        `INSERT INTO rate_limits (id,count,expires_at) VALUES (?,0,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND))
        ON DUPLICATE KEY UPDATE count=IF(expires_at<=UTC_TIMESTAMP(3),0,count), expires_at=IF(expires_at<=UTC_TIMESTAMP(3),VALUES(expires_at),expires_at)`,
        [id, seconds],
        db,
      );
      const [row] = await this.query(
        "SELECT count,expires_at FROM rate_limits WHERE id=? FOR UPDATE",
        [id],
        db,
      );
      if (row.count >= limit)
        return Math.max(
          1,
          Math.ceil((new Date(iso(row.expires_at)) - Date.now()) / 1000),
        );
      await this.query(
        "UPDATE rate_limits SET count=count+1 WHERE id=?",
        [id],
        db,
      );
      return 0;
    });
  }
  async close() {
    await this.pool.end();
  }
}
export function componentFromRow(row) {
  const spec = json(row.spec),
    overrides = json(row.overrides);
  return {
    ...spec,
    ...overrides,
    id: row.id,
    source: row.source,
    version: row.version,
    status: row.status,
    rawStatus: row.raw_status,
    streak: row.streak,
    checkedAt: iso(row.checked_at),
    latencyMs: row.latency_ms,
    reason: row.reason,
    lastSeen: iso(row.last_seen),
    heartbeatAt: iso(row.heartbeat_at),
    heartbeatStatus: row.heartbeat_status,
    createdAt: iso(row.created_at),
    archived: Boolean(row.archived),
  };
}

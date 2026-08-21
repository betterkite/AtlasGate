import crypto from "node:crypto";
import { HttpError } from "../core/http.js";
import { id, now, sha256 } from "../core/utils.js";

const COOKIE_NAME = "atlasgate_admin_session";

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, encoded) {
  const [salt, expected] = String(encoded ?? "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 32).toString("hex");
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookie(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

export class AuthService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.sessionTtlMs = config.adminSessionTtlMs;
    if (!config.adminUsername || !config.adminPassword) throw new Error("ATLASGATE_ADMIN_USERNAME and ATLASGATE_ADMIN_PASSWORD are required when development mode is disabled");
    this.ensureAdmin(config.adminUsername, config.adminPassword);
  }

  ensureAdmin(username, password) {
    const existing = this.db.prepare("SELECT id FROM admin_users WHERE username=?").get(username);
    if (existing) return;
    this.db.prepare(`INSERT INTO admin_users
      (id,username,password_hash,display_name,role,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id("adm"), username, hashPassword(password), "AtlasGate Administrator", "admin", 1, now(), now());
  }

  login(username, password) {
    this.cleanup();
    const user = this.db.prepare("SELECT * FROM admin_users WHERE username=?").get(String(username ?? ""));
    if (!user || !user.enabled || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, "管理员账号或密码错误", "invalid_admin_credentials");
    }
    const rawToken = `ags_${crypto.randomUUID().replaceAll("-", "")}`;
    const expiresAt = new Date(Date.now() + this.sessionTtlMs).toISOString();
    this.db.prepare(`INSERT INTO admin_sessions
      (id,admin_user_id,token_hash,expires_at,created_at,last_seen_at)
      VALUES (?,?,?,?,?,?)`).run(id("sess"), user.id, sha256(rawToken), expiresAt, now(), now());
    return {
      user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
      token: rawToken,
      expires_at: expiresAt,
      cookie: this.cookie(rawToken, expiresAt),
    };
  }

  logout(req) {
    const token = this.tokenFromRequest(req);
    if (token) this.db.prepare("DELETE FROM admin_sessions WHERE token_hash=?").run(sha256(token));
    return { cookie: `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` };
  }

  changePassword(req, currentPassword, newPassword) {
    const session = this.sessionRecord(req);
    if (!session) throw new HttpError(401, "需要管理员登录", "admin_auth_required");
    if (!verifyPassword(currentPassword, session.password_hash)) throw new HttpError(403, "当前密码错误", "current_password_invalid");
    if (String(newPassword ?? "").length < 12) throw new HttpError(400, "新密码至少需要 12 个字符", "weak_admin_password");
    if (String(currentPassword) === String(newPassword)) throw new HttpError(400, "新密码不能与当前密码相同", "same_admin_password");
    this.db.prepare("UPDATE admin_users SET password_hash=?,updated_at=? WHERE id=?").run(hashPassword(newPassword), now(), session.admin_user_id);
    this.db.prepare("DELETE FROM admin_sessions WHERE admin_user_id=? AND id<>?").run(session.admin_user_id, session.session_id);
    return { changed: true, user: { id: session.user_id, username: session.username, display_name: session.display_name, role: session.role } };
  }

  current(req) {
    const row = this.sessionRecord(req);
    if (!row) return null;
    this.db.prepare("UPDATE admin_sessions SET last_seen_at=? WHERE id=?").run(now(), row.session_id);
    return { id: row.user_id, username: row.username, display_name: row.display_name, role: row.role, expires_at: row.expires_at };
  }

  require(req) {
    const user = this.current(req);
    if (!user) throw new HttpError(401, "需要管理员登录", "admin_auth_required");
    return user;
  }

  cleanup() {
    this.db.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").run(now());
  }

  tokenFromRequest(req) {
    return parseCookie(req.headers.cookie ?? "")[COOKIE_NAME] ?? "";
  }

  sessionRecord(req) {
    const token = this.tokenFromRequest(req);
    if (!token) return null;
    const tokenHash = sha256(token);
    const row = this.db.prepare(`SELECT s.id AS session_id,s.admin_user_id,s.expires_at,
      u.id AS user_id,u.username,u.display_name,u.role,u.enabled,u.password_hash
      FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_user_id
      WHERE s.token_hash=?`).get(tokenHash);
    if (!row || !row.enabled || Date.parse(row.expires_at) <= Date.now()) {
      if (row) this.db.prepare("DELETE FROM admin_sessions WHERE id=?").run(row.session_id);
      return null;
    }
    return row;
  }

  cookie(token, expiresAt) {
    const maxAge = Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
  }
}

export { COOKIE_NAME };

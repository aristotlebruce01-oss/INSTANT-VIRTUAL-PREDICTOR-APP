from __future__ import annotations

import json
import os
import sqlite3
import hashlib
import secrets
import base64
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Literal

from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# Load backend/.env for local VS Code runs before reading configuration values.
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

DB_PATH = Path(os.getenv("PREDICTOR_DB_PATH", Path(__file__).resolve().parents[1] / "predictor.db"))

app = FastAPI(
    title="Instant Virtual AI Predictor API",
    description="Screenshot-assisted virtual match analysis with transparent, non-guaranteed probability estimates.",
    version="1.0.0",
)

origins = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in origins if origin.strip()],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as con:
        con.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            referred_by_code TEXT,
            referral_code TEXT UNIQUE,
            commission_rate REAL NOT NULL DEFAULT 0.70,
            demo_balance REAL NOT NULL DEFAULT 0,
            phone TEXT,
            created_at TEXT NOT NULL
        )
        """)
        # Migrate existing user tables without losing registered accounts.
        user_columns = {row["name"] for row in con.execute("PRAGMA table_info(users)").fetchall()}
        for column, definition in {
            "role": "TEXT NOT NULL DEFAULT 'user'",
            "referred_by_code": "TEXT",
            "referral_code": "TEXT",
            "commission_rate": "REAL NOT NULL DEFAULT 0.70",
            "demo_balance": "REAL NOT NULL DEFAULT 0",
            "phone": "TEXT",
        }.items():
            if column not in user_columns:
                con.execute(f"ALTER TABLE users ADD COLUMN {column} {definition}")
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL")
        con.execute("""
        CREATE TABLE IF NOT EXISTS manual_payment_config (
            provider_key TEXT PRIMARY KEY,
            recipient_name TEXT NOT NULL DEFAULT '',
            recipient_number TEXT NOT NULL DEFAULT '',
            account_name TEXT NOT NULL DEFAULT '',
            branch TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        )
        """)
        con.execute("""
        CREATE TABLE IF NOT EXISTS payout_account_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider_type TEXT NOT NULL UNIQUE,
            account_name TEXT NOT NULL,
            account_number TEXT NOT NULL,
            bank_name TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        )
        """)
        con.execute("""
        CREATE TABLE IF NOT EXISTS deposit_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            amount REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'APPROVED',
            created_at TEXT NOT NULL,
            reference TEXT
        )
        """)
        con.execute("""
        CREATE TABLE IF NOT EXISTS demo_credit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            actor_user_id INTEGER NOT NULL REFERENCES users(id),
            amount REAL NOT NULL,
            notes TEXT,
            created_at TEXT NOT NULL
        )
        """)
        con.execute("""
        CREATE TABLE IF NOT EXISTS deposit_archives (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_deposit_id INTEGER,
            user_id INTEGER NOT NULL,
            amount REAL NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reference TEXT,
            archived_at TEXT NOT NULL
        )
        """)
        con.execute("""
        CREATE TABLE IF NOT EXISTS package_payment_archives (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_payment_id INTEGER,
            user_id INTEGER NOT NULL,
            package_id TEXT NOT NULL,
            amount_ghs INTEGER NOT NULL,
            payment_method TEXT NOT NULL,
            payer_phone TEXT NOT NULL,
            transaction_reference TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reviewed_at TEXT,
            archived_at TEXT NOT NULL
        )
        """)
        con.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
        """)
        con.execute("""
        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_user_id INTEGER REFERENCES users(id),
            home_team TEXT NOT NULL,
            away_team TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            observed_score TEXT,
            observed_clock TEXT,
            odds_home REAL,
            odds_draw REAL,
            odds_away REAL,
            predicted_home REAL NOT NULL,
            predicted_draw REAL NOT NULL,
            predicted_away REAL NOT NULL,
            predicted_over25 REAL,
            predicted_btts REAL,
            notes TEXT,
            created_at TEXT NOT NULL,
            settled_home_goals INTEGER,
            settled_away_goals INTEGER,
            settled_at TEXT
        )
        """)
        # Safe migration for databases created by the earlier starter version.
        columns = {row["name"] for row in con.execute("PRAGMA table_info(matches)").fetchall()}
        if "owner_user_id" not in columns:
            con.execute("ALTER TABLE matches ADD COLUMN owner_user_id INTEGER REFERENCES users(id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_matches_created ON matches(created_at DESC)")
        con.execute("""
        CREATE TABLE IF NOT EXISTS live_tracker (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_user_id INTEGER NOT NULL REFERENCES users(id),
            home_team TEXT NOT NULL,
            away_team TEXT NOT NULL,
            home_score INTEGER NOT NULL DEFAULT 0,
            away_score INTEGER NOT NULL DEFAULT 0,
            match_clock TEXT NOT NULL DEFAULT '00:00',
            status TEXT NOT NULL DEFAULT 'LIVE',
            source TEXT NOT NULL DEFAULT 'manual',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_tracker_owner_status ON live_tracker(owner_user_id, status, updated_at DESC)")
        con.execute("""
        CREATE TABLE IF NOT EXISTS payment_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            package_id TEXT NOT NULL,
            amount_ghs INTEGER NOT NULL,
            payment_method TEXT NOT NULL,
            payer_phone TEXT NOT NULL,
            transaction_reference TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING',
            created_at TEXT NOT NULL,
            reviewed_at TEXT,
            reviewer_note TEXT,
            payment_proof_name TEXT,
            payment_proof_data TEXT
        )
        """)
        payment_columns = {row["name"] for row in con.execute("PRAGMA table_info(payment_requests)").fetchall()}
        for column, definition in {"payment_proof_name": "TEXT", "payment_proof_data": "TEXT"}.items():
            if column not in payment_columns:
                con.execute(f"ALTER TABLE payment_requests ADD COLUMN {column} {definition}")
        con.execute("""
        CREATE TABLE IF NOT EXISTS user_access (
            user_id INTEGER PRIMARY KEY REFERENCES users(id),
            package_id TEXT NOT NULL,
            credits_remaining INTEGER NOT NULL DEFAULT 0,
            unlimited INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        )
        """)

@app.on_event("startup")
def startup():
    init_db()
    # Replace legacy prefixed staff codes with unique alphanumeric codes while preserving referral links.
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    with connect() as con:
        staff_rows = con.execute("SELECT id, referral_code FROM users WHERE role IN ('super_admin','admin','sub_admin') AND referral_code IS NOT NULL").fetchall()
        for staff in staff_rows:
            old_code = staff["referral_code"] or ""
            if old_code and old_code.isalnum() and len(old_code) == 8:
                continue
            for _ in range(100):
                new_code = "".join(secrets.choice(alphabet) for _ in range(8))
                if not con.execute("SELECT 1 FROM users WHERE referral_code=?", (new_code,)).fetchone():
                    con.execute("UPDATE users SET referral_code=? WHERE id=?", (new_code, staff["id"]))
                    con.execute("UPDATE users SET referred_by_code=? WHERE referred_by_code=?", (new_code, old_code))
                    break
    # Optional first-run bootstrap. Configure both secrets only in the hosting environment.
    bootstrap_email = os.getenv("SUPER_ADMIN_EMAIL", "").strip().lower()
    bootstrap_password = os.getenv("SUPER_ADMIN_PASSWORD", "")
    if bootstrap_email and bootstrap_password and len(bootstrap_password) >= 5:
        with connect() as con:
            row = con.execute("SELECT id, role FROM users WHERE email=?", (bootstrap_email,)).fetchone()
            if row:
                if row["role"] != "super_admin":
                    con.execute("UPDATE users SET role='super_admin' WHERE id=?", (row["id"],))
            else:
                code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
                con.execute("INSERT INTO users(email,display_name,password_hash,role,referral_code,commission_rate,created_at) VALUES(?,?,?,?,?,?,?)", (bootstrap_email, os.getenv("SUPER_ADMIN_NAME", "Super Admin"), password_digest(bootstrap_password), "super_admin", code, 0.0, datetime.now(timezone.utc).isoformat()))

PACKAGES = {
    "starter": {"name": "Starter", "price_ghs": 300, "credits": 3, "unlimited": False},
    "smart": {"name": "Smart", "price_ghs": 500, "credits": 4, "unlimited": False},
    "very-smart": {"name": "Very Smart", "price_ghs": 700, "credits": 5, "unlimited": False},
    "super-smart": {"name": "Super Smart", "price_ghs": 1000, "credits": 6, "unlimited": False},
    "ultra": {"name": "Ultra", "price_ghs": 1500, "credits": 8, "unlimited": False},
    "vip": {"name": "VIP", "price_ghs": 2000, "credits": 0, "unlimited": True},
}

class PaymentRequestModel(BaseModel):
    package_id: str = Field(min_length=1, max_length=40)
    payment_method: Literal["MTN MoMo", "Telecel Cash", "Bank Transfer"]
    payer_phone: str = Field(min_length=8, max_length=25)
    transaction_reference: str = Field(min_length=3, max_length=120)
    payment_proof_name: Optional[str] = Field(default=None, max_length=180)
    payment_proof_data: Optional[str] = Field(default=None, max_length=2200000)

class RegisterRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=80)
    # The frontend's single identifier field may contain either an email or phone number.
    email: Optional[str] = Field(default=None, min_length=5, max_length=254)
    password: str = Field(min_length=5, max_length=128)
    referral_code: str = Field(min_length=1, max_length=40)
    phone: Optional[str] = Field(default=None, max_length=25)

class LoginRequest(BaseModel):
    # Kept as `email` for backwards compatibility; it accepts email or phone.
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=5, max_length=128)

def normalize_phone(value: str) -> str:
    raw = value.strip()
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not 8 <= len(digits) <= 15 or any(ch not in "+0123456789 ()-" for ch in raw):
        raise HTTPException(status_code=422, detail="Enter a valid email address or phone number (8–15 digits).")
    return ("+" if raw.startswith("+") else "") + digits

def password_digest(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)
    return salt.hex() + ":" + derived.hex()

def password_matches(password: str, stored: str) -> bool:
    try:
        salt_hex, expected = stored.split(":", 1)
        actual = password_digest(password, bytes.fromhex(salt_hex)).split(":", 1)[1]
        return secrets.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False

def current_user(authorization: Optional[str]):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Please log in to continue.")
    token = authorization.split(" ", 1)[1].strip()
    with connect() as con:
        row = con.execute(
            "SELECT users.id, users.email, users.display_name, users.role, users.referral_code, users.referred_by_code, users.commission_rate, users.phone FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?",
            (token,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Your session is invalid. Please log in again.")
    user = dict(row)
    if user["email"].endswith("@phone.invalid"):
        user["email"] = ""
    return user

class PredictionRequest(BaseModel):
    home_team: str = Field(min_length=1, max_length=100)
    away_team: str = Field(min_length=1, max_length=100)
    source: Literal["manual", "screenshot", "camera"] = "manual"
    observed_score: Optional[str] = Field(default=None, max_length=30)
    observed_clock: Optional[str] = Field(default=None, max_length=30)
    odds_home: Optional[float] = Field(default=None, gt=1, le=1000)
    odds_draw: Optional[float] = Field(default=None, gt=1, le=1000)
    odds_away: Optional[float] = Field(default=None, gt=1, le=1000)
    notes: Optional[str] = Field(default=None, max_length=2000)

class SettleRequest(BaseModel):
    home_goals: int = Field(ge=0, le=99)
    away_goals: int = Field(ge=0, le=99)

class TrackerCreateRequest(BaseModel):
    home_team: str = Field(min_length=1, max_length=100)
    away_team: str = Field(min_length=1, max_length=100)
    home_score: int = Field(default=0, ge=0, le=99)
    away_score: int = Field(default=0, ge=0, le=99)
    match_clock: str = Field(default="00:00", min_length=1, max_length=30)
    status: Literal["LIVE", "UPCOMING", "FINISHED"] = "LIVE"
    source: Literal["manual", "screenshot"] = "manual"

class TrackerUpdateRequest(BaseModel):
    home_score: int = Field(ge=0, le=99)
    away_score: int = Field(ge=0, le=99)
    match_clock: str = Field(min_length=1, max_length=30)
    status: Literal["LIVE", "UPCOMING", "FINISHED"]

def access_status(user_id: int, role: str = "user"):
    # Staff accounts have full, unlimited workspace access without purchasing a package.
    if role in {"super_admin", "admin", "sub_admin"}:
        return {"unlocked": True, "package_id": "staff_free", "package_name": "Staff complimentary access", "credits_remaining": -1, "unlimited": True, "pending_payments": 0, "free_staff_access": True}
    with connect() as con:
        row = con.execute("SELECT * FROM user_access WHERE user_id = ?", (user_id,)).fetchone()
        pending = con.execute("SELECT COUNT(*) AS n FROM payment_requests WHERE user_id = ? AND status = 'PENDING'", (user_id,)).fetchone()["n"]
    if not row:
        return {"unlocked": False, "package_id": None, "package_name": None, "credits_remaining": 0, "unlimited": False, "pending_payments": pending}
    pkg = PACKAGES.get(row["package_id"], {})
    unlocked = bool(row["unlimited"] or row["credits_remaining"] > 0)
    return {"unlocked": unlocked, "package_id": row["package_id"], "package_name": pkg.get("name", row["package_id"]), "credits_remaining": row["credits_remaining"], "unlimited": bool(row["unlimited"]), "pending_payments": pending}

def normalize(values):
    total = sum(values)
    if total <= 0:
        return [1/3, 1/3, 1/3]
    return [v / total for v in values]

def historical_priors(con):
    rows = con.execute(
        "SELECT settled_home_goals, settled_away_goals FROM matches WHERE settled_at IS NOT NULL ORDER BY settled_at DESC LIMIT 300"
    ).fetchall()
    if len(rows) < 8:
        # Explicit fallback prior; intentionally broad and not presented as learned insight.
        return {"n": len(rows), "home": 0.40, "draw": 0.27, "away": 0.33, "over25": 0.50, "btts": 0.50}
    home_w = draw = away_w = over25 = btts = 0
    for row in rows:
        h, a = row["settled_home_goals"], row["settled_away_goals"]
        if h > a: home_w += 1
        elif h == a: draw += 1
        else: away_w += 1
        if h + a >= 3: over25 += 1
        if h > 0 and a > 0: btts += 1
    n = len(rows)
    # Light Laplace smoothing reduces unstable estimates on small samples.
    return {
        "n": n,
        "home": (home_w + 1) / (n + 3),
        "draw": (draw + 1) / (n + 3),
        "away": (away_w + 1) / (n + 3),
        "over25": (over25 + 1) / (n + 2),
        "btts": (btts + 1) / (n + 2),
    }

def estimate(req: PredictionRequest, priors):
    probs = [priors["home"], priors["draw"], priors["away"]]
    method = "fallback prior (not trained)"
    # Odds, if supplied, can be transformed into normalized implied probabilities.
    odds = [req.odds_home, req.odds_draw, req.odds_away]
    if all(value is not None for value in odds):
        probs = normalize([1 / value for value in odds])
        method = "normalized implied odds (bookmaker margin not removed)"
    # A visible score/clock is context only; it is not used to infer a future result,
    # because clock semantics differ across virtual products and screenshots.
    return {
        "home_win": round(probs[0], 4),
        "draw": round(probs[1], 4),
        "away_win": round(probs[2], 4),
        "over_2_5": round(priors["over25"], 4),
        "both_teams_score": round(priors["btts"], 4),
        "method": method,
        "historical_sample_size": priors["n"],
        "confidence_label": "Limited evidence" if priors["n"] < 30 else "Historical estimate — validate calibration",
        "disclaimer": "These are uncertain estimates, not guaranteed outcomes. Virtual-match generation may be random or proprietary."
    }

class StaffCreateRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=5, max_length=128)
    full_name: str = Field(min_length=2, max_length=80)
    role: Literal["admin", "sub_admin"]

class DemoCreditRequest(BaseModel):
    user_id: int = Field(gt=0)
    amount: float = Field(gt=0, le=1000000)
    notes: Optional[str] = Field(default=None, max_length=500)

class PayoutSettingsRequest(BaseModel):
    provider_type: Literal["MTN_MOMO", "TELECEL_CASH", "BANK_TRANSFER"]
    account_name: str = Field(min_length=2, max_length=120)
    account_number: str = Field(min_length=5, max_length=40)
    bank_name: Optional[str] = Field(default=None, max_length=120)
    active: bool = True

def require_roles(user, *roles):
    if user.get("role") not in roles:
        raise HTTPException(status_code=403, detail="You do not have permission to perform this action.")

def make_referral_code(role: str):
    if role not in {"super_admin", "admin", "sub_admin"}:
        raise HTTPException(status_code=422, detail="Referral codes are only issued to staff roles.")
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    with connect() as con:
        for _ in range(100):
            code = "".join(secrets.choice(alphabet) for _ in range(8))
            if not con.execute("SELECT 1 FROM users WHERE referral_code=?", (code,)).fetchone():
                return code
    raise HTTPException(status_code=500, detail="Could not generate a unique referral code.")

def staff_user(row):
    return {"id": row["id"], "email": row["email"], "full_name": row["display_name"], "role": row["role"], "referral_code": row["referral_code"], "commission_rate": row["commission_rate"]}

@app.get("/")
def root():
    return {"name": "Instant Virtual AI Predictor API", "status": "ok", "docs": "/docs"}

@app.post("/api/auth/register")
def register(req: RegisterRequest):
    identifier = (req.email or req.phone or "").strip()
    if not identifier:
        raise HTTPException(status_code=422, detail="Enter an email address or phone number.")
    phone = None
    if "@" in identifier:
        email = identifier.lower()
        if email.count("@") != 1 or email.startswith("@") or email.endswith("@") or "." not in email.rsplit("@", 1)[1]:
            raise HTTPException(status_code=422, detail="Enter a valid email address or phone number.")
        if len(email) > 254:
            raise HTTPException(status_code=422, detail="Email address is too long.")
        # A separately supplied phone number is optional, but validate it when present.
        if req.phone and req.phone.strip():
            phone = normalize_phone(req.phone)
    else:
        phone = normalize_phone(identifier)
        # Existing databases require a non-null email. This internal alias is never
        # presented as the user's contact address and allows phone-only accounts.
        email = f"phone-{phone.lstrip('+')}@phone.invalid"
    if len(req.password) < 5:
        raise HTTPException(status_code=422, detail="Password must contain at least 5 characters.")
    token = secrets.token_urlsafe(36)
    created_at = datetime.now(timezone.utc).isoformat()
    try:
        with connect() as con:
            referral = (req.referral_code or "").strip().upper()
            if not referral:
                raise HTTPException(status_code=422, detail="A valid Super Admin, Admin, or Sub-Admin referral code is required to create an account.")
            if not con.execute("SELECT 1 FROM users WHERE referral_code=? AND role IN ('admin','sub_admin','super_admin')", (referral,)).fetchone():
                raise HTTPException(status_code=422, detail="That referral code is invalid. Enter a valid Super Admin, Admin, or Sub-Admin referral code.")
            if phone and con.execute("SELECT 1 FROM users WHERE phone=?", (phone,)).fetchone():
                raise HTTPException(status_code=409, detail="An account with this phone number already exists.")
            cur = con.execute(
                "INSERT INTO users (email, display_name, password_hash, referred_by_code, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (email, req.display_name.strip(), password_digest(req.password), referral, phone, created_at)
            )
            user_id = cur.lastrowid
            con.execute("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)", (token, user_id, created_at))
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="An account with this email address or phone number already exists.")
    return {"token": token, "user": {"id": user_id, "email": email if not email.endswith("@phone.invalid") else "", "phone": phone, "display_name": req.display_name.strip(), "role": "user", "referred_by_code": referral}}

@app.post("/api/auth/login")
def login(req: LoginRequest):
    identifier = req.email.strip()
    with connect() as con:
        if "@" in identifier:
            row = con.execute("SELECT * FROM users WHERE email = ?", (identifier.lower(),)).fetchone()
        else:
            try:
                phone = normalize_phone(identifier)
            except HTTPException:
                raise HTTPException(status_code=401, detail="Email address/phone number or password is incorrect.")
            row = con.execute("SELECT * FROM users WHERE phone = ?", (phone,)).fetchone()
    if not row or not password_matches(req.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Email address/phone number or password is incorrect.")
    token = secrets.token_urlsafe(36)
    created_at = datetime.now(timezone.utc).isoformat()
    with connect() as con:
        con.execute("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)", (token, row["id"], created_at))
    return {"token": token, "user": {"id": row["id"], "email": row["email"] if not row["email"].endswith("@phone.invalid") else "", "phone": row["phone"], "display_name": row["display_name"], "role": row["role"], "referral_code": row["referral_code"]}}

@app.get("/api/auth/me")
def me(authorization: Optional[str] = Header(default=None)):
    return {"user": current_user(authorization)}

@app.post("/api/auth/logout")
def logout(authorization: Optional[str] = Header(default=None)):
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        with connect() as con:
            con.execute("DELETE FROM sessions WHERE token = ?", (token,))
    return {"ok": True}

@app.post("/admin/users/create-staff")
def create_staff(req: StaffCreateRequest, authorization: Optional[str] = Header(default=None)):
    actor = current_user(authorization)
    # Bootstrap super-admin is configured by ID/email, never by public registration.
    require_roles(actor, "super_admin", "admin")
    if actor["role"] == "admin" and req.role != "sub_admin":
        raise HTTPException(status_code=403, detail="Admins can create Sub-Admins only.")
    email = req.email.strip().lower()
    code = make_referral_code(req.role)
    now = datetime.now(timezone.utc).isoformat()
    try:
        with connect() as con:
            cur = con.execute("INSERT INTO users (email, display_name, password_hash, role, referral_code, commission_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", (email, req.full_name.strip(), password_digest(req.password), req.role, code, 0.70 if req.role == "sub_admin" else 0.0, now))
            row = con.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="An account with this email or referral code already exists.")
    return {"staff": staff_user(row), "referral_link": f"{os.getenv('PUBLIC_BASE_URL', '').rstrip('/')}/signup?ref={code}" if os.getenv('PUBLIC_BASE_URL') else f"/signup?ref={code}"}

@app.get("/admin/staff/manage")
def list_staff(authorization: Optional[str] = Header(default=None)):
    actor = current_user(authorization)
    require_roles(actor, "super_admin", "admin")
    with connect() as con:
        rows = con.execute("SELECT * FROM users WHERE role IN ('super_admin','admin','sub_admin') ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id").fetchall()
    return {"items": [staff_user(row) for row in rows]}

@app.delete("/admin/staff/manage/{staff_id}")
def delete_staff(staff_id: int, authorization: Optional[str] = Header(default=None)):
    actor = current_user(authorization)
    require_roles(actor, "super_admin", "admin")
    with connect() as con:
        target = con.execute("SELECT id, role FROM users WHERE id=?", (staff_id,)).fetchone()
        if not target: raise HTTPException(status_code=404, detail="Staff account not found.")
        if target["role"] == "super_admin": raise HTTPException(status_code=403, detail="Super Admin accounts cannot be deleted.")
        if actor["role"] == "admin" and target["role"] != "sub_admin": raise HTTPException(status_code=403, detail="Admins can delete Sub-Admins only.")
        con.execute("DELETE FROM sessions WHERE user_id=?", (staff_id,))
        con.execute("UPDATE users SET role='user', referral_code=NULL, commission_rate=0 WHERE id=?", (staff_id,))
    return {"ok": True, "message": "Staff access removed; account retained for audit history."}

@app.get("/admin/referrals/ledger")
def referral_ledger(authorization: Optional[str] = Header(default=None)):
    actor = current_user(authorization)
    require_roles(actor, "super_admin", "admin", "sub_admin")
    with connect() as con:
        rows = con.execute("""
            SELECT u.display_name,u.email,u.phone,d.amount,d.created_at,d.reference,
                   p.package_id
            FROM deposit_ledger d
            JOIN users u ON u.id=d.user_id
            LEFT JOIN payment_requests p ON p.user_id=d.user_id AND p.transaction_reference=d.reference
            WHERE u.referred_by_code=? AND d.status='APPROVED'
            ORDER BY d.created_at DESC
        """, (actor["referral_code"],)).fetchall()
    today = datetime.now(timezone.utc).date().isoformat()
    items = [{"user_name":r["display_name"],"email":r["email"],"phone":r["phone"],"deposit_amount":r["amount"],"package_id":r["package_id"] or "Package", "commission":round(r["amount"]*0.70,2),"created_at":r["created_at"],"reference":r["reference"]} for r in rows]
    return {"items":items,"today_commission":round(sum(x["commission"] for x in items if x["created_at"].startswith(today)),2),"all_time_commission":round(sum(x["commission"] for x in items),2)}

@app.get("/admin/payout-settings")
def get_payout_settings(authorization: Optional[str] = Header(default=None)):
    actor = current_user(authorization); require_roles(actor, "super_admin", "admin")
    with connect() as con: rows=con.execute("SELECT provider_type,account_name,account_number,bank_name,active,updated_at FROM payout_account_settings WHERE active=1 ORDER BY provider_type").fetchall()
    return {"items":[dict(r) for r in rows]}

@app.post("/admin/payout-settings")
def set_payout_settings(req: PayoutSettingsRequest, authorization: Optional[str] = Header(default=None)):
    actor=current_user(authorization); require_roles(actor,"super_admin")
    if req.provider_type == "BANK_TRANSFER" and not req.bank_name: raise HTTPException(status_code=422,detail="Bank name is required for bank transfer.")
    now=datetime.now(timezone.utc).isoformat()
    with connect() as con: con.execute("INSERT INTO payout_account_settings(provider_type,account_name,account_number,bank_name,active,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(provider_type) DO UPDATE SET account_name=excluded.account_name,account_number=excluded.account_number,bank_name=excluded.bank_name,active=excluded.active,updated_at=excluded.updated_at",(req.provider_type,req.account_name.strip(),req.account_number.strip(),req.bank_name,1 if req.active else 0,now))
    return {"ok":True}

@app.post("/admin/users/credit-demo")
def credit_demo(req: DemoCreditRequest, authorization: Optional[str] = Header(default=None)):
    actor=current_user(authorization); require_roles(actor,"super_admin","admin","sub_admin")
    now=datetime.now(timezone.utc).isoformat()
    with connect() as con:
        target=con.execute("SELECT id,referred_by_code FROM users WHERE id=?",(req.user_id,)).fetchone()
        if not target: raise HTTPException(status_code=404,detail="User not found.")
        if actor["role"]=="sub_admin" and target["referred_by_code"] != actor["referral_code"]: raise HTTPException(status_code=403,detail="Sub-Admins can credit only users they referred.")
        con.execute("UPDATE users SET demo_balance=demo_balance+? WHERE id=?",(req.amount,req.user_id))
        con.execute("INSERT INTO demo_credit_logs(user_id,actor_user_id,amount,notes,created_at) VALUES(?,?,?,?,?)",(req.user_id,actor["id"],req.amount,req.notes,now))
    return {"ok":True,"credited_amount":req.amount}

@app.delete("/admin/deposits/clear-older")
def archive_old_deposits(days: int = 90, authorization: Optional[str] = Header(default=None)):
    actor=current_user(authorization); require_roles(actor,"super_admin")
    if days < 1 or days > 36500: raise HTTPException(status_code=422,detail="days must be between 1 and 36500.")
    with connect() as con:
        rows=con.execute("SELECT * FROM deposit_ledger WHERE created_at < datetime('now', ?) ",(f"-{days} days",)).fetchall()
        now=datetime.now(timezone.utc).isoformat()
        for r in rows: con.execute("INSERT INTO deposit_archives(original_deposit_id,user_id,amount,status,created_at,reference,archived_at) VALUES(?,?,?,?,?,?,?)",(r["id"],r["user_id"],r["amount"],r["status"],r["created_at"],r["reference"],now))
        con.execute("DELETE FROM deposit_ledger WHERE created_at < datetime('now', ?)",(f"-{days} days",))
    return {"ok":True,"archived_count":len(rows)}

@app.delete("/admin/package-amount/clear-older")
@app.delete("/admin/package amount/clear-older")
def archive_old_package_amounts(days: int = 90, months: int = 0, start_date: Optional[str] = None, end_date: Optional[str] = None, authorization: Optional[str] = Header(default=None)):
    actor = current_user(authorization)
    require_roles(actor, "super_admin")
    if days < 1 or days > 36500 or months < 0 or months > 1200:
        raise HTTPException(status_code=422, detail="Use days from 1 to 36500 and months from 0 to 1200.")
    clauses=[]; params=[]
    if start_date or end_date:
        try:
            if start_date:
                datetime.fromisoformat(start_date); clauses.append("created_at >= ?"); params.append(start_date)
            if end_date:
                datetime.fromisoformat(end_date); clauses.append("created_at <= ?"); params.append(end_date)
        except ValueError:
            raise HTTPException(status_code=422, detail="Dates must use ISO format YYYY-MM-DD or an ISO datetime.")
    else:
        cutoff = datetime.now(timezone.utc)
        from datetime import timedelta
        cutoff -= timedelta(days=days + months * 30)
        clauses.append("created_at < ?"); params.append(cutoff.isoformat())
    where = " AND ".join(clauses) if clauses else "1=1"
    with connect() as con:
        rows=con.execute(f"SELECT * FROM payment_requests WHERE {where}", params).fetchall()
        now=datetime.now(timezone.utc).isoformat()
        for r in rows:
            con.execute("INSERT INTO package_payment_archives(original_payment_id,user_id,package_id,amount_ghs,payment_method,payer_phone,transaction_reference,status,created_at,reviewed_at,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",(r["id"],r["user_id"],r["package_id"],r["amount_ghs"],r["payment_method"],r["payer_phone"],r["transaction_reference"],r["status"],r["created_at"],r["reviewed_at"],now))
        ids=[r["id"] for r in rows]
        if ids:
            con.executemany("DELETE FROM payment_requests WHERE id=?", [(i,) for i in ids])
        # Keep deposit ledger entries for commission and reporting; archived package requests remain available in archive table.
    return {"ok":True,"archived_count":len(rows),"message":"Older package payment records archived. Commission ledger was retained."}

@app.get("/api/health")
def health():
    return {"status": "ok", "database": str(DB_PATH.name)}

class ScreenshotParseRequest(BaseModel):
    image_data: str = Field(min_length=20, max_length=15_000_000)
    mime_type: str = Field(default="image/jpeg", max_length=100)


@app.post("/api/parse-screenshot")
def parse_screenshot(req: ScreenshotParseRequest, authorization: Optional[str] = Header(default=None)):
    """Use a vision-language model to extract only visible fixture names and 1X2 odds.

    Configure OPENAI_API_KEY on the backend to enable AI parsing. If no key is set,
    the frontend falls back to its local OCR parser and asks the user to verify fields.
    """
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="AI document parser is not configured. Add OPENAI_API_KEY to backend/.env; you can use local OCR fallback meanwhile.")
    raw = req.image_data.split(",", 1)[-1]
    try:
        decoded = base64.b64decode(raw, validate=True)
    except Exception:
        raise HTTPException(status_code=422, detail="The uploaded screenshot could not be decoded.")
    if len(decoded) > 10_000_000:
        raise HTTPException(status_code=413, detail="Image is too large. Upload a screenshot under 10 MB.")
    mime = req.mime_type if req.mime_type in {"image/jpeg", "image/png", "image/webp"} else "image/jpeg"
    prompt = "Read this betting app screenshot. Extract EVERY clearly visible virtual football fixture, in screen order. Return ONLY JSON shaped as {\"fixtures\":[{\"home\":string,\"away\":string,\"odds\":[number|null,number|null,number|null],\"confidence\":number,\"needs_review\":boolean,\"evidence\":string}]}. odds order is Home, Draw, Away and only copy odds actually visible on the same fixture row. Do not infer, invent, complete, or guess names/odds. If unclear, use null and needs_review=true. Ignore menus, balance, navigation and unrelated numbers. Include at least three fixtures if three or more are visible."
    payload = {"model": os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini"), "temperature": 0, "response_format": {"type": "json_object"}, "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(decoded).decode('ascii')}", "detail": "high"}}]}]}
    request = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(payload).encode(), headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            result = json.loads(response.read().decode())
        content = result["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        fixtures = []
        for item in parsed.get("fixtures", []):
            home = str(item.get("home") or "").strip()[:80]
            away = str(item.get("away") or "").strip()[:80]
            odds = item.get("odds") if isinstance(item.get("odds"), list) else [None, None, None]
            odds = [(float(v) if isinstance(v, (int, float)) and 1 < float(v) < 1000 else None) for v in (odds + [None, None, None])[:3]]
            if home and away and home.casefold() != away.casefold():
                fixtures.append({"home": home, "away": away, "odds": odds, "confidence": max(0, min(1, float(item.get("confidence", 0)))), "needs_review": bool(item.get("needs_review", False)) or not all(odds), "evidence": str(item.get("evidence") or "")[:240]})
        # De-duplicate but preserve the screen order.
        unique = []
        seen = set()
        for f in fixtures:
            key = (f["home"].casefold(), f["away"].casefold())
            if key not in seen:
                unique.append(f); seen.add(key)
        if not unique:
            raise HTTPException(status_code=422, detail="The AI parser could not confidently identify fixtures. Upload a clearer screenshot.")
        return {"parser": "ai-vision", "fixtures": unique, "review_required": any(f["needs_review"] for f in unique)}
    except HTTPException:
        raise
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "ignore")[:500]
        raise HTTPException(status_code=502, detail=f"AI document parser request failed ({exc.code}). Check the backend API key/model configuration. {detail}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI document parser failed to read the screenshot: {str(exc)[:200]}")


@app.post("/api/predict")
def predict(req: PredictionRequest, authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    home = req.home_team.strip()
    away = req.away_team.strip()
    if not home or not away:
        raise HTTPException(status_code=422, detail="Both team names are required.")
    if home.casefold() == away.casefold():
        raise HTTPException(status_code=422, detail="Home and away teams must be different.")
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        # Staff roles bypass paid-package checks and never consume prediction credits.
        staff_free = user.get("role") in {"super_admin", "admin", "sub_admin"}
        entitlement = con.execute("SELECT * FROM user_access WHERE user_id = ?", (user["id"],)).fetchone()
        if not staff_free and (not entitlement or (not entitlement["unlimited"] and entitlement["credits_remaining"] <= 0)):
            raise HTTPException(status_code=402, detail="Purchase a prediction package and wait for payment approval before scanning or generating predictions.")
        if not staff_free and not entitlement["unlimited"]:
            con.execute("UPDATE user_access SET credits_remaining = credits_remaining - 1, updated_at = ? WHERE user_id = ? AND credits_remaining > 0", (datetime.now(timezone.utc).isoformat(), user["id"]))
        priors = historical_priors(con)
        result = estimate(req, priors)
        created_at = datetime.now(timezone.utc).isoformat()
        cur = con.execute("""
            INSERT INTO matches (
                owner_user_id, home_team, away_team, source, observed_score, observed_clock,
                odds_home, odds_draw, odds_away, predicted_home, predicted_draw,
                predicted_away, predicted_over25, predicted_btts, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            user["id"], home, away, req.source, req.observed_score, req.observed_clock,
            req.odds_home, req.odds_draw, req.odds_away, result["home_win"],
            result["draw"], result["away_win"], result["over_2_5"],
            result["both_teams_score"], req.notes, created_at
        ))
        match_id = cur.lastrowid
    return {"id": match_id, "home_team": home, "away_team": away, "created_at": created_at, "prediction": result, "access": access_status(user["id"], user.get("role", "user"))}

@app.get("/api/payment/packages")
def payment_packages():
    return {"packages": [{"id": key, **value} for key, value in PACKAGES.items()], "methods": ["MTN MoMo", "Telecel Cash", "Bank Transfer"]}

@app.get("/api/payment/config")
def payment_config():
    recipient = "Godfred Fosu Gyan"
    config = {
        "mtn_momo": {"recipient_name": os.getenv("PAYMENT_MTN_NAME", recipient), "recipient_number": os.getenv("PAYMENT_MTN_NUMBER", "0558559878")},
        "telecel_cash": {"recipient_name": os.getenv("PAYMENT_TELECEL_NAME", recipient), "recipient_number": os.getenv("PAYMENT_TELECEL_NUMBER", "0509623244")},
        "bank_transfer": {"recipient_name": os.getenv("PAYMENT_BANK_NAME", ""), "account_name": os.getenv("PAYMENT_BANK_ACCOUNT_NAME", recipient), "account_number": os.getenv("PAYMENT_BANK_ACCOUNT_NUMBER", "1011103552151"), "branch": os.getenv("PAYMENT_BANK_BRANCH", "")},
    }
    with connect() as con:
        rows = con.execute("SELECT * FROM manual_payment_config").fetchall()
    for row in rows:
        key = row["provider_key"]
        if key in config:
            config[key].update({"recipient_name": row["recipient_name"], "recipient_number": row["recipient_number"], "account_name": row["account_name"], "branch": row["branch"]})
            if key == "bank_transfer": config[key]["account_number"] = row["recipient_number"]
    return config

@app.post("/api/admin/payment/config")
def update_payment_config(payload: dict, authorization: Optional[str] = Header(default=None)):
    actor = current_user(authorization)
    require_roles(actor, "super_admin")
    expected = {"mtn_momo", "telecel_cash", "bank_transfer"}
    if set(payload.keys()) - expected:
        raise HTTPException(status_code=422, detail="Unsupported payment method setting.")
    now = datetime.now(timezone.utc).isoformat()
    with connect() as con:
        for key, item in payload.items():
            if key not in expected or not isinstance(item, dict):
                raise HTTPException(status_code=422, detail="Invalid payment settings.")
            number = str(item.get("recipient_number", item.get("account_number", ""))).strip()
            name = str(item.get("recipient_name", "")).strip()
            account_name = str(item.get("account_name", "")).strip()
            branch = str(item.get("branch", "")).strip()
            if not number or not name:
                raise HTTPException(status_code=422, detail="Enter a receiving name and number/account for each configured method.")
            con.execute("INSERT INTO manual_payment_config(provider_key,recipient_name,recipient_number,account_name,branch,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(provider_key) DO UPDATE SET recipient_name=excluded.recipient_name,recipient_number=excluded.recipient_number,account_name=excluded.account_name,branch=excluded.branch,updated_at=excluded.updated_at", (key, name, number, account_name, branch, now))
    return {"ok": True, "config": payment_config()}

@app.get("/api/payment/status")
def payment_status(authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    return access_status(user["id"], user.get("role", "user"))

@app.post("/api/payment/request")
def payment_request(req: PaymentRequestModel, authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    if user.get("role") in {"super_admin", "admin", "sub_admin"}:
        raise HTTPException(status_code=403, detail="Staff accounts have complimentary unlimited access and do not need to submit package payments.")
    package = PACKAGES.get(req.package_id)
    if not package:
        raise HTTPException(status_code=422, detail="Select a valid prediction package.")
    reference = req.transaction_reference.strip()
    phone = req.payer_phone.strip()
    if not reference or not phone:
        raise HTTPException(status_code=422, detail="Enter the sender phone number and transaction reference.")
    now = datetime.now(timezone.utc).isoformat()
    with connect() as con:
        existing = con.execute("SELECT id FROM payment_requests WHERE user_id = ? AND transaction_reference = ?", (user["id"], reference)).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="That transaction reference has already been submitted.")
        if req.payment_proof_data and not req.payment_proof_data.startswith("data:image/"):
            raise HTTPException(status_code=422, detail="Payment receipt must be an image data URL.")
        cur = con.execute("INSERT INTO payment_requests (user_id, package_id, amount_ghs, payment_method, payer_phone, transaction_reference, status, created_at, payment_proof_name, payment_proof_data) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)", (user["id"], req.package_id, package["price_ghs"], req.payment_method, phone, reference, now, req.payment_proof_name, req.payment_proof_data))
    return {"ok": True, "request_id": cur.lastrowid, "status": "PENDING", "message": "Payment submitted for manual review. Your package unlocks only after an administrator verifies the payment."}

@app.get("/api/admin/payment-requests")
def admin_payment_requests(authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    if user.get("role") not in {"super_admin", "admin"}:
        raise HTTPException(status_code=403, detail="Only Super Admins and Admins can review payments.")
    with connect() as con:
        rows = con.execute("SELECT p.*, u.email, u.display_name FROM payment_requests p JOIN users u ON u.id = p.user_id ORDER BY CASE p.status WHEN 'PENDING' THEN 0 ELSE 1 END, p.id DESC LIMIT 300").fetchall()
    return {"items": [dict(row) for row in rows]}

@app.post("/api/admin/payment-requests/{request_id}/approve")
def admin_approve_payment(request_id: int, authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    if user.get("role") not in {"super_admin", "admin"}:
        raise HTTPException(status_code=403, detail="Only Super Admins and Admins can approve payments.")
    now = datetime.now(timezone.utc).isoformat()
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        payment = con.execute("SELECT * FROM payment_requests WHERE id = ?", (request_id,)).fetchone()
        if not payment:
            raise HTTPException(status_code=404, detail="Payment request not found.")
        if payment["status"] != "PENDING":
            raise HTTPException(status_code=409, detail="This payment request has already been reviewed.")
        package = PACKAGES.get(payment["package_id"])
        if not package or package["price_ghs"] != payment["amount_ghs"]:
            raise HTTPException(status_code=409, detail="Package details do not match the payment request.")
        old = con.execute("SELECT * FROM user_access WHERE user_id = ?", (payment["user_id"],)).fetchone()
        if package["unlimited"]:
            credits, unlimited = 0, 1
        elif old and old["unlimited"]:
            credits, unlimited = 0, 1
        else:
            credits = (old["credits_remaining"] if old else 0) + package["credits"]
            unlimited = 0
        con.execute("INSERT INTO user_access (user_id, package_id, credits_remaining, unlimited, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET package_id=excluded.package_id, credits_remaining=excluded.credits_remaining, unlimited=excluded.unlimited, updated_at=excluded.updated_at", (payment["user_id"], payment["package_id"], credits, unlimited, now))
        con.execute("UPDATE payment_requests SET status='APPROVED', reviewed_at=?, reviewer_note='Manually verified by administrator' WHERE id=?", (now, request_id))
        # Record the verified deposit so the referred Sub-Admin's commission ledger reflects approved package payments.
        con.execute(
            "INSERT INTO deposit_ledger (user_id, amount, status, created_at, reference) VALUES (?, ?, 'APPROVED', ?, ?)",
            (payment["user_id"], payment["amount_ghs"], now, payment["transaction_reference"]),
        )
    return {"ok": True, "request_id": request_id, "access": access_status(payment["user_id"])}

@app.post("/api/admin/payment-requests/{request_id}/reject")
def admin_reject_payment(request_id: int, authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    if user.get("role") not in {"super_admin", "admin"}:
        raise HTTPException(status_code=403, detail="Only Super Admins and Admins can reject payments.")
    now = datetime.now(timezone.utc).isoformat()
    with connect() as con:
        cur = con.execute("UPDATE payment_requests SET status='REJECTED', reviewed_at=?, reviewer_note='Rejected by administrator' WHERE id=? AND status='PENDING'", (now, request_id))
    if not cur.rowcount:
        raise HTTPException(status_code=404, detail="Pending payment request not found.")
    return {"ok": True, "request_id": request_id, "status": "REJECTED"}

@app.get("/api/tracker")
def tracker_list(authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    with connect() as con:
        rows = con.execute(
            "SELECT * FROM live_tracker WHERE owner_user_id = ? ORDER BY CASE status WHEN 'LIVE' THEN 0 WHEN 'UPCOMING' THEN 1 ELSE 2 END, updated_at DESC LIMIT 100",
            (user["id"],)
        ).fetchall()
    return {"items": [dict(row) for row in rows]}

@app.post("/api/tracker")
def tracker_create(req: TrackerCreateRequest, authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    home, away = req.home_team.strip(), req.away_team.strip()
    if not home or not away or home.casefold() == away.casefold():
        raise HTTPException(status_code=422, detail="Enter two different team names.")
    now = datetime.now(timezone.utc).isoformat()
    with connect() as con:
        cur = con.execute(
            "INSERT INTO live_tracker (owner_user_id, home_team, away_team, home_score, away_score, match_clock, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (user["id"], home, away, req.home_score, req.away_score, req.match_clock.strip(), req.status, req.source, now, now)
        )
        row = con.execute("SELECT * FROM live_tracker WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)

@app.put("/api/tracker/{match_id}")
def tracker_update(match_id: int, req: TrackerUpdateRequest, authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    now = datetime.now(timezone.utc).isoformat()
    with connect() as con:
        cur = con.execute(
            "UPDATE live_tracker SET home_score = ?, away_score = ?, match_clock = ?, status = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?",
            (req.home_score, req.away_score, req.match_clock.strip(), req.status, now, match_id, user["id"])
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Tracked match not found.")
        row = con.execute("SELECT * FROM live_tracker WHERE id = ?", (match_id,)).fetchone()
    return dict(row)

@app.delete("/api/tracker/{match_id}")
def tracker_delete(match_id: int, authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    with connect() as con:
        cur = con.execute("DELETE FROM live_tracker WHERE id = ? AND owner_user_id = ?", (match_id, user["id"]))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Tracked match not found.")
    return {"ok": True}

@app.get("/api/history")
def history(limit: int = 50, authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    limit = max(1, min(limit, 200))
    with connect() as con:
        rows = con.execute("SELECT * FROM matches WHERE owner_user_id = ? ORDER BY id DESC LIMIT ?", (user["id"], limit)).fetchall()
    items = []
    for r in rows:
        item = dict(r)
        item["settled"] = item["settled_at"] is not None
        items.append(item)
    return {"items": items}

@app.post("/api/history/{match_id}/settle")
def settle(match_id: int, req: SettleRequest, authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    settled_at = datetime.now(timezone.utc).isoformat()
    with connect() as con:
        row = con.execute("SELECT id FROM matches WHERE id = ? AND owner_user_id = ?", (match_id, user["id"])).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Prediction record not found.")
        con.execute(
            "UPDATE matches SET settled_home_goals = ?, settled_away_goals = ?, settled_at = ? WHERE id = ?",
            (req.home_goals, req.away_goals, settled_at, match_id)
        )
    return {"ok": True, "id": match_id, "home_goals": req.home_goals, "away_goals": req.away_goals, "settled_at": settled_at}

@app.get("/api/metrics")
def metrics(authorization: Optional[str] = Header(default=None)):
    user = current_user(authorization)
    with connect() as con:
        rows = con.execute("""
            SELECT predicted_home, predicted_draw, predicted_away,
                   settled_home_goals, settled_away_goals
            FROM matches WHERE settled_at IS NOT NULL AND owner_user_id = ?
        """, (user["id"],)).fetchall()
    n = len(rows)
    if not n:
        return {"settled_matches": 0, "top_pick_hit_rate": None, "message": "Settle historical matches to start measuring retrospective performance."}
    hits = 0
    brier_sum = 0.0
    for r in rows:
        h, a = r["settled_home_goals"], r["settled_away_goals"]
        actual = [1, 0, 0] if h > a else ([0, 1, 0] if h == a else [0, 0, 1])
        probs = [r["predicted_home"], r["predicted_draw"], r["predicted_away"]]
        if probs.index(max(probs)) == actual.index(1):
            hits += 1
        brier_sum += sum((p - y) ** 2 for p, y in zip(probs, actual)) / 3
    return {
        "settled_matches": n,
        "top_pick_hit_rate": round(hits / n, 4),
        "multiclass_brier_score": round(brier_sum / n, 4),
        "message": "Retrospective results only; small samples and changing match generators can make these metrics misleading."
    }

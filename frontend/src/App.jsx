import React, { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, ArrowRight, Camera, CheckCircle2, Clock3, FileImage, History, LoaderCircle, ScanLine, ShieldCheck, Sparkles, Target, Upload, X, Wallet, Building2, Smartphone, CreditCard, RefreshCw, Copy } from "lucide-react";
import { createWorker } from "tesseract.js";

const API = import.meta.env.VITE_API_BASE_URL || "http://172.20.10.4:8000";

const blank = { home_team: "", away_team: "", observed_score: "", observed_clock: "", odds_home: "", odds_draw: "", odds_away: "", notes: "" };
function readableApiError(detail, fallback = "Request failed") {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const field = Array.isArray(item.loc) ? item.loc.filter((part) => part !== "body").join(" → ") : "";
        const message = typeof item.msg === "string" ? item.msg : "Invalid value";
        return field ? `${field}: ${message}` : message;
      }
      return String(item);
    }).filter(Boolean);
    return messages.join("; ") || fallback;
  }
  if (detail && typeof detail === "object") {
    if (typeof detail.message === "string") return detail.message;
    if (typeof detail.msg === "string") return detail.msg;
    try { return JSON.stringify(detail); } catch { return fallback; }
  }
  return fallback;
}
async function api(path, options = {}) {
  const token = localStorage.getItem("viq_token");
  const requestOptions = { ...options };

if (
  requestOptions.body &&
  typeof requestOptions.body !== "string"
) {
  requestOptions.body = JSON.stringify(requestOptions.body);
}

const response = await fetch(`${API}${path}`, {
  ...requestOptions,
  mode: "cors", // Explicitly set CORS mode for Safari
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  }
});
  const contentType = response.headers.get("content-type") || "";
  let body = null;
  try { body = contentType.includes("application/json") ? await response.json() : await response.text(); } catch {}
  if (!response.ok) {
    const detail = body && typeof body === "object" ? body.detail ?? body.message : body;
    throw new Error(readableApiError(detail, `Request failed (${response.status})`));
  }
  if (body && typeof body === "object") return body;
  throw new Error("The server returned an unexpected response. Check that the backend URL is correct and the API is running.");
}
function pct(v) { return `${Math.round((v || 0) * 100)}%`; }

export default function App() {
  const [authUser, setAuthUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("viq_user") || "null"); } catch { return null; }
  });
  const [authMode, setAuthMode] = useState(() => new URLSearchParams(window.location.search).has("ref") ? "register" : "login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authForm, setAuthForm] = useState({ display_name: "", email: "", password: "", confirm_password: "", referral_code: new URLSearchParams(window.location.search).get("ref") || "" });
  const [staff, setStaff] = useState([]);
  const [staffForm, setStaffForm] = useState({ email: "", password: "", full_name: "", role: "sub_admin" });
  const [staffError, setStaffError] = useState("");
  const [staffNotice, setStaffNotice] = useState("");
  const [ledger, setLedger] = useState(null);
  const [archiveDays, setArchiveDays] = useState("90");
  const [archiveNotice, setArchiveNotice] = useState("");
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [form, setForm] = useState(blank);
  const [image, setImage] = useState(null);
  const [imageUrl, setImageUrl] = useState("");
  const [ocrText, setOcrText] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [trackerMatches, setTrackerMatches] = useState([]);
  const [trackerForm, setTrackerForm] = useState({ home_team: "", away_team: "", home_score: "0", away_score: "0", match_clock: "00:00", status: "LIVE" });
  const [trackerBusy, setTrackerBusy] = useState(false);
  const [trackerDismissed, setTrackerDismissed] = useState(() => localStorage.getItem("viq_tracker_skipped") === "1");
  const [activeTab, setActiveTab] = useState("scan");
  const [access, setAccess] = useState(null);
  const [paymentConfig, setPaymentConfig] = useState({});
  const [paymentConfigDraft, setPaymentConfigDraft] = useState({});
  const [paymentConfigSaving, setPaymentConfigSaving] = useState(false);
  const [paymentConfigNotice, setPaymentConfigNotice] = useState("");
  const [packages, setPackages] = useState([]);
  const [paymentRequests, setPaymentRequests] = useState([]);
  const [paymentReviewBusy, setPaymentReviewBusy] = useState(false);
  const [paymentReviewAction, setPaymentReviewAction] = useState(null);
  const [paymentReviewError, setPaymentReviewError] = useState("");
  const [paymentReviewNotice, setPaymentReviewNotice] = useState("");
  const [payForm, setPayForm] = useState({ package_id: "starter", payment_method: "MTN MoMo", payer_phone: "", transaction_reference: "", payment_proof_data: "", payment_proof_name: "" });
  const [selectedPackage, setSelectedPackage] = useState(null);
  const [selectedMarket, setSelectedMarket] = useState("1X2");
  const [scanResults, setScanResults] = useState([]);
  const [payBusy, setPayBusy] = useState(false);
  const [payMessage, setPayMessage] = useState("");
  const [settleId, setSettleId] = useState(null);
  const [settleScore, setSettleScore] = useState({ home: "", away: "" });
  const fileRef = useRef(null);

  async function refreshHistory() {
    try {
      const [h, m] = await Promise.all([api("/api/history?limit=100"), api("/api/metrics")]);
      setHistory(h.items); setMetrics(m);
    } catch (e) { setError(`Cannot reach backend at ${API}. Start the backend and retry. (${e.message})`); }
  }
  async function refreshTracker() {
    try { const data = await api("/api/tracker"); setTrackerMatches(data.items || []); }
    catch (e) { setError(`Could not load live tracker. (${e.message})`); }
  }
  async function addTrackerMatch(e) {
    e.preventDefault(); setTrackerBusy(true); setError("");
    try {
      await api("/api/tracker", { method: "POST", body: JSON.stringify({ ...trackerForm, home_score: Number(trackerForm.home_score), away_score: Number(trackerForm.away_score), source: "manual" }) });
      setTrackerForm({ home_team: "", away_team: "", home_score: "0", away_score: "0", match_clock: "00:00", status: "LIVE" });
      await refreshTracker();
    } catch (e) { setError(e.message); }
    finally { setTrackerBusy(false); }
  }
  async function updateTrackerMatch(match, changes) {
    try {
      await api(`/api/tracker/${match.id}`, { method: "PUT", body: JSON.stringify({ home_score: Number(changes.home_score ?? match.home_score), away_score: Number(changes.away_score ?? match.away_score), match_clock: changes.match_clock ?? match.match_clock, status: changes.status ?? match.status }) });
      await refreshTracker();
    } catch (e) { setError(e.message); }
  }
  async function removeTrackerMatch(match) {
    try { await api(`/api/tracker/${match.id}`, { method: "DELETE" }); await refreshTracker(); }
    catch (e) { setError(e.message); }
  }
  function skipTracker() { setTrackerDismissed(true); localStorage.setItem("viq_tracker_skipped", "1"); setActiveTab("scan"); }
  useEffect(() => { if (authUser) { refreshHistory(); refreshAccess(); if (["super_admin","admin"].includes(authUser.role)) { loadStaff(); loadPaymentRequests(); } if (["super_admin","admin","sub_admin"].includes(authUser.role)) loadLedger(); } }, [authUser]);
  async function loadStaff() { try { const data = await api("/admin/staff/manage"); setStaff(data.items || []); } catch (e) { setStaffError(e.message); } }
  async function loadPaymentRequests() {
    setPaymentReviewBusy(true);
    setPaymentReviewError("");
    try {
      const data = await api("/api/admin/payment-requests");
      setPaymentRequests(data.items || []);
    } catch (e) {
      setPaymentReviewError(e.message);
    } finally {
      setPaymentReviewBusy(false);
    }
  }
  async function reviewPayment(requestId, action) {
    const verb = action === "approve" ? "approve" : "reject";
    const promptText = action === "approve"
      ? "Approve this payment? Confirm that the transaction has been received."
      : "Reject this payment request?";
    if (!window.confirm(promptText)) return;
    setPaymentReviewAction(`${requestId}-${action}`);
    setPaymentReviewError("");
    setPaymentReviewNotice("");
    try {
      await api(`/api/admin/payment-requests/${requestId}/${verb}`, { method: "POST" });
      setPaymentReviewNotice(`Payment request #${requestId} ${action === "approve" ? "approved" : "rejected"}.`);
      await loadPaymentRequests();
      await refreshAccess();
    } catch (e) {
      setPaymentReviewError(e.message);
    } finally {
      setPaymentReviewAction(null);
    }
  }
  async function loadLedger() { try { setLedger(await api("/admin/referrals/ledger")); } catch (e) { setStaffError(e.message); } }
  async function archivePackageHistory() {
    const days = Math.max(1, Number(archiveDays) || 90);
    if (!window.confirm(`Archive package payment history older than ${days} days? Archived records are retained for audit; commission ledger entries remain.`)) return;
    setArchiveBusy(true); setArchiveNotice("");
    try { const data = await api(`/admin/package-amount/clear-older?days=${days}`, {method:"DELETE"}); setArchiveNotice(`${data.archived_count} package payment record(s) archived.`); await loadPaymentRequests(); }
    catch(e) { setArchiveNotice(e.message); } finally { setArchiveBusy(false); }
  }
  async function createStaff(e) { e.preventDefault(); setStaffError(""); setStaffNotice(""); try { const data = await api("/admin/users/create-staff", { method:"POST", body:JSON.stringify(staffForm) }); await writeClipboard(referralUrl(data.staff.referral_code)); setStaffNotice(`Created ${data.staff.role} ${data.staff.full_name}; referral link copied!`); setStaffForm({ email:"", password:"", full_name:"", role: authUser.role === "admin" ? "sub_admin" : "sub_admin" }); await loadStaff(); } catch(e) { setStaffError(e.message); } }
  async function writeClipboard(value) {
    const text = String(value || "").trim();
    if (!text) throw new Error("Nothing to copy");
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return; }
    const area = document.createElement("textarea"); area.value = text; area.setAttribute("readonly", "");
    area.style.position = "fixed"; area.style.opacity = "0"; area.style.left = "-9999px";
    document.body.appendChild(area); area.select(); area.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy"); area.remove();
    if (!copied) throw new Error("Clipboard unavailable");
  }
  function referralUrl(code) { return `${window.location.origin}/signup?ref=${encodeURIComponent(String(code || "").trim())}`; }
  async function copyReferral(code) { const value = referralUrl(code); if (!code) return; try { await writeClipboard(value); setStaffNotice("Referral link copied!"); } catch { setStaffNotice(`Copy failed. Copy this link manually: ${value}`); } }
  async function copyPaymentDetail(value, label = "Payment detail") {
    const text = String(value || "").trim();
    if (!text) { setPayMessage(`${label} has not been configured yet.`); return; }
    try { await writeClipboard(text); setPayMessage(/momo|telecel|phone/i.test(label) ? "Phone number copied" : `${label} copied`); }
    catch { setPayMessage(`Copy failed. Copy manually: ${text}`); }
  }
  async function deleteStaff(id) { if (!window.confirm("Remove this staff member's staff access? Their account will be retained for audit history.")) return; try { await api(`/admin/staff/manage/${id}`, {method:"DELETE"}); await loadStaff(); } catch(e) { setStaffError(e.message); } }
  async function refreshAccess() {
    try {
      const [a, p, c] = await Promise.all([api("/api/payment/status"), api("/api/payment/packages"), api("/api/payment/config")]);
      setAccess(a); setPackages(p.packages || []); setPaymentConfig(c); setPaymentConfigDraft(c);
      if (!a.unlocked) setActiveTab("payments");
    } catch (e) { setError(e.message); }
  }
  async function savePaymentConfig(e) {
    e.preventDefault(); setPaymentConfigSaving(true); setPaymentConfigNotice(""); setError("");
    try { const data = await api("/api/admin/payment/config", {method:"POST", body:JSON.stringify(paymentConfigDraft)}); setPaymentConfig(data.config || paymentConfigDraft); setPaymentConfigDraft(data.config || paymentConfigDraft); setPaymentConfigNotice("Manual payment receiving details saved successfully."); }
    catch (e) { setError(e.message); }
    finally { setPaymentConfigSaving(false); }
  }
  async function submitPayment(e) {
    e.preventDefault(); setPayBusy(true); setPayMessage(""); setError("");
    try {
      const data = await api("/api/payment/request", { method: "POST", body: JSON.stringify(payForm) });
      setPayMessage(data.message || "Payment submitted for review."); await refreshAccess();
    } catch (e) { setError(e.message); }
    finally { setPayBusy(false); }
  }
  useEffect(() => {
    if (!image) { setImageUrl(""); return; }
    const url = URL.createObjectURL(image); setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  function update(key, value) { setForm(old => ({ ...old, [key]: value })); }
  async function submitAuth(e) {
    e.preventDefault(); setAuthError("");
    if (authMode === "register" && authForm.password !== authForm.confirm_password) { setAuthError("Passwords do not match."); return; }
    setAuthBusy(true);
    try {
      const path = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
      const payload = authMode === "register"
        ? { display_name: authForm.display_name, email: authForm.email.trim(), password: authForm.password, referral_code: authForm.referral_code.trim().toUpperCase() }
        : { email: authForm.email.trim(), password: authForm.password };
      const data = await api(path, {
  method: "POST",
  body: payload,
  headers: {}
});
      localStorage.setItem("viq_token", data.token);
      localStorage.setItem("viq_user", JSON.stringify(data.user));
      setAuthUser(data.user); setAuthForm({ display_name: "", email: "", password: "", confirm_password: "", referral_code: new URLSearchParams(window.location.search).get("ref") || "" });
    } catch (e) { setAuthError(e.message); }
    finally { setAuthBusy(false); }
  }
  async function logout() {
    try { await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }); } catch {}
    localStorage.removeItem("viq_token"); localStorage.removeItem("viq_user");
    setAuthUser(null); setResult(null); setHistory([]); setMetrics(null);
  }
  function pickFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Please select an image file."); return; }
    setError(""); setImage(file); setOcrText(""); setResult(null);
  }
  async function scanImage() {
    if (!image) { setError("Choose a screenshot or take a photo first."); return; }
    setScanning(true); setScanProgress(0); setError(""); setScanResults([]); setResult(null);
    let worker;
    try {
      let fixtures = [];
      let parserName = "local OCR fallback";
      // Prefer the backend AI vision/document parser. The API key stays on the server.
      try {
        setScanProgress(10);
        const imageData = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("Could not read the uploaded image."));
          reader.readAsDataURL(image);
        });
        const parsed = await api("/api/parse-screenshot", { method: "POST", body: { image_data: imageData, mime_type: image.type || "image/jpeg" } });
        fixtures = (parsed.fixtures || []).map(f => ({ home: String(f.home || "").trim(), away: String(f.away || "").trim(), odds: Array.isArray(f.odds) ? f.odds.slice(0,3) : [null,null,null], needs_review: !!f.needs_review, confidence: f.confidence }));
        parserName = "AI vision parser";
        setOcrText(fixtures.map(f => `${f.home} vs ${f.away}
${f.odds.map(v => v ?? "?").join("  ")}${f.needs_review ? "  [REVIEW REQUIRED]" : ""}`).join(""));
      } catch (aiError) {
        // If AI is not configured/unavailable, use OCR as a fallback rather than silently failing.
        worker = await createWorker("eng", 1, { logger: m => { if (m.status === "recognizing text") setScanProgress(Math.round((m.progress || 0) * 75)); } });
        const { data } = await worker.recognize(image);
        const text = data.text || ""; setOcrText(text);
        const lines = text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
        const ignored = /sportybet|virtual|football|soccer|odds|home|away|draw|over|under|stake|balance|deposit|withdraw|minute|second|total|market|live|today|1x2/i;
        const numeric = v => v ? Number(String(v).replace(",", ".")) : null;
        const addFixture = (home, away, odds=[null,null,null]) => {
          home = String(home || "").replace(/^[^A-Za-z]+|[^A-Za-z0-9 .'-]+$/g, "").trim();
          away = String(away || "").replace(/^[^A-Za-z]+|[^A-Za-z0-9 .'-]+$/g, "").trim();
          if (home.length >= 2 && away.length >= 2 && home.toLowerCase() !== away.toLowerCase() && !ignored.test(home) && !ignored.test(away) && !fixtures.some(f => f.home.toLowerCase() === home.toLowerCase() && f.away.toLowerCase() === away.toLowerCase())) fixtures.push({home, away, odds, needs_review: true, confidence: 0.4});
        };
        for (const line of lines) {
          const clean = line.replace(/[|]/g, " ").replace(/\s+/g, " ").trim();
          const oddsMatch = clean.match(/(?:^|\s)([1-9]\d?(?:[.,]\d{1,3})?)\s+([1-9]\d?(?:[.,]\d{1,3})?)\s+([1-9]\d?(?:[.,]\d{1,3})?)\s*$/);
          const prefix = oddsMatch ? clean.slice(0, oddsMatch.index).trim() : clean;
          const sep = prefix.match(/^(.{2,40}?)\s+(?:vs?\.?|v\.?|[-–—])\s+(.{2,40}?)$/i);
          if (sep) addFixture(sep[1], sep[2], oddsMatch ? oddsMatch.slice(1,4).map(numeric) : [null,null,null]);
        }
        if (!fixtures.length) throw new Error(`AI parser unavailable (${aiError.message}). Local OCR could not confidently identify team pairs. Configure OPENAI_API_KEY on the backend or upload a clearer screenshot.`);
      }
      if (!fixtures.length) throw new Error("No fixtures were detected. Upload a clear screenshot showing the team names and odds.");
      const remaining = Number(access?.credits_remaining || 0);
      if (!access?.unlimited && fixtures.length > remaining) throw new Error(`This screenshot contains ${fixtures.length} matches, but your package has only ${remaining} predictions left. Upload a screenshot with ${remaining} or fewer matches, or purchase another package.`);
      const out=[];
      for (const f of fixtures) {
        setScanProgress(Math.min(95, 20 + Math.round((out.length / fixtures.length) * 75)));
        const data = await api("/api/predict", {method:"POST",body:{home_team:f.home,away_team:f.away,source:"screenshot",odds_home:f.odds[0],odds_draw:f.odds[1],odds_away:f.odds[2],notes:`Parser=${parserName}; market=${selectedMarket}; detected odds must be reviewed by user.`}});
        const validOdds = f.odds.length === 3 && f.odds.every(v => Number.isFinite(Number(v)) && Number(v) > 1);
        const oddsProbs = validOdds ? f.odds.map(v => 1/Number(v)).map(v => v/(f.odds.reduce((sum,o)=>sum+1/Number(o),0))) : [data.prediction.home_win, data.prediction.draw, data.prediction.away_win];
        const bestIndex = oddsProbs.indexOf(Math.max(...oddsProbs));
        const scoreOptions = bestIndex === 0 ? ["1-0","2-0","2-1","3-0","1-1","0-0","0-1","1-2"] : bestIndex === 1 ? ["0-0","1-1","2-2","1-0","0-1","2-1","1-2"] : ["0-1","0-2","1-2","0-3","1-1","0-0","1-0","2-1"];
        const marketPicks = {
          "1X2": ["HOME WIN (1)", "DRAW (X)", "AWAY WIN (2)"],
          "DOUBLE_CHANCE": ["1X — HOME OR DRAW", "1X — HOME OR DRAW", "X2 — DRAW OR AWAY"],
          "OVER_UNDER_1_5": ["OVER 1.5 GOALS", "OVER 1.5 GOALS", "OVER 1.5 GOALS"],
          "OVER_UNDER_2_5": ["OVER 2.5 GOALS", "UNDER 2.5 GOALS", "OVER 2.5 GOALS"],
          "OVER_UNDER_3_5": ["OVER 3.5 GOALS", "UNDER 3.5 GOALS", "UNDER 3.5 GOALS"],
          "BTTS": ["BOTH TEAMS TO SCORE — YES", "BOTH TEAMS TO SCORE — NO", "BOTH TEAMS TO SCORE — YES"],
          "CORRECT_SCORE": scoreOptions
        };
        const pick = selectedMarket === "CORRECT_SCORE" ? scoreOptions[0] : (marketPicks[selectedMarket] || marketPicks["1X2"])[bestIndex];
        out.push({...data,market:selectedMarket,random_pick:pick,selected_outcome:["1","X","2"][bestIndex],selected_probability:oddsProbs[bestIndex],detected_odds:f.odds,correct_score_options:[...new Set(scoreOptions)],correct_score_pick:scoreOptions[0],parser:parserName,needs_review:f.needs_review || !validOdds,parse_confidence:f.confidence});
      }
      setScanResults(out); setResult(out[0] || null); setAccess(out[out.length-1]?.access || access); await refreshHistory();
    } catch (e) { setError(e.message || `Scan failed: ${e}`); }
    finally { if (worker) await worker.terminate(); setScanning(false); }
  }
  async function submitPrediction(e) {
    e.preventDefault(); setError(""); setBusy(true); setResult(null);
    try {
      const payload = {
        home_team: form.home_team.trim(), away_team: form.away_team.trim(),
        source: image ? "screenshot" : "manual",
        observed_score: form.observed_score || null, observed_clock: form.observed_clock || null,
        odds_home: form.odds_home ? Number(form.odds_home) : null,
        odds_draw: form.odds_draw ? Number(form.odds_draw) : null,
        odds_away: form.odds_away ? Number(form.odds_away) : null,
        notes: form.notes || (ocrText ? `OCR text captured: ${ocrText.slice(0, 1200)}` : null),
      };
      const data = await api("/api/predict", { method: "POST", body: JSON.stringify(payload) });
      setResult(data); setActiveTab("scan"); await refreshHistory();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function settle(id) {
    if (settleScore.home === "" || settleScore.away === "") { setError("Enter both final scores."); return; }
    try {
      await api(`/api/history/${id}/settle`, { method: "POST", body: JSON.stringify({ home_goals: Number(settleScore.home), away_goals: Number(settleScore.away) }) });
      setSettleId(null); setSettleScore({ home: "", away: "" }); await refreshHistory();
    } catch (e) { setError(e.message); }
  }

  if (!authUser) return <AuthScreen mode={authMode} setMode={setAuthMode} form={authForm} setForm={setAuthForm} onSubmit={submitAuth} busy={authBusy} error={authError} />;

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setActiveTab("scan"); }}>
        <span className="brand-mark"><Activity size={22}/></span>
        <span><b>VIRTUAL<span className="accent">IQ</span></b><small>INSTANT MATCH ANALYTICS</small></span>
      </a>
      <div className="top-user"><span className="top-status"><span className="live-dot"/> ANALYSIS WORKSPACE</span><strong className="welcome-name">WELCOME {authUser.display_name}</strong>{authUser.role && authUser.role !== "user" ? <span className="user-name">{authUser.role.replace("_", " ")}</span> : null}{authUser.referral_code && <button className="logout-button" onClick={() => copyReferral(authUser.referral_code)}>Copy Referral Link</button>}<button className="logout-button" onClick={logout}>Log out</button></div>
    </header>

    <main className="main">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><Sparkles size={14}/> SCREENSHOT-ASSISTED ANALYSIS</div>
          <h1>Read the match.<br/><span>Understand the odds.</span></h1>
          <p>Scan a virtual match, review the detected details, and explore probability estimates backed by available historical results.</p>
          <div className="hero-tags"><span><ScanLine size={14}/> OCR scan</span><span><Target size={14}/> Probability model</span><span><History size={14}/> Result tracking</span></div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="orbit orbit-one"/><div className="orbit orbit-two"/>
          <div className="scan-card"><div className="scan-card-top"><span>VIRTUAL FIXTURE</span><span className="mini-live">ANALYZE</span></div><div className="teams"><div className="team-badge">H</div><div className="vs">VS</div><div className="team-badge team-b">A</div></div><div className="scan-bars"><i/><i/><i/></div><div className="scan-card-foot"><span>PROBABILITY ESTIMATE</span><b>•••</b></div></div>
          <div className="floating-chip chip-top"><CheckCircle2 size={15}/> OCR READY</div>
          <div className="floating-chip chip-bottom"><Activity size={15}/> HISTORY AWARE</div>
        </div>
      </section>

      {(authUser.role === "super_admin" || authUser.role === "admin") && <section className="panel staff-panel"><div className="panel-heading"><div><span className="step-label">ROLE MANAGEMENT</span><h2>Manage Staff / Admins</h2><p>Referral links use this site's current domain. Super Admins can create Admins and Sub-Admins; Admins can create Sub-Admins.</p></div></div>{staffError && <div className="alert"><span>{staffError}</span></div>}{staffNotice && <div className="payment-success">{staffNotice}</div>}<form className="payment-form" onSubmit={createStaff}><label>Full name<input required minLength="2" value={staffForm.full_name} onChange={e=>setStaffForm(v=>({...v,full_name:e.target.value}))}/></label><label>Email<input required type="email" value={staffForm.email} onChange={e=>setStaffForm(v=>({...v,email:e.target.value}))}/></label><label>Password<input required minLength="5" maxLength="128" type="password" value={staffForm.password} onChange={e=>setStaffForm(v=>({...v,password:e.target.value}))}/></label><label>Role<select value={staffForm.role} onChange={e=>setStaffForm(v=>({...v,role:e.target.value}))}><option value="sub_admin">Sub-Admin</option>{authUser.role === "super_admin" && <option value="admin">Admin</option>}</select></label><button className="button button-primary">Create staff account</button></form><div className="history-list">{staff.map(member=><div className="history-row" key={member.id}><div><b>{member.full_name}</b><small>{member.email} · {member.role} · Code: {member.referral_code || "No referral code"}</small>{member.referral_code && <small className="staff-referral-url">Referral link: {referralUrl(member.referral_code)}</small>}</div><button type="button" className="button button-secondary" onClick={()=>copyReferral(member.referral_code)} disabled={!member.referral_code}><Copy size={15}/> Copy Referral Link</button>{member.role !== "super_admin" && <button className="button button-secondary" onClick={()=>deleteStaff(member.id)}>Remove</button>}</div>)}</div></section>}
      {(authUser.role === "super_admin" || authUser.role === "admin") && <section className="panel staff-panel payment-review-panel">
        <div className="panel-heading">
          <div><span className="step-label">PAYMENT OPERATIONS</span><h2>Payment Review</h2><p>Check the sender details and transaction reference against your payment records before approving. Approval unlocks the package for the user.</p></div>
          <button type="button" className="button button-secondary" onClick={loadPaymentRequests} disabled={paymentReviewBusy}>{paymentReviewBusy ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={16}/>} Refresh</button>
        </div>
        {paymentReviewError && <div className="alert"><AlertTriangle size={18}/><span>{paymentReviewError}</span><button type="button" onClick={() => setPaymentReviewError("")} aria-label="Dismiss"><X size={16}/></button></div>}
        {paymentReviewNotice && <div className="payment-success"><CheckCircle2 size={18}/><span>{paymentReviewNotice}</span></div>}
        <div className="metrics-grid">
          <div className="metric-card"><small>Pending payments</small><b>{paymentRequests.filter(item => item.status === "PENDING").length}</b></div>
          <div className="metric-card"><small>All requests loaded</small><b>{paymentRequests.length}</b></div>
        </div>
        <div className="history-list">
          {paymentReviewBusy && paymentRequests.length === 0 ? <div className="empty-state"><LoaderCircle className="spin" size={24}/><span>Loading payment requests…</span></div>
          : paymentRequests.length === 0 ? <div className="empty-state"><Wallet size={28}/><b>No payment requests found</b><span>When a user submits a payment, it will appear here after refreshing.</span></div>
          : paymentRequests.map(item => <div className="history-row payment-review-row" key={item.id}>
            <div className="payment-review-details">
              <b>Request #{item.id} · GH₵{Number(item.amount_ghs || 0).toLocaleString("en-GH", {minimumFractionDigits: 2, maximumFractionDigits: 2})}</b>
              <small>{item.display_name || "User"} · {item.email || "Phone account"} · Package: {item.package_id}</small>
              <small>Method: {item.payment_method} · Sender: {item.payer_phone}</small>
              <small>Transaction reference: <strong>{item.transaction_reference}</strong></small>
              {item.payment_proof_data && <a className="receipt-preview-link" href={item.payment_proof_data} target="_blank" rel="noreferrer">View uploaded receipt image{item.payment_proof_name ? ` · ${item.payment_proof_name}` : ""}</a>}
              <small>Submitted: {item.created_at ? new Date(item.created_at).toLocaleString() : "Date unavailable"}</small>
              <small>Status: <strong>{item.status}</strong>{item.reviewer_note ? ` · ${item.reviewer_note}` : ""}</small>
            </div>
            {item.status === "PENDING" ? <div className="payment-review-actions">
              <button type="button" className="button button-primary" disabled={paymentReviewAction !== null} onClick={() => reviewPayment(item.id, "approve")}>{paymentReviewAction === `${item.id}-approve` ? <LoaderCircle className="spin" size={15}/> : <CheckCircle2 size={15}/>} Approve</button>
              <button type="button" className="button button-secondary" disabled={paymentReviewAction !== null} onClick={() => reviewPayment(item.id, "reject")}>{paymentReviewAction === `${item.id}-reject` ? <LoaderCircle className="spin" size={15}/> : <X size={15}/>} Reject</button>
            </div> : null}
          </div>)}
        </div>
      </section>}
      { ["super_admin", "admin", "sub_admin"].includes(authUser.role) && <section className="panel staff-panel"><div className="panel-heading"><div><span className="step-label">REFERRAL PERFORMANCE</span><h2>Referred users & package ledger</h2><p>Use your personal referral link to invite users and track their approved package purchases.</p></div></div><div className="copy-row"><label>Your referral link<input aria-label="Your referral link" readOnly value={referralUrl(authUser.referral_code)} onFocus={e=>e.target.select()}/></label><button type="button" className="button button-primary" onClick={()=>copyReferral(authUser.referral_code)} disabled={!authUser.referral_code}><Copy size={16}/> Copy My Referral Link</button></div>{!authUser.referral_code && <small className="muted">A referral code has not been assigned to this account yet. Contact the Super Admin.</small>}{authUser.role === "sub_admin" && <div className="metrics-grid"><div className="metric-card"><small>Today's Total Commission</small><b>GH₵{Number(ledger?.today_commission||0).toFixed(2)}</b></div><div className="metric-card"><small>All-Time Commission</small><b>GH₵{Number(ledger?.all_time_commission||0).toFixed(2)}</b></div></div>}<div className="history-list">{(ledger?.items||[]).length === 0 ? <div className="empty-state"><b>No approved referred package purchases yet</b></div> : (ledger?.items||[]).map((item,i)=><div className="history-row" key={`${item.reference||i}-${i}`}><div><b>{item.user_name} · {item.package_id} · GH₵{Number(item.deposit_amount).toFixed(2)}</b><small>{item.email || "No email"} · {item.phone||"No phone"}</small><small>Purchased: {item.created_at ? new Date(item.created_at).toLocaleString("en-GB", {hour12:true}) : "Date unavailable"}</small></div>{authUser.role === "sub_admin" && <strong>GH₵{Number(item.commission).toFixed(2)}</strong>}</div>)}</div></section>}
      {authUser.role === "super_admin" && <section className="panel staff-panel payment-settings-panel"><div className="panel-heading"><div><span className="step-label">SUPER ADMIN ONLY</span><h2>Manual Payment Settings</h2><p>Update the receiving name and number/account shown to users. Changes apply to future package checkouts.</p></div></div><form className="payment-form" onSubmit={savePaymentConfig}>{[{key:"mtn_momo",title:"MTN MoMo"},{key:"telecel_cash",title:"Telecel Cash"},{key:"bank_transfer",title:"Bank Transfer"}].map(method=><fieldset className="payment-setting-card" key={method.key}><legend>{method.title}</legend><label>Receiving name<input required value={paymentConfigDraft[method.key]?.recipient_name || ""} onChange={e=>setPaymentConfigDraft(v=>({...v,[method.key]:{...(v[method.key]||{}),recipient_name:e.target.value}}))}/></label><label>{method.key === "bank_transfer" ? "Account number" : "Receiving number"}<input required value={paymentConfigDraft[method.key]?.recipient_number || paymentConfigDraft[method.key]?.account_number || ""} onChange={e=>setPaymentConfigDraft(v=>({...v,[method.key]:{...(v[method.key]||{}),recipient_number:e.target.value,account_number:e.target.value}}))}/></label>{method.key === "bank_transfer" && <><label>Account name<input value={paymentConfigDraft.bank_transfer?.account_name || ""} onChange={e=>setPaymentConfigDraft(v=>({...v,bank_transfer:{...(v.bank_transfer||{}),account_name:e.target.value}}))}/></label><label>Branch (optional)<input value={paymentConfigDraft.bank_transfer?.branch || ""} onChange={e=>setPaymentConfigDraft(v=>({...v,bank_transfer:{...(v.bank_transfer||{}),branch:e.target.value}}))}/></label></>}</fieldset>)}<button className="button button-primary full-button" disabled={paymentConfigSaving}>{paymentConfigSaving ? "Saving settings…" : "Save manual payment settings"}</button></form>{paymentConfigNotice && <div className="payment-success">{paymentConfigNotice}</div>}</section>}

      {authUser.role === "super_admin" && <section className="panel staff-panel"><div className="panel-heading"><div><span className="step-label">SUPER ADMIN ONLY</span><h2>Package Payment History Archive</h2><p>Archive older package payment requests without deleting the commission ledger.</p></div></div><div className="copy-row"><label>Archive records older than (days)<input type="number" min="1" max="36500" value={archiveDays} onChange={e=>setArchiveDays(e.target.value)}/></label><button className="button button-primary" onClick={archivePackageHistory} disabled={archiveBusy}>{archiveBusy ? "Archiving…" : "Archive older package history"}</button></div>{archiveNotice && <div className="payment-success">{archiveNotice}</div>}</section>}

      <nav className="tabs">
        <button className={activeTab === "payments" ? "tab active" : "tab"} onClick={() => setActiveTab("payments")}><Wallet size={17}/> Packages & Payment</button>
        <button className={activeTab === "scan" ? "tab active" : "tab"} disabled={!access?.unlocked} onClick={() => setActiveTab("scan")}><ScanLine size={17}/> Scan & Predict</button>
        <button className={activeTab === "tracker" ? "tab active" : "tab"} disabled={!access?.unlocked} onClick={() => { setActiveTab("tracker"); refreshTracker(); }}><Activity size={17}/> Live Tracker <span className="count">{trackerMatches.filter(m => m.status === "LIVE").length}</span></button>
      <button className={activeTab === "history" ? "tab active" : "tab"} disabled={!access?.unlocked} onClick={() => { setActiveTab("history"); refreshHistory(); }}><History size={17}/> Match History <span className="count">{history.length}</span></button>
      </nav>

      {error && <div className="alert"><AlertTriangle size={18}/><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss"><X size={16}/></button></div>}

      {activeTab === "payments" && !access?.free_staff_access ? <section className="panel payment-panel">
        <div className="panel-heading"><div><span className="step-label">MANUAL PAYMENT</span><h2>Choose your prediction package</h2><p>Choose a package and tap its Buy button to reveal payment options. Scan access opens only after staff approval.</p></div><div className="heading-icon"><Wallet/></div></div>
        <div className="package-grid package-grid-six">{packages.map((pkg, index) => <article key={pkg.id} className={`package-card package-card-rich package-theme-${index} ${selectedPackage === pkg.id ? "selected" : ""}`}><span className="package-eyebrow">{["STARTER","SMART PICK","POPULAR","PRO CHOICE","ELITE","VIP ACCESS"][index] || "PREDICTION PACKAGE"}</span><h3>{pkg.name}</h3><b>GH₵{Number(pkg.price_ghs).toLocaleString("en-GH")}</b><small>{pkg.unlimited ? "Unlimited predictions" : `${pkg.credits} predictions`}</small><button type="button" className="button button-primary package-buy" onClick={() => { setSelectedPackage(pkg.id); setPayForm(v => ({...v, package_id:pkg.id})); setPayMessage(""); }}>{`Buy ${pkg.name}`}</button></article>)}</div>
        {selectedPackage && <div className="package-checkout"><div className="checkout-title"><div><span className="step-label">CHECKOUT</span><h3>{`Buy ${(packages.find(p => p.id === selectedPackage)?.name) || selectedPackage}`}</h3><p>Pay exactly GH₵{Number(packages.find(p => p.id === selectedPackage)?.price_ghs || 0).toLocaleString("en-GH")} using one of the manual options below.</p></div><button type="button" className="button button-secondary" onClick={() => setSelectedPackage(null)}>Close</button></div>
          <div className="payment-method-cards">
            <button type="button" className={payForm.payment_method === "MTN MoMo" ? "payment-method selected mtn" : "payment-method mtn"} onClick={() => setPayForm(v => ({...v, payment_method:"MTN MoMo"}))}><span className="payment-logo mtn-logo"><b>MTN</b></span><strong>MTN MoMo</strong><small>Mobile Money</small></button>
            <button type="button" className={payForm.payment_method === "Telecel Cash" ? "payment-method selected telecel" : "payment-method telecel"} onClick={() => setPayForm(v => ({...v, payment_method:"Telecel Cash"}))}><span className="payment-logo telecel-logo"><b>t</b></span><strong>Telecel Cash</strong><small>Mobile Money</small></button>
            <button type="button" className={payForm.payment_method === "Bank Transfer" ? "payment-method selected bank" : "payment-method bank"} onClick={() => setPayForm(v => ({...v, payment_method:"Bank Transfer"}))}><span className="payment-logo bank-logo"><Building2 size={30}/></span><strong>Bank Transfer</strong><small>Bank account</small></button>
          </div>
          <div className="payment-instructions"><h3><CreditCard size={18}/> Send your payment</h3>
            {payForm.payment_method === "MTN MoMo" ? <><p>Send GH₵{Number(packages.find(p => p.id === selectedPackage)?.price_ghs || 0).toLocaleString("en-GH")} to <b>{paymentConfig.mtn_momo?.recipient_number || "MTN number not configured"}</b>{paymentConfig.mtn_momo?.recipient_name ? ` (${paymentConfig.mtn_momo.recipient_name})` : ""}.</p><button type="button" className="button button-secondary button-small" onClick={() => copyPaymentDetail(paymentConfig.mtn_momo?.recipient_number, "MTN MoMo number")}><Copy size={14}/> Copy number</button></> : payForm.payment_method === "Telecel Cash" ? <><p>Send GH₵{Number(packages.find(p => p.id === selectedPackage)?.price_ghs || 0).toLocaleString("en-GH")} to <b>{paymentConfig.telecel_cash?.recipient_number || "Telecel Cash number not configured"}</b>{paymentConfig.telecel_cash?.recipient_name ? ` (${paymentConfig.telecel_cash.recipient_name})` : ""}.</p><button type="button" className="button button-secondary button-small" onClick={() => copyPaymentDetail(paymentConfig.telecel_cash?.recipient_number, "Telecel Cash number")}><Copy size={14}/> Copy number</button></> : <><p>Transfer GH₵{Number(packages.find(p => p.id === selectedPackage)?.price_ghs || 0).toLocaleString("en-GH")} to <b>{paymentConfig.bank_transfer?.account_number || "Bank account not configured"}</b>{paymentConfig.bank_transfer?.account_name ? ` · ${paymentConfig.bank_transfer.account_name}` : ""}{paymentConfig.bank_transfer?.recipient_name ? ` · ${paymentConfig.bank_transfer.recipient_name}` : ""}{paymentConfig.bank_transfer?.branch ? ` · ${paymentConfig.bank_transfer.branch}` : ""}.</p><button type="button" className="button button-secondary button-small" onClick={() => copyPaymentDetail(paymentConfig.bank_transfer?.account_number, "Bank account number")}><Copy size={14}/> Copy account number</button></>}
          </div>
          <form className="payment-form" onSubmit={submitPayment}><label>Sender phone number / account contact<input required minLength="8" maxLength="25" value={payForm.payer_phone} onChange={e => setPayForm(v => ({...v, payer_phone:e.target.value}))} placeholder="Sender phone or account"/></label><label>Transaction reference<input required minLength="3" maxLength="120" value={payForm.transaction_reference} onChange={e => setPayForm(v => ({...v, transaction_reference:e.target.value}))} placeholder="Transaction ID/reference"/></label><label className="receipt-upload">Payment receipt image (optional)<input type="file" accept="image/*" onChange={e => { const file=e.target.files?.[0]; if (!file) {setPayForm(v=>({...v,payment_proof_data:"",payment_proof_name:""}));return;} if(file.size>1500000){setError("Receipt image must be 1.5 MB or smaller.");e.target.value="";return;} const reader=new FileReader(); reader.onload=()=>setPayForm(v=>({...v,payment_proof_data:String(reader.result||""),payment_proof_name:file.name})); reader.readAsDataURL(file); }}/><small>{payForm.payment_proof_name ? `Attached: ${payForm.payment_proof_name}` : "Optional JPG or PNG, max 1.5 MB"}</small></label><button className="button button-primary full-button" disabled={payBusy}>{payBusy ? <LoaderCircle className="spin" size={17}/> : <Wallet size={17}/>} Submit payment for review</button></form>
        </div>}
        {payMessage && <div className="payment-success"><CheckCircle2 size={18}/><span>{payMessage} {access?.pending_payments ? "Current status: pending review." : ""}</span></div>}
        <div className="access-status"><b>Access status:</b> {access?.unlocked ? `${access.unlimited ? "VIP unlimited access" : `${access.credits_remaining} predictions remaining`} · ${access.package_name || "Active package"}`.replace(" · $", " · ") : access?.pending_payments ? "Payment submitted — waiting for approval." : "Locked until a package payment is approved."}</div>
      </section> : activeTab === "tracker" ? <section className="panel tracker-panel">
        <div className="panel-heading"><div><span className="step-label">OPTIONAL TOOL</span><h2>Live match tracker</h2><p>Track a match you are watching. Scores and clocks are manual unless a verified live feed is connected.</p></div><div className="heading-icon"><Activity/></div></div>
        {!trackerDismissed && <div className="tracker-intro"><div><b>Want to skip tracking?</b><span>You can go straight to screenshot scanning and prediction at any time.</span></div><button className="button button-secondary" onClick={skipTracker}>Skip tracker <ArrowRight size={15}/></button></div>}
        <form className="tracker-form" onSubmit={addTrackerMatch}>
          <label>Home team<input required maxLength="100" value={trackerForm.home_team} onChange={e => setTrackerForm(v => ({...v, home_team:e.target.value}))} placeholder="Home team"/></label>
          <label>Away team<input required maxLength="100" value={trackerForm.away_team} onChange={e => setTrackerForm(v => ({...v, away_team:e.target.value}))} placeholder="Away team"/></label>
          <label>Home score<input type="number" min="0" max="99" required value={trackerForm.home_score} onChange={e => setTrackerForm(v => ({...v, home_score:e.target.value}))}/></label>
          <label>Away score<input type="number" min="0" max="99" required value={trackerForm.away_score} onChange={e => setTrackerForm(v => ({...v, away_score:e.target.value}))}/></label>
          <label>Match clock<input required maxLength="30" value={trackerForm.match_clock} onChange={e => setTrackerForm(v => ({...v, match_clock:e.target.value}))} placeholder="e.g. 04:32"/></label>
          <label>Status<select value={trackerForm.status} onChange={e => setTrackerForm(v => ({...v, status:e.target.value}))}><option value="LIVE">Live / In play</option><option value="UPCOMING">Upcoming</option><option value="FINISHED">Finished</option></select></label>
          <button className="button button-primary tracker-add" disabled={trackerBusy}>{trackerBusy ? <LoaderCircle className="spin" size={16}/> : <Activity size={16}/>} Add match</button>
        </form>
        <div className="tracker-list">
          {trackerMatches.length === 0 ? <div className="empty-state"><Activity size={30}/><b>No tracked matches yet</b><span>Add a match above and update its score as you watch.</span></div> : trackerMatches.map(match => <TrackerCard key={match.id} match={match} update={updateTrackerMatch} remove={removeTrackerMatch} analyse={() => { setForm(old => ({...old, home_team:match.home_team, away_team:match.away_team, observed_score:`${match.home_score} - ${match.away_score}`, observed_clock:match.match_clock})); setActiveTab("scan"); }}/>) }
        </div>
        <div className="tracker-footnote"><AlertTriangle size={15}/> No automatic live feed is connected yet. Only mark a match LIVE when you have confirmed it is in play.</div>
      </section> : activeTab === "scan" ? <div className="content-grid">
        <section className="panel scan-panel">
          <div className="panel-heading"><div><span className="step-label">STEP 01</span><h2>Scan & Predict</h2><p>Upload one screenshot to predict every visible virtual football fixture.</p></div><div className="heading-icon"><ScanLine/></div></div>
          <label className="market-picker">Prediction market<select value={selectedMarket} onChange={e => setSelectedMarket(e.target.value)}><option value="1X2">1X2 — Home / Draw / Away</option><option value="DOUBLE_CHANCE">Double Chance — 1X / X2 / 12</option><option value="OVER_UNDER_1_5">Over/Under 1.5 Goals</option><option value="OVER_UNDER_2_5">Over/Under 2.5 Goals</option><option value="OVER_UNDER_3_5">Over/Under 3.5 Goals</option><option value="BTTS">Both Teams to Score — Yes/No</option><option value="CORRECT_SCORE">Correct Score — exact score options</option></select><small>Correct-score picks are illustrative options, not guaranteed outcomes.</small></label>
          <div className="upload-zone">
            {imageUrl ? <div className="preview-wrap"><img src={imageUrl} alt="Selected match screenshot"/><button className="remove-image" onClick={() => { setImage(null); setOcrText(""); }} aria-label="Remove image"><X size={16}/></button></div> :
              <div className="upload-placeholder"><div className="upload-icon"><FileImage size={27}/></div><b>Upload a virtual teams screenshot</b><span>All detected fixtures will be predicted individually</span><div className="upload-actions"><button className="button button-secondary" onClick={() => fileRef.current?.click()}><Upload size={16}/> Upload image</button><button className="button button-ghost" onClick={() => { if (fileRef.current) { fileRef.current.setAttribute("capture", "environment"); fileRef.current.click(); } }}><Camera size={16}/> Use camera</button></div><small>PNG, JPG or WEBP · AI document parser with local OCR fallback</small></div>}
            <input ref={fileRef} className="hidden-input" type="file" accept="image/*" onChange={e => pickFile(e.target.files?.[0])}/>
          </div>
          {image && <button className="button button-primary full-button" onClick={scanImage} disabled={scanning}>{scanning ? <><LoaderCircle className="spin" size={17}/> Reading screenshot {scanProgress}%</> : <><ScanLine size={17}/> Scan screenshot with AI parser</>}</button>}
          {ocrText && <div className="ocr-box"><div className="ocr-title"><CheckCircle2 size={15}/> OCR text captured <span>Review fields below</span></div><details><summary>Show extracted text</summary><pre>{ocrText}</pre></details></div>}
          <div className="privacy-note"><ShieldCheck size={16}/><span>Image processing happens in your browser. The image itself is not uploaded to the API.</span></div>
        </section>

      </div> : <section className="panel history-panel">
        <div className="panel-heading"><div><span className="step-label">YOUR RECORDS</span><h2>Historical match results</h2><p>Settle records after the actual final result is known.</p></div><div className="heading-icon"><History/></div></div>
        <div className="metrics-grid">
          <div className="metric"><span>Settled matches</span><b>{metrics?.settled_matches ?? "—"}</b></div>
          <div className="metric"><span>Top-pick hit rate</span><b>{metrics?.top_pick_hit_rate == null ? "—" : pct(metrics.top_pick_hit_rate)}</b></div>
          <div className="metric"><span>Multiclass Brier score</span><b>{metrics?.multiclass_brier_score == null ? "—" : metrics.multiclass_brier_score.toFixed(3)}</b></div>
        </div>
        {metrics?.message && <p className="metric-note">{metrics.message}</p>}
        <HistoryList history={history} settleId={settleId} setSettleId={setSettleId} settleScore={settleScore} setSettleScore={setSettleScore} settle={settle}/>
      </section>}

      {result && activeTab === "scan" && <section className="panel result-panel"><div className="disclaimer"><AlertTriangle size={18}/><span>Predictions are generated individually from detected teams and available odds. OCR may misread team names or odds; verify detected fixtures.</span></div>{scanResults.length > 0 && <div className="scan-results-list"><h2>Screenshot scan results ({scanResults.length})</h2>{scanResults.map((item,i)=><article className="market-result" key={`${item.id}-${i}`}><h3>{item.home_team} vs {item.away_team}</h3><p className="scan-pick"><b>PREDICTION: {item.random_pick || `${item.home_team} ${item.selected_outcome === "1" ? "HOME WIN (1)" : item.selected_outcome === "X" ? "DRAW (X)" : "AWAY WIN (2)"}`}</b></p>{item.needs_review && <p className="scan-review-warning">Please verify this fixture and its odds: some details were unclear or came from fallback OCR.</p>}{selectedMarket === "CORRECT_SCORE" && <div className="correct-score-options"><b>Correct score options</b><div className="score-chip-row">{(item.correct_score_options || ["1-0","2-0","2-1","1-1","0-0","0-1","1-2","0-2"]).map(score => <span className={score === item.correct_score_pick ? "score-chip selected" : "score-chip"} key={score}>{score}</span>)}</div></div>}<p><b>Detected 1X2 odds:</b> Home {item.detected_odds?.[0] ?? "Not detected"} · Draw {item.detected_odds?.[1] ?? "Not detected"} · Away {item.detected_odds?.[2] ?? "Not detected"}</p></article>)}</div>}
        <div className="result-header"><div><span className="step-label">ANALYSIS COMPLETE · #{result.id}</span><h2>Probability snapshot</h2><p>{result.home_team} vs {result.away_team}</p></div><span className="estimate-badge"><Activity size={14}/> ESTIMATE ONLY</span></div>
        <div className="prob-grid">
          <Probability label="Home win" value={result.prediction.home_win} tone="green"/>
          <Probability label="Draw" value={result.prediction.draw} tone="blue"/>
          <Probability label="Away win" value={result.prediction.away_win} tone="purple"/>
        </div>
        <OpportunityRankings prediction={result.prediction} />
        <div className="secondary-probs"><div><span>Over 2.5 goals</span><b>{pct(result.prediction.over_2_5)}</b></div><div><span>Both teams score</span><b>{pct(result.prediction.both_teams_score)}</b></div></div>
        <div className="method-note"><div><b>Method</b><span>{result.prediction.method}</span></div><div><b>Historical sample</b><span>{result.prediction.historical_sample_size} settled matches</span></div><div><b>Evidence level</b><span>{result.prediction.confidence_label}</span></div></div>
        <div className="disclaimer"><AlertTriangle size={18}/><span>{result.prediction.disclaimer} If no odds were supplied, the 1X2 estimate uses a broad fallback prior until enough of your own historical results are recorded.</span></div>
        <button className="button button-secondary" onClick={() => { setResult(null); setForm(blank); setImage(null); setOcrText(""); }}>Scan another screenshot</button>
      </section>}

      <section className="panel how-works"><div className="panel-heading"><div><span className="step-label">QUICK GUIDE</span><h2>HOW THE APP WORKS</h2><p>Follow these steps to request access and use the screenshot scanner.</p></div></div><div className="how-grid">{[{n:"1",title:"Choose a Package",body:"Browse packages on the Packages page and pick one that fits your budget. Each package has a set number of predictions."},{n:"2",title:"Upload a Screenshot",body:"Take a screenshot from SportyBet or a similar app. Open Scan & Predict and upload the image."},{n:"3",title:"See Your Picks",body:"The scanner reads visible fixture text and odds and displays a market selection. Random picks are illustrative, not guaranteed forecasts."},{n:"4",title:"Use the Results Carefully",body:"Review team names, market and odds yourself. Never stake money you cannot afford to lose."},{n:"5",title:"Buy Another Package",body:"When your credits run out, return to Packages & Payment and submit a new manual payment for approval."},{n:"6",title:"Track Your Package",body:"Check your account access status and remaining predictions in the app."},{n:"7",title:"Contact Support",body:"Use the support contact provided by the site operator if you need help with payments, scans or account access."}].map(step=><article className="how-step" key={step.n}><span>{step.n}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></article>)}</div></section>
      <footer><div className="footer-brand"><span className="brand-mark small"><Activity size={16}/></span> VIRTUAL<span className="accent">IQ</span></div><span>Probabilities are estimates, never guarantees.</span><span>Independent tool · No direct SportyBet connection</span></footer>
    </main>
  </div>;
}


function OpportunityRankings({ prediction }) {
  const choices = [
    { label: "Home win", value: prediction.home_win, group: "1X2" },
    { label: "Draw", value: prediction.draw, group: "1X2" },
    { label: "Away win", value: prediction.away_win, group: "1X2" },
    { label: "Over 2.5 goals", value: prediction.over_2_5, group: "Goals" },
    { label: "Both teams to score — Yes", value: prediction.both_teams_score, group: "Goals" },
  ].filter(item => Number.isFinite(item.value)).sort((a, b) => b.value - a.value);
  const sample = prediction.historical_sample_size || 0;
  const evidence = sample < 8 ? "Fallback estimate · very limited evidence" : sample < 30 ? `Limited evidence · ${sample} settled matches` : `Historical sample · ${sample} settled matches`;
  return <section className="opportunity-panel" aria-label="Strongest estimated opportunities">
    <div className="opportunity-heading"><div><span className="step-label">OPPORTUNITY RADAR</span><h3>Strongest estimated opportunities</h3><p>Ranked by estimated probability across the markets currently available.</p></div><span className="radar-icon"><Target size={19}/></span></div>
    <div className="opportunity-evidence"><AlertTriangle size={15}/><span>{evidence}. Rankings show probability, not guaranteed outcomes or proven betting value.</span></div>
    <div className="opportunity-list">{choices.map((item, index) => <div className={`opportunity-row ${index === 0 ? "top-opportunity" : ""}`} key={item.label}>
      <span className="opportunity-rank">{index + 1}</span><div className="opportunity-name"><b>{item.label}</b><small>{item.group} market</small><div className="opportunity-bar"><i style={{ width: `${Math.max(0, Math.min(100, item.value * 100))}%` }}/></div></div><strong>{pct(item.value)}</strong>
    </div>)}</div>
    <p className="opportunity-footnote">Only the 1X2 probabilities can use supplied odds. Goal-market estimates currently rely on the app’s historical sample or fallback prior; they are not verified live-feed predictions.</p>
  </section>;
}

function TrackerCard({ match, update, remove, analyse }) {
  const [home, setHome] = useState(String(match.home_score));
  const [away, setAway] = useState(String(match.away_score));
  const [clock, setClock] = useState(match.match_clock);
  const [status, setStatus] = useState(match.status);
  useEffect(() => { setHome(String(match.home_score)); setAway(String(match.away_score)); setClock(match.match_clock); setStatus(match.status); }, [match.home_score, match.away_score, match.match_clock, match.status]);
  return <article className="tracker-card">
    <div className="tracker-card-top"><span className={`tracker-status ${match.status.toLowerCase()}`}>{match.status === "LIVE" && <i/>}{match.status === "LIVE" ? "LIVE / IN PLAY" : match.status}</span><small>Updated {new Date(match.updated_at).toLocaleString()}</small></div>
    <div className="tracker-score"><b>{match.home_team}</b><strong>{match.home_score} <span>:</span> {match.away_score}</strong><b>{match.away_team}</b></div>
    <div className="tracker-clock"><Clock3 size={14}/>{match.match_clock}</div>
    <div className="tracker-edit"><label>Home<input type="number" min="0" max="99" value={home} onChange={e=>setHome(e.target.value)}/></label><label>Away<input type="number" min="0" max="99" value={away} onChange={e=>setAway(e.target.value)}/></label><label>Clock<input value={clock} maxLength="30" onChange={e=>setClock(e.target.value)}/></label><label>Status<select value={status} onChange={e=>setStatus(e.target.value)}><option value="LIVE">Live</option><option value="UPCOMING">Upcoming</option><option value="FINISHED">Finished</option></select></label><button className="button button-secondary button-small" onClick={()=>update(match,{home_score:home,away_score:away,match_clock:clock,status})}>Save update</button><button className="button button-ghost button-small" onClick={analyse}>Analyse</button><button className="button button-ghost button-small" onClick={()=>remove(match)}>Remove</button></div>
  </article>;
}

function AuthScreen({ mode, setMode, form, setForm, onSubmit, busy, error }) {
  const register = mode === "register";
  function update(key, value) { setForm(old => ({ ...old, [key]: value })); }
  return <div className="auth-shell">
    <div className="auth-art"><div className="auth-glow"/><div className="auth-logo"><Activity size={27}/></div><div className="eyebrow"><Sparkles size={14}/> INSTANT VIRTUAL MATCH ANALYTICS</div><h1>Your match.<br/><span>Your data.<br/>Clearer probabilities.</span></h1><p>Scan virtual match screenshots, review uncertain estimates, and track real outcomes over time.</p><div className="auth-points"><span><ScanLine size={15}/> Screenshot OCR</span><span><History size={15}/> Personal history</span><span><ShieldCheck size={15}/> Private account records</span></div></div>
    <div className="auth-side"><div className="auth-card">
      <div className="auth-card-brand"><span className="brand-mark"><Activity size={21}/></span><div><b>VIRTUAL<span className="accent">IQ</span></b><small>INSTANT MATCH ANALYTICS</small></div></div>
      <div className="auth-title"><h2>{register ? "Create your account" : "Welcome back"}</h2><p>{register ? "Create an account to save your scans and results." : "Log in to continue to your analysis workspace."}</p></div>
      {error && <div className="alert auth-alert"><AlertTriangle size={16}/><span>{error}</span></div>}
      <form onSubmit={onSubmit} className="auth-form">
        {register && <label>Display name<input required minLength="2" maxLength="80" autoComplete="name" placeholder="Your name" value={form.display_name} onChange={e => update("display_name", e.target.value)}/></label>}
        <label>Email address / phone number<input required type="text" inputMode="text" maxLength="254" autoComplete="username" placeholder="you@example.com or 0241234567" value={form.email} onChange={e => update("email", e.target.value)}/><small className="password-hint">Use an email address or a phone number you can use to log in.</small></label>
        <label>Password<input required type="password" minLength="5" maxLength="128" autoComplete={register ? "new-password" : "current-password"} placeholder={register ? "At least 5 characters" : "Enter your password"} value={form.password} onChange={e => update("password", e.target.value)}/></label>
        {register && <label>Confirm password<input required type="password" minLength="5" maxLength="128" autoComplete="new-password" placeholder="Re-enter your password" value={form.confirm_password || ""} onChange={e => update("confirm_password", e.target.value)}/></label>}
        {register && <label>Referral code (required)<input required minLength="1" maxLength="40" autoComplete="off" placeholder="Enter a valid staff referral code" value={form.referral_code || ""} onChange={e => update("referral_code", e.target.value.toUpperCase())} readOnly={Boolean(new URLSearchParams(window.location.search).get("ref"))}/>{new URLSearchParams(window.location.search).get("ref") ? <small className="password-hint">Referral code from your invite link is locked. The code must be valid.</small> : <small className="password-hint">A valid Super Admin, Admin, or Sub-Admin referral code is required to register.</small>}</label>}
        {register && <small className="password-hint">Use at least 5 characters. A longer, unique password is safer.</small>}
        <button className="button button-primary full-button auth-submit" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={17}/> Please wait…</> : register ? "Create account" : "Log in"} <ArrowRight size={17}/></button>
      </form>
      <div className="auth-switch">{register ? "Already have an account?" : "New here?"} <button onClick={() => { setMode(register ? "login" : "register"); }} type="button">{register ? "Log in" : "Create account"}</button></div>
      <div className="auth-legal"><ShieldCheck size={14}/> Your match history is separated by account. High-confidence probability estimates — outcomes are not guaranteed.</div>
    </div></div>
  </div>;
}

function Probability({ label, value, tone }) {
  return <div className={`prob-card ${tone}`}><div className="prob-top"><span>{label}</span><Target size={15}/></div><strong>{pct(value)}</strong><div className="progress"><i style={{ width: pct(value) }}/></div></div>;
}
function HistoryList({ history, settleId, setSettleId, settleScore, setSettleScore, settle }) {
  if (!history.length) return <div className="empty-state"><History size={28}/><b>No saved matches yet</b><span>Your scans and predictions will appear here.</span></div>;
  return <div className="history-list">{history.map(item => <article className="history-item" key={item.id}>
    <div className="history-main"><div className="history-match"><b>{item.home_team}</b><span>vs</span><b>{item.away_team}</b></div><small>{new Date(item.created_at).toLocaleString()} · {item.source}</small></div>
    <div className="history-picks"><span>H {pct(item.predicted_home)}</span><span>D {pct(item.predicted_draw)}</span><span>A {pct(item.predicted_away)}</span></div>
    <div className="history-state">{item.settled ? <span className="settled"><CheckCircle2 size={14}/> {item.settled_home_goals} - {item.settled_away_goals}</span> : <button className="button button-small" onClick={() => setSettleId(settleId === item.id ? null : item.id)}>Record result</button>}</div>
    {settleId === item.id && <div className="settle-form"><label>Home goals<input type="number" min="0" max="99" value={settleScore.home} onChange={e => setSettleScore(s => ({...s, home:e.target.value}))}/></label><label>Away goals<input type="number" min="0" max="99" value={settleScore.away} onChange={e => setSettleScore(s => ({...s, away:e.target.value}))}/></label><button className="button button-primary button-small" onClick={() => settle(item.id)}>Save final score</button></div>}
  </article>)}</div>;
}

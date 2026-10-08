"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Camera, Check, CheckCircle2, ChevronDown, Cloud, Compass, Eye, ImagePlus, Images, Info, LoaderCircle, RefreshCw, ScanLine, Sparkles, Trophy, Upload, UserRound, X } from "lucide-react";
import type { AppState, Photo, Profile, Rank } from "@/lib/types";

type View = "home" | "capture" | "collection" | "guide" | "result";
type PendingPhoto = { userId: string; title: string; image: string; sampleKey?: string; requestId: string };
const ranks: Rank[] = ["S", "A", "B", "C", "F"];
const rankDescriptions = [
  { rank: "S", range: "90–100", name: "未知との遭遇", description: "思わず二度見する、圧倒的な神秘。" },
  { rank: "A", range: "75–89", name: "ただならぬ気配", description: "偶然とは思えない、不思議な存在感。" },
  { rank: "B", range: "60–74", name: "小さなミステリー", description: "想像力をくすぐる、意味ありげな一枚。" },
  { rank: "C", range: "40–59", name: "日常のほころび", description: "いつもの景色の中に、かすかな違和感。" },
  { rank: "F", range: "0–39", name: "平穏な日常", description: "今日はこの世界も、落ち着いているようです。" },
];
const axes = [{ key: "atmosphere", name: "神秘的な雰囲気", en: "ATMOSPHERE" }, { key: "light", name: "光と自然の表情", en: "LIGHT & NATURE" }, { key: "symbolism", name: "象徴・都市伝説の連想", en: "SYMBOLISM" }, { key: "story", name: "物語を感じる構図", en: "STORY" }] as const;
const navigation: { view: View; label: string; icon: typeof Compass }[] = [
  { view: "home", label: "TOP", icon: Compass },
  { view: "capture", label: "写真を追加", icon: Camera },
  { view: "collection", label: "コレクション", icon: Images },
  { view: "guide", label: "評価ガイド", icon: Sparkles },
];
const SESSION_KEY = "oddshot.profile";
const EMPTY: AppState = { profiles: [], photos: [], ranking: [], ai: { mode: "demo", provider: "OpenAI Decisions API", model: "gpt-6-luna", ready: true } };
const formatDate = (date: string) => new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit" }).format(new Date(date));
function rememberedProfile(): string | null { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } }
function rememberProfile(id: string | null) { try { if (id) sessionStorage.setItem(SESSION_KEY, id); else sessionStorage.removeItem(SESSION_KEY); } catch { /* The selected profile remains in this tab's state. */ } }

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } }); }
  catch { throw new Error("接続できませんでした。もう一度お試しください。"); }
  const body = await response.json().catch(() => { throw new Error("応答を受け取れませんでした。少し待ってから、もう一度お試しください。"); });
  if (!response.ok) throw new Error(body.error || "処理に失敗しました。もう一度お試しください。");
  return body;
}

function Avatar({ profile, size = "normal" }: { profile?: Profile; size?: string }) {
  return <span className={`avatar ${size}`} style={{ backgroundColor: profile?.color || "#D5F466" }} aria-hidden="true">{profile?.nickname.slice(0, 1) || "?"}</span>;
}

function RankBadge({ rank, large = false }: { rank: Rank; large?: boolean }) {
  return <span className={`rank-badge rank-${rank} ${large ? "large" : ""}`}><span className="sr-only">ランク </span>{rank}</span>;
}

function AstralOrbit() {
  return <div className="astral-orbit" aria-hidden="true">
    <svg viewBox="0 0 520 520" fill="none" focusable="false">
      <circle className="orbit-halo" cx="260" cy="260" r="172" />
      <circle className="orbit-ring" cx="260" cy="260" r="154" />
      <ellipse className="orbit-ring orbit-faint" cx="260" cy="260" rx="224" ry="93" transform="rotate(-37 260 260)" />
      <ellipse className="orbit-ring orbit-faint" cx="260" cy="260" rx="204" ry="66" transform="rotate(48 260 260)" />
      <path className="orbit-constellation" d="M117 200 227 135 354 199 392 331 283 387 152 328Z M227 135 283 387 M117 200 392 331" />
      <g className="orbit-stars">
        <path d="m117 187 3 10 10 3-10 3-3 10-3-10-10-3 10-3Z" />
        <path d="m354 184 4 11 11 4-11 4-4 11-4-11-11-4 11-4Z" />
        <path d="m283 374 3 10 10 3-10 3-3 10-3-10-10-3 10-3Z" />
        <circle cx="227" cy="135" r="3" /><circle cx="392" cy="331" r="3" /><circle cx="152" cy="328" r="3" />
      </g>
      <path className="orbit-center" d="m260 233 7 20 20 7-20 7-7 20-7-20-20-7 20-7Z" />
    </svg>
  </div>;
}

function SyncLabel({ photo, drive, retry, retrying = false }: { photo: Photo; drive?: AppState["drive"]; retry?: () => void; retrying?: boolean }) {
  const google = drive?.mode === "google";
  const label = photo.syncStatus === "synced" ? google ? "Drive に同期済み" : "デモ同期済み" : photo.syncStatus === "failed" ? google ? "Drive 同期に失敗" : "デモ同期に失敗" : google ? drive.connected ? "Drive に同期中" : "Drive の連携待ち" : "デモ同期中";
  return <div className={`sync-label ${photo.syncStatus}`} role="status" aria-live="polite">
    {photo.syncStatus === "synced" ? <CheckCircle2 size={16} aria-hidden="true" /> : photo.syncStatus === "failed" || google && !drive.connected ? <Cloud size={16} aria-hidden="true" /> : <LoaderCircle size={16} className="spin" aria-hidden="true" />}
    <span>{label}</span>
    {retry && photo.syncStatus === "failed" && <button className="retry-button" disabled={retrying} onClick={retry}><RefreshCw size={14} className={retrying ? "spin" : ""} aria-hidden="true" />{retrying ? "再試行中" : "再試行"}</button>}
  </div>;
}

function Dialog({ title, children, onClose, wide = false, className = "", dismissDisabled = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string; dismissDisabled?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className={`dialog ${wide ? "wide" : ""} ${className}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!dismissDisabled) onClose(); }} onClick={event => { if (!dismissDisabled && event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-head"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} disabled={dismissDisabled} aria-label={dismissDisabled ? "写真の処理が終わるまで閉じられません" : "閉じる"}><X size={22} aria-hidden="true" /></button></div>
    {children}
  </dialog>;
}

function NicknameForm({ profiles, onSelect, onCreate, submitting, error, selected }: { profiles: Profile[]; onSelect: (profile: Profile) => void; onCreate: (name: string) => void; submitting: boolean; error: string; selected?: Profile }) {
  const [name, setName] = useState("");
  const fieldId = useId();
  function submit(event: FormEvent) { event.preventDefault(); onCreate(name); }
  return <div className="nickname-form">
    <form onSubmit={submit}>
      <label htmlFor={fieldId}>新しいニックネーム</label>
      <div className="name-input-row"><input id={fieldId} placeholder="例：月の探検家" maxLength={20} value={name} onChange={e => setName(e.target.value)} required autoComplete="nickname" disabled={submitting} aria-describedby={`${fieldId}-error`} /><button className="button primary" disabled={submitting}>{submitting ? <LoaderCircle size={19} className="spin" aria-hidden="true" /> : <>はじめる<ArrowRight size={18} aria-hidden="true" /></>}</button></div>
      <p className="form-error" id={`${fieldId}-error`} role="alert">{error}</p>
    </form>
    <div className="returning-head"><span>キミはもしかして</span><span className="tiny-muted">以前の名前を選んで続きから</span></div>
    <div className="profile-options">{profiles.map(p => <button className={`profile-option ${selected?.id === p.id ? "selected" : ""}`} key={p.id} onClick={() => onSelect(p)} disabled={submitting}><Avatar profile={p} size="small" /><span>{p.nickname}</span>{selected?.id === p.id ? <Check size={15} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}</button>)}</div>
    <p className="identity-note">名前の選択だけで参加できます。本人確認は行いません。</p>
  </div>;
}

function PhotoCard({ photo, profile, open }: { photo: Photo; profile?: Profile; open: () => void }) {
  return <button className="photo-card" onClick={open} aria-label={`${photo.title}、ランク${photo.evaluation.rank}、${photo.evaluation.score}点、${photo.evaluation.isDemo ? "デモ採点" : "AI 採点"}。詳細を見る`}>
    <div className="photo-image"><img src={photo.image} alt={photo.title} loading="lazy" /><RankBadge rank={photo.evaluation.rank} /><span className="image-corner"><ArrowUpRight size={20} aria-hidden="true" /></span>{photo.isSample && <span className="sample-tag">DEMO PHOTO</span>}</div>
    <div className="photo-meta"><h3>{photo.title}</h3><span className="photo-score">{photo.evaluation.score}<small> / 100</small></span></div>
    <div className="photo-author"><span><Avatar profile={profile} size="tiny" />{profile?.nickname || "探検家"}</span><time dateTime={photo.createdAt}>{formatDate(photo.createdAt)}</time></div>
    <span className={`photo-evaluation-source ${photo.evaluation.isDemo ? "demo" : "live"}`}><Sparkles size={11} aria-hidden="true" />{photo.evaluation.isDemo ? "デモ採点" : "AI 採点"}</span>
  </button>;
}

function PhotoComposer({ title, onTitleChange, processing, step, preview, isLive, uploadError, canRetry, onRetry, onFile, onSample, requireProfile }: {
  title: string; onTitleChange: (title: string) => void; processing: boolean; step: number; preview: string; isLive: boolean;
  uploadError: string; canRetry: boolean; onRetry: () => void; onFile: (file?: File) => Promise<void>;
  onSample: (key: string) => void; requireProfile: () => boolean;
}) {
  const titleId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  async function choose(file?: File) {
    try { await onFile(file); }
    finally { if (fileInput.current) fileInput.current.value = ""; if (cameraInput.current) cameraInput.current.value = ""; }
  }
  return <div className="photo-composer">
    {processing ? <div className="processing-card" role="status" aria-live="polite">{preview && <img src={preview} alt="採点中の写真" />}<div className="processing-overlay"><span className="scan-frame"><ScanLine size={56} strokeWidth={1} aria-hidden="true" /></span><LoaderCircle size={28} className="spin" aria-hidden="true" /><h2>{["写真を準備しています", "写真の雰囲気を判定しています", "結果を整えています"][step]}</h2><p>{!title.trim() ? isLive ? "写真に合うタイトルも提案しています" : "デモ採点とタイトル候補を準備しています" : isLive ? "写真と評価基準を照らし合わせています" : "デモ採点の流れを体験しています"}</p><div className="processing-dots">{[0, 1, 2].map(n => <span className={step >= n ? "active" : ""} key={n} />)}</div></div></div> : <>
      <div className={`drop-zone ${dragging ? "dragging" : ""}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); void choose(e.dataTransfer.files[0]); }}><div className="upload-illustration"><ImagePlus size={45} strokeWidth={1.2} aria-hidden="true" /><span className="cross-corner top-left" /><span className="cross-corner top-right" /><span className="cross-corner bottom-left" /><span className="cross-corner bottom-right" /></div><h2>その写真に、未知の気配は？</h2><p>ここに写真をドラッグするか、<br className="mobile-only" />下のボタンから選んでください。</p><div className="capture-buttons"><button className="button primary" onClick={() => { if (requireProfile()) cameraInput.current?.click(); }}><Camera size={19} aria-hidden="true" />写真を撮る</button><button className="button secondary" onClick={() => { if (requireProfile()) fileInput.current?.click(); }}><Upload size={18} aria-hidden="true" />写真を選ぶ</button></div><span className="small-note">JPEG / PNG / WebP · 20 MB まで</span><span className="small-note">撮影は対応するスマートフォンで利用できます</span></div>
      <label className="title-label" htmlFor={titleId}>写真のタイトル<span>任意</span></label><input className="title-input" id={titleId} placeholder="空欄なら、写真からタイトルを提案" value={title} maxLength={60} onChange={e => onTitleChange(e.target.value)} aria-describedby={`${titleId}-hint`} /><p className="composer-title-hint" id={`${titleId}-hint`}><Sparkles size={14} aria-hidden="true" />{isLive ? "画像から AI が候補を提案し、最初の案を付けます。" : "今はデモのタイトル候補を提案し、最初の案を付けます。"} 保存後に自由に編集できます。</p>
      <div className="upload-feedback"><p className="form-error upload-error" role="alert">{uploadError}</p>{uploadError && canRetry && <button className="button secondary" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />同じ写真でもう一度試す</button>}</div>
      <div className="sample-section"><div className="sample-heading"><span>写真がなくても、体験できます。</span><small>{isLive ? "サンプルを AI で採点" : "サンプル写真で試す"}</small></div><div className="sample-options">{[{ key: "forest", name: "霧の向こう側" }, { key: "sky", name: "宇宙からのサイン" }].map(s => <button key={s.key} onClick={() => { if (requireProfile()) onSample(s.key); }}><img src={`/images/${s.key}.jpg`} alt={s.name} /><span>{s.name}<ArrowUpRight size={17} aria-hidden="true" /></span></button>)}</div></div>
    </>}
    <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" ref={fileInput} onChange={e => void choose(e.target.files?.[0])} tabIndex={-1} aria-label="写真ファイルを選ぶ" /><input className="sr-only" type="file" accept="image/*" capture="environment" ref={cameraInput} onChange={e => void choose(e.target.files?.[0])} tabIndex={-1} aria-label="カメラで撮影する" />
  </div>;
}

function PhotoTitleEditor({ photo, userId, isLive, onUpdate, onSaved }: { photo: Photo; userId: string; isLive: boolean; onUpdate: (photo: Photo) => void; onSaved: () => void }) {
  const fieldId = useId();
  const [draft, setDraft] = useState(photo.title);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  useEffect(() => { setDraft(photo.title); setError(""); }, [photo.id, photo.title]);
  const candidates = photo.titleSuggestions;
  const hasCandidates = !!candidates?.suggestions.length && candidates.source !== "unavailable";
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    if (!draft.trim()) { setError("タイトルを入力してください。"); return; }
    busy.current = true; setSaving(true); setError("");
    try { const changed = await request<Photo>(`/api/photos/${photo.id}/title`, { method: "PATCH", body: JSON.stringify({ userId, title: draft.trim() }) }); onUpdate(changed); onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { busy.current = false; setSaving(false); }
  }
  async function suggest() {
    if (busy.current) return;
    busy.current = true; setSuggesting(true); setError("");
    try {
      const changed = await request<Photo>(`/api/photos/${photo.id}/titles`, { method: "POST", body: JSON.stringify({ userId }) });
      onUpdate(changed);
      if (changed.titleSuggestions?.source === "unavailable") setError("タイトル候補を取得できませんでした。写真と採点結果は保存済みです。もう一度お試しください。");
    } catch (e) { setError(`タイトル候補を取得できませんでした。写真と採点結果は保存済みです。${(e as Error).message}`); }
    finally { busy.current = false; setSuggesting(false); }
  }
  return <section className="photo-title-editor" aria-labelledby={`${fieldId}-heading`}><div className="title-editor-heading"><div><span className="section-label">NAME YOUR DISCOVERY</span><h2 id={`${fieldId}-heading`}>この一枚に、名前を。</h2></div><Sparkles size={22} strokeWidth={1.4} aria-hidden="true" /></div>
    {hasCandidates ? <><div className="title-suggestion-source"><span className={`evaluation-badge ${candidates.source === "ai" ? "live" : ""}`}>{candidates.source === "ai" ? "画像から AI が提案" : "デモのタイトル候補"}</span><span>選んだ案は、そのまま編集できます</span></div><div className="title-suggestion-chips">{candidates.suggestions.map(candidate => <button key={candidate} type="button" aria-pressed={draft === candidate} className={draft === candidate ? "selected" : ""} disabled={saving || suggesting} onClick={() => { setDraft(candidate); setError(""); }}>{candidate}{draft === candidate && <Check size={14} aria-hidden="true" />}</button>)}</div><button className="text-link title-regenerate" type="button" disabled={saving || suggesting} onClick={() => void suggest()}>{suggesting ? <><LoaderCircle size={15} className="spin" aria-hidden="true" />タイトル候補を考えています</> : <><RefreshCw size={14} aria-hidden="true" />{error ? "タイトル提案を再試行" : "別のタイトル案を提案"}</>}</button></> : <div className="title-suggestion-empty"><p>{candidates?.source === "unavailable" ? "タイトルの提案を取得できませんでした。写真と採点は保存済みです。" : "この写真から、タイトルの候補を提案できます。"}</p><button className="text-link" onClick={() => void suggest()} disabled={saving || suggesting}>{suggesting ? <><LoaderCircle size={16} className="spin" aria-hidden="true" />タイトル候補を考えています</> : <><Sparkles size={16} aria-hidden="true" />{candidates?.source === "unavailable" || error ? "タイトル提案を再試行" : "画像からタイトルを提案"}<ArrowUpRight size={15} aria-hidden="true" /></>}</button></div>}
    <form onSubmit={save}><label htmlFor={fieldId}>タイトルを編集</label><div className="title-editor-input"><input id={fieldId} value={draft} onChange={e => setDraft(e.target.value)} maxLength={60} disabled={saving || suggesting} required aria-describedby={`${fieldId}-error`} /><button className="button primary" disabled={saving || suggesting || draft.trim() === photo.title}>{saving ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <><Check size={17} aria-hidden="true" />保存する</>}</button></div><p className="form-error" id={`${fieldId}-error`} role="alert">{error}</p></form>
    <p className="title-editor-note">タイトルの変更で、点数やランキングは変わりません。{isLive && <span>AI に候補を再提案させる場合は、AI 利用料がかかります。</span>}</p>
  </section>;
}

export default function Home() {
  const [state, setState] = useState<AppState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>("home");
  const [userId, setUserId] = useState<string | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [modal, setModal] = useState<"profile" | "ranking" | "about" | "capture" | null>(null);
  const [captureProfiles, setCaptureProfiles] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [nameError, setNameError] = useState("");
  const [globalError, setGlobalError] = useState("");
  const [toast, setToast] = useState("");
  const [filter, setFilter] = useState<"all" | Rank>("all");
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [processing, setProcessing] = useState(false);
  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState("");
  const [pendingPhoto, setPendingPhoto] = useState<PendingPhoto | null>(null);
  const [title, setTitle] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [retryingPhotoId, setRetryingPhotoId] = useState<string | null>(null);
  const captureIdentityRef = useRef<HTMLDivElement>(null);
  const evaluationBusy = useRef(false);
  const fileBusy = useRef(false);
  const syncTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const profile = state.profiles.find(p => p.id === userId);
  const ownPhotos = state.photos.filter(p => p.userId === userId);
  const selectedPhoto = state.photos.find(p => p.id === photoId);
  const ownRank = state.ranking.find(p => p.id === userId);
  const isLive = state.ai?.mode === "decisions";
  const aiReady = !isLive || state.ai?.ready === true;
  const isGoogleDrive = state.drive?.mode === "google";
  const driveConnected = isGoogleDrive && state.drive?.connected === true;
  const driveNote = isGoogleDrive ? driveConnected ? "写真と評価を保存後、共通の Google Drive へ自動同期します。" : "写真と評価は保存済みです。管理者が Google Drive を連携すると、順に自動同期します。" : "写真と評価は保存済みです。Google Drive への同期はデモです。";

  const refresh = useCallback(async () => {
    const data = await request<AppState>("/api/state");
    setState(data);
    return data;
  }, []);

  const navigate = useCallback((next: View, id?: string, push = true) => {
    setView(next);
    if (id) setPhotoId(id);
    if (push) window.history.pushState(null, "", next === "home" ? "/" : `/?view=${next}${id ? `&photo=${id}` : ""}`);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  useEffect(() => {
    function readUrl() {
      const params = new URLSearchParams(window.location.search);
      const next = params.get("view") as View;
      navigate(["capture", "collection", "guide", "result"].includes(next) ? next : "home", params.get("photo") || undefined, false);
    }
    readUrl();
    window.addEventListener("popstate", readUrl);
    refresh().then(data => {
      const remembered = rememberedProfile();
      if (remembered && data.profiles.some(p => p.id === remembered)) setUserId(remembered);
      else rememberProfile(null);
      setLoaded(true);
    }).catch(e => { setGlobalError(e.message); setLoaded(true); });
    return () => window.removeEventListener("popstate", readUrl);
  }, [navigate, refresh]);

  useEffect(() => {
    if (!loaded || processing) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh().catch(e => setGlobalError(e.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [loaded, processing, refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const scheduleSync = useCallback((id: string, fail = false) => {
    if (isGoogleDrive || syncTimers.current.has(id)) return;
    const timer = setTimeout(async () => {
      try {
        const photo = await request<Photo>(`/api/photos/${id}/sync`, { method: "PATCH", body: JSON.stringify({ status: fail ? "failed" : "synced" }) });
        setState(s => ({ ...s, photos: s.photos.map(p => p.id === id ? photo : p) }));
      } catch (e) { setGlobalError((e as Error).message); }
      finally { syncTimers.current.delete(id); }
    }, 2500);
    syncTimers.current.set(id, timer);
  }, [isGoogleDrive]);

  useEffect(() => {
    if (isGoogleDrive) {
      syncTimers.current.forEach(timer => clearTimeout(timer));
      syncTimers.current.clear();
      return;
    }
    state.photos.filter(p => p.syncStatus === "pending").forEach(p => scheduleSync(p.id, simulateFailure));
  }, [isGoogleDrive, state.photos, scheduleSync, simulateFailure]);

  useEffect(() => {
    const timers = syncTimers.current;
    return () => { timers.forEach(timer => clearTimeout(timer)); timers.clear(); };
  }, []);

  function selectProfile(p: Profile) {
    rememberProfile(p.id);
    setUserId(p.id);
    setModal(previous => previous === "capture" ? "capture" : null);
    setCaptureProfiles(false);
    setNameError("");
    setPendingPhoto(null);
    setUploadError("");
    setToast(`${p.nickname} として参加しました`);
  }

  async function register(name: string) {
    if (registering) return;
    if (!name.trim()) { setNameError("ニックネームを入力してください。"); return; }
    setRegistering(true); setNameError("");
    try {
      const p = await request<Profile>("/api/profiles", { method: "POST", body: JSON.stringify({ nickname: name.trim() }) });
      setState(s => ({ ...s, profiles: [...s.profiles.filter(existing => existing.id !== p.id), p] }));
      await refresh().catch(() => setGlobalError("名前は保存済みです。ランキングの更新をもう一度お試しください。"));
      selectProfile(p);
    } catch (e) { setNameError((e as Error).message); }
    finally { setRegistering(false); }
  }

  function requireProfile(): boolean {
    if (profile) return true;
    if (modal === "capture") {
      setNameError("写真を追加する前に、名前を選んでください。"); setCaptureProfiles(true);
      captureIdentityRef.current?.scrollIntoView({ block: "start" });
      return false;
    }
    setNameError(""); setModal("profile"); return false;
  }

  function openCapture() {
    setCaptureProfiles(!profile); setNameError(""); setModal("capture");
  }

  function updatePhoto(photo: Photo) {
    setState(previous => ({ ...previous, photos: previous.photos.map(existing => existing.id === photo.id ? photo : existing) }));
  }

  async function evaluate(image: string, sampleKey?: string, retry?: PendingPhoto) {
    if (evaluationBusy.current || !profile) return;
    if (!aiReady) { setUploadError("AI 採点の準備がまだ完了していません。管理者に設定を確認してもらってください。"); return; }
    evaluationBusy.current = true;
    const input = retry || { userId: profile.id, title: title.trim(), image, sampleKey, requestId: crypto.randomUUID() };
    setPendingPhoto(input);
    setProcessing(true); setUploadError(""); setPreview(image); setStep(0);
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    try {
      if (!isLive) await wait(500);
      setStep(1);
      if (!isLive) await wait(650);
      const photo = await request<Photo>("/api/photos", { method: "POST", body: JSON.stringify(input) });
      setStep(2);
      setPendingPhoto(null);
      setState(s => ({ ...s, photos: [photo, ...s.photos.filter(existing => existing.id !== photo.id)] }));
      await refresh().catch(() => setGlobalError("写真と評価は保存済みです。ランキングの更新をもう一度お試しください。"));
      scheduleSync(photo.id, simulateFailure);
      setTitle(""); setModal(null); navigate("result", photo.id);
      setToast(photo.evaluation.isDemo ? "写真とデモ採点を保存しました" : "写真と AI 採点を保存しました");
    } catch (e) { setUploadError((e as Error).message); }
    finally { evaluationBusy.current = false; setProcessing(false); setStep(0); }
  }

  async function readPhoto(file?: File) {
    if (!file || !requireProfile() || evaluationBusy.current || fileBusy.current) return;
    setUploadError("");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setUploadError("JPEG・PNG・WebP の写真を選んでください。HEIC は JPEG に変換してください。"); return; }
    if (file.size > 20 * 1024 * 1024) { setUploadError("20 MB 以下の写真を選んでください。"); return; }
    fileBusy.current = true;
    setProcessing(true); setStep(0); setPreview("");
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("このブラウザでは写真を読み込めませんでした。");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
      await evaluate(canvas.toDataURL("image/jpeg", 0.8));
    } catch (e) { setUploadError(e instanceof Error ? e.message : "写真を読み込めませんでした。別の写真をお試しください。"); }
    finally { fileBusy.current = false; setProcessing(false); }
  }

  async function retrySync(photo: Photo) {
    if (retryingPhotoId) return;
    setRetryingPhotoId(photo.id);
    try {
      const changed = await request<Photo>(`/api/photos/${photo.id}/sync`, { method: "PATCH", body: JSON.stringify({ status: "pending" }) });
      setState(s => ({ ...s, photos: s.photos.map(p => p.id === photo.id ? changed : p) }));
      scheduleSync(photo.id, false);
      if (isGoogleDrive) setToast(driveConnected ? "Drive 同期を再試行します" : "Drive の連携後に同期します");
    } catch (e) { setGlobalError((e as Error).message); }
    finally { setRetryingPhotoId(null); }
  }

  const nicknameForm = <NicknameForm profiles={state.profiles} onSelect={selectProfile} onCreate={register} submitting={registering} error={nameError} selected={profile} />;
  const composer = <PhotoComposer title={title} onTitleChange={value => { setTitle(value); setPendingPhoto(null); }} processing={processing} step={step} preview={preview} isLive={isLive} uploadError={uploadError} canRetry={!!pendingPhoto && pendingPhoto.userId === profile?.id} onRetry={() => { if (pendingPhoto) void evaluate(pendingPhoto.image, pendingPhoto.sampleKey, pendingPhoto); }} onFile={readPhoto} onSample={key => void evaluate(`/images/${key}.jpg`, key)} requireProfile={requireProfile} />;
  const photoGrid = (photos: Photo[]) => <div className="photo-grid">{photos.map(photo => <PhotoCard key={photo.id} photo={photo} profile={state.profiles.find(p => p.id === photo.userId)} open={() => navigate("result", photo.id)} />)}</div>;
  const rankingRows = (limit?: number) => <div className="ranking-rows">{state.ranking.slice(0, limit).map(p => <div className={`ranking-row ${p.id === userId ? "is-you" : ""}`} key={p.id}><span className={`position pos-${p.position}`}>{String(p.position).padStart(2, "0")}</span><Avatar profile={p} /><div className="ranking-name"><strong>{p.nickname}{p.id === userId && <small>YOU</small>}</strong><span>S <b>{p.sCount}</b><i>·</i>A <b>{p.aCount}</b></span></div><div className="high-count">{p.highCount}<small>枚</small></div></div>)}</div>;

  return <>
    <div className="cosmic-sky" aria-hidden="true" />
    <a href="#main" className="skip-link">メインコンテンツへ</a>
    <header className="site-header"><div className="header-inner">
      <a href="/" className="brand" onClick={e => { e.preventDefault(); navigate("home"); }} aria-label="ODDSHOT TOP"><span className="brand-mark"><Eye size={27} strokeWidth={1.7} aria-hidden="true" /></span><span>ODDSHOT<span className="brand-dot">.</span></span></a>
      <nav className="desktop-nav" aria-label="メインナビゲーション">{navigation.map(item => <a key={item.view} href={item.view === "home" ? "/" : `/?view=${item.view}`} className={(view === item.view || view === "result" && item.view === "collection") ? "active" : ""} aria-current={view === item.view ? "page" : undefined} onClick={e => { e.preventDefault(); navigate(item.view); }}>{item.label}</a>)}</nav>
      <div className="header-actions"><button className="button primary header-add-photo" onClick={openCapture} disabled={!loaded} aria-label="写真を追加"><Camera size={18} aria-hidden="true" /><span className="header-add-label">写真を追加</span><span className="header-add-short">追加</span></button><button className={`mock-pill ${isLive ? "live" : ""}`} onClick={() => setModal("about")}><span />{isLive ? "AI MODE" : "DEMO"}<Info size={13} aria-hidden="true" /></button><button className="profile-switch" onClick={() => { setNameError(""); setModal("profile"); }} aria-label={profile ? `${profile.nickname}、名前を切り替える` : "ニックネームを登録または選択"}>{profile ? <Avatar profile={profile} size="small" /> : <UserRound size={19} aria-hidden="true" />}<span>{profile?.nickname || "参加する"}</span><ChevronDown size={14} aria-hidden="true" /></button></div>
    </div></header>

    <main id="main" className="main-shell">
      {globalError && <div className="error-banner" role="alert">{globalError}<button onClick={() => { setGlobalError(""); refresh().catch(e => setGlobalError(e.message)); }}>もう一度読み込む</button></div>}
      {!loaded ? <div className="initial-loading"><LoaderCircle className="spin" size={30} aria-hidden="true" /><p>コレクションを開いています…</p></div> : <>
      {view === "home" && <>
        <div className="section-eyebrow top-eyebrow"><span><span className="status-dot" />A LITTLE BEYOND THE ORDINARY</span><span>日常の、ちょっと向こう側。</span></div>
        <section className="home-top">
          <div className="hero-card"><img className="hero-photo" src="/images/forest.jpg" alt="光と霧が差し込む深い森" fetchPriority="high" /><div className="hero-shade" />
            <AstralOrbit />
            <div className="hero-stamp"><span>SPIRITUAL<br />LEVEL</span><b>S</b><span>UNKNOWN / 96</span></div>
            <div className="hero-content"><div className="hero-kicker"><ScanLine size={16} aria-hidden="true" />FIND YOUR NEXT MYSTERY</div><h1>その一枚、<br />何かある。</h1><p>いつもの景色に、未知の気配。<br />あなたが見つけた「奇妙」を、集めよう。</p><button className="button primary hero-button" onClick={openCapture}><Camera size={19} aria-hidden="true" />写真を撮る・選ぶ<ArrowUpRight size={20} aria-hidden="true" /></button><div className="hero-footnote">写真の雰囲気を楽しむ、スピリチュアル採点。</div></div>
            <div className="hero-caption"><span>001 / THE SILENT FOREST</span><span>DEMO PHOTO</span></div>
          </div>
          <aside className="leaderboard"><div className="leaderboard-heading"><span className="section-label">HALL OF ODD</span><Trophy size={23} strokeWidth={1.4} aria-hidden="true" /></div><h2>奇妙を集めた人たち</h2><p className="panel-description">S・A ランクの獲得枚数ランキング</p><div className="ranking-rule"><span className="mini-rank">S</span><span>＋</span><span className="mini-rank a">A</span><span className="ranking-rule-tail">= 高ランク獲得数</span></div>{rankingRows(4)}<button className="text-link ranking-link" onClick={() => setModal("ranking")}>ランキングをすべて見る<ArrowRight size={18} aria-hidden="true" /></button><div className="ranking-bottom"><span className="status-dot" />写真の保存後に更新</div></aside>
        </section>

        <section className={`join-panel ${profile ? "joined" : ""}`} aria-label="参加者の登録">
          {profile ? <><div className="join-intro"><span className="section-label">YOUR EXPLORATION</span><h2>おかえり、{profile.nickname}。</h2><p>今日も、何気ない景色の向こう側へ。</p><button className="text-link" onClick={() => setModal("profile")}>名前を切り替える<ArrowRight size={16} aria-hidden="true" /></button></div><div className="personal-stats"><div><span>あなたの記録</span><strong>{ownPhotos.length}<small>枚</small></strong></div><div><span>S・A 獲得数</span><strong>{ownRank?.highCount || 0}<small>枚</small></strong></div><div><span>現在の順位</span><strong>{ownRank?.highCount ? ownRank.position : "—"}<small>{ownRank?.highCount ? "位" : ""}</small></strong></div></div></> : <><div className="join-intro"><span className="section-label">HELLO, EXPLORER</span><h2>まずは、呼び名から。</h2><p>ログインは不要。<br />ニックネームひとつで、探索をはじめよう。</p><span className="small-note">選んだ名前は、このタブで覚えておきます。</span></div>{nicknameForm}</>}
        </section>

        <section className="recent-section"><div className="section-heading"><div><span className="section-label">RECENT DISCOVERIES</span><h2>みんなが見つけた、不思議。</h2></div><button className="text-link" onClick={() => { setScope("all"); navigate("collection"); }}>すべての写真<ArrowUpRight size={18} aria-hidden="true" /></button></div>{photoGrid(state.photos.slice(0, 4))}</section>
        <section className="how-section"><div><span className="section-label">HOW IT WORKS</span><h2>見つけたら、<br />あとはおまかせ。</h2><button className="text-link" onClick={() => navigate("guide")}>評価のしくみ<ArrowUpRight size={17} aria-hidden="true" /></button></div><div className="how-step"><span>01</span><Camera size={27} strokeWidth={1.4} aria-hidden="true" /><h3>撮る、または選ぶ</h3><p>日常で見つけた不思議を<br />一枚の写真に。</p></div><div className="how-step"><span>02</span><Sparkles size={27} strokeWidth={1.4} aria-hidden="true" /><h3>スピリチュアル度を採点</h3><p>写真と評価基準から、<br />S・A・B・C・F で評価。</p><small>{isLive ? "Decisions API で写真を直接判定" : "Decisions API を想定したデモ採点"}</small></div><div className="how-step"><span>03</span><Cloud size={27} strokeWidth={1.4} aria-hidden="true" /><h3>集める、自動で残す</h3><p>写真と評価を記録して、<br />写真を共通の Drive へ自動同期。</p><small>{isGoogleDrive ? driveConnected ? "写真を自動保存 · 評価はアプリで確認" : "管理者の Drive 連携を待っています" : "このモードでは同期を再現します"}</small></div></section>
      </>}

      {view === "capture" && <section className="capture-page">
        <div className="page-heading"><span className="section-label">NEW DISCOVERY</span><h1>あなたの「何かある」を。</h1><p>写真を選ぶと、採点と保存がはじまります。タイトルも写真から提案します。</p><div className={`scoring-mode ${isLive ? "live" : ""}`}><Sparkles size={14} aria-hidden="true" /><span>{isLive ? aiReady ? "AI 採点モード" : "AI 採点の設定待ち" : "デモ採点モード"}</span><span>画像を直接判定する Decisions API</span></div></div>
        <div className="process-strip">{["写真を準備", "採点・タイトル提案", "結果を保存"].map((text, index) => <div key={text} className={processing && step >= index ? "current" : ""}><span>{String(index + 1).padStart(2, "0")}</span>{text}{index < 2 && <ArrowRight size={16} aria-hidden="true" />}</div>)}</div>
        <div className="capture-layout"><div className="capture-main">{modal !== "capture" && composer}</div><aside className="capture-aside"><div className="aside-profile"><span className="section-label">EXPLORER</span><div><Avatar profile={profile} /><strong>{profile?.nickname || "名前を選んで参加"}</strong></div><button className="text-link" disabled={processing} onClick={() => setModal("profile")}>{profile ? "名前を切り替える" : "ニックネームを登録・選択"}<ArrowRight size={15} aria-hidden="true" /></button></div><div className={`ai-card ${isLive ? "live" : ""}`}><div className="ai-card-label"><Sparkles size={18} aria-hidden="true" /><span>{isLive ? "AI SCORING" : "DEMO SCORING"}</span></div><h3>写真から、不思議を見つける。</h3><p>{isLive ? aiReady ? "写真を直接見て、神秘的な雰囲気や光、構図など 4 つの観点から採点します。" : "AI 採点の接続設定が完了するまで、写真の追加をお待ちください。" : "Decisions API による採点を想定した体験版です。今はデモの結果が表示されます。"}</p><span className="ai-provider">OpenAI Decisions API</span></div><div className="save-card"><Cloud size={30} strokeWidth={1.4} aria-hidden="true" /><h3>思い出は、自動で残る。</h3><p>{isGoogleDrive ? "写真・ユーザー・評価を保存し、みんなの共通 Google Drive へ自動同期します。" : "写真・ユーザー・評価を保存し、共通 Google Drive への自動同期を体験できます。"}</p><div className="destination"><span className="folder-icon"><Images size={19} aria-hidden="true" /></span><div><strong>{state.drive?.folderName || "ODDSHOT / みんなの記録"}</strong><span>{isGoogleDrive ? driveConnected ? "共通の保存先 · 連携済み" : "共通の保存先 · 連携待ち" : "共通の保存先 · デモ"}</span></div></div><p className="demo-note">{driveNote}</p></div><div className="entertainment-note"><Sparkles size={17} aria-hidden="true" /><p>採点するのは「写真から受ける印象」。UFO や超常現象の実在を判定するものではありません。</p></div></aside></div>

      </section>}

      {view === "collection" && <section className="collection-page"><div className="page-heading page-heading-row"><div><span className="section-label">COLLECTION OF THE UNEXPLAINED</span><h1>不思議の、コレクション。</h1><p>一枚ずつ増えていく、日常の向こう側。</p></div><button className="button primary" onClick={openCapture}><ImagePlus size={19} aria-hidden="true" />写真を追加<ArrowUpRight size={18} aria-hidden="true" /></button></div><div className="collection-toolbar"><div className="scope-toggle" aria-label="写真の表示範囲"><button className={scope === "all" ? "active" : ""} aria-pressed={scope === "all"} onClick={() => setScope("all")}>みんなの記録</button><button className={scope === "mine" ? "active" : ""} aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>自分の記録</button></div><span className="collection-count">{(scope === "all" ? state.photos : ownPhotos).filter(p => filter === "all" || p.evaluation.rank === filter).length} PHOTOS</span></div><div className="rank-filters" aria-label="ランクで絞り込み"><button className={filter === "all" ? "active" : ""} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>すべて</button>{ranks.map(r => <button className={filter === r ? "active" : ""} aria-pressed={filter === r} onClick={() => setFilter(r)} key={r}><span className={`rank-dot rank-${r}`}>{r}</span>ランク</button>)}</div>
        {scope === "mine" && !profile ? <div className="empty-state"><UserRound size={40} strokeWidth={1.3} aria-hidden="true" /><h2>あなたの名前を、教えてください。</h2><p>名前を選ぶと、あなたが集めた写真を表示します。</p><button className="button primary" onClick={() => setModal("profile")}>名前を選ぶ<ArrowRight size={18} aria-hidden="true" /></button></div> : (() => { const visible = (scope === "all" ? state.photos : ownPhotos).filter(p => filter === "all" || p.evaluation.rank === filter); return visible.length ? photoGrid(visible) : <div className="empty-state"><Images size={40} strokeWidth={1.3} aria-hidden="true" /><h2>まだ、見ぬ不思議。</h2><p>{filter === "all" ? "最初の一枚から、コレクションをはじめよう。" : `${filter} ランクの写真はまだありません。`}</p><button className="button primary" onClick={openCapture}>写真を追加する<ArrowRight size={18} aria-hidden="true" /></button></div>; })()}
      </section>}

      {view === "result" && (selectedPhoto ? <section className="result-page"><button className="back-link" onClick={() => navigate("collection")}><ArrowLeft size={17} aria-hidden="true" />コレクションに戻る</button><div className="result-layout"><div className="result-visual"><img src={selectedPhoto.image} alt={selectedPhoto.title} /><div className="result-image-label"><ScanLine size={17} aria-hidden="true" /><span>{selectedPhoto.isSample ? "DEMO PHOTO" : "YOUR DISCOVERY"}</span><span>NO. {selectedPhoto.id.slice(-6).toUpperCase()}</span></div><div className="result-photo-info"><h1>{selectedPhoto.title}</h1><div><Avatar profile={state.profiles.find(p => p.id === selectedPhoto.userId)} size="small" /><span>{state.profiles.find(p => p.id === selectedPhoto.userId)?.nickname}</span><time dateTime={selectedPhoto.createdAt}>{formatDate(selectedPhoto.createdAt)}</time></div></div>{selectedPhoto.userId === userId && <PhotoTitleEditor key={selectedPhoto.id} photo={selectedPhoto} userId={userId} isLive={isLive} onUpdate={updatePhoto} onSaved={() => setToast("タイトルを保存しました")} />}</div><div className="result-detail"><span className="section-label">YOUR SPIRITUAL LEVEL</span><div className="result-grade"><b className={`grade-${selectedPhoto.evaluation.rank}`}>{selectedPhoto.evaluation.rank}</b><div><span>{rankDescriptions.find(r => r.rank === selectedPhoto.evaluation.rank)?.name}</span><strong>{selectedPhoto.evaluation.score}<small> / 100</small></strong><span className={`evaluation-badge ${selectedPhoto.evaluation.isDemo ? "" : "live"}`}>{selectedPhoto.evaluation.isDemo ? "デモ採点" : "AI 採点"}</span></div></div><p className="result-reason">{selectedPhoto.evaluation.reason}</p><div className="tags">{selectedPhoto.evaluation.tags.map(tag => <span key={tag}>{tag}</span>)}</div><div className="score-axes">{axes.map(a => <div className="axis" key={a.key}><div><span>{a.name}</span><strong>{selectedPhoto.evaluation.axes[a.key]}<small> / 25</small></strong></div><div className="axis-track"><span style={{ width: `${selectedPhoto.evaluation.axes[a.key] * 4}%` }} /></div></div>)}</div><div className="result-saved"><div><CheckCircle2 size={21} aria-hidden="true" /><span>写真と評価を保存しました</span></div><SyncLabel photo={selectedPhoto} drive={state.drive} retry={() => void retrySync(selectedPhoto)} retrying={retryingPhotoId === selectedPhoto.id} /><p>{driveNote}</p></div><div className="result-actions"><button className="button primary" onClick={openCapture}><Camera size={18} aria-hidden="true" />次の不思議を探す<ArrowUpRight size={18} aria-hidden="true" /></button><button className="text-link" onClick={() => navigate("guide")}>どう採点したの？<ArrowRight size={17} aria-hidden="true" /></button></div><p className="demo-note">{selectedPhoto.evaluation.isDemo ? "操作確認用のデモ採点です。" : "写真の印象を評価基準に照らし合わせた AI 採点です。"} 説明は判定項目に応じて組み立てています。{(selectedPhoto.evaluation.criteriaVersion || selectedPhoto.evaluation.ai?.criteriaVersion) && <span className="criteria-version">採点基準：{selectedPhoto.evaluation.criteriaVersion || selectedPhoto.evaluation.ai?.criteriaVersion}</span>}</p></div></div></section> : <div className="empty-state"><Images size={35} aria-hidden="true" /><h1>写真が見つかりませんでした。</h1><button className="button primary" onClick={() => navigate("collection")}>コレクションへ</button></div>)}

      {view === "guide" && <section className="guide-page"><div className="guide-intro"><div><span className="section-label">A GUIDE TO THE UNKNOWN</span><h1>不思議にも、<br />ものさしを。</h1><p>霧に包まれた森、偶然できた謎の模様、<br />UFO を連想する光。<br />写真に宿る「想像したくなる気配」を楽しむ採点です。</p></div><div className="guide-rank-orbit"><span>SPIRITUAL LEVEL</span><div><b>S</b><b>A</b><b>B</b><b>C</b><b>F</b></div><p>0 — 100 POINTS / 5 RANKS</p></div></div><div className="section-heading"><div><span className="section-label">THE FIVE LEVELS</span><h2>5 つの、不思議のレベル。</h2></div><span className="small-note">採点基準は初期版の仮案です</span></div><div className="rank-guide-list">{rankDescriptions.map(r => <div className="rank-guide-row" key={r.rank}><RankBadge rank={r.rank as Rank} large /><strong>{r.name}</strong><p>{r.description}</p><span>{state.criteria?.ranks.find(rule => rule.rank === r.rank) ? `${state.criteria.ranks.find(rule => rule.rank === r.rank)!.min}–${state.criteria.ranks.find(rule => rule.rank === r.rank)!.max}` : r.range}<small>POINTS</small></span></div>)}</div><section className="axes-guide"><div className="section-heading"><div><span className="section-label">WHAT WE LOOK FOR</span><h2>写真の、ここを見ています。</h2></div><span className="small-note">各 25 点・合計 100 点</span></div><div className="axes-guide-grid">{axes.map((a, i) => <div key={a.key}><span>0{i + 1}</span><h3>{a.name}</h3><small>{a.en}</small><p>{["静けさ、霧、奥行き。現実から少し離れたような空気感。", "光のにじみや自然の造形。偶然生まれる幻想的な表情。", "謎の紋様、幾何学、未知の光。都市伝説を連想するモチーフ。", "何が起きたのか想像したくなる、視点や余白、構図。"][i]}</p></div>)}</div></section><section className="scoring-guide-card"><div><span className="section-label">FROM PHOTO TO SCORE</span><h2>一枚の写真から、ひとつの判定。</h2><p>Decisions API が写真と評価基準を照らし合わせ、4 つの観点をまとめて判定します。合計点からランクを決め、判定項目に応じた説明を添えます。</p></div><div className="scoring-guide-flow"><span><ScanLine size={19} aria-hidden="true" />写真と評価基準</span><ArrowRight size={17} aria-hidden="true" /><span><Sparkles size={19} aria-hidden="true" />4 項目を判定</span><ArrowRight size={17} aria-hidden="true" /><span><Trophy size={19} aria-hidden="true" />100 点・5 ランク</span></div><p className="scoring-guide-note">{isLive ? aiReady ? "現在は AI 採点モードです。" : "現在は AI 採点の設定待ちです。" : "現在はデモ採点モードです。"} 判定できなかった写真には点数を付けず、再試行をご案内します。</p></section><div className="guide-footer-note"><Sparkles size={24} strokeWidth={1.4} aria-hidden="true" /><div><h3>想像を楽しもう。</h3><p>UFO やフリーメイソンなどの都市伝説は、写真からの連想として扱います。<br />人物の所属や信仰、超常現象の実在を写真から判断するものではありません。</p></div><button className="button primary" onClick={openCapture}>一枚、試してみる<ArrowUpRight size={18} aria-hidden="true" /></button></div></section>}
      </>}
    </main>

    <footer className="site-footer"><span className="footer-brand">ODDSHOT<span>.</span></span><p>見慣れた世界に、まだ見ぬ不思議を。</p><button onClick={() => setModal("about")}>DECISIONS EDITION <ArrowUpRight size={14} aria-hidden="true" /></button><a className="text-link" href="/admin/drive">Drive 管理<ArrowUpRight size={14} aria-hidden="true" /></a></footer>
    <nav className="mobile-nav" aria-label="モバイルナビゲーション">{navigation.map(item => <a key={item.view} href={item.view === "home" ? "/" : `/?view=${item.view}`} className={view === item.view || view === "result" && item.view === "collection" ? "active" : ""} onClick={e => { e.preventDefault(); navigate(item.view); }}><item.icon size={21} strokeWidth={1.7} aria-hidden="true" /><span>{item.label}</span></a>)}</nav>
    {toast && <div className="toast" role="status"><CheckCircle2 size={19} aria-hidden="true" />{toast}</div>}

    {modal === "capture" && <Dialog title="あなたの「何かある」を。" onClose={() => { if (!processing) setModal(null); }} className="capture-dialog" dismissDisabled={processing} wide>
      <p className="dialog-description capture-dialog-intro">撮る、または選ぶ。写真から採点とタイトル提案がはじまります。</p>
      <div className={`scoring-mode ${isLive ? "live" : ""}`}><Sparkles size={14} aria-hidden="true" /><span>{isLive ? aiReady ? "AI 採点モード" : "AI 採点の設定待ち" : "デモ採点モード"}</span><span>{isGoogleDrive ? driveConnected ? "Google Drive に自動同期" : "Google Drive の連携待ち" : "Google Drive 同期はデモ"}</span></div>
      <div className="capture-dialog-identity" ref={captureIdentityRef}>
        {(!profile || captureProfiles) && !processing ? <><div className="capture-identity-heading"><UserRound size={18} aria-hidden="true" /><strong>{profile ? "投稿する名前を選ぶ" : "まずは、呼び名から。"}</strong>{profile && <button className="text-link" onClick={() => setCaptureProfiles(false)}>この名前で続ける</button>}</div>{nicknameForm}</> : <div className="capture-selected-profile"><Avatar profile={profile} size="small" /><span><strong>{profile?.nickname || "探検家"}</strong> として投稿</span><button className="text-link" disabled={processing} onClick={() => { setCaptureProfiles(true); setNameError(""); }}>名前を切り替える<ChevronDown size={14} aria-hidden="true" /></button></div>}
      </div>
      <div className="process-strip">{["写真を準備", "採点・タイトル提案", "結果を保存"].map((text, index) => <div key={text} className={processing && step >= index ? "current" : ""}><span>{String(index + 1).padStart(2, "0")}</span>{text}{index < 2 && <ArrowRight size={16} aria-hidden="true" />}</div>)}</div>
      {composer}
      <p className="capture-dialog-note">{processing ? "採点と保存が終わるまで、この画面を閉じずにお待ちください。" : "写真を選ぶと自動で採点・保存します。空欄のタイトルは候補から付け、保存後に編集できます。"}</p>
    </Dialog>}
    {modal === "profile" && <Dialog title={profile ? "あなたの名前を、選ぼう。" : "はじめまして、探検家。"} onClose={() => setModal(null)}><p className="dialog-description">ログイン不要。ニックネームで写真を集められます。</p>{nicknameForm}{profile && <button className="forget-button" onClick={() => { rememberProfile(null); setUserId(null); setModal(null); setToast("このタブの名前をリセットしました。記録は残っています。"); }}>このタブの名前をリセット</button>}</Dialog>}
    {modal === "ranking" && <Dialog title="奇妙を集めた人たち" onClose={() => setModal(null)}><p className="dialog-description">S・A ランクの獲得枚数で順位を決めます。同じ枚数は同じ順位です。</p>{rankingRows()}<p className="identity-note">1 枚の写真を 1 回だけ集計します。</p></Dialog>}
    {modal === "about" && <Dialog title="このアプリでできること" onClose={() => setModal(null)} wide><div className="about-intro"><span className="section-label">ODDSHOT / DECISIONS EDITION</span><p>写真の読み取りと採点を、Decisions API にまとめる構成です。</p></div><ul className="about-list"><li><CheckCircle2 size={19} aria-hidden="true" /><span>ニックネーム登録・既存の名前で再開</span></li><li><CheckCircle2 size={19} aria-hidden="true" /><span>カメラ・写真選択・サンプルで採点とタイトル提案</span></li><li><CheckCircle2 size={19} aria-hidden="true" /><span>写真・ユーザー・評価をデータベースに保存</span></li><li><CheckCircle2 size={19} aria-hidden="true" /><span>S＋A 獲得数ランキング・履歴の絞り込み</span></li><li><Cloud size={19} aria-hidden="true" /><span>{isGoogleDrive ? "Google Drive に写真を自動保存" : "Google Drive の自動同期・失敗・再試行を体験"}</span></li></ul>{!isGoogleDrive && <div className="demo-settings"><div><strong>同期失敗を体験する</strong><p>次に追加する写真のデモ同期を失敗させます。</p></div><button role="switch" aria-checked={simulateFailure} className={`switch ${simulateFailure ? "on" : ""}`} onClick={() => setSimulateFailure(!simulateFailure)} aria-label="同期失敗を体験する"><span /></button></div>}<div className={`about-ai-status ${isLive ? "live" : ""}`}><Sparkles size={22} aria-hidden="true" /><div><strong>{isLive ? aiReady ? "Decisions API で採点します" : "Decisions API の設定待ちです" : "現在はデモ採点です"}</strong><p>{isLive ? aiReady ? "追加した写真を OpenAI に送り、4 つの項目を判定し、別の画像対応 AI でタイトル候補を提案します。サンプル写真も AI で採点します。" : "AI の接続設定が完了すると、写真の採点を利用できます。" : "写真は外部の AI に送信しません。サンプルは固定の結果、追加した写真は操作確認用の採点とデモのタイトル候補です。"}</p></div></div><div className="about-pipeline"><span>写真＋評価基準</span><ArrowRight size={15} aria-hidden="true" /><strong>Decisions API</strong><ArrowRight size={15} aria-hidden="true" /><span>点数・ランク・説明</span></div><p className="demo-note">画像を直接判定し、アプリ側で合計点・ランクと定型の説明を組み立てます。写真・参加者・評価・基準はデータベースに保存します。{driveNote}</p><div className="about-bottom"><span>写真サンプル：Unsplash</span><button className="text-link" onClick={openCapture}>体験してみる<ArrowRight size={18} aria-hidden="true" /></button></div></Dialog>}
  </>;
}

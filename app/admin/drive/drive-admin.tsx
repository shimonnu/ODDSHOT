"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, Cloud, FolderOpen, KeyRound, LoaderCircle, LogOut, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";

type DriveStatus = {
  authenticated: boolean;
  configured: boolean;
  connected: boolean;
  folderName?: string;
  redirectUri?: string;
  message?: string;
};

const callbackErrors: Record<string, string> = {
  access_denied: "Google の保存許可がキャンセルされました。連携ボタンからやり直せます。",
  invalid_state: "連携の有効期限が切れました。この画面から、もう一度連携してください。",
  folder_mismatch: "アプリに設定した保存先フォルダを選んでください。別のフォルダには保存しません。",
  missing_folder: "保存先が選ばれていません。連携をやり直して、フォルダを選んでください。",
  missing_refresh_token: "継続して保存するための許可を受け取れませんでした。もう一度 Google と連携してください。",
  invalid_scope: "写真を保存する権限を受け取れませんでした。Google の許可画面をご確認ください。",
  configuration: "連携の設定が揃っていません。Google の設定と、アプリの接続設定をご確認ください。",
  cancelled: "Google の保存許可がキャンセルされました。連携ボタンからやり直せます。",
  state: "連携の確認情報が無効になりました。この画面から、もう一度連携してください。",
  folder: "アプリに設定した保存先フォルダを選び、そのフォルダに保存できる Google アカウントで許可してください。",
  reconnect_required: "Google の保存許可を更新する必要があります。「Google と再連携する」から、もう一度許可してください。",
  scope: "写真を保存する権限を受け取れませんでした。連携をやり直し、Google の許可画面をご確認ください。",
  unauthorized: "管理者の確認が必要です。管理画面に入り直して、連携をやり直してください。",
  csrf: "この連携操作を確認できませんでした。この管理画面から、もう一度連携してください。",
  rate_limit: "連携操作が短時間に続いています。少し待ってから、もう一度お試しください。",
  connection: "Google Drive に接続できませんでした。通信と Google の接続設定を確認し、もう一度お試しください。",
};

async function call<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...options, cache: "no-store", headers: { "Content-Type": "application/json", ...options?.headers } });
  } catch {
    throw new Error("接続できませんでした。通信を確認して、もう一度お試しください。");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "処理に失敗しました。もう一度お試しください。");
  return body as T;
}

export default function DriveAdmin() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"login" | "logout" | "process" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/admin/drive", { cache: "no-store" });
    if (response.status === 401) {
      const signedOut: DriveStatus = { authenticated: false, configured: false, connected: false };
      setStatus(signedOut);
      return signedOut;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "連携状態を取得できませんでした。");
    const latest = body as DriveStatus;
    setStatus(latest);
    return latest;
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("drive") === "error") {
      const code = params.get("code") || params.get("reason") || "";
      setError(callbackErrors[code] || "Google Drive と連携できませんでした。Google の設定を確認し、もう一度お試しください。");
    }
    refresh().then(latest => {
      if (params.get("drive") === "connected" && latest.connected) setNotice("Google Drive と連携しました。保存済みの写真も、順に自動同期します。");
    }).catch(() => setError("連携状態を確認できませんでした。下のボタンから再読み込みしてください。")).finally(() => setLoading(false));
  }, [refresh]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!secret.trim()) { setError("管理用パスワードを入力してください。"); return; }
    setBusy("login"); setError("");
    try {
      await call("/api/admin/session", { method: "POST", body: JSON.stringify({ secret }) });
      setSecret("");
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "管理画面を開けませんでした。");
    } finally { setBusy(null); }
  }

  async function process() {
    if (busy) return;
    setBusy("process"); setError(""); setNotice("");
    try {
      await call("/api/admin/drive/process", { method: "POST", body: "{}" });
      setNotice("保存待ちの写真の同期を開始しました。コレクションから、写真ごとの状態を確認できます。");
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "同期を開始できませんでした。");
    } finally { setBusy(null); }
  }

  async function logout() {
    if (busy) return;
    setBusy("logout"); setError("");
    try {
      await call("/api/admin/session", { method: "DELETE" });
      setStatus({ authenticated: false, configured: false, connected: false });
      setNotice(connected ? "管理画面から退出しました。Google Drive への自動保存は続きます。" : "管理画面から退出しました。");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "退出できませんでした。");
    } finally { setBusy(null); }
  }

  const authenticated = status?.authenticated === true;
  const connected = status?.connected === true;

  return <>
    <div className="cosmic-sky" aria-hidden="true" />
    <a className="skip-link" href="#drive-admin-main">メインコンテンツへ</a>
    <header className="drive-admin-header">
      <a className="brand" href="/" aria-label="ODDSHOT の TOP へ">ODDSHOT<span className="brand-dot">.</span></a>
      <a className="text-link" href="/"><ArrowLeft size={16} aria-hidden="true" />アプリへ戻る</a>
    </header>
    <main id="drive-admin-main" className="drive-admin-shell">
      <div className="drive-admin-heading"><span className="section-label">OWNER SETTINGS</span><h1>思い出の、保存先。</h1><p>あなたの Google Drive に、みんなの写真と採点データを自動で残します。</p></div>

      {notice && <div className="drive-admin-feedback success" role="status"><CheckCircle2 size={20} aria-hidden="true" /><p>{notice}</p></div>}
      {error && <div className="drive-admin-feedback error" role="alert"><Cloud size={20} aria-hidden="true" /><p>{error}</p></div>}

      {loading ? <section className="drive-admin-card drive-admin-loading" aria-label="連携状態を読み込み中" role="status"><LoaderCircle className="spin" size={28} aria-hidden="true" /><p>保存先を確認しています</p></section> : !status ? <section className="drive-admin-card"><h2>接続状態を確認できませんでした</h2><button className="button secondary" onClick={() => { setLoading(true); refresh().catch(() => setError("接続できませんでした。通信を確認してください。")).finally(() => setLoading(false)); }}><RefreshCw size={17} aria-hidden="true" />再読み込み</button></section> : !authenticated ? <section className="drive-admin-card drive-admin-login">
        <span className="drive-admin-icon"><KeyRound size={27} strokeWidth={1.5} aria-hidden="true" /></span>
        <h2>管理者として、連携する。</h2><p>保存先の連携は、アプリの管理者が一度行います。参加者は Google ログイン不要です。</p>
        <form onSubmit={login}>
          <label htmlFor="drive-admin-secret">管理用パスワード</label>
          <input id="drive-admin-secret" name="password" type="password" autoComplete="current-password" value={secret} onChange={event => setSecret(event.target.value)} required disabled={busy !== null} />
          <button className="button primary" type="submit" disabled={busy !== null}>{busy === "login" ? <LoaderCircle size={18} className="spin" aria-hidden="true" /> : <ArrowRight size={18} aria-hidden="true" />}{busy === "login" ? "確認しています" : "管理画面を開く"}</button>
        </form>
      </section> : <>
        <section className={`drive-admin-card drive-admin-connection ${connected ? "connected" : ""}`}>
          <div className="drive-admin-status-heading"><span className="drive-admin-icon"><Cloud size={28} strokeWidth={1.5} aria-hidden="true" /></span><span className="drive-admin-badge">{connected ? "連携済み" : "連携待ち"}</span></div>
          <h2>{connected ? "この場所に、自動で残ります。" : "Google とつないで、準備完了。"}</h2>
          <p>{connected ? "写真を追加すると、写真と採点データが保存先へ自動で送られます。タイトルを変更したときも更新します。" : "Google で保存を許可し、アプリに設定したフォルダを選びます。以降は、投稿するたびにサーバーが自動で保存します。"}</p>
          <div className="drive-admin-destination"><FolderOpen size={24} aria-hidden="true" /><div><span>みんなの共通保存先</span><strong>{status.folderName || "アプリに設定した Google Drive フォルダ"}</strong></div></div>
          {status.message && <p className="drive-admin-setting-note">{status.message}</p>}
          <div className="drive-admin-actions">
            {status.configured ? <a className={`button ${connected ? "secondary" : "primary"}`} href="/api/admin/drive/connect"><ShieldCheck size={19} aria-hidden="true" />{connected ? "Google と再連携する" : "Google で許可して、保存先を選ぶ"}<ArrowRight size={17} aria-hidden="true" /></a> : <button className="button primary" disabled><ShieldCheck size={19} aria-hidden="true" />接続設定の完了を待っています</button>}
            {connected && <button className="button secondary" disabled={busy !== null} onClick={() => void process()}><RefreshCw size={17} className={busy === "process" ? "spin" : ""} aria-hidden="true" />{busy === "process" ? "同期を開始しています" : "保存待ちの写真を同期"}</button>}
          </div>
          <p className="drive-admin-small">管理画面を閉じても、Google Drive への自動保存は続きます。</p>
        </section>
        <section className="drive-admin-card drive-admin-setup">
          <h2>Google の接続設定</h2><p>Google Cloud の OAuth クライアントで「承認済みのリダイレクト URI」に、次の URL を登録してください。</p>
          {status.redirectUri ? <code className="drive-admin-redirect">{status.redirectUri}</code> : <p className="drive-admin-setting-note">アプリの接続先 URL を設定すると、登録する URL が表示されます。</p>}
          <div className="drive-admin-permissions"><ShieldCheck size={21} aria-hidden="true" /><p>許可の目的は、選んだフォルダに写真と採点データを継続して保存することです。参加者が Google の設定を行う必要はありません。</p></div>
        </section>
        <div className="drive-admin-session"><span><Sparkles size={16} aria-hidden="true" />写真の採点と、Google の連携は別の設定です。</span><button className="text-link" disabled={busy !== null} onClick={() => void logout()}><LogOut size={16} aria-hidden="true" />{busy === "logout" ? "退出しています" : "管理画面から退出"}</button></div>
      </>}
    </main>
  </>;
}

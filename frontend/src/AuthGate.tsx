import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { initialAuthLink, recoveryRedirectUrl, supabase } from "./lib/supabase";
import { getInboundDashboard, getMyAccess, hasAccess, mapDashboard, ShapeError, type LiveJob } from "./lib/mita";

export type LiveData = { jobs: LiveJob[]; userEmail: string; access: unknown; onSignOut: () => void; onReload: () => void };

type Phase =
  | { k: "loading"; msg: string }
  | { k: "denied"; reason: string }
  | { k: "error"; msg: string; detail?: string }
  | { k: "ready"; jobs: LiveJob[]; access: unknown };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-screen min-w-[1280px] place-items-center bg-[#f0f0ec] text-foreground">
      <div className="w-[400px] border border-border bg-card shadow-[0_1px_2px_rgba(18,40,32,.04)]">
        <div className="flex items-center gap-2.5 border-b border-border bg-[#172b27] px-4 py-3">
          <span className="grid h-7 w-7 place-items-center rounded bg-[#d6b45c] font-mono text-[11px] font-bold text-[#182f2b]">M</span>
          <span className="font-slab text-[15px] font-bold tracking-[0.02em] text-white">MITA-OS</span>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

const btn = "rounded border border-[#24564e] bg-[#24564e] px-3 py-1.5 text-[12px] font-bold text-white hover:bg-[#183f39] disabled:opacity-60";
const btn2 = "rounded border border-border bg-white px-3 py-1.5 text-[12px] font-semibold text-[#35443f] hover:bg-[#f2f5f2]";

function SignIn({ notice }: { notice?: string }) {
  const [forgot, setForgot] = useState(false);
  const [info, setInfo] = useState(notice ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(""); setInfo("");
    if (forgot) {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: recoveryRedirectUrl() });
      if (error) setErr(error.message);
      else setInfo("If an account exists for this email, a recovery link has been sent. Open it in this browser.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setErr(error.message);
    }
    setBusy(false);
  };
  return (
    <Shell>
      <h1 className="font-slab text-[15px] font-bold text-[#17201f]">{forgot ? "Reset password" : "Sign in"}</h1>
      <p className="mb-3 text-[11px] text-muted-foreground">{forgot ? "Enter your account email to receive a recovery link." : "Warehouse Group · Inbound. Access is granted by your database role."}</p>
      <form onSubmit={submit} className="space-y-2">
        <label className="block font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">Email
          <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1.5 text-[12px] normal-case tracking-normal text-foreground outline-none focus:border-[#24564e]" />
        </label>
        {!forgot && <label className="block font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">Password
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-0.5 w-full rounded border border-border bg-white px-2 py-1.5 text-[12px] normal-case tracking-normal text-foreground outline-none focus:border-[#24564e]" />
        </label>}
        {info && <p role="status" className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-800">{info}</p>}
        {err && <p role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-800">{err}</p>}
        <button disabled={busy} className={`${btn} w-full`}>{busy ? (forgot ? "Sending…" : "Signing in…") : forgot ? "Send recovery link" : "Sign in"}</button>
        <button type="button" onClick={() => { setForgot(!forgot); setErr(""); setInfo(""); }} className="w-full text-center text-[11px] font-semibold text-[#276157] hover:underline">{forgot ? "Back to sign in" : "Forgot password?"}</button>
      </form>
    </Shell>
  );
}

function cleanUrl() { window.history.replaceState(null, "", window.location.pathname); }

function SetPassword({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    if (pw.length < 8) return setErr("Password must be at least 8 characters.");
    if (pw !== pw2) return setErr("Passwords do not match.");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setErr(error.message);
    onDone();
  };
  const inp = "mt-0.5 w-full rounded border border-border bg-white px-2 py-1.5 text-[12px] normal-case tracking-normal text-foreground outline-none focus:border-[#24564e]";
  return (
    <Shell>
      <h1 className="font-slab text-[15px] font-bold text-[#17201f]">Set a new password</h1>
      <p className="mb-3 text-[11px] text-muted-foreground">Choose a password of at least 8 characters.</p>
      <form onSubmit={submit} className="space-y-2">
        <label className="block font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">New password
          <input type="password" required autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className={inp} /></label>
        <label className="block font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">Confirm password
          <input type="password" required autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} className={inp} /></label>
        {err && <p role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-800">{err}</p>}
        <button disabled={busy} className={`${btn} w-full`}>{busy ? "Saving…" : "Save new password"}</button>
      </form>
    </Shell>
  );
}

export default function AuthGate({ children }: { children: (d: LiveData) => React.ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ k: "loading", msg: "Checking session…" });
  const [nonce, setNonce] = useState(0);
  const [recovering, setRecovering] = useState(initialAuthLink.recovery && !initialAuthLink.error);
  const [linkError, setLinkError] = useState<string | null>(initialAuthLink.error ? (initialAuthLink.errorCode === "otp_expired" ? "This recovery link has expired. Request a new one." : `This recovery link is invalid or has already been used. ${initialAuthLink.error}`) : null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((e, s) => {
      if (e === "PASSWORD_RECOVERY") setRecovering(true);
      setSession(s);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const uid = session?.user.id;
  useEffect(() => {
    if (session === undefined) return;
    if (!session || recovering) { setPhase({ k: "loading", msg: "" }); return; }
    let cancelled = false;
    (async () => {
      try {
        setPhase({ k: "loading", msg: "Verifying access…" });
        const access = await getMyAccess();
        if (cancelled) return;
        if (!hasAccess(access)) { setPhase({ k: "denied", reason: "Your account has no Inbound permissions." }); return; }
        setPhase({ k: "loading", msg: "Loading inbound dashboard…" });
        const jobs = mapDashboard(await getInboundDashboard(100));
        if (!cancelled) setPhase({ k: "ready", jobs, access });
      } catch (e) {
        if (cancelled) return;
        const m = e instanceof Error ? e.message : String(e);
        setPhase({ k: "error", msg: m, detail: e instanceof ShapeError ? e.detail : undefined });
      }
    })();
    return () => { cancelled = true; };
  }, [uid, nonce, recovering]); // eslint-disable-line react-hooks/exhaustive-deps

  const signOut = useCallback(() => { supabase.auth.signOut(); }, []);

  useEffect(() => {
    if (!recovering || session !== null || linkError) return undefined;
    const t = setTimeout(() => setLinkError("This recovery link is invalid or has expired. Request a new one."), 4000);
    return () => clearTimeout(t);
  }, [recovering, session, linkError]);

  if (linkError) return (
    <Shell>
      <h1 className="font-slab text-[15px] font-bold text-red-800">Recovery link problem</h1>
      <p role="alert" className="my-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-800">{linkError}</p>
      <button onClick={() => { cleanUrl(); setLinkError(null); setRecovering(false); }} className={btn}>Back to sign in</button>
    </Shell>
  );
  if (recovering && session) return <SetPassword onDone={async () => {
    cleanUrl(); setRecovering(false); setNotice("Password updated. Sign in with your new password.");
    await supabase.auth.signOut();
  }} />;
  if (session === undefined || (recovering && session === null)) return <Shell><p className="text-[12px] text-muted-foreground">Checking session…</p></Shell>;
  if (!session) return <SignIn notice={notice} />;
  if (phase.k === "loading") return <Shell><p className="flex items-center gap-2 text-[12px] text-muted-foreground"><span className="h-2 w-2 animate-pulse rounded-full bg-[#3e8a64]" />{phase.msg}</p></Shell>;
  if (phase.k === "denied") return (
    <Shell>
      <h1 className="font-slab text-[15px] font-bold text-[#17201f]">No access</h1>
      <p className="my-2 text-[12px] text-[#4a5550]">{phase.reason} Signed in as <span className="font-mono">{session.user.email}</span>. Ask an administrator to assign a role.</p>
      <button onClick={signOut} className={btn2}>Sign out</button>
    </Shell>
  );
  if (phase.k === "error") return (
    <Shell>
      <h1 className="font-slab text-[15px] font-bold text-red-800">Unable to load operational data</h1>
      <p role="alert" className="my-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 font-mono text-[11px] text-red-800">{phase.msg}</p>
      {phase.detail && <p className="mb-2 text-[11px] text-[#4a5550]">{phase.detail}</p>}
      <div className="flex gap-2"><button onClick={() => setNonce((n) => n + 1)} className={btn}>Retry</button><button onClick={signOut} className={btn2}>Sign out</button></div>
    </Shell>
  );
  return <>{children({ jobs: phase.jobs, userEmail: session.user.email ?? "", access: phase.access, onSignOut: signOut, onReload: () => setNonce((n) => n + 1) })}</>;
}
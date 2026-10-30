import { Logo } from "@/components/ui/Logo";
import { env, isDemo } from "@/lib/env";
import { currentGhStatus } from "@/lib/local/identity";
import { loginCommand, REQUIRED_SCOPES } from "@/lib/github/gh";
import { Banner } from "@/components/ui/primitives";
import { ShieldCheck } from "@/components/ui/icons";
import { GhLogin } from "@/components/forms/GhLogin";
import { HubConnect } from "@/components/forms/HubConnect";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  "gh-missing": "The GitHub CLI (gh) is not installed.",
  "gh-login": "gh is not signed in to GitHub yet.",
  "gh-error": "gh could not reach GitHub. Check your connection and try again.",
  mismatch: "gh is signed in as a different account than this profile belongs to. Switch with gh auth switch, or start Mergeport again to use that account's own profile.",
  "demo-unseeded": "Demo data has not been seeded. Run npm run local:demo.",
  "hub-not-invited": "That GitHub account is not invited to this server. Ask its owner to invite you.",
  "hub-removed": "You were removed from that server. Ask its owner to invite you again.",
  "hub-expired": "The sign-in code expired. Connect again.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const demo = isDemo();
  const st = demo ? null : await currentGhStatus(true);
  const launched = Boolean(env().MERGEPORT_LAUNCH_TOKEN);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center gap-5 px-4 py-10">
      <div className="flex items-center gap-2.5">
        <Logo size={36} />
        <span className="text-[18px] font-medium">Mergeport</span>
        <span className="pill pill-unknown ml-auto">Runs on this computer</span>
      </div>
      <div className="panel">
        <div className="panel-body p-5">
          <h1 className="text-[20px] font-medium">Sign in with GitHub</h1>
          {sp.error && <div className="mt-4"><Banner tone="error" title="Could not sign you in">{ERRORS[sp.error] ?? "Something went wrong."}</Banner></div>}

          {demo && <p className="mt-2 text-[13px] text-ink-3">Demo mode uses synthetic data and never contacts GitHub.</p>}

          {st?.state === "missing-gh" && (
            <div className="mt-3 flex flex-col gap-3 text-[13px]">
              <p>Mergeport signs in through the official GitHub CLI so no secret has to be shared or stored by this app.</p>
              <ol className="list-decimal space-y-1 pl-5 text-ink-2">
                <li>Install <strong>gh</strong> from <a className="underline" href="https://cli.github.com/" target="_blank" rel="noopener noreferrer">cli.github.com</a> (Windows: <span className="mono">winget install GitHub.cli</span>).</li>
                <li>Reopen this page.</li>
              </ol>
              <a className="btn w-fit" href="/sign-in">Check again</a>
            </div>
          )}

          {st?.state === "not-logged-in" && (
            <div className="mt-3 flex flex-col gap-3 text-[13px]">
              <p>The GitHub CLI is installed but not signed in.</p>
              <GhLogin />
              <p className="text-ink-3">Or run this yourself:</p>
              <pre className="mono overflow-x-auto rounded-[8px] border border-line bg-canvas p-2.5 text-[12px]">{loginCommand()}</pre>
              <p className="flex items-start gap-2 text-[12.5px] text-ink-3"><ShieldCheck size={14} aria-hidden className="mt-0.5 shrink-0" />This asks GitHub for the scopes <span className="mono">{REQUIRED_SCOPES.join(", ")}</span>. <strong className="font-medium text-ink-2">repo</strong> is broad read and write access to the repositories you can reach, not a read-only permission; it is what private coordination repositories and private source repositories need. gh keeps the token in your operating system&apos;s credential store. Mergeport never reads it and never sends it anywhere.</p>
            </div>
          )}

          {st?.state === "error" && <div className="mt-3"><Banner tone="error" title="Could not ask GitHub who you are">{st.message}</Banner></div>}

          {st?.state === "ok" && (
            <div className="mt-3 flex flex-col gap-3 text-[13px]">
              <p>gh is signed in as <strong>@{st.identity.login}</strong> (GitHub id {st.identity.id.toString()}). Your data is stored only in a profile for this exact account on this computer.</p>
              {launched ? (
                <p className="text-ink-3">Open Mergeport with the link the launcher opened (<span className="mono">npm run local</span>). That one-time link ties this browser to this process.</p>
              ) : (
                <form action="/api/local/signin" method="post"><button className="btn btn-primary !h-10 w-full">Continue as @{st.identity.login}</button></form>
              )}
            </div>
          )}
        </div>
      </div>

      {!demo && (
        <div className="panel">
          <div className="panel-head"><h2 className="text-[13px] font-medium text-ink-2">Connect to a server</h2></div>
          <div className="panel-body p-4"><HubConnect /></div>
        </div>
      )}

      {demo && (
        <div className="panel">
          <div className="panel-head"><h2 className="text-[13px] font-medium text-ink-2">Demo people (synthetic)</h2></div>
          <form action="/api/local/demo" method="post" className="panel-body flex flex-col gap-2 p-3">
            <button name="as" value="admin" className="btn justify-start">Owner · owner-demo (sees everything)</button>
            <button name="as" value="alice" className="btn justify-start">Member A · alice-demo (3 repositories)</button>
            <button name="as" value="bram" className="btn justify-start">Member B · bram-demo (2 repositories)</button>
          </form>
        </div>
      )}
    </main>
  );
}

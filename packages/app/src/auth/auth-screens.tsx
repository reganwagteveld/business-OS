import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@business-os/ui';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { AuthClient, AuthResult } from '../api/auth';

export type AuthView = 'sign-in' | 'sign-up' | 'check-email' | 'forgot' | 'reset';

const field = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const button = 'w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50';
const link = 'text-sm underline underline-offset-4';

function Frame({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </div>
  );
}

function useSubmit(action: (form: FormData) => Promise<AuthResult>, onSuccess: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await action(new FormData(event.currentTarget));
    setBusy(false);
    if (result.ok) onSuccess();
    else setError(result.message);
  };
  return { busy, error, submit };
}

const value = (form: FormData, name: string) => String(form.get(name) ?? '');

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
}

/** Browser-app authentication screens (sign in, sign up, password reset). */
export function AuthScreens({ auth, initialView, resetToken, onSignedIn }: {
  auth: AuthClient;
  initialView: AuthView;
  resetToken?: string | null;
  onSignedIn: () => void;
}) {
  const [view, setView] = useState<AuthView>(initialView);
  const [notice, setNotice] = useState<string | null>(null);
  const go = (next: AuthView, message: string | null = null) => {
    setNotice(message);
    setView(next);
  };

  const signIn = useSubmit((f) => auth.signIn({ email: value(f, 'email'), password: value(f, 'password') }), onSignedIn);
  const signUp = useSubmit((f) => auth.signUp({ email: value(f, 'email'), password: value(f, 'password'), name: value(f, 'name') }), () => go('check-email'));
  const forgot = useSubmit((f) => auth.requestPasswordReset(value(f, 'email')), () => go('sign-in', 'If an account exists for that email, a reset link is on its way.'));
  const reset = useSubmit((f) => auth.resetPassword(resetToken ?? '', value(f, 'password')), () => go('sign-in', 'Password changed. Sign in with your new password.'));

  switch (view) {
    case 'sign-in':
      return (
        <Frame title="Sign in" description="Business OS">
          {notice ? <p className="text-sm">{notice}</p> : null}
          <form className="flex flex-col gap-3" onSubmit={signIn.submit}>
            <input className={field} name="email" type="email" autoComplete="email" placeholder="Email" required aria-label="Email" />
            <input className={field} name="password" type="password" autoComplete="current-password" placeholder="Password" required aria-label="Password" />
            <ErrorLine error={signIn.error} />
            <button className={button} type="submit" disabled={signIn.busy}>Sign in</button>
          </form>
          <div className="flex justify-between">
            <button type="button" className={link} onClick={() => go('sign-up')}>Create an account</button>
            <button type="button" className={link} onClick={() => go('forgot')}>Forgot password?</button>
          </div>
        </Frame>
      );
    case 'sign-up':
      return (
        <Frame title="Create your account">
          <form className="flex flex-col gap-3" onSubmit={signUp.submit}>
            <input className={field} name="name" autoComplete="name" placeholder="Your name" required aria-label="Your name" />
            <input className={field} name="email" type="email" autoComplete="email" placeholder="Email" required aria-label="Email" />
            <input className={field} name="password" type="password" autoComplete="new-password" placeholder="Password (12+ characters)" minLength={12} required aria-label="Password" />
            <ErrorLine error={signUp.error} />
            <button className={button} type="submit" disabled={signUp.busy}>Create account</button>
          </form>
          <button type="button" className={link} onClick={() => go('sign-in')}>I already have an account</button>
        </Frame>
      );
    case 'check-email':
      return (
        <Frame title="Check your email" description="We sent a link to confirm your address. Open it, then sign in.">
          <button type="button" className={link} onClick={() => go('sign-in')}>Back to sign in</button>
        </Frame>
      );
    case 'forgot':
      return (
        <Frame title="Reset your password" description="We will email you a link if the account exists.">
          <form className="flex flex-col gap-3" onSubmit={forgot.submit}>
            <input className={field} name="email" type="email" autoComplete="email" placeholder="Email" required aria-label="Email" />
            <ErrorLine error={forgot.error} />
            <button className={button} type="submit" disabled={forgot.busy}>Send reset link</button>
          </form>
          <button type="button" className={link} onClick={() => go('sign-in')}>Back to sign in</button>
        </Frame>
      );
    case 'reset':
      return (
        <Frame title="Choose a new password">
          <form className="flex flex-col gap-3" onSubmit={reset.submit}>
            <input className={field} name="password" type="password" autoComplete="new-password" placeholder="New password (12+ characters)" minLength={12} required aria-label="New password" />
            <ErrorLine error={reset.error ?? (resetToken ? null : 'This reset link is invalid. Request a new one.')} />
            <button className={button} type="submit" disabled={reset.busy || !resetToken}>Change password</button>
          </form>
        </Frame>
      );
  }
}

/** Desktop sign-in: the system browser does the sign-in; the app never sees the password (D9a). */
export function DesktopSignIn({ auth, onSignedIn }: { auth: AuthClient; onSignedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (auth.transport.kind !== 'bearer') return null;
  const transport = auth.transport;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await transport.signIn();
      onSignedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in did not complete. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Sign in to Business OS" description="Your browser will open so you can sign in securely. Come back here when it is done.">
      <ErrorLine error={error} />
      <button className={button} type="button" onClick={start} disabled={busy}>
        {busy ? 'Waiting for your browser…' : 'Sign in with your browser'}
      </button>
    </Frame>
  );
}

/** Accepting an invitation: an explicit click (never automatic), then a confirmation. */
export function AcceptInvitation({ auth, token, email, onDone }: {
  auth: AuthClient;
  token: string | null;
  email: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<{ slug: string; role: string } | null>(null);
  if (!token) {
    return (
      <Frame title="Invitation link problem" description="This link is incomplete. Open the link from your invitation email again.">
        <button type="button" className={link} onClick={onDone}>Continue to Business OS</button>
      </Frame>
    );
  }
  if (joined) {
    return (
      <Frame title="You're in" description={`You joined as ${joined.role.toLowerCase()}.`}>
        <button className={button} type="button" onClick={onDone}>Continue to Business OS</button>
      </Frame>
    );
  }
  const accept = async () => {
    setBusy(true);
    setError(null);
    const result = await auth.acceptInvitation(token);
    setBusy(false);
    if (result.ok) setJoined(result.data);
    else setError(result.message);
  };
  return (
    <Frame title="Accept your invitation" description={`You are signed in as ${email}. The invitation works only for the email address it was sent to.`}>
      <ErrorLine error={error} />
      <button className={button} type="button" onClick={accept} disabled={busy}>Accept invitation</button>
      <button type="button" className={link} onClick={onDone}>Not now</button>
    </Frame>
  );
}

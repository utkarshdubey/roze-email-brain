// `roze auth`: loopback Google OAuth for the read-only Gmail scope, saved to .token.json.
import { signInWithGoogle } from "../gmail/auth.js";
import { GmailClient } from "../gmail/client.js";
import { createUi } from "../tui.js";

/** Verifying the profile immediately avoids silently saving a token for the wrong account. */
export async function runAuthCommand(args: readonly string[]): Promise<void> {
  if (args.length) throw new Error("Usage: roze auth");
  const ui = createUi();
  ui.intro("Opening your browser to sign in with Google (Gmail read-only)…");
  const spin = ui.spinner("Waiting for you to finish signing in…");
  const profile = await new GmailClient(await signInWithGoogle()).getProfile();
  spin.stop(`Signed in as ${profile.emailAddress}.`);
  ui.outro("Token saved to .token.json");
}

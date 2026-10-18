import { expect, test } from "bun:test";
import { onboardingAuthState } from "../web/src/Onboarding";

test("an unknown credential state permits onboarding without a signed-in success label", () => {
  expect(onboardingAuthState({ ok: true, loggedIn: null, needsKey: false })).toEqual({
    signedIn: false,
    canContinue: true,
  });
  expect(onboardingAuthState({ ok: true, loggedIn: true })).toEqual({ signedIn: true, canContinue: true });
});

test("authentication and session failures keep retry and sign-in actions visible", () => {
  for (const failure of [
    { authError: "Sign-in cancelled" },
    { sessionError: "Workspace no longer exists" },
    { needsKey: true },
  ]) {
    // Even session/new succeeding cannot erase a failed authentication attempt.
    expect(onboardingAuthState({ ok: true, loggedIn: true, ...failure })).toEqual({
      signedIn: false,
      canContinue: false,
    });
  }
  expect(onboardingAuthState({ ok: true, loggedIn: false })).toEqual({ signedIn: false, canContinue: false });
  expect(onboardingAuthState({ ok: false, error: "Connection closed" })).toEqual({
    signedIn: false,
    canContinue: false,
  });
  expect(onboardingAuthState("running")).toEqual({ signedIn: false, canContinue: false });
});

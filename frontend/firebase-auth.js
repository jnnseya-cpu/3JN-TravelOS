// Firebase Auth integration (progressive).
//
// Loads the Firebase SDK from the gstatic CDN (no bundler needed). If the CDN
// or config is unavailable (e.g. the fully-offline prototype), this module
// fails quietly and `window.firebaseAuth` stays undefined — app.js then falls
// back to the built-in prototype login. When it IS available, app.js shows a
// "Continue with Google" / email auth flow and bridges the Firebase identity to
// a backend account (by email) so loyalty, bookings, etc. keep working.

const SDK = 'https://www.gstatic.com/firebasejs/12.0.0';

(async () => {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey) return; // not configured

  try {
    const { initializeApp } = await import(`${SDK}/firebase-app.js`);
    const {
      getAuth, GoogleAuthProvider, signInWithPopup,
      createUserWithEmailAndPassword, signInWithEmailAndPassword,
      signOut, onAuthStateChanged, setPersistence, browserLocalPersistence,
      sendEmailVerification, updateProfile, sendPasswordResetEmail,
      verifyBeforeUpdateEmail,
    } = await import(`${SDK}/firebase-auth.js`);

    const app = initializeApp(cfg);
    const auth = getAuth(app);
    try { await setPersistence(auth, browserLocalPersistence); } catch {}

    const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
    const toUser = (u) => ({ uid: u.uid, email: u.email, name: u.displayName || (u.email || '').split('@')[0], emailVerified: !!u.emailVerified });

    window.firebaseAuth = {
      available: true,
      async google() { const { user } = await signInWithPopup(auth, new GoogleAuthProvider()); return toUser(user); },
      async signUp(email, password, name) {
        const { user } = await createUserWithEmailAndPassword(auth, email, password);
        if (name && user) { try { await updateProfile(user, { displayName: name }); } catch {} }
        // Send the verification email (uses your Firebase console template). Do
        // NOT swallow a failure — otherwise the banner says "check your inbox"
        // while nothing was ever sent. Surface the real reason so it's fixable
        // (usually: this domain isn't in Firebase Auth → Settings → Authorized
        // domains, or the Email/Password template is disabled).
        let verificationSent = false, verificationError = null;
        try { await sendEmailVerification(user); verificationSent = true; }
        catch (e) { verificationError = e?.code || e?.message || String(e); console.warn('[firebase-auth] verification email failed:', verificationError); }
        return { ...toUser(user), verificationSent, verificationError };
      },
      async signIn(email, password) { const { user } = await signInWithEmailAndPassword(auth, email, password); return toUser(user); },
      async resetPassword(email) { await sendPasswordResetEmail(auth, email); return true; },
      async resendVerification() { if (auth.currentUser) { await sendEmailVerification(auth.currentUser); return true; } return false; },
      // Secure email change — sends a "review the change" email to the OLD
      // address and only applies the new email after the user confirms.
      async changeEmail(newEmail) { if (!auth.currentUser) return false; await verifyBeforeUpdateEmail(auth.currentUser, newEmail); return true; },
      async signOut() { await signOut(auth); },
      currentEmailVerified() { return !!auth.currentUser?.emailVerified; },
      // Re-run the verified sign-in bridge with a FRESH token — re-establishes a
      // valid backend session (fixes a stale/expired session id) and re-applies
      // role (an allowlisted owner becomes admin). Returns false if not signed in.
      async reauth() {
        if (!auth.currentUser) return false;
        let idToken = null;
        try { idToken = await auth.currentUser.getIdToken(true); } catch { return false; }
        emit('firebase-auth', { ...toUser(auth.currentUser), idToken });
        return true;
      },
    };

    // Auto-bridge: when Firebase auth state changes, tell the app — INCLUDING a
    // fresh ID token the server verifies (the email is trusted only from that).
    onAuthStateChanged(auth, async (u) => {
      if (u) {
        let idToken = null;
        try { idToken = await u.getIdToken(); } catch { /* offline */ }
        emit('firebase-auth', { ...toUser(u), idToken });
      } else emit('firebase-signout', {});
    });

    emit('firebase-ready', {});
  } catch (err) {
    // CDN unreachable / blocked — stay on the prototype login.
    console.warn('[firebase-auth] unavailable, using built-in login:', err?.message || err);
  }
})();

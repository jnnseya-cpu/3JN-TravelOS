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
    } = await import(`${SDK}/firebase-auth.js`);

    const app = initializeApp(cfg);
    const auth = getAuth(app);
    try { await setPersistence(auth, browserLocalPersistence); } catch {}

    const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
    const toUser = (u) => ({ uid: u.uid, email: u.email, name: u.displayName || (u.email || '').split('@')[0] });

    window.firebaseAuth = {
      available: true,
      async google() { const { user } = await signInWithPopup(auth, new GoogleAuthProvider()); return toUser(user); },
      async signUp(email, password, name) {
        const { user } = await createUserWithEmailAndPassword(auth, email, password);
        if (name && user) { try { const { updateProfile } = await import(`${SDK}/firebase-auth.js`); await updateProfile(user, { displayName: name }); } catch {} }
        return toUser(user);
      },
      async signIn(email, password) { const { user } = await signInWithEmailAndPassword(auth, email, password); return toUser(user); },
      async signOut() { await signOut(auth); },
    };

    // Auto-bridge: when Firebase auth state changes, tell the app.
    onAuthStateChanged(auth, (u) => {
      if (u) emit('firebase-auth', toUser(u));
      else emit('firebase-signout', {});
    });

    emit('firebase-ready', {});
  } catch (err) {
    // CDN unreachable / blocked — stay on the prototype login.
    console.warn('[firebase-auth] unavailable, using built-in login:', err?.message || err);
  }
})();

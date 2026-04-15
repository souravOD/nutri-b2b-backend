// ─── Firebase Admin SDK — singleton initialisation ────────────────────────────
// Reads credentials from env vars (set after creating the Firebase project).
// Safe to import in any route/service — initializeApp is idempotent.
// If FIREBASE_PROJECT_ID is absent the module is a no-op (local dev without
// Firebase configured).
// ─────────────────────────────────────────────────────────────────────────────

import admin from "firebase-admin";

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;

if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        // Cloud Run / Docker store the key with literal \n — restore real newlines
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  }
}

export { admin };

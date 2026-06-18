import {initializeApp} from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCustomToken,
  signInWithPopup,
  signOut as firebaseSignOut,
} from "firebase/auth";
import {getFirestore} from "firebase/firestore";
import {getStorage} from "firebase/storage";

let auth;
let firestore;
let storage;

const defaultFirebaseConfig = {
  apiKey: "AIzaSyA0A772IU-qiva6p_zV1mD70uN8BtvP8to",
  authDomain: "pi-agents-cloud.firebaseapp.com",
  projectId: "pi-agents-cloud",
  storageBucket: "pi-agents-cloud.firebasestorage.app",
  messagingSenderId: "299764728235",
};

export async function initializeFirebase() {
  const app = initializeApp(await getFirebaseConfig());
  auth = getAuth(app);
  firestore = getFirestore(app);
  storage = getStorage(app);
  return auth;
}

export function getFirestoreDb() {
  return firestore;
}

export function getFirebaseStorage() {
  return storage;
}

export function watchAuth(authInstance, callback) {
  return onAuthStateChanged(authInstance, callback);
}

export async function signIn() {
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
}

export async function signOut() {
  await firebaseSignOut(auth);
}

export async function maybeSignInWithQaToken() {
  const request = qaLoginRequest();
  if (!request.enabled) return false;
  if (!request.secret) {
    throw new Error("qa_login_secret_missing");
  }

  const response = await fetch("/api/qa/custom-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-mapache-qa-secret": request.secret,
    },
    body: JSON.stringify({}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || response.statusText || "qa_login_failed");
  }
  await signInWithCustomToken(auth, data.token);
  return true;
}

async function getFirebaseConfig() {
  const envConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };

  if (envConfig.apiKey && envConfig.projectId) {
    return envConfig;
  }

  try {
    const response = await fetch("/__/firebase/init.json", {
      headers: {Accept: "application/json"},
    });
    const contentType = response.headers.get("content-type") || "";
    if (response.ok && contentType.includes("application/json")) {
      return response.json();
    }
  } catch (error) {
    console.warn("Falling back to bundled Firebase config.", error);
  }

  return defaultFirebaseConfig;
}

function qaLoginRequest() {
  if (typeof window === "undefined") return {enabled: false, secret: ""};
  const params = new URLSearchParams(window.location.search);
  const enabled = params.get("qaLogin") === "1" ||
    readStorage("mapache.qaLogin") === "1";
  const secret = params.get("qaSecret") ||
    readStorage("mapache.qaSecret") ||
    "";
  if (params.has("qaSecret") || params.has("qaLogin")) {
    params.delete("qaSecret");
    params.delete("qaLogin");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }
  return {enabled, secret};
}

function readStorage(key) {
  try {
    return window.sessionStorage.getItem(key) || window.localStorage.getItem(key) || "";
  } catch (error) {
    return "";
  }
}

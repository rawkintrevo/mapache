import {initializeApp} from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
} from "firebase/auth";
import {getFirestore} from "firebase/firestore";

let auth;
let firestore;

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
  return auth;
}

export function getFirestoreDb() {
  return firestore;
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

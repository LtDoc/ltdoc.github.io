// js/firebase.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js';
import { getDatabase }    from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-database.js';
import {
  getStorage,
  ref   as storageRef,
  uploadBytes,
  getDownloadURL
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-storage.js';

const firebaseConfig = {
  apiKey:            "AIzaSyCo9QPVrLCXS6li_kcTu3e-GOoiiwpHvLs",
  authDomain:        "woe-world.firebaseapp.com",
  databaseURL:       "https://woe-world-default-rtdb.firebaseio.com/",   // ← note the trailing slash
  projectId:         "woe-world",
  storageBucket:     "woe-world.appspot.com",
  messagingSenderId: "706865712365",
  appId:             "1:706865712365:web:e080b1ef45b8d8b27190e4",
  measurementId:     "G-789BN2WECG"
};

const app = initializeApp(firebaseConfig);

// Pass the URL in directly to bypass the parser’s strict default check:
export const db      = getDatabase(app, firebaseConfig.databaseURL);
export const storage = getStorage(app);

export async function uploadFile(path, file) {
  const ref = storageRef(storage, path);
  await uploadBytes(ref, file);
  return getDownloadURL(ref);
}

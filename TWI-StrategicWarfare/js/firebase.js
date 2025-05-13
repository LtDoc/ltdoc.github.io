// js/firebase.js
import firebase from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js';
import 'https://www.gstatic.com/firebasejs/9.22.2/firebase-database-compat.js';
import {
  getStorage,
  ref   as storageRef,
  uploadBytes,
  getDownloadURL
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-storage.js';

const firebaseConfig = {
  apiKey:            "AIzaSyCo9QPVrLCXS6li_kcTu3e-GOoiiwpHvLs",
  authDomain:        "woe-world.firebaseapp.com",
  databaseURL:       "https://woe-world-default-rtdb.firebaseio.com",  // your existing URL
  projectId:         "woe-world",
  storageBucket:     "woe-world.appspot.com",
  messagingSenderId: "706865712365",
  appId:             "1:706865712365:web:e080b1ef45b8d8b27190e4",
  measurementId:     "G-789BN2WECG"
};

// initialize with compat
firebase.initializeApp(firebaseConfig);
// now this works with your default-rtdb URL
export const db      = firebase.database();
export const storage = getStorage(firebase.app());

export async function uploadFile(path, file) {
  const ref = storageRef(storage, path);
  await uploadBytes(ref, file);
  return getDownloadURL(ref);
}

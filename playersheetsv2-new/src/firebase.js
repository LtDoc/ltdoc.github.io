// src/firebase.js

import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: "AIzaSyCo9QPVrLCXS6li_kcTu3e-GOoiiwpHvLs",
  authDomain: "woe-world.firebaseapp.com",
  databaseURL: "https://woe-world-default-rtdb.firebaseio.com",
  projectId: "woe-world",
  storageBucket: "woe-world.appspot.com",
  messagingSenderId: "706865712365",
  appId: "1:706865712365:web:e080b1ef45b8d8b27190e4",
  measurementId: "G-789BN2WECG"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);

export { auth, database };

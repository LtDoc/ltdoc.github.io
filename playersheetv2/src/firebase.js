// src/firebase.js
import firebase from "firebase/app";
import "firebase/database";

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

firebase.initializeApp(firebaseConfig);

const database = firebase.database();

export { database };
